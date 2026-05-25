import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { InteractionUpdate } from "@cursor/sdk";
import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { formatInactiveCursorReplayTrace } from "./cursor-native-replay-trace.js";
import { resolveNativeReplayDisposition } from "./cursor-native-replay-routing.js";
import { truncateCursorDisplayLine } from "./cursor-display-text.js";
import { CursorPartialContentEmitter } from "./cursor-partial-content-emitter.js";
import { asRecord, getField, hasUsableText } from "./cursor-record-utils.js";
import { scrubPiToolDisplay, scrubSensitiveText } from "./cursor-sensitive-text.js";
import { buildCursorPiToolDisplay, formatCursorToolTranscript, getCursorCreatePlanText, mergeCursorToolCalls } from "./cursor-tool-transcript.js";
import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";
import { getString, getToolArgs, getToolName } from "./cursor-transcript-utils.js";

function formatCursorToolName(toolCall: unknown): string {
	return truncateCursorDisplayLine(getToolName(toolCall), 80) || "unknown";
}

interface CursorShellOutputDelta {
	stream: "stdout" | "stderr";
	data: string;
}

interface CursorShellOutputDeltas {
	stdout: string[];
	stderr: string[];
}

function isCursorShellToolCall(toolCall: unknown): boolean {
	const normalizedName = getToolName(toolCall).replace(/\s+/g, " ").trim().toLowerCase();
	return normalizedName === "shell" || normalizedName === "run_terminal_cmd" || normalizedName === "terminal" || normalizedName === "bash";
}

function isCursorTaskToolCall(toolCall: unknown): boolean {
	return getToolName(toolCall).replace(/\s+/g, " ").trim().toLowerCase() === "task";
}

function extractCursorTaskProgressLabel(toolCall: unknown, apiKey?: string): string | undefined {
	if (!isCursorTaskToolCall(toolCall)) return undefined;
	const description = getString(getToolArgs(toolCall), "description");
	if (!description?.trim()) return undefined;
	return truncateCursorDisplayLine(scrubSensitiveText(description, apiKey));
}

function getCursorShellOutputDelta(update: InteractionUpdate): CursorShellOutputDelta | undefined {
	if (update.type !== "shell-output-delta") return undefined;
	const event = getField(update, "event");
	const eventCase = getField(event, "case");
	if (eventCase !== "stdout" && eventCase !== "stderr") return undefined;
	const value = getField(event, "value");
	const data = getField(value, "data");
	if (typeof data !== "string" || data.length === 0) return undefined;
	return { stream: eventCase, data };
}

function mergeShellOutputDeltasIntoCursorToolCall(toolCall: unknown, deltas: CursorShellOutputDeltas | undefined): unknown {
	if (!deltas) return toolCall;
	const stdout = deltas.stdout.join("");
	const stderr = deltas.stderr.join("");
	if (!hasUsableText(stdout) && !hasUsableText(stderr)) return toolCall;

	const toolRecord = asRecord(toolCall);
	const result = getField(toolRecord, "result");
	const resultRecord = asRecord(result);
	if (!toolRecord || !resultRecord || resultRecord.status !== "success") return toolCall;

	const value = getField(resultRecord, "value");
	const valueRecord = asRecord(value);
	const completedStdout = getField(valueRecord, "stdout");
	const completedStderr = getField(valueRecord, "stderr");
	if (hasUsableText(typeof completedStdout === "string" ? completedStdout : undefined)) return toolCall;
	if (hasUsableText(typeof completedStderr === "string" ? completedStderr : undefined)) return toolCall;

	return {
		...toolRecord,
		result: {
			...resultRecord,
			value: {
				...(valueRecord ?? {}),
				stdout,
				stderr,
			},
		},
	};
}

type ToolCompletionResolution =
	| { action: "ignore-bridge"; identity?: string }
	| {
			action: "handle";
			toolCall: unknown;
			identity?: string;
			source?: "started" | "fallback";
			matchedStartedCallId?: string;
	  };

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

	private readonly contentEmitter: CursorPartialContentEmitter;
	private readonly debugRecorder?: CursorSdkEventDebugRecorder;
	private nativeToolDisplayCounter = 0;
	private nativeToolReplayStarted = false;
	private cursorPlanTextCandidate: string | undefined;
	private readonly startedToolCalls = new Map<string, unknown>();
	private readonly bridgeStartedToolCallIds = new Set<string>();
	private readonly activeShellCallIds = new Set<string>();
	private readonly ambiguousShellOutputCallIds = new Set<string>();
	private readonly shellOutputDeltasByCallId = new Map<string, CursorShellOutputDeltas>();
	private readonly completedToolIdentities = new Set<string>();
	private readonly completedStartedToolFingerprints = new Set<string>();
	private readonly completedFallbackToolFingerprints = new Set<string>();
	private readonly emittedTaskProgressCallIds = new Set<string>();

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
		this.contentEmitter = new CursorPartialContentEmitter(options.stream, options.partial, undefined, false);
	}

	get planTextCandidate(): string | undefined {
		return this.cursorPlanTextCandidate;
	}

	get replayStarted(): boolean {
		return this.nativeToolReplayStarted;
	}

	discardIncompleteStartedToolCalls(): void {
		this.startedToolCalls.clear();
		this.bridgeStartedToolCallIds.clear();
		this.activeShellCallIds.clear();
		this.ambiguousShellOutputCallIds.clear();
		this.shellOutputDeltasByCallId.clear();
		this.emittedTaskProgressCallIds.clear();
	}

	closeTraceBlock(): void {
		this.contentEmitter.closeThinking();
	}

	flushText(deltas: string[]): string {
		return this.contentEmitter.flushText(deltas);
	}

	handleDelta(update: InteractionUpdate): void {
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
			this.maybeEmitCursorTaskProgress(update.callId, update.toolCall);
			return;
		}
		if (update.type === "tool-call-started") {
			if (this.liveRun?.bridgeRun?.isBridgeMcpToolCall(update.toolCall)) {
				if (typeof update.callId === "string") this.bridgeStartedToolCallIds.add(update.callId);
			} else {
				this.maybeEmitCursorTaskProgress(update.callId, update.toolCall);
				this.startedToolCalls.set(update.callId, update.toolCall);
				if (isCursorShellToolCall(update.toolCall)) this.activeShellCallIds.add(update.callId);
			}
			return;
		}
		if (update.type === "tool-call-completed") {
			const resolution = this.resolveToolCompletion({
				source: "delta",
				callId: update.callId,
				toolCall: update.toolCall,
				startedToolCall: this.startedToolCalls.get(update.callId),
			});
			if (resolution.action === "ignore-bridge") {
				this.recordIgnoreBridgeDecision(resolution.identity, getToolName(update.toolCall), "delta");
				return;
			}
			this.handleCompletedToolCall(resolution.toolCall, {
				identity: resolution.identity,
				source: resolution.source,
			});
			return;
		}
		if (update.type === "shell-output-delta") {
			const delta = getCursorShellOutputDelta(update);
			if (delta) this.appendShellOutputDelta(delta);
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

		const resolution = this.resolveToolCompletion({
			source: "step",
			callId: stepId,
			toolCall,
		});
		if (resolution.action === "ignore-bridge") {
			this.recordIgnoreBridgeDecision(resolution.identity, getToolName(toolCall), "step");
			return;
		}
		this.handleCompletedToolCall(resolution.toolCall, {
			identity: resolution.identity,
			source: resolution.source,
		});
		if (resolution.matchedStartedCallId && resolution.matchedStartedCallId !== stepId) {
			this.completedToolIdentities.add(`cursor-tool:${resolution.matchedStartedCallId}`);
		}
	}

	private resolveToolCompletion(options: {
		source: "delta" | "step";
		callId: unknown;
		toolCall: unknown;
		startedToolCall?: unknown;
	}): ToolCompletionResolution {
		const bridgeStartedCallId = this.takeBridgeStartedToolCallId(options.callId);
		if (bridgeStartedCallId) {
			this.completedToolIdentities.add(`cursor-tool:${bridgeStartedCallId}`);
			return { action: "ignore-bridge", identity: `cursor-tool:${bridgeStartedCallId}` };
		}

		let matchedStartedCallId: string | undefined;
		let resolvedToolCall: unknown;
		let identity: string | undefined;
		let source: "started" | "fallback" | undefined;

		if (options.source === "delta") {
			const callId = options.callId;
			identity = typeof callId === "string" ? `cursor-tool:${callId}` : undefined;
			resolvedToolCall = mergeCursorToolCalls(options.startedToolCall, options.toolCall);
			if (typeof callId === "string") {
				this.clearStartedToolCall(callId);
			}
			resolvedToolCall = mergeShellOutputDeltasIntoCursorToolCall(
				resolvedToolCall,
				typeof callId === "string" ? this.takeShellOutputDeltas(callId) : undefined,
			);
			source = identity ? "started" : "fallback";
		} else {
			matchedStartedCallId = this.removeStartedToolCallForStep(options.toolCall, options.callId);
			resolvedToolCall = mergeShellOutputDeltasIntoCursorToolCall(
				options.toolCall,
				matchedStartedCallId ? this.takeShellOutputDeltas(matchedStartedCallId) : undefined,
			);
			const identityId = typeof options.callId === "string" ? options.callId : matchedStartedCallId;
			identity = identityId ? `cursor-tool:${identityId}` : undefined;
		}

		if (this.liveRun?.bridgeRun?.isBridgeMcpToolCall(resolvedToolCall)) {
			const bridgeIdentity = options.source === "step" && matchedStartedCallId
				? `cursor-tool:${matchedStartedCallId}`
				: identity;
			if (bridgeIdentity) this.completedToolIdentities.add(bridgeIdentity);
			return { action: "ignore-bridge", identity: bridgeIdentity };
		}

		if (options.source === "delta") {
			return { action: "handle", toolCall: resolvedToolCall, identity, source };
		}
		return {
			action: "handle",
			toolCall: resolvedToolCall,
			identity,
			matchedStartedCallId,
		};
	}

	private handleCompletedToolCall(
		toolCall: unknown,
		options: { identity?: string; source?: "started" | "fallback" } = {},
	): void {
		const planText = getCursorCreatePlanText(toolCall);
		if (planText) this.cursorPlanTextCandidate = scrubSensitiveText(planText, this.resolvedApiKey);

		const transcript = scrubSensitiveText(formatCursorToolTranscript(toolCall, { cwd: this.cwd }), this.resolvedApiKey);
		const display = buildCursorPiToolDisplay(toolCall, { cwd: this.cwd });
		const toolName = display.toolName;
		const fingerprint = this.getToolFingerprint({ toolName: display.toolName, args: display.args, result: display.result });
		if (options.identity && this.completedToolIdentities.has(options.identity)) {
			this.recordDisplayDecision({
				action: "skip-duplicate",
				toolName,
				identity: options.identity,
				source: options.source,
				reason: "identity-already-completed",
			});
			return;
		}
		if (options.source === "started") {
			if (this.completedFallbackToolFingerprints.has(fingerprint)) {
				this.recordDisplayDecision({
					action: "skip-duplicate",
					toolName,
					identity: options.identity,
					source: options.source,
					reason: "fallback-fingerprint-already-completed",
				});
				return;
			}
		} else if (this.completedStartedToolFingerprints.has(fingerprint) || this.completedFallbackToolFingerprints.has(fingerprint)) {
			this.recordDisplayDecision({
				action: "skip-duplicate",
				toolName,
				identity: options.identity,
				source: options.source,
				reason: "fingerprint-already-completed",
			});
			return;
		}
		if (options.identity) this.completedToolIdentities.add(options.identity);
		if (options.source === "started") {
			this.completedStartedToolFingerprints.add(fingerprint);
		} else {
			this.completedFallbackToolFingerprints.add(fingerprint);
		}

		const disposition = resolveNativeReplayDisposition({
			toolName: display.toolName,
			useNativeToolReplay: this.useNativeToolReplay,
			activeToolNames: this.activeToolNames,
			hasLiveRun: this.liveRun !== undefined,
		});

		if (disposition === "queue_replay" && this.liveRun) {
			this.nativeToolReplayStarted = true;
			const id = `${this.nativeReplayId}-tool-${++this.nativeToolDisplayCounter}`;
			const scrubbedDisplay = scrubPiToolDisplay(display, this.resolvedApiKey);
			this.recordDisplayDecision({
				action: "queue_replay",
				disposition,
				toolName,
				identity: options.identity,
				source: options.source,
				transcript,
				replayToolId: id,
			});
			cursorLiveRuns.queueEvent(this.liveRun, {
				type: "tool",
				tool: { ...scrubbedDisplay, id },
			});
			return;
		}

		const traceText =
			disposition === "inactive_trace"
				? formatInactiveCursorReplayTrace(scrubPiToolDisplay(display, this.resolvedApiKey))
				: transcript || `Cursor tool: ${formatCursorToolName(toolCall)} completed`;
		this.recordDisplayDecision({
			action: "emit_trace",
			disposition,
			toolName,
			identity: options.identity,
			source: options.source,
			transcript,
			traceText,
		});
		this.emitCursorToolTrace(traceText);
	}

	private recordIgnoreBridgeDecision(
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

	private maybeEmitCursorTaskProgress(callId: unknown, toolCall: unknown): void {
		if (typeof callId !== "string" || this.emittedTaskProgressCallIds.has(callId)) return;
		if (this.liveRun?.bridgeRun?.isBridgeMcpToolCall(toolCall)) return;
		const label = extractCursorTaskProgressLabel(toolCall, this.resolvedApiKey);
		if (!label) return;
		this.emittedTaskProgressCallIds.add(callId);
		this.emitCursorTaskProgress(label);
	}

	private emitCursorTaskProgress(label: string): void {
		const progressText = `Cursor task: ${label}\n`;
		this.debugRecorder?.recordCoordinatorEvent("task_progress", { label, progressText, liveRun: this.liveRun !== undefined });
		if (this.liveRun) {
			cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-delta", text: progressText });
			return;
		}
		this.contentEmitter.appendThinkingDelta(progressText);
	}

	private getToolFingerprint(value: unknown): string {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	private getStartedToolCallFingerprint(toolCall: unknown): string {
		return this.getToolFingerprint({ toolName: getToolName(toolCall), args: getField(toolCall, "args") });
	}

	private clearStartedToolCall(callId: string): void {
		this.startedToolCalls.delete(callId);
		this.bridgeStartedToolCallIds.delete(callId);
		this.activeShellCallIds.delete(callId);
		this.ambiguousShellOutputCallIds.delete(callId);
	}

	private takeBridgeStartedToolCallId(callId: unknown): string | undefined {
		if (typeof callId !== "string" || !this.bridgeStartedToolCallIds.has(callId)) return undefined;
		this.bridgeStartedToolCallIds.delete(callId);
		return callId;
	}

	private takeShellOutputDeltas(callId: string): CursorShellOutputDeltas | undefined {
		const deltas = this.shellOutputDeltasByCallId.get(callId);
		this.shellOutputDeltasByCallId.delete(callId);
		return deltas;
	}

	private appendShellOutputDelta(delta: CursorShellOutputDelta): void {
		if (this.activeShellCallIds.size !== 1) {
			for (const activeCallId of this.activeShellCallIds) {
				this.ambiguousShellOutputCallIds.add(activeCallId);
				this.shellOutputDeltasByCallId.delete(activeCallId);
			}
			return;
		}
		const [callId] = this.activeShellCallIds;
		if (!callId || this.ambiguousShellOutputCallIds.has(callId)) return;
		let deltas = this.shellOutputDeltasByCallId.get(callId);
		if (!deltas) {
			deltas = { stdout: [], stderr: [] };
			this.shellOutputDeltasByCallId.set(callId, deltas);
		}
		deltas[delta.stream].push(delta.data);
	}

	private removeStartedToolCallForStep(toolCall: unknown, stepId: unknown): string | undefined {
		if (typeof stepId === "string" && this.startedToolCalls.has(stepId)) {
			this.clearStartedToolCall(stepId);
			return stepId;
		}
		const fingerprint = this.getStartedToolCallFingerprint(toolCall);
		for (const [callId, startedToolCall] of this.startedToolCalls) {
			if (this.getStartedToolCallFingerprint(startedToolCall) !== fingerprint) continue;
			this.clearStartedToolCall(callId);
			return callId;
		}
		return undefined;
	}
}
