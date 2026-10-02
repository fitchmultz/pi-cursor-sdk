import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { truncateCursorDisplayLine } from "./cursor-display-text.js";
import { formatInactiveCursorReplayTrace } from "./cursor-native-replay-trace.js";
import { resolveNativeReplayDisposition, type NativeReplayDisposition } from "./cursor-native-replay-routing.js";
import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";
import {
	buildIncompleteCursorToolDisplay,
	formatIncompleteCursorToolTrace,
	type IncompleteCursorToolDiscardReason,
} from "./cursor-incomplete-tool-visibility.js";
import { scrubPiToolDisplay, scrubSensitiveText } from "./cursor-sensitive-text.js";
import {
	buildCursorPiToolDisplay,
	formatCursorToolTranscript,
	getCursorCreatePlanText,
} from "./cursor-tool-transcript.js";
import { getToolName } from "./cursor-transcript-utils.js";
import type { CursorPartialContentEmitter } from "./cursor-partial-content-emitter.js";
import type { CursorToolDisplaySource } from "./cursor-provider-turn-tool-ledger.js";

function formatCursorToolName(toolCall: unknown): string {
	return truncateCursorDisplayLine(getToolName(toolCall), 80) || "unknown";
}

export interface CursorTurnDisplayRouterOptions {
	cwd: string;
	resolvedApiKey?: string;
	liveRun?: CursorLiveRun;
	useNativeToolReplay: boolean;
	activeToolNames?: ReadonlySet<string>;
	registeredToolNames?: ReadonlySet<string>;
	nativeReplayId: string;
	contentEmitter: CursorPartialContentEmitter;
	debugRecorder?: CursorSdkEventDebugRecorder;
}

export type CursorTurnDisplayAction =
	| { kind: "queue_replay"; tool: ReturnType<typeof scrubPiToolDisplay>; replayToolId: string; disposition: NativeReplayDisposition }
	| { kind: "emit_trace"; traceText: string; disposition: NativeReplayDisposition };

export class CursorTurnDisplayRouter {
	private readonly cwd: string;
	private readonly resolvedApiKey?: string;
	private readonly liveRun?: CursorLiveRun;
	private readonly useNativeToolReplay: boolean;
	private readonly activeToolNames?: ReadonlySet<string>;
	private readonly registeredToolNames?: ReadonlySet<string>;
	private readonly nativeReplayId: string;
	private readonly contentEmitter: CursorPartialContentEmitter;
	private readonly debugRecorder?: CursorSdkEventDebugRecorder;
	private nativeToolDisplayCounter = 0;
	nativeToolReplayStarted = false;
	planTextCandidate: string | undefined;

	constructor(options: CursorTurnDisplayRouterOptions) {
		this.cwd = options.cwd;
		this.resolvedApiKey = options.resolvedApiKey;
		this.liveRun = options.liveRun;
		this.useNativeToolReplay = options.useNativeToolReplay;
		this.activeToolNames = options.activeToolNames;
		this.registeredToolNames = options.registeredToolNames;
		this.nativeReplayId = options.nativeReplayId;
		this.contentEmitter = options.contentEmitter;
		this.debugRecorder = options.debugRecorder;
	}

	routeCompletedToolCall(
		toolCall: unknown,
		options: { identity?: string; source?: CursorToolDisplaySource } = {},
	): CursorTurnDisplayAction | undefined {
		const planText = getCursorCreatePlanText(toolCall);
		if (planText) this.planTextCandidate = scrubSensitiveText(planText, this.resolvedApiKey);

		const transcript = scrubSensitiveText(formatCursorToolTranscript(toolCall, { cwd: this.cwd }), this.resolvedApiKey);
		const display = buildCursorPiToolDisplay(toolCall, { cwd: this.cwd });
		const disposition = resolveNativeReplayDisposition({
			toolName: display.toolName,
			useNativeToolReplay: this.useNativeToolReplay,
			activeToolNames: this.activeToolNames,
			registeredToolNames: this.registeredToolNames,
			hasLiveRun: this.liveRun !== undefined,
		});

		if (disposition === "queue_replay" && this.liveRun) {
			this.nativeToolReplayStarted = true;
			const id = `${this.nativeReplayId}-tool-${++this.nativeToolDisplayCounter}`;
			const scrubbedDisplay = scrubPiToolDisplay(display, this.resolvedApiKey);
			this.recordDisplayDecision({
				action: "queue_replay",
				disposition,
				toolName: display.toolName,
				identity: options.identity,
				source: options.source,
				transcript,
				replayToolId: id,
			});
			return { kind: "queue_replay", tool: scrubbedDisplay, replayToolId: id, disposition };
		}

		const traceText =
			disposition === "inactive_trace"
				? formatInactiveCursorReplayTrace(scrubPiToolDisplay(display, this.resolvedApiKey))
				: transcript || `Cursor tool: ${formatCursorToolName(toolCall)} completed`;
		this.recordDisplayDecision({
			action: "emit_trace",
			disposition,
			toolName: display.toolName,
			identity: options.identity,
			source: options.source,
			transcript,
			traceText,
		});
		return { kind: "emit_trace", traceText, disposition };
	}

	routeIncompleteStartedToolCall(
		toolCall: unknown,
		reason: IncompleteCursorToolDiscardReason,
	): CursorTurnDisplayAction | undefined {
		const display = scrubPiToolDisplay(
			buildIncompleteCursorToolDisplay(toolCall, reason, { apiKey: this.resolvedApiKey }),
			this.resolvedApiKey,
		);
		const disposition = resolveNativeReplayDisposition({
			toolName: display.toolName,
			useNativeToolReplay: this.useNativeToolReplay,
			activeToolNames: this.activeToolNames,
			registeredToolNames: this.registeredToolNames,
			hasLiveRun: this.liveRun !== undefined,
		});

		if (disposition === "queue_replay" && this.liveRun && reason !== "abort") {
			this.nativeToolReplayStarted = true;
			const id = `${this.nativeReplayId}-tool-${++this.nativeToolDisplayCounter}`;
			this.recordDisplayDecision({
				action: "queue_replay",
				disposition,
				toolName: display.toolName,
				source: "started",
				reason: "incomplete-started-tool-call",
				replayToolId: id,
			});
			return { kind: "queue_replay", tool: display, replayToolId: id, disposition };
		}

		const traceText =
			disposition === "inactive_trace"
				? formatInactiveCursorReplayTrace(display)
				: formatIncompleteCursorToolTrace(display);
		this.recordDisplayDecision({
			action: "emit_trace",
			disposition,
			toolName: display.toolName,
			source: "started",
			reason: "incomplete-started-tool-call",
			traceText,
		});
		return { kind: "emit_trace", traceText, disposition };
	}

	emitDisplayAction(action: CursorTurnDisplayAction): void {
		if (action.kind === "queue_replay") {
			if (!this.liveRun) return;
			cursorLiveRuns.queueEvent(this.liveRun, {
				type: "tool",
				tool: { ...action.tool, id: action.replayToolId },
			});
			return;
		}
		this.emitCursorToolTrace(action.traceText);
	}

	recordIgnoreBridgeDecision(
		identity: string | undefined,
		toolName: string,
		source: "delta" | "step",
	): void {
		this.debugRecorder?.recordDisplayDecision({
			action: "ignore-bridge",
			toolName,
			identity,
			source,
		});
	}

	recordDuplicateSkip(
		toolName: string,
		options: { identity?: string; source?: CursorToolDisplaySource; reason: string },
	): void {
		this.recordDisplayDecision({
			action: "skip-duplicate",
			toolName,
			identity: options.identity,
			source: options.source,
			reason: options.reason,
		});
	}

	recordIncompleteSkip(
		toolName: string,
		reason: string,
	): void {
		this.recordDisplayDecision({
			action: "skip-incomplete-fast-local",
			toolName,
			source: "started",
			reason,
		});
	}

	private recordDisplayDecision(decision: Parameters<CursorSdkEventDebugRecorder["recordDisplayDecision"]>[0]): void {
		this.debugRecorder?.recordDisplayDecision(decision);
	}

	private emitCursorToolTrace(text: string): void {
		const traceText = text.endsWith("\n") ? text : `${text}\n`;
		if (this.liveRun) {
			cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-delta", text: traceText });
			cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-completed" });
			return;
		}
		this.contentEmitter.appendThinkingBlock(traceText);
	}
}
