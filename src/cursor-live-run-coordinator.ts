import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import { getCursorConversationMessages } from "./cursor-pi-context.js";
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
import type { CursorNativeToolDisplayItem, CursorNativeToolDisplayState } from "./cursor-native-tool-display-state.js";
import type { CursorPiBridgeToolRequest, CursorPiToolBridgeRun } from "./cursor-pi-tool-bridge.js";
import type { CursorRunOutcome } from "./cursor-provider-run-outcome.js";
import type { CursorSessionAgentResumePublication } from "./cursor-session-agent-resume.js";
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
	| { type: "text-completed" }
	| { type: "tool"; tool: CursorNativeToolDisplayItem }
	| { type: "bridge-tool"; request: CursorPiBridgeToolRequest };

export interface CursorLiveSdkRun {
	cancel(): Promise<void>;
}

/** Terminal facts replay needs from `CursorRunOutcome`; a thrown `wait()` has no RunResult to keep. */
export type CursorLiveRunSettledOutcome =
	| Pick<Extract<CursorRunOutcome, { kind: "finished" }>, "kind" | "finalText">
	| Pick<Extract<CursorRunOutcome, { kind: "cancelled" }>, "kind" | "abortMessage">
	| Pick<Extract<CursorRunOutcome, { kind: "error" }>, "kind" | "errorMessage">;

export type CursorLiveRunOutcome = { kind: "running" } | CursorLiveRunSettledOutcome;

/** Independent of the SDK outcome: a finished run stays open while its queued replay drains. */
export type CursorLiveRunResources =
	| { kind: "open" }
	| { kind: "releasing"; completion: Promise<void> }
	| { kind: "released"; result: PromiseSettledResult<void> };

export interface CursorLiveRun {
	id: string;
	agent: SDKAgent;
	/** Effective ordinary main-loop policy captured when this SDK run was created. */
	nativeToolsEnabled?: boolean;
	bridgeRun?: CursorPiToolBridgeRun;
	sessionBridgeRun?: CursorPiToolBridgeRun;
	sessionAgentScopeKey: string;
	sdkRun?: CursorLiveSdkRun;
	ignoreFutureSdkTurnUsage?: boolean;
	accounting: CursorLiveRunAccountingState;
	onAbandon?: () => Promise<void>;
	pendingEvents: CursorLiveQueuedEvent[];
	textDeltas: string[];
	emittedText: string;
	recordedToolDisplayIds: string[];
	resumeNotice?: string;
	/** Committed at SDK completion; only terminal deliveries publish it, which chained or disposed runs never reach. */
	resumePublication?: CursorSessionAgentResumePublication;
	/** Written only by the coordinator's `settle()`; `release()` owns `resources`. */
	outcome: CursorLiveRunOutcome;
	resources: CursorLiveRunResources;
	chainUserInputAfterCompletion: boolean;
	debugRecorder?: CursorSdkEventDebugRecorder;
	nativeDisplay?: CursorNativeToolDisplayState;
}

export interface CursorLiveRunCreateParams {
	id: string;
	agent: SDKAgent;
	/** Effective ordinary main-loop policy captured when this SDK run was created. */
	nativeToolsEnabled?: boolean;
	bridgeRun?: CursorPiToolBridgeRun;
	sessionBridgeRun?: CursorPiToolBridgeRun;
	sessionAgentScopeKey?: string;
	promptInputTokens: number;
	textDeltas?: string[];
	debugRecorder?: CursorSdkEventDebugRecorder;
	nativeDisplay?: CursorNativeToolDisplayState;
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
	settle(run: CursorLiveRun, outcome: CursorLiveRunSettledOutcome): void;
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
	getPendingFromContext(context: Context, getReplayId: CursorReplayIdResolver, scopeKey: string): CursorLiveRun | undefined;
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
	pendingCallUnsubscribers?: Array<() => void>;
	leased: boolean;
	leaseQueue: LeaseWaiter[];
}

export function hasTrailingUserMessagesAfterToolResults(context: Context): boolean {
	const messages = getCursorConversationMessages(context);
	let index = messages.length - 1;
	let sawTrailingUser = false;
	while (index >= 0 && messages[index]?.role === "user") {
		sawTrailingUser = true;
		index -= 1;
	}
	if (!sawTrailingUser) return false;

	let sawToolResult = false;
	while (index >= 0 && messages[index]?.role === "toolResult") {
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

	function getOpen(runId: string | undefined): CursorLiveRun | undefined {
		if (!runId) return undefined;
		const run = pendingRuns.get(runId);
		if (!run || run.resources.kind !== "open") return undefined;
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
		if (state.idleDisposeRequested && run.resources.kind === "open") {
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

	/** Enters `releasing` before any cleanup side effect so every caller shares one completion. */
	function beginRelease(run: CursorLiveRun): Promise<void> {
		const completion = Promise.withResolvers<void>();
		run.resources = { kind: "releasing", completion: completion.promise };
		void releaseResources(run, run.outcome).then(
			() => {
				run.resources = { kind: "released", result: { status: "fulfilled", value: undefined } };
				completion.resolve();
			},
			(reason: unknown) => {
				run.resources = { kind: "released", result: { status: "rejected", reason } };
				completion.reject(reason);
			},
		);
		return completion.promise;
	}

	async function releaseResources(run: CursorLiveRun, outcome: CursorLiveRunOutcome): Promise<void> {
		const state = getPrivateState(run);
		for (const unsubscribe of state.pendingCallUnsubscribers ?? []) {
			try { unsubscribe(); } catch {
				// Cleanup continues even if an observer cannot detach.
			}
		}
		state.pendingCallUnsubscribers = [];
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
		switch (outcome.kind) {
			case "finished":
				// The pooled agent stays reusable after a successful run.
				return;
			case "running": {
				const usageCompletion = run.onAbandon?.();
				try {
					await cancelCursorLiveSdkRun(run);
				} catch {
					// cancellation failure should not block session-agent abandonment
				}
				await usageCompletion;
				break;
			}
			case "cancelled":
			case "error":
				break;
			default: {
				const _exhaustive: never = outcome;
				return _exhaustive;
			}
		}
		await deps.abandonSessionAgent(run.sessionAgentScopeKey);
	}

	const coordinator: CursorLiveRunCoordinator = {
		start(params): CursorLiveRun {
			const sessionAgentScopeKey = params.sessionAgentScopeKey ?? getScopeKey();
			const run: CursorLiveRun = {
				id: params.id,
				agent: params.agent,
				nativeToolsEnabled: params.nativeToolsEnabled !== false,
				bridgeRun: params.bridgeRun,
				sessionBridgeRun: params.sessionBridgeRun,
				sessionAgentScopeKey,
				nativeDisplay: params.nativeDisplay,
				accounting: createCursorLiveRunAccountingState(params.promptInputTokens),
				pendingEvents: [],
				textDeltas: params.textDeltas ?? [],
				emittedText: "",
				recordedToolDisplayIds: [],
				outcome: { kind: "running" },
				resources: { kind: "open" },
				chainUserInputAfterCompletion: false,
				debugRecorder: params.debugRecorder,
			};
			privateStates.set(run, {
				waiters: new Set(),
				idleDisposeRequested: false,
				leased: false,
				leaseQueue: [],
			});
			const state = getPrivateState(run);
			state.pendingCallUnsubscribers = [...new Set([run.bridgeRun, run.sessionBridgeRun])].flatMap((bridge) =>
				bridge ? [bridge.onPendingToolCallsChanged(() => {
					if (state.idleDisposeRequested || state.idleDisposeTimer) coordinator.requestIdleDispose(run);
				})] : [],
			);
			pendingRuns.set(run.id, run);
			pendingRunIdsByScopeKey.set(sessionAgentScopeKey, run.id);
			return run;
		},

		attachSdkRun(run, sdkRun): void {
			if (run.resources.kind !== "open") return;
			run.sdkRun = sdkRun;
		},

		settle(run, outcome): void {
			// Release already fixed this run's disposition; a later SDK outcome cannot change it.
			if (run.resources.kind !== "open") return;
			run.outcome = outcome;
			notifyProgress(run);
			coordinator.requestIdleDispose(run);
		},

		recordSdkTurnEnded(run, usage): void {
			if (run.resources.kind !== "open") return;
			if (run.ignoreFutureSdkTurnUsage) {
				run.accounting = { ...run.accounting, sdkTurnEnded: false, sdkTurnUsage: undefined };
				notifyProgress(run);
				return;
			}
			run.accounting = recordCursorLiveSdkTurnEnded(run.accounting, usage);
			notifyProgress(run);
		},

		ignoreFutureSdkTurnUsage(run): void {
			if (run.resources.kind === "open") run.ignoreFutureSdkTurnUsage = true;
		},

		hasSdkTurnEnded(run): boolean {
			return run.accounting.sdkTurnEnded;
		},

		queueEvent(run, event): void {
			if (run.resources.kind !== "open") return;
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

		getPendingFromContext(context, getReplayId, scopeKey): CursorLiveRun | undefined {
			const run = getOpen(pendingRunIdsByScopeKey.get(scopeKey));
			if (!run) return undefined;
			const messages = getCursorConversationMessages(context);
			let index = messages.length - 1;
			while (index >= 0 && messages[index]?.role === "user") {
				index -= 1;
			}

			for (; index >= 0; index -= 1) {
				const message = messages[index];
				if (message.role !== "toolResult") break;
				if (matchesCursorLiveRunToolResult(run, message, getReplayId)) return run;
			}
			return undefined;
		},

		getActiveForScope(scopeKey = getScopeKey()): CursorLiveRun | undefined {
			return getOpen(pendingRunIdsByScopeKey.get(scopeKey));
		},

		isReady(run): boolean {
			return run.resources.kind !== "open" || run.pendingEvents.length > 0 || run.outcome.kind !== "running";
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
			if (run.resources.kind !== "open") return;
			const state = getPrivateState(run);
			clearIdleDisposeTimer(run);
			state.idleDisposeRequested = true;
			if (state.leased || state.leaseQueue.length > 0 ||
				[run.bridgeRun, run.sessionBridgeRun].some((bridge) => bridge?.hasPendingToolCalls())) return;
			state.idleDisposeTimer = setTimeout(() => {
				state.idleDisposeTimer = undefined;
				if (state.leased || state.leaseQueue.length > 0 ||
					[run.bridgeRun, run.sessionBridgeRun].some((bridge) => bridge?.hasPendingToolCalls())) {
					coordinator.requestIdleDispose(run);
					return;
				}
				void coordinator.release(run).catch(() => {
					// Idle dispose must not leave release failures as unhandled rejections.
				});
			}, deps.getIdleDisposeMs());
			state.idleDisposeTimer.unref?.();
		},

		release(run): Promise<void> {
			switch (run.resources.kind) {
				case "open":
					return beginRelease(run);
				case "releasing":
					return run.resources.completion;
				case "released": {
					const { result } = run.resources;
					return result.status === "fulfilled" ? Promise.resolve() : Promise.reject(result.reason);
				}
			}
		},

		count(): number {
			return pendingRuns.size;
		},
	};

	return coordinator;
}
