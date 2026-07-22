import type { Context, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import type { SDKAgent } from "@cursor/sdk";
import {
	consumeCursorLiveToolResults,
	createCursorLiveRunAccountingState,
	recordCursorLiveSdkTurnEnded,
	takeCursorLiveSdkTurnUsage,
	takeCursorLiveTurnInputTokens,
	type CursorLiveRunAccountingState,
	type CursorLiveToolResultConsumption,
} from "./cursor-live-run-accounting.js";
import type { CursorSdkTurnUsage } from "./cursor-usage-accounting.js";
import type { CursorNativeToolDisplayItem } from "./cursor-native-tool-display-state.js";
import type { CursorPiBridgeToolRequest, CursorPiToolBridgeRun } from "./cursor-pi-tool-bridge.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";
import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";
import { installCursorSdkProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";

export class CursorLiveRunAbortError extends Error {
	constructor() {
		super("aborted");
		this.name = "CursorLiveRunAbortError";
	}
}

export type CursorLiveQueuedEvent =
	| { type: "thinking-delta"; text: string }
	| { type: "thinking-completed" }
	| { type: "text-delta"; text: string }
	| { type: "tool"; tool: CursorNativeToolDisplayItem }
	| { type: "bridge-tool"; request: CursorPiBridgeToolRequest };

export interface CursorLiveSdkRun {
	cancel(): Promise<void>;
}

export interface CursorLiveRun {
	id: string;
	agent: SDKAgent;
	bridgeRun?: CursorPiToolBridgeRun;
	sessionBridgeRun?: CursorPiToolBridgeRun;
	sessionAgentScopeKey: string;
	sdkRun?: CursorLiveSdkRun;
	ignoreFutureSdkTurnUsage?: boolean;
	accounting: CursorLiveRunAccountingState;
	pendingEvents: CursorLiveQueuedEvent[];
	textDeltas: string[];
	emittedText: string;
	recordedToolDisplayIds: string[];
	finalText?: string;
	resumeNotice?: string;
	done: boolean;
	cancelled: boolean;
	disposed: boolean;
	errorMessage?: string;
	abortMessage?: string;
	chainUserInputAfterCompletion: boolean;
	debugRecorder?: CursorSdkEventDebugRecorder;
}

export interface CursorLiveRunCreateParams {
	id: string;
	agent: SDKAgent;
	bridgeRun?: CursorPiToolBridgeRun;
	sessionBridgeRun?: CursorPiToolBridgeRun;
	sessionAgentScopeKey?: string;
	promptInputTokens: number;
	textDeltas?: string[];
	debugRecorder?: CursorSdkEventDebugRecorder;
}

export interface CursorLiveRunCoordinatorDeps {
	getScopeKey?: () => string;
	getIdleDisposeMs: () => number;
	deleteNativeToolDisplay: (id: string) => void;
	abandonSessionAgent: (scopeKey: string | undefined) => Promise<void>;
}

export interface CursorLiveRunCoordinator {
	start(params: CursorLiveRunCreateParams): CursorLiveRun;
	attachSdkRun(run: CursorLiveRun, sdkRun: CursorLiveSdkRun): void;
	markFinished(run: CursorLiveRun, finalText: string): void;
	markCancelled(run: CursorLiveRun, abortMessage?: string): void;
	markError(run: CursorLiveRun, errorMessage: string): void;
	recordSdkTurnEnded(run: CursorLiveRun, usage?: CursorSdkTurnUsage): void;
	ignoreFutureSdkTurnUsage(run: CursorLiveRun): void;
	hasSdkTurnEnded(run: CursorLiveRun): boolean;
	queueEvent(run: CursorLiveRun, event: CursorLiveQueuedEvent): void;
	peekEvent(run: CursorLiveRun): CursorLiveQueuedEvent | undefined;
	shiftEvent(run: CursorLiveRun): CursorLiveQueuedEvent | undefined;
	collectNativeToolBatch(run: CursorLiveRun): CursorNativeToolDisplayItem[];
	collectBridgeToolBatch(run: CursorLiveRun): CursorPiBridgeToolRequest[];
	consumeToolResults(run: CursorLiveRun, context: Context, getReplayId: CursorReplayIdResolver): CursorLiveToolResultConsumption;
	takeTurnInputTokens(run: CursorLiveRun, toolResultInputTokens: number): number;
	takeSdkTurnUsage(run: CursorLiveRun): CursorSdkTurnUsage | undefined;
	getPendingFromContext(context: Context, getReplayId: CursorReplayIdResolver): CursorLiveRun | undefined;
	getActiveForScope(scopeKey?: string): CursorLiveRun | undefined;
	isReady(run: CursorLiveRun): boolean;
	waitForProgress(run: CursorLiveRun, signal?: AbortSignal): Promise<void>;
	withRunLease<T>(run: CursorLiveRun, signal: AbortSignal | undefined, body: () => Promise<T>): Promise<T>;
	requestIdleDispose(run: CursorLiveRun): void;
	release(run: CursorLiveRun): Promise<void>;
	count(): number;
}

type CursorLiveBridgeMatcher = Pick<CursorPiToolBridgeRun, "hasPendingPiToolCallId">;

function isPendingBridgeToolRequest(run: CursorLiveRun, request: CursorPiBridgeToolRequest): boolean {
	const bridgeRun = [run.bridgeRun, run.sessionBridgeRun].find((candidate) => candidate?.id === request.runId);
	return bridgeRun?.hasPendingPiToolCallId(request.piToolCallId) === true;
}

export interface CursorLiveRunRecord {
	id: string;
	disposed: boolean;
	bridgeRun?: CursorLiveBridgeMatcher;
	sessionAgentScopeKey?: string;
}

type CursorReplayIdResolver = (toolCallId: string) => string | undefined;

interface ProgressWaiter {
	resolve: () => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface LeaseWaiter {
	resolve: () => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

async function cancelCursorLiveSdkRun(run: CursorLiveRun): Promise<void> {
	if (!run.sdkRun) return;
	const guard = installCursorSdkProcessErrorGuard();
	guard.suppressAbortErrors();
	try {
		await run.sdkRun.cancel();
	} finally {
		guard.dispose();
	}
}

interface CursorLiveRunPrivateState {
	waiters: Set<ProgressWaiter>;
	idleDisposeTimer?: ReturnType<typeof setTimeout>;
	idleDisposeRequested: boolean;
	leased: boolean;
	leaseQueue: LeaseWaiter[];
	releasing?: Promise<void>;
}

export function hasTrailingUserMessagesAfterToolResults(context: Context): boolean {
	let index = context.messages.length - 1;
	let sawTrailingUser = false;
	while (index >= 0 && context.messages[index]?.role === "user") {
		sawTrailingUser = true;
		index -= 1;
	}
	if (!sawTrailingUser) return false;

	let sawToolResult = false;
	while (index >= 0 && context.messages[index]?.role === "toolResult") {
		sawToolResult = true;
		index -= 1;
	}
	return sawToolResult;
}

export function matchesCursorLiveRunToolResult(
	run: CursorLiveRunRecord,
	message: ToolResultMessage,
	getReplayId: CursorReplayIdResolver,
): boolean {
	const replayId = getReplayId(message.toolCallId);
	if (replayId) return replayId === run.id;
	return run.bridgeRun?.hasPendingPiToolCallId(message.toolCallId) ?? false;
}

function isSuccessfulCursorLiveRun(run: CursorLiveRun): boolean {
	return run.done && !run.cancelled && !run.errorMessage;
}

export function createCursorLiveRunCoordinator(deps: CursorLiveRunCoordinatorDeps): CursorLiveRunCoordinator {
	const pendingRuns = new Map<string, CursorLiveRun>();
	const pendingRunIdsByScopeKey = new Map<string, string>();
	const privateStates = new WeakMap<CursorLiveRun, CursorLiveRunPrivateState>();
	const getScopeKey = deps.getScopeKey ?? getCursorSessionScopeKey;

	function getPrivateState(run: CursorLiveRun): CursorLiveRunPrivateState {
		let state = privateStates.get(run);
		if (!state) {
			state = {
				waiters: new Set(),
				idleDisposeRequested: false,
				leased: false,
				leaseQueue: [],
			};
			privateStates.set(run, state);
		}
		return state;
	}

	function getUndisposed(runId: string | undefined): CursorLiveRun | undefined {
		if (!runId) return undefined;
		const run = pendingRuns.get(runId);
		if (!run || run.disposed) return undefined;
		return run;
	}

	function clearIdleDisposeTimer(run: CursorLiveRun): void {
		const state = getPrivateState(run);
		if (!state.idleDisposeTimer) return;
		clearTimeout(state.idleDisposeTimer);
		state.idleDisposeTimer = undefined;
	}

	function notifyProgress(run: CursorLiveRun): void {
		const state = getPrivateState(run);
		const waiters = [...state.waiters];
		state.waiters.clear();
		for (const waiter of waiters) {
			if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
			waiter.resolve();
		}
	}

	function removeLeaseWaiter(state: CursorLiveRunPrivateState, waiter: LeaseWaiter): void {
		const index = state.leaseQueue.indexOf(waiter);
		if (index >= 0) state.leaseQueue.splice(index, 1);
	}

	function grantNextLeaseOrUnlock(run: CursorLiveRun): void {
		const state = getPrivateState(run);
		while (state.leaseQueue.length > 0) {
			const next = state.leaseQueue.shift();
			if (!next) continue;
			if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort);
			next.resolve();
			return;
		}
		state.leased = false;
		if (state.idleDisposeRequested && !run.disposed) {
			coordinator.requestIdleDispose(run);
		}
	}

	async function acquireLease(run: CursorLiveRun, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new CursorLiveRunAbortError();
		const state = getPrivateState(run);
		if (!state.leased) {
			state.leased = true;
			return;
		}

		await new Promise<void>((resolve, reject) => {
			const waiter: LeaseWaiter = { resolve, reject, signal };
			const onAbort = (): void => {
				removeLeaseWaiter(state, waiter);
				reject(new CursorLiveRunAbortError());
			};
			waiter.onAbort = onAbort;
			state.leaseQueue.push(waiter);
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	function unregister(run: CursorLiveRun): void {
		pendingRuns.delete(run.id);
		const scopeKey = run.sessionAgentScopeKey;
		if (pendingRunIdsByScopeKey.get(scopeKey) === run.id) {
			pendingRunIdsByScopeKey.delete(scopeKey);
		}
	}

	const coordinator: CursorLiveRunCoordinator = {
		start(params): CursorLiveRun {
			const sessionAgentScopeKey = params.sessionAgentScopeKey ?? getScopeKey();
			const run: CursorLiveRun = {
				id: params.id,
				agent: params.agent,
				bridgeRun: params.bridgeRun,
				sessionBridgeRun: params.sessionBridgeRun,
				sessionAgentScopeKey,
				accounting: createCursorLiveRunAccountingState(params.promptInputTokens),
				pendingEvents: [],
				textDeltas: params.textDeltas ?? [],
				emittedText: "",
				recordedToolDisplayIds: [],
				done: false,
				cancelled: false,
				disposed: false,
				chainUserInputAfterCompletion: false,
				debugRecorder: params.debugRecorder,
			};
			privateStates.set(run, {
				waiters: new Set(),
				idleDisposeRequested: false,
				leased: false,
				leaseQueue: [],
			});
			pendingRuns.set(run.id, run);
			pendingRunIdsByScopeKey.set(sessionAgentScopeKey, run.id);
			return run;
		},

		attachSdkRun(run, sdkRun): void {
			if (run.disposed) return;
			run.sdkRun = sdkRun;
		},

		markFinished(run, finalText): void {
			if (run.disposed) return;
			run.finalText = finalText;
			run.cancelled = false;
			run.done = true;
			notifyProgress(run);
			coordinator.requestIdleDispose(run);
		},

		markCancelled(run, abortMessage): void {
			if (run.disposed) return;
			run.cancelled = true;
			run.abortMessage = abortMessage;
			run.done = true;
			notifyProgress(run);
			coordinator.requestIdleDispose(run);
		},

		markError(run, errorMessage): void {
			if (run.disposed) return;
			run.errorMessage = errorMessage;
			run.done = true;
			notifyProgress(run);
			coordinator.requestIdleDispose(run);
		},

		recordSdkTurnEnded(run, usage): void {
			if (run.disposed) return;
			if (run.ignoreFutureSdkTurnUsage) {
				run.accounting = { ...run.accounting, sdkTurnEnded: false, sdkTurnUsage: undefined };
				notifyProgress(run);
				return;
			}
			run.accounting = recordCursorLiveSdkTurnEnded(run.accounting, usage);
			notifyProgress(run);
		},

		ignoreFutureSdkTurnUsage(run): void {
			if (!run.disposed) run.ignoreFutureSdkTurnUsage = true;
		},

		hasSdkTurnEnded(run): boolean {
			return run.accounting.sdkTurnEnded;
		},

		queueEvent(run, event): void {
			if (run.disposed) return;
			run.pendingEvents.push(event);
			run.debugRecorder?.recordLiveRunEvent(event);
			notifyProgress(run);
		},

		peekEvent(run): CursorLiveQueuedEvent | undefined {
			return run.pendingEvents[0];
		},

		shiftEvent(run): CursorLiveQueuedEvent | undefined {
			return run.pendingEvents.shift();
		},

		collectNativeToolBatch(run): CursorNativeToolDisplayItem[] {
			const tools: CursorNativeToolDisplayItem[] = [];
			while (run.pendingEvents[0]?.type === "tool") {
				const event = run.pendingEvents.shift();
				if (event?.type === "tool") tools.push(event.tool);
			}
			return tools;
		},

		collectBridgeToolBatch(run): CursorPiBridgeToolRequest[] {
			const requests: CursorPiBridgeToolRequest[] = [];
			while (run.pendingEvents[0]?.type === "bridge-tool") {
				const event = run.pendingEvents.shift();
				if (event?.type === "bridge-tool" && isPendingBridgeToolRequest(run, event.request)) {
					requests.push(event.request);
				}
			}
			return requests;
		},

		consumeToolResults(run, context, getReplayId): CursorLiveToolResultConsumption {
			const consumed = consumeCursorLiveToolResults(run.accounting, context, (toolResult) =>
				matchesCursorLiveRunToolResult(run, toolResult, getReplayId),
			);
			run.accounting = consumed.state;
			return consumed;
		},

		takeTurnInputTokens(run, toolResultInputTokens): number {
			const taken = takeCursorLiveTurnInputTokens(run.accounting, toolResultInputTokens);
			run.accounting = taken.state;
			return taken.sessionInputTokens;
		},

		takeSdkTurnUsage(run): CursorSdkTurnUsage | undefined {
			const taken = takeCursorLiveSdkTurnUsage(run.accounting);
			run.accounting = taken.state;
			return taken.sdkTurnUsage;
		},

		getPendingFromContext(context, getReplayId): CursorLiveRun | undefined {
			let index = context.messages.length - 1;
			while (index >= 0 && context.messages[index]?.role === "user") {
				index -= 1;
			}

			for (; index >= 0; index -= 1) {
				const message = context.messages[index];
				if (message.role !== "toolResult") break;
				const replayId = getReplayId(message.toolCallId);
				if (replayId) {
					const replayRun = getUndisposed(replayId);
					if (replayRun) return replayRun;
				}
				for (const run of pendingRuns.values()) {
					if (run.disposed) continue;
					if (run.bridgeRun?.hasPendingPiToolCallId(message.toolCallId)) return run;
				}
			}
			return undefined;
		},

		getActiveForScope(scopeKey = getScopeKey()): CursorLiveRun | undefined {
			return getUndisposed(pendingRunIdsByScopeKey.get(scopeKey));
		},

		isReady(run): boolean {
			return run.disposed || run.pendingEvents.length > 0 || run.done || run.cancelled || run.errorMessage !== undefined;
		},

		async waitForProgress(run, signal): Promise<void> {
			if (signal?.aborted) throw new CursorLiveRunAbortError();
			if (coordinator.isReady(run)) return;
			await new Promise<void>((resolve, reject) => {
				const state = getPrivateState(run);
				const waiter: ProgressWaiter = { resolve, reject, signal };
				const cleanup = (): void => {
					state.waiters.delete(waiter);
					if (waiter.onAbort) signal?.removeEventListener("abort", waiter.onAbort);
				};
				const onAbort = (): void => {
					cleanup();
					reject(new CursorLiveRunAbortError());
				};
				waiter.onAbort = onAbort;
				waiter.resolve = () => {
					cleanup();
					resolve();
				};
				state.waiters.add(waiter);
				if (signal?.aborted) {
					onAbort();
					return;
				}
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		},

		async withRunLease(run, signal, body): Promise<Awaited<ReturnType<typeof body>>> {
			await acquireLease(run, signal);
			clearIdleDisposeTimer(run);
			try {
				if (signal?.aborted) throw new CursorLiveRunAbortError();
				return await body();
			} finally {
				grantNextLeaseOrUnlock(run);
			}
		},

		requestIdleDispose(run): void {
			if (run.disposed) return;
			const state = getPrivateState(run);
			clearIdleDisposeTimer(run);
			state.idleDisposeRequested = true;
			if (state.leased || state.leaseQueue.length > 0) return;
			state.idleDisposeRequested = false;
			state.idleDisposeTimer = setTimeout(() => {
				void coordinator.release(run).catch(() => {
					// Idle dispose must not leave release failures as unhandled rejections.
				});
			}, deps.getIdleDisposeMs());
			state.idleDisposeTimer.unref?.();
		},

		async release(run): Promise<void> {
			const state = getPrivateState(run);
			if (state.releasing) return state.releasing;
			state.releasing = (async () => {
				if (run.disposed) return;
				const abandoned = !isSuccessfulCursorLiveRun(run);
				run.disposed = true;
				unregister(run);
				clearIdleDisposeTimer(run);
				state.idleDisposeRequested = false;
				notifyProgress(run);
				run.bridgeRun?.cancel("Cursor live run released");
				for (const toolDisplayId of run.recordedToolDisplayIds) deps.deleteNativeToolDisplay(toolDisplayId);
				run.recordedToolDisplayIds = [];
				if (run.sessionBridgeRun) {
					run.sessionBridgeRun.setOnToolRequest(undefined);
				}
				if (run.bridgeRun && run.bridgeRun !== run.sessionBridgeRun) {
					try {
						await run.bridgeRun.dispose();
					} catch {
						// bridge disposal failure should not mask the provider result
					}
				}
				if (abandoned) {
					if (!run.done) {
						try {
							await cancelCursorLiveSdkRun(run);
						} catch {
							// cancellation failure should not block session-agent abandonment
						}
					}
					await deps.abandonSessionAgent(run.sessionAgentScopeKey);
				}
			})();
			return state.releasing;
		},

		count(): number {
			return pendingRuns.size;
		},
	};

	return coordinator;
}
