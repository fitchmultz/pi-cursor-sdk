import {
	CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
	getCursorReplayDisplayLabel,
	type CursorReplayLegacyToolName,
} from "./cursor-tool-names.js";
import { truncateCursorDisplayLine } from "./cursor-display-text.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import {
	DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
	type DiscardedIncompleteStartedToolCallReason,
} from "./cursor-sdk-event-debug.js";
import { getToolArgs, getToolName, normalizeToolName, truncateArg, type CursorPiToolDisplay } from "./cursor-transcript-utils.js";
import { resolveTranscriptToolName } from "./cursor-web-tool-activity.js";

export type IncompleteCursorToolDiscardReason = DiscardedIncompleteStartedToolCallReason;

const INCOMPLETE_TITLE_KEYS: Partial<Record<string, CursorReplayLegacyToolName>> = {
	task: "cursor_task",
	mcp: "cursor_mcp",
	generateimage: "cursor_generate_image",
	recordscreen: "cursor_record_screen",
	semsearch: "cursor_sem_search",
	websearch: "cursor_web_search",
	webfetch: "cursor_web_fetch",
	createplan: "cursor_create_plan",
	updatetodos: "cursor_update_todos",
	readlints: "cursor_read_lints",
	delete: "cursor_delete",
	edit: "cursor_edit",
	write: "cursor_write",
};

function buildGenericIncompleteActivityTitle(displayName: string): string {
	if (!displayName || displayName === "unknown") return "Cursor tool";
	return `Cursor ${truncateArg(displayName)}`;
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
	const args = getToolArgs(toolCall);
	const name = resolveTranscriptToolName(getToolName(toolCall), args);
	const normalized = normalizeToolName(name).toLowerCase();
	const labelKey = INCOMPLETE_TITLE_KEYS[normalized];
	if (labelKey) return getCursorReplayDisplayLabel(labelKey);
	switch (normalized) {
		case "read":
			return "Cursor read";
		case "shell":
			return "Cursor shell";
		case "grep":
			return "Cursor grep";
		case "glob":
			return "Cursor find";
		case "ls":
			return "Cursor ls";
		default:
			return buildGenericIncompleteActivityTitle(name);
	}
}

export function buildIncompleteCursorToolDisplay(
	toolCall: unknown,
	reason: IncompleteCursorToolDiscardReason,
	options: { apiKey?: string } = {},
): CursorPiToolDisplay {
	const args = getToolArgs(toolCall);
	const transcriptName = resolveTranscriptToolName(getToolName(toolCall), args);
	const activityTitle = getIncompleteCursorToolActivityTitle(toolCall);
	const headline = `${activityTitle} did not complete`;
	const reasonText = scrubSensitiveText(formatIncompleteCursorToolReasonText(reason), options.apiKey);
	const contentText = `${headline}\n${reasonText}`;
	return {
		toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
		args: {
			cursorToolName: normalizeToolName(transcriptName),
			activityTitle,
			activitySummary: reasonText,
			incomplete: true,
		},
		result: {
			content: [{ type: "text", text: contentText }],
			details: {
				cursorToolName: normalizeToolName(transcriptName),
				title: headline,
				summary: reasonText,
			},
		},
		isError: true,
	};
}

export function formatIncompleteCursorToolTrace(display: CursorPiToolDisplay): string {
	const details = display.result.details;
	const detailRecord = details && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
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
