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
	accounting: CursorLiveRunAccountingState;
	onAbandon?: () => Promise<void>;
	pendingEvents: CursorLiveQueuedEvent[];
	/** Bridge `piToolCallId`s queued by this run, retained after MCP delivery settles pending state. */
	issuedBridgeToolCallIds: Set<string>;
	textDeltas: string[];
	emittedText: string;
	recordedToolDisplayIds: string[];
	resumeNotice?: string;
	/** Committed at SDK completion; only terminal deliveries publish it, which replaced or released runs never reach. */
	resumePublication?: CursorSessionAgentResumePublication;
	/** Written only by the coordinator's `settle()`; `release()` owns `resources`. */
	outcome: CursorLiveRunOutcome;
	resources: CursorLiveRunResources;
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

/** Starts the body only if the run is open after acquisition. Release during the body does not interrupt it. */
export type CursorLiveRunLeaseResult<T> = { kind: "leased"; value: T } | { kind: "released" };

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
	hasUntakenSdkTurnObservation(run: CursorLiveRun): boolean;
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
	withRunLease<T>(run: CursorLiveRun, signal: AbortSignal | undefined, body: () => Promise<T>): Promise<CursorLiveRunLeaseResult<T>>;
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
	readonly issuedBridgeToolCallIds?: ReadonlySet<string>;
	sessionAgentScopeKey?: string;
}

type CursorReplayIdResolver = (toolCallId: string) => string | undefined;

interface ProgressWaiter {
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

/** Callers queue only behind a held lease; each grant hands the lease to the next caller in FIFO order. */
interface HeldCursorLiveRunLease {
	kind: "held";
	queue: Array<() => void>;
}

/** Expiry stays requested while a lease or pending bridge call keeps the run busy, then arms one full window. */
type CursorLiveRunIdleExpiry =
	| { kind: "none" }
	| { kind: "requested" }
	| { kind: "armed"; timer: ReturnType<typeof setTimeout> };

interface CursorLiveRunPrivateState {
	waiters: Set<ProgressWaiter>;
	pendingCallUnsubscribers?: Array<() => void>;
	lease: { kind: "free" } | HeldCursorLiveRunLease;
	idle: CursorLiveRunIdleExpiry;
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
	return run.issuedBridgeToolCallIds?.has(message.toolCallId)
		|| (run.bridgeRun?.hasPendingPiToolCallId(message.toolCallId) ?? false);
}

export function createCursorLiveRunCoordinator(deps: CursorLiveRunCoordinatorDeps): CursorLiveRunCoordinator {
	const pendingRuns = new Map<string, CursorLiveRun>();
	const pendingRunIdsByScopeKey = new Map<string, string>();
	const privateStates = new WeakMap<CursorLiveRun, CursorLiveRunPrivateState>();
	const getScopeKey = deps.getScopeKey ?? getCursorSessionScopeKey;

	function getPrivateState(run: CursorLiveRun): CursorLiveRunPrivateState {
		let state = privateStates.get(run);
		if (!state) {
			state = { waiters: new Set(), lease: { kind: "free" }, idle: { kind: "none" } };
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

	function isIdleExpiryEligible(run: CursorLiveRun, state: CursorLiveRunPrivateState): boolean {
		return state.lease.kind === "free" && ![run.bridgeRun, run.sessionBridgeRun].some((bridge) => bridge?.hasPendingToolCalls());
	}

	/** Every idle transition goes through here, so leaving `armed` always cancels its timer. */
	function setIdleExpiry(state: CursorLiveRunPrivateState, idle: CursorLiveRunIdleExpiry): void {
		if (state.idle.kind === "armed") clearTimeout(state.idle.timer);
		state.idle = idle;
	}

	function startIdleExpiryTimer(run: CursorLiveRun, state: CursorLiveRunPrivateState): ReturnType<typeof setTimeout> {
		const timer = setTimeout(() => {
			// Bridge calls can become pending without a change notification; recheck before expiring.
			if (!isIdleExpiryEligible(run, state)) {
				setIdleExpiry(state, { kind: "requested" });
				return;
			}
			void coordinator.release(run).catch(() => {
				// Idle dispose must not leave release failures as unhandled rejections.
			});
		}, deps.getIdleDisposeMs());
		timer.unref?.();
		return timer;
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

	async function acquireLease(state: CursorLiveRunPrivateState, signal?: AbortSignal): Promise<HeldCursorLiveRunLease> {
		if (signal?.aborted) throw new CursorLiveRunAbortError();
		if (state.lease.kind === "free") {
			const lease: HeldCursorLiveRunLease = { kind: "held", queue: [] };
			state.lease = lease;
			return lease;
		}

		const lease = state.lease;
		await new Promise<void>((resolve, reject) => {
			const grant = (): void => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = (): void => {
				const index = lease.queue.indexOf(grant);
				if (index >= 0) lease.queue.splice(index, 1);
				reject(new CursorLiveRunAbortError());
			};
			lease.queue.push(grant);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		return lease;
	}

	/** Hands the lease to the next queued caller, or frees it and arms a deferred idle request. */
	function passLease(run: CursorLiveRun, state: CursorLiveRunPrivateState, lease: HeldCursorLiveRunLease): void {
		const grant = lease.queue.shift();
		if (grant) {
			grant();
			return;
		}
		state.lease = { kind: "free" };
		if (state.idle.kind === "requested") coordinator.requestIdleDispose(run);
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
		setIdleExpiry(state, { kind: "none" });
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
				issuedBridgeToolCallIds: new Set(),
				textDeltas: params.textDeltas ?? [],
				emittedText: "",
				recordedToolDisplayIds: [],
				outcome: { kind: "running" },
				resources: { kind: "open" },
				debugRecorder: params.debugRecorder,
			};
			const state = getPrivateState(run);
			state.pendingCallUnsubscribers = [...new Set([run.bridgeRun, run.sessionBridgeRun])].flatMap((bridge) =>
				bridge ? [bridge.onPendingToolCallsChanged(() => {
					if (state.idle.kind !== "none") coordinator.requestIdleDispose(run);
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
			run.accounting = recordCursorLiveSdkTurnEnded(run.accounting, usage);
			notifyProgress(run);
		},

		hasUntakenSdkTurnObservation(run): boolean {
			return run.accounting.sdkTurnUsage.kind === "available";
		},

		queueEvent(run, event): void {
			if (run.resources.kind !== "open") return;
			if (event.type === "bridge-tool") run.issuedBridgeToolCallIds.add(event.request.piToolCallId);
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
			return taken.usage;
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

		async withRunLease<T>(run: CursorLiveRun, signal: AbortSignal | undefined, body: () => Promise<T>): Promise<CursorLiveRunLeaseResult<T>> {
			const state = getPrivateState(run);
			const lease = await acquireLease(state, signal);
			// Holding the lease defers expiry; passing it back rearms a full window.
			if (state.idle.kind === "armed") setIdleExpiry(state, { kind: "requested" });
			try {
				if (signal?.aborted) throw new CursorLiveRunAbortError();
				// The previous holder can release the run while this caller is queued.
				if (run.resources.kind !== "open") return { kind: "released" };
				return { kind: "leased", value: await body() };
			} finally {
				passLease(run, state, lease);
			}
		},

		requestIdleDispose(run): void {
			if (run.resources.kind !== "open") return;
			const state = getPrivateState(run);
			setIdleExpiry(state, { kind: "requested" });
			if (isIdleExpiryEligible(run, state)) setIdleExpiry(state, { kind: "armed", timer: startIdleExpiryTimer(run, state) });
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
