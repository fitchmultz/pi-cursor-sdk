import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { InteractionUpdate } from "@cursor/sdk";
import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { truncateCursorDisplayLine } from "./cursor-display-text.js";
import {
	recordDiscardedIncompleteStartedToolCall,
	type CursorSdkEventDebugRecorder,
} from "./cursor-sdk-event-debug.js";
import {
	buildIncompleteCursorToolRunOutcome,
	resolveIncompleteCursorToolVisibility,
	type IncompleteCursorToolRunOutcome,
} from "./cursor-incomplete-tool-visibility.js";
import { getToolName } from "./cursor-transcript-utils.js";
import { getNormalizedCursorToolName } from "./cursor-tool-visibility.js";
import { buildCursorPiToolDisplay } from "./cursor-tool-transcript.js";
import { getField } from "./cursor-record-utils.js";
import { readCursorTaskMetadata } from "./cursor-task-presentation.js";
import { mirrorCursorActivityTool } from "./cursor-todo-mirror.js";
import { getToolArgs, getToolResult, normalizeResult } from "./cursor-transcript-utils.js";
import { CursorTurnDisplayRouter } from "./cursor-provider-turn-display-router.js";
import {
	createTurnCoordinatorContentEmitter,
	CursorToolLifecycleEmitter,
} from "./cursor-provider-turn-lifecycle-emitter.js";
import { resolveCursorToolCompletion } from "./cursor-provider-turn-sdk-normalizer.js";
import {
	CursorShellOutputTracker,
	formatCursorShellOutputProgressText,
	getCursorShellOutputDelta,
	isCursorShellToolCall,
} from "./cursor-provider-turn-shell-output.js";
import {
	CursorToolCompletionLedger,
	getToolFingerprint,
} from "./cursor-provider-turn-tool-ledger.js";
import { readCursorSdkTurnUsageFromUpdate, type CursorSdkTurnUsage } from "./cursor-usage-accounting.js";

export interface CursorSdkTurnCoordinatorOptions {
	stream: AssistantMessageEventStream;
	partial: AssistantMessage;
	cwd: string;
	resolvedApiKey?: string;
	liveRun?: CursorLiveRun;
	useNativeToolReplay: boolean;
	activeToolNames?: ReadonlySet<string>;
	nativeReplayId: string;
	textDeltas: string[];
	debugRecorder?: CursorSdkEventDebugRecorder;
}

export class CursorSdkTurnCoordinator {
	readonly stream: AssistantMessageEventStream;
	readonly partial: AssistantMessage;
	readonly cwd: string;
	readonly resolvedApiKey?: string;
	readonly liveRun?: CursorLiveRun;
	readonly useNativeToolReplay: boolean;
	readonly activeToolNames?: ReadonlySet<string>;
	readonly nativeReplayId: string;
	readonly textDeltas: string[];

	private readonly debugRecorder?: CursorSdkEventDebugRecorder;
	private readonly ledger = new CursorToolCompletionLedger();
	private readonly shellOutput = new CursorShellOutputTracker();
	private readonly displayRouter: CursorTurnDisplayRouter;
	private readonly lifecycleEmitter: CursorToolLifecycleEmitter;
	private readonly contentEmitter;
	private sdkTurnUsage?: CursorSdkTurnUsage;

	constructor(options: CursorSdkTurnCoordinatorOptions) {
		this.stream = options.stream;
		this.partial = options.partial;
		this.cwd = options.cwd;
		this.resolvedApiKey = options.resolvedApiKey;
		this.liveRun = options.liveRun;
		this.useNativeToolReplay = options.useNativeToolReplay;
		this.activeToolNames = options.activeToolNames;
		this.nativeReplayId = options.nativeReplayId;
		this.textDeltas = options.textDeltas;
		this.debugRecorder = options.debugRecorder;
		this.contentEmitter = createTurnCoordinatorContentEmitter(options.stream, options.partial);
		this.displayRouter = new CursorTurnDisplayRouter({
			cwd: options.cwd,
			resolvedApiKey: options.resolvedApiKey,
			liveRun: options.liveRun,
			useNativeToolReplay: options.useNativeToolReplay,
			activeToolNames: options.activeToolNames,
			nativeReplayId: options.nativeReplayId,
			contentEmitter: this.contentEmitter,
			debugRecorder: options.debugRecorder,
		});
		this.lifecycleEmitter = new CursorToolLifecycleEmitter({
			liveRun: options.liveRun,
			resolvedApiKey: options.resolvedApiKey,
			contentEmitter: this.contentEmitter,
			debugRecorder: options.debugRecorder,
			hasStartedToolCall: (callId) => this.ledger.hasStartedToolCall(callId),
			isBridgeMcpToolCall: (toolCall) => options.liveRun?.bridgeRun?.isBridgeMcpToolCall(toolCall) ?? false,
		});
	}

	get planTextCandidate(): string | undefined {
		return this.displayRouter.planTextCandidate;
	}

	get replayStarted(): boolean {
		return this.displayRouter.nativeToolReplayStarted;
	}

	get lastSdkTurnUsage(): CursorSdkTurnUsage | undefined {
		return this.sdkTurnUsage;
	}

	discardIncompleteStartedToolCalls(
		outcome: IncompleteCursorToolRunOutcome = buildIncompleteCursorToolRunOutcome(),
	): void {
		for (const [callId, toolCall] of this.ledger.startedToolCallEntries()) {
			const toolName = getNormalizedCursorToolName(toolCall);
			recordDiscardedIncompleteStartedToolCall(this.debugRecorder, process.env, {
				toolName,
				callId,
				reason: outcome.reason,
			});
			const visibilityDecision = resolveIncompleteCursorToolVisibility(toolCall, outcome);
			if (visibilityDecision !== "emit") {
				this.displayRouter.recordIncompleteSkip(
					toolName,
					visibilityDecision === "debugOnly" && outcome.assistantTextProduced
						? "successful-run-text-produced"
						: visibilityDecision,
				);
				continue;
			}
			const action = this.displayRouter.routeIncompleteStartedToolCall(toolCall, outcome.reason);
			if (action) this.displayRouter.emitDisplayAction(action);
		}
		this.ledger.clearStartedToolCalls();
		this.shellOutput.clear();
		this.lifecycleEmitter.clear();
	}

	closeTraceBlock(): void {
		this.contentEmitter.closeThinking();
	}

	flushText(deltas: string[]): string {
		return this.contentEmitter.flushText(deltas);
	}

	handleDelta(update: InteractionUpdate): void {
		const sdkTurnUsage = readCursorSdkTurnUsageFromUpdate(update);
		if (sdkTurnUsage) this.sdkTurnUsage = sdkTurnUsage;
		if (this.liveRun && (update.type === "turn-ended" || sdkTurnUsage)) {
			cursorLiveRuns.recordSdkTurnEnded(this.liveRun, sdkTurnUsage);
		}
		if (update.type === "text-delta") {
			this.textDeltas.push(update.text);
			if (this.liveRun) {
				cursorLiveRuns.queueEvent(this.liveRun, { type: "text-delta", text: update.text });
			} else {
				this.contentEmitter.appendTextDelta(update.text);
			}
			return;
		}
		if (update.type === "thinking-delta") {
			if (this.liveRun) {
				cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-delta", text: update.text });
			} else {
				this.contentEmitter.appendThinkingDelta(update.text);
			}
			return;
		}
		if (update.type === "thinking-completed") {
			if (this.liveRun) {
				cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-completed" });
			} else {
				this.contentEmitter.closeThinking();
			}
			return;
		}
		if (update.type === "partial-tool-call") {
			this.lifecycleEmitter.maybeSchedule(update.callId, update.toolCall);
			return;
		}
		if (update.type === "tool-call-started") {
			if (this.liveRun?.bridgeRun?.isBridgeMcpToolCall(update.toolCall)) {
				if (typeof update.callId === "string") this.ledger.markBridgeStarted(update.callId);
			} else {
				this.lifecycleEmitter.maybeSchedule(update.callId, update.toolCall);
				this.ledger.registerStartedToolCall(update.callId, update.toolCall);
				if (isCursorShellToolCall(update.toolCall) && typeof update.callId === "string") {
					this.shellOutput.onShellToolStarted(update.callId);
				}
			}
			return;
		}
		if (update.type === "tool-call-completed") {
			const resolution = resolveCursorToolCompletion({
				source: "delta",
				callId: update.callId,
				toolCall: update.toolCall,
				startedToolCall: this.ledger.getStartedToolCall(update.callId),
				liveRun: this.liveRun,
				ledger: this.ledger,
				shellOutput: this.shellOutput,
				onClearStartedCallId: (callId) => {
					this.lifecycleEmitter.cancel(callId);
					this.shellOutput.onShellToolCleared(callId);
				},
			});
			if (resolution.action === "ignore-bridge") {
				this.displayRouter.recordIgnoreBridgeDecision(resolution.identity, getToolName(update.toolCall), "delta");
				return;
			}
			this.handleCompletedToolCall(resolution.toolCall, {
				identity: resolution.identity,
				source: resolution.source,
			});
			if (resolution.matchedStartedCallId && resolution.matchedStartedCallId !== update.callId) {
				this.ledger.recordCompletedIdentity(`cursor-tool:${resolution.matchedStartedCallId}`);
			}
			return;
		}
		if (update.type === "shell-output-delta") {
			const delta = getCursorShellOutputDelta(update);
			if (delta) {
				const progress = this.shellOutput.appendShellOutputDelta(delta);
				const progressText = progress ? formatCursorShellOutputProgressText(progress, this.resolvedApiKey) : undefined;
				if (progressText) {
					if (this.liveRun) {
						cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-delta", text: progressText });
					} else {
						this.contentEmitter.appendThinkingDelta(progressText);
					}
				}
			}
			return;
		}
		if (update.type === "summary") {
			const summary = `Cursor summary: ${truncateCursorDisplayLine(update.summary)}\n`;
			if (this.liveRun) {
				cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-delta", text: summary });
			} else {
				this.contentEmitter.appendThinkingDelta(summary);
			}
		}
	}

	handleStep(stepEnvelope: unknown): void {
		const stepType = getField(stepEnvelope, "type");
		const step = getField(stepEnvelope, "message") ? stepEnvelope : undefined;
		const rawStepToolCall = getField(step, "message");
		if (stepType !== "toolCall") return;
		const toolCall = rawStepToolCall;
		const stepId = getField(stepEnvelope, "id") ?? getField(toolCall, "id") ?? getField(toolCall, "callId");
		if (!toolCall) return;

		const resolution = resolveCursorToolCompletion({
			source: "step",
			callId: stepId,
			toolCall,
			liveRun: this.liveRun,
			ledger: this.ledger,
			shellOutput: this.shellOutput,
			onClearStartedCallId: (callId) => {
				this.lifecycleEmitter.cancel(callId);
				this.shellOutput.onShellToolCleared(callId);
			},
		});
		if (resolution.action === "ignore-bridge") {
			this.displayRouter.recordIgnoreBridgeDecision(resolution.identity, getToolName(toolCall), "step");
			return;
		}
		this.handleCompletedToolCall(resolution.toolCall, {
			identity: resolution.identity,
			source: resolution.source,
		});
		if (resolution.matchedStartedCallId && resolution.matchedStartedCallId !== stepId) {
			this.ledger.recordCompletedIdentity(`cursor-tool:${resolution.matchedStartedCallId}`);
		}
	}

	handleTranscriptCompletedToolCalls(toolCalls: readonly { identity: string; toolCall: unknown }[]): void {
		for (const { identity, toolCall } of toolCalls) {
			this.handleCompletedToolCall(toolCall, { identity, source: "transcript" });
		}
	}

	private handleCompletedToolCall(
		toolCall: unknown,
		options: { identity?: string; source?: "started" | "fallback" | "transcript" } = {},
	): void {
		const display = buildCursorPiToolDisplay(toolCall, { cwd: this.cwd });
		const fingerprint = getToolFingerprint({
			toolName: display.toolName,
			args: display.args,
			result: display.result,
		});
		const duplicateReason = this.ledger.shouldSkipDuplicateCompletion({
			identity: options.identity,
			source: options.source,
			fingerprint,
		});
		if (duplicateReason) {
			this.displayRouter.recordDuplicateSkip(display.toolName, {
				identity: options.identity,
				source: options.source,
				reason: duplicateReason,
			});
			return;
		}
		this.ledger.recordCompletedTool({
			identity: options.identity,
			source: options.source,
			fingerprint,
		});

		// Live Cursor activity only. Transcript/history completions stay display-only.
		if (options.source !== "transcript") {
			const normalized = getNormalizedCursorToolName(toolCall);
			if (normalized === "updateTodos" || normalized === "task") {
				const args = getToolArgs(toolCall);
				const result = normalizeResult(getToolResult(toolCall));
				void mirrorCursorActivityTool({
					toolName: normalized,
					args,
					result,
					taskMetadata: normalized === "task" ? readCursorTaskMetadata(args, result.value) : undefined,
				});
			}
		}

		const action = this.displayRouter.routeCompletedToolCall(toolCall, options);
		if (action) this.displayRouter.emitDisplayAction(action);
	}
}
