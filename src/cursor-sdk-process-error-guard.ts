import { classifyCursorConnectError, isCursorSdkAbortConnectError } from "./cursor-provider-errors.js";

interface CursorSdkProcessErrorGuardToken {
	suppressAbortErrors: boolean;
}

export interface CursorSdkProcessErrorGuard {
	suppressAbortErrors(): void;
	dispose(): void;
}

type GenericProcessEmit = (event: string | symbol, ...args: unknown[]) => boolean;

// The local Cursor SDK can surface some ConnectRPC failures as process-level
// uncaught exceptions/unhandled rejections even when run.wait()/run.cancel() is awaited.
// Keep suppression scoped to active Cursor provider turns and tightly matched SDK shapes.
const activeProviderTurns = new Set<CursorSdkProcessErrorGuardToken>();
let originalProcessEmit: GenericProcessEmit | undefined;
let captureCallbackInstalled = false;

function hasActiveAbortSuppression(): boolean {
	for (const turn of activeProviderTurns) {
		if (turn.suppressAbortErrors) return true;
	}
	return false;
}

function isCursorProvenance(source: string): boolean {
	return source === "cursor-sdk-stack" || source === "cursor-backend-details";
}

function shouldSuppressProcessError(event: string | symbol, args: readonly unknown[]): boolean {
	if (event !== "uncaughtException" && event !== "unhandledRejection") return false;
	const error = args[0];
	const classification = classifyCursorConnectError(error);
	if (!classification) return false;
	if (classification.kind === "abort") return hasActiveAbortSuppression();
	return activeProviderTurns.size > 0 && isCursorProvenance(classification.source);
}

function installProcessEmitPatch(): void {
	if (originalProcessEmit) return;
	originalProcessEmit = process.emit.bind(process) as GenericProcessEmit;
	process.emit = function patchedCursorSdkProcessErrorEmit(this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
		if (shouldSuppressProcessError(event, args)) return true;
		return originalProcessEmit!(event, ...args);
	} as typeof process.emit;
}

function installCaptureCallbackIfAvailable(): void {
	if (captureCallbackInstalled || process.hasUncaughtExceptionCaptureCallback()) return;
	process.setUncaughtExceptionCaptureCallback((error: Error) => {
		if (shouldSuppressProcessError("uncaughtException", [error])) return;
		uninstallCaptureCallbackIfIdle(true);
		if (originalProcessEmit?.("uncaughtException", error)) return;
		throw error;
	});
	captureCallbackInstalled = true;
}

function uninstallCaptureCallbackIfIdle(force = false): void {
	if (!captureCallbackInstalled) return;
	if (!force && activeProviderTurns.size > 0) return;
	process.setUncaughtExceptionCaptureCallback(null);
	captureCallbackInstalled = false;
}

function uninstallProcessEmitPatchIfIdle(): void {
	if (activeProviderTurns.size > 0 || !originalProcessEmit) return;
	uninstallCaptureCallbackIfIdle();
	process.emit = originalProcessEmit as typeof process.emit;
	originalProcessEmit = undefined;
}

export const __testUtils = {
	activeProviderTurnCount: (): number => activeProviderTurns.size,
};

export { isCursorSdkAbortConnectError };

export function installCursorSdkProcessErrorGuard(): CursorSdkProcessErrorGuard {
	installProcessEmitPatch();
	installCaptureCallbackIfAvailable();
	const token: CursorSdkProcessErrorGuardToken = { suppressAbortErrors: false };
	activeProviderTurns.add(token);
	let disposed = false;
	return {
		suppressAbortErrors(): void {
			if (disposed) return;
			token.suppressAbortErrors = true;
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			activeProviderTurns.delete(token);
			uninstallProcessEmitPatchIfIdle();
		},
	};
}
