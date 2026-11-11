import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { CursorPartialContentEmitter } from "./cursor-partial-content-emitter.js";
import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";
import {
	CURSOR_TOOL_LIFECYCLE_DEFER_MS,
	formatCursorToolLifecycleProgressText,
	isCursorToolLifecycleEligible,
} from "./cursor-tool-lifecycle.js";
import { getNormalizedCursorToolName } from "./cursor-tool-visibility.js";
import { getStartedToolCallFingerprint } from "./cursor-provider-turn-tool-ledger.js";

export interface CursorToolLifecycleEmitterOptions {
	liveRun?: CursorLiveRun;
	resolvedApiKey?: string;
	contentEmitter: CursorPartialContentEmitter;
	debugRecorder?: CursorSdkEventDebugRecorder;
	hasStartedToolCall: (callId: string) => boolean;
	isBridgeMcpToolCall: (toolCall: unknown) => boolean;
}

/**
 * Lifecycle label state for one Cursor call ID during a turn. Deferred, emitted and suppressed calls own
 * their started-call fingerprint until completion, so duplicate starts stay quiet. An empty call ID never
 * blocks or suppresses another call.
 * - deferred: waiting out the defer window so fast start+complete pairs show only the completed result.
 * - emitted: the call's one in-progress label was shown.
 * - suppressed: a started sibling owned the same label text when the window ended. The call does not
 *   inherit the label when that sibling completes; only a newer update for the call schedules it again.
 * - completed: an emitted call completed; its ID still cannot show a second label this turn.
 * Completing a deferred or suppressed call forgets it.
 */
type LifecycleCall =
	| { kind: "deferred"; fingerprint: string; progressText: string; timer: ReturnType<typeof setTimeout> }
	| { kind: "emitted" | "suppressed"; fingerprint: string; progressText: string }
	| { kind: "completed" };

export class CursorToolLifecycleEmitter {
	private readonly liveRun?: CursorLiveRun;
	private readonly resolvedApiKey?: string;
	private readonly contentEmitter: CursorPartialContentEmitter;
	private readonly debugRecorder?: CursorSdkEventDebugRecorder;
	private readonly hasStartedToolCall: (callId: string) => boolean;
	private readonly isBridgeMcpToolCall: (toolCall: unknown) => boolean;
	private readonly calls = new Map<string, LifecycleCall>();
	/** Label text owner: claimed by the first call scheduled with it, taken over by the call that emits it. */
	private readonly progressTextOwners = new Map<string, string>();

	constructor(options: CursorToolLifecycleEmitterOptions) {
		this.liveRun = options.liveRun;
		this.resolvedApiKey = options.resolvedApiKey;
		this.contentEmitter = options.contentEmitter;
		this.debugRecorder = options.debugRecorder;
		this.hasStartedToolCall = options.hasStartedToolCall;
		this.isBridgeMcpToolCall = options.isBridgeMcpToolCall;
	}

	maybeSchedule(callId: unknown, toolCall: unknown): void {
		if (typeof callId !== "string") return;
		const existing = this.calls.get(callId);
		if (existing?.kind === "emitted" || existing?.kind === "completed") return;
		if (this.isBridgeMcpToolCall(toolCall)) return;
		if (!isCursorToolLifecycleEligible(toolCall)) return;

		const progressText = formatCursorToolLifecycleProgressText(toolCall, this.resolvedApiKey);
		if (!progressText) return;

		const fingerprint = getStartedToolCallFingerprint(toolCall);
		const fingerprintOwner = this.findFingerprintOwner(fingerprint);
		if (fingerprintOwner && fingerprintOwner !== callId) {
			this.debugRecorder?.recordCoordinatorEvent("tool_lifecycle_skip", {
				callId,
				ownerCallId: fingerprintOwner,
				toolName: getNormalizedCursorToolName(toolCall),
				reason: "duplicate-active-fingerprint",
			});
			return;
		}

		this.release(callId);
		if (!this.progressTextOwners.has(progressText)) this.progressTextOwners.set(progressText, callId);
		const timer = setTimeout(() => this.settle(callId, toolCall), CURSOR_TOOL_LIFECYCLE_DEFER_MS);
		timer.unref?.();
		this.calls.set(callId, { kind: "deferred", fingerprint, progressText, timer });
	}

	cancel(callId: string): void {
		const emitted = this.calls.get(callId)?.kind === "emitted";
		this.release(callId);
		if (emitted) this.calls.set(callId, { kind: "completed" });
	}

	clear(): void {
		for (const call of this.calls.values()) {
			if (call.kind === "deferred") clearTimeout(call.timer);
		}
		this.calls.clear();
		this.progressTextOwners.clear();
	}

	private settle(callId: string, toolCall: unknown): void {
		const call = this.calls.get(callId);
		if (call?.kind !== "deferred") return;
		if (!this.hasStartedToolCall(callId)) {
			this.release(callId);
			return;
		}
		const { fingerprint, progressText } = call;
		const progressOwner = this.progressTextOwners.get(progressText);
		// Keep the truthy check: an empty call ID must not suppress another call.
		if (progressOwner && progressOwner !== callId && this.hasStartedToolCall(progressOwner)) {
			this.calls.set(callId, { kind: "suppressed", fingerprint, progressText });
			this.debugRecorder?.recordCoordinatorEvent("tool_lifecycle_skip", {
				callId,
				ownerCallId: progressOwner,
				toolName: getNormalizedCursorToolName(toolCall),
				reason: "duplicate-active-progress-text",
			});
			return;
		}
		this.progressTextOwners.set(progressText, callId);
		this.calls.set(callId, { kind: "emitted", fingerprint, progressText });
		this.emit(callId, toolCall, progressText);
	}

	/** Forgets a deferred, emitted or suppressed call, releasing its timer, fingerprint and label-text claims. */
	private release(callId: string): void {
		const call = this.calls.get(callId);
		if (call === undefined || call.kind === "completed") return;
		if (call.kind === "deferred") clearTimeout(call.timer);
		if (this.progressTextOwners.get(call.progressText) === callId) this.progressTextOwners.delete(call.progressText);
		this.calls.delete(callId);
	}

	private findFingerprintOwner(fingerprint: string): string | undefined {
		for (const [callId, call] of this.calls) {
			if (callId && call.kind !== "completed" && call.fingerprint === fingerprint) return callId;
		}
		return undefined;
	}

	private emit(callId: string, toolCall: unknown, progressText: string): void {
		this.debugRecorder?.recordCoordinatorEvent("tool_lifecycle", {
			callId,
			toolName: getNormalizedCursorToolName(toolCall),
			progressText,
			liveRun: this.liveRun !== undefined,
		});
		if (this.liveRun) {
			cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-delta", text: progressText });
			return;
		}
		this.contentEmitter.appendThinkingDelta(progressText);
	}
}

export function createTurnCoordinatorContentEmitter(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
): CursorPartialContentEmitter {
	return new CursorPartialContentEmitter(stream, partial, undefined, false);
}
