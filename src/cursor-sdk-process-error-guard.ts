import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyCursorConnectError, isCursorSdkAbortConnectError, isCursorSdkConnectionStalledError } from "./cursor-provider-errors.js";

interface CursorSdkProcessErrorGuardToken {
	suppressAbortErrors: boolean;
	onLocalTransportClosedPipe?: () => void;
}

interface CursorSdkSessionProcessErrorGuardToken {}

export interface CursorSdkProcessErrorGuard {
	suppressAbortErrors(): void;
	containLocalTransportClosedPipe(onClosedPipe: () => void): void;
	dispose(): void;
}

export interface CursorSdkSessionProcessErrorGuard {
	dispose(): void;
}

type GenericProcessEmit = (event: string | symbol, ...args: unknown[]) => boolean;

// Cursor SDK controlled-exec tasks can reject after their originating provider turn
// has ended. The exact closed-writable failure is therefore session-scoped; existing
// ConnectRPC suppression remains scoped to active provider turns.
const activeProviderTurns = new Set<CursorSdkProcessErrorGuardToken>();
const activeSessions = new Set<CursorSdkSessionProcessErrorGuardToken>();
let activeLifecycleSessionGuard: CursorSdkSessionProcessErrorGuard | undefined;
let originalProcessEmit: GenericProcessEmit | undefined;
let cursorProcessEmit: GenericProcessEmit | undefined;
let bunUnhandledRejectionListenerInstalled = false;

function hasActiveGuard(): boolean {
	return activeProviderTurns.size > 0 || activeSessions.size > 0;
}

function hasActiveAbortSuppression(): boolean {
	for (const turn of activeProviderTurns) {
		if (turn.suppressAbortErrors) return true;
	}
	return false;
}

function isCursorProvenance(source: string): boolean {
	return source === "cursor-sdk-stack" || source === "cursor-extension-connect-stack" || source === "cursor-backend-details";
}

function isCursorSdkWriteIterableClosedError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "WriteIterableClosedError" &&
		error.message === "WritableIterable is closed" &&
		/(?:^|[\\/])node_modules[\\/]@cursor[\\/]sdk[\\/]dist[\\/]/.test(error.stack ?? "")
	);
}

// The Cursor SDK aborts an in-flight controlled-exec turn via its internal
// `AbortController.abort()` (user interrupt or stall-detector cancellation),
// which surfaces as a raw `DOMException [AbortError]` rather than a
// `ConnectError`. `classifyCursorConnectError` returns undefined for it, so it
// otherwise falls through the emit patch and terminates the process. A
// DOMException is not `instanceof Error`, so match structurally on the
// `AbortError` name plus the same `@cursor/sdk/dist` stack provenance the
// WriteIterableClosedError recognizer uses, keeping unrelated AbortErrors fatal.
function isCursorSdkAbortError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { name, stack } = error as { name?: unknown; stack?: unknown };
	return (
		name === "AbortError" &&
		typeof stack === "string" &&
		/(?:^|[\\/])node_modules[\\/]@cursor[\\/]sdk[\\/]dist[\\/]/.test(stack)
	);
}

// The exact observed incident: the Cursor SDK 1.0.23 local shell executor writes a
// spawned child's stdin without a stream 'error' listener, so a child exiting while
// a write is in flight surfaces a raw `write EPIPE` uncaught exception whose stack
// is exactly the single async pipe-write completion frame. Installed 1.0.27 attaches
// a no-op `error` listener before that write; keep this guard as defense in depth.
// Pi's own piped-stdout or dead-terminal EPIPE normally surfaces through the
// synchronous write-dispatch path with multiple frames (afterWriteDispatched /
// Socket._writeGeneric) and must stay fatal per Unix convention, so anything beyond
// this one-frame contract is rejected.
const OBSERVED_CLOSED_PIPE_STACK_FRAME =
	/^\s+at WriteWrap\.onWriteComplete \[as oncomplete\] \(node:internal\/stream_base_commons:\d+:\d+\)$/;

function isObservedLocalTransportClosedPipeWriteError(error: unknown): boolean {
	if (!(error instanceof Error) || error.name !== "Error") return false;
	const { code, syscall } = error as NodeJS.ErrnoException;
	if (code !== "EPIPE" || syscall !== "write" || !error.message.startsWith("write EPIPE")) return false;
	const frames = (error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
	return frames.length === 1 && OBSERVED_CLOSED_PIPE_STACK_FRAME.test(frames[0] ?? "");
}

// Contained only while a provider turn that declared a local transport is active;
// each contained turn invalidates its own session-agent scope for recreation.
function containLocalTransportClosedPipeError(): boolean {
	let contained = false;
	for (const turn of [...activeProviderTurns]) {
		if (!turn.onLocalTransportClosedPipe) continue;
		contained = true;
		try {
			turn.onLocalTransportClosedPipe();
		} catch {
			// stale-agent invalidation must not throw inside process error handling
		}
	}
	return contained;
}

function shouldSuppressProcessError(event: string | symbol, args: readonly unknown[]): boolean {
	if (event !== "uncaughtException" && event !== "unhandledRejection") return false;
	const error = args[0];
	if (isObservedLocalTransportClosedPipeWriteError(error)) {
		return containLocalTransportClosedPipeError();
	}
	if (isCursorSdkWriteIterableClosedError(error)) return activeSessions.size > 0;
	// SDK stall timers and inter-turn teardown aborts never call suppressAbortErrors();
	// any active provider turn or session is enough — stack provenance already gates SDK-only AbortErrors.
	if (isCursorSdkAbortError(error)) return hasActiveGuard();
	// RetriableError "Connection stalled" / "Connection stalled repeatedly" is not a ConnectError; suppress during active turns only.
	if (isCursorSdkConnectionStalledError(error)) return activeProviderTurns.size > 0;
	const classification = classifyCursorConnectError(error);
	if (!classification) return false;
	if (classification.kind === "abort") return hasActiveAbortSuppression();
	if (activeProviderTurns.size === 0) return false;
	if (classification.kind === "network") return isCursorProvenance(classification.source) || classification.source === "connect-node-stack";
	return isCursorProvenance(classification.source);
}

function installProcessEmitPatch(): void {
	if (cursorProcessEmit) {
		if (process.emit === cursorProcessEmit) return;
		if (process.emit !== originalProcessEmit) return;
		cursorProcessEmit = undefined;
		originalProcessEmit = undefined;
	}
	const forwardEmit = process.emit as GenericProcessEmit;
	originalProcessEmit = forwardEmit;
	cursorProcessEmit = function patchedCursorSdkProcessErrorEmit(this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
		if (shouldSuppressProcessError(event, args)) return true;
		return forwardEmit.call(this, event, ...args);
	};
	process.emit = cursorProcessEmit as typeof process.emit;
}

function isBunRuntime(): boolean {
	return typeof (process.versions as { bun?: string }).bun === "string";
}

function handleBunUnhandledRejection(error: unknown): void {
	if (shouldSuppressProcessError("unhandledRejection", [error])) return;
	// Without another rejection listener, retain Bun's default fatal behavior.
	if (process.listenerCount("unhandledRejection") === 1) throw error;
}

function installBunUnhandledRejectionListener(): void {
	if (!isBunRuntime() || bunUnhandledRejectionListenerInstalled) return;
	process.prependListener("unhandledRejection", handleBunUnhandledRejection);
	bunUnhandledRejectionListenerInstalled = true;
}

function uninstallBunUnhandledRejectionListenerIfIdle(): void {
	if (hasActiveGuard() || !bunUnhandledRejectionListenerInstalled) return;
	process.off("unhandledRejection", handleBunUnhandledRejection);
	bunUnhandledRejectionListenerInstalled = false;
}

function uninstallProcessHooksIfIdle(): void {
	if (hasActiveGuard()) return;
	uninstallBunUnhandledRejectionListenerIfIdle();
	if (!originalProcessEmit || !cursorProcessEmit || process.emit !== cursorProcessEmit) return;
	process.emit = originalProcessEmit as typeof process.emit;
	originalProcessEmit = undefined;
	cursorProcessEmit = undefined;
}

function installProcessHooks(): void {
	installProcessEmitPatch();
	installBunUnhandledRejectionListener();
}

export const __testUtils = {
	activeProviderTurnCount: (): number => activeProviderTurns.size,
	activeSessionCount: (): number => activeSessions.size,
	resetLifecycleSessionGuard(): void {
		activeLifecycleSessionGuard?.dispose();
		activeLifecycleSessionGuard = undefined;
	},
};

export { isCursorSdkAbortConnectError };

export function installCursorSdkProcessErrorGuard(): CursorSdkProcessErrorGuard {
	const token: CursorSdkProcessErrorGuardToken = { suppressAbortErrors: false };
	activeProviderTurns.add(token);
	installProcessHooks();
	let disposed = false;
	return {
		suppressAbortErrors(): void {
			if (disposed) return;
			token.suppressAbortErrors = true;
		},
		containLocalTransportClosedPipe(onClosedPipe: () => void): void {
			if (disposed) return;
			token.onLocalTransportClosedPipe = onClosedPipe;
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			activeProviderTurns.delete(token);
			uninstallProcessHooksIfIdle();
		},
	};
}

export function installCursorSdkSessionProcessErrorGuard(): CursorSdkSessionProcessErrorGuard {
	const token: CursorSdkSessionProcessErrorGuardToken = {};
	activeSessions.add(token);
	installProcessHooks();
	let disposed = false;
	return {
		dispose(): void {
			if (disposed) return;
			disposed = true;
			activeSessions.delete(token);
			uninstallProcessHooksIfIdle();
		},
	};
}

export function registerCursorSdkSessionProcessErrorGuard(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("session_start", () => {
		activeLifecycleSessionGuard?.dispose();
		activeLifecycleSessionGuard = installCursorSdkSessionProcessErrorGuard();
	});
	pi.on("session_shutdown", () => {
		activeLifecycleSessionGuard?.dispose();
		activeLifecycleSessionGuard = undefined;
	});
}
