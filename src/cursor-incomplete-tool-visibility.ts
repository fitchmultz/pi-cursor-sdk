import { CURSOR_REPLAY_ACTIVITY_TOOL_NAME, getCursorToolActivityTitle } from "./cursor-tool-presentation-registry.js";
import { truncateCursorDisplayLine } from "./cursor-display-text.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import {
	DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
	type DiscardedIncompleteStartedToolCallReason,
} from "./cursor-sdk-event-debug.js";
import {
	assembleCursorReplayActivityDetails,
	parseCursorReplayToolDetails,
	resolveIncompleteReplayActivitySourceToolName,
} from "./cursor-replay-tool-details.js";
import { asRecord } from "./cursor-record-utils.js";
import { type CursorPiToolDisplay } from "./cursor-transcript-utils.js";
import { classifyCursorToolVisibility } from "./cursor-tool-visibility.js";

export type IncompleteCursorToolDiscardReason = DiscardedIncompleteStartedToolCallReason;

export interface IncompleteCursorToolRunOutcome {
	reason: IncompleteCursorToolDiscardReason;
	assistantTextProduced: boolean;
}

export interface IncompleteCursorToolRunOutcomeInput {
	reason?: IncompleteCursorToolDiscardReason;
	status?: string;
	signalAborted?: boolean;
	assistantTextProduced?: boolean;
}

export type IncompleteCursorToolVisibilityDecision = "emit" | "suppress" | "debugOnly";

export function buildIncompleteCursorToolRunOutcome(
	outcome: IncompleteCursorToolRunOutcomeInput = {},
): IncompleteCursorToolRunOutcome {
	return {
		reason:
			outcome.reason ??
			(outcome.status === "cancelled" || outcome.signalAborted
				? "abort"
				: outcome.status === "error"
					? "sdk-failure"
					: DISCARDED_INCOMPLETE_TOOL_CALL_REASON),
		assistantTextProduced: outcome.assistantTextProduced ?? false,
	};
}

export function resolveIncompleteCursorToolVisibility(
	toolCall: unknown,
	outcome: IncompleteCursorToolRunOutcome,
): IncompleteCursorToolVisibilityDecision {
	const visibility = classifyCursorToolVisibility(toolCall);
	// Shell is side-effectful, so incomplete starts stay visible by default.
	// After a successful text-producing turn, Cursor often omits tool-call-completed
	// for shell even when stdout already replayed as bash — same stale-start class as read/grep.
	const suppressStaleStart = visibility.fastLocalDiscovery || visibility.normalizedKey === "shell";
	if (
		outcome.reason === DISCARDED_INCOMPLETE_TOOL_CALL_REASON &&
		outcome.assistantTextProduced &&
		suppressStaleStart
	) {
		return "debugOnly";
	}
	return "emit";
}

export function formatIncompleteCursorToolReasonText(reason: IncompleteCursorToolDiscardReason): string {
	switch (reason) {
		case DISCARDED_INCOMPLETE_TOOL_CALL_REASON:
			return "missing completion";
		case "abort":
			return "aborted";
		case "sdk-failure":
			return "SDK run failed";
		case "run-drain":
			return "run ended during drain";
	}
}

export function getIncompleteCursorToolActivityTitle(toolCall: unknown): string {
	const visibility = classifyCursorToolVisibility(toolCall);
	return visibility.incompleteTitle ?? getCursorToolActivityTitle(visibility.displayName);
}

export function buildIncompleteCursorToolDisplay(
	toolCall: unknown,
	reason: IncompleteCursorToolDiscardReason,
	options: { apiKey?: string } = {},
): CursorPiToolDisplay {
	const visibility = classifyCursorToolVisibility(toolCall);
	const activityTitle = getIncompleteCursorToolActivityTitle(toolCall);
	const headline = `${activityTitle} did not complete`;
	const reasonText = scrubSensitiveText(formatIncompleteCursorToolReasonText(reason), options.apiKey);
	const contentText = `${headline}\n${reasonText}`;
	const details = assembleCursorReplayActivityDetails(
		resolveIncompleteReplayActivitySourceToolName(visibility.normalizedName),
		headline,
		{ summary: reasonText, expandedText: contentText },
		contentText,
		true,
		reasonText,
	);
	return {
		toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
		args: {
			activityTitle,
			activitySummary: reasonText,
			incomplete: true,
		},
		result: {
			content: [{ type: "text", text: contentText }],
			details,
		},
		isError: true,
	};
}

export function formatIncompleteCursorToolTrace(display: CursorPiToolDisplay): string {
	const parsed = parseCursorReplayToolDetails(display.result.details);
	if (parsed?.variant === "activity") {
		const summary =
			parsed.summary?.trim() ||
			(typeof display.args.activitySummary === "string" && display.args.activitySummary.trim()) ||
			formatIncompleteCursorToolReasonText(DISCARDED_INCOMPLETE_TOOL_CALL_REASON);
		return `${truncateCursorDisplayLine(parsed.title)}: ${truncateCursorDisplayLine(summary)}\n`;
	}
	const detailRecord = asRecord(display.result.details);
	const argsRecord = display.args;
	const title =
		(typeof detailRecord?.title === "string" && detailRecord.title.trim()) ||
		(typeof argsRecord.activityTitle === "string" && argsRecord.activityTitle.trim()
			? `${argsRecord.activityTitle} did not complete`
			: "Cursor tool did not complete");
	const summary =
		(typeof detailRecord?.summary === "string" && detailRecord.summary.trim()) ||
		(typeof argsRecord.activitySummary === "string" && argsRecord.activitySummary.trim()) ||
		formatIncompleteCursorToolReasonText(DISCARDED_INCOMPLETE_TOOL_CALL_REASON);
	return `${truncateCursorDisplayLine(title)}: ${truncateCursorDisplayLine(summary)}\n`;
}
