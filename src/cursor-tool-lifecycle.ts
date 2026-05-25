import { truncateCursorDisplayLine } from "./cursor-display-text.js";
import { getCursorReplayDisplayLabel, type CursorReplayLegacyToolName } from "./cursor-tool-names.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import {
	extractWebFetchTarget,
	extractWebSearchQuery,
	resolveTranscriptToolName,
} from "./cursor-web-tool-activity.js";
import { firstNonEmptyLine, getArray, getString, getToolArgs, getToolName, normalizeToolName, truncateArg } from "./cursor-transcript-utils.js";

/** Defer pending lifecycle lines so fast start+complete pairs coalesce into the completed replay card only. */
export const CURSOR_TOOL_LIFECYCLE_DEFER_MS = 75;

const LIFECYCLE_ELIGIBLE_TOOLS = new Set(
	["task", "shell", "mcp", "generateImage", "recordScreen", "semSearch", "webSearch", "webFetch", "createPlan", "updateTodos"].map(
		(name) => name.toLowerCase(),
	),
);

const LIFECYCLE_TITLE_KEYS: Partial<Record<string, CursorReplayLegacyToolName>> = {
	task: "cursor_task",
	mcp: "cursor_mcp",
	generateimage: "cursor_generate_image",
	recordscreen: "cursor_record_screen",
	semsearch: "cursor_sem_search",
	websearch: "cursor_web_search",
	webfetch: "cursor_web_fetch",
	createplan: "cursor_create_plan",
	updatetodos: "cursor_update_todos",
};

export function isCursorToolLifecycleEligible(toolCall: unknown): boolean {
	const args = getToolArgs(toolCall);
	const name = resolveTranscriptToolName(getToolName(toolCall), args);
	return LIFECYCLE_ELIGIBLE_TOOLS.has(normalizeToolName(name).toLowerCase());
}

function getCursorToolLifecycleTitle(toolCall: unknown): string {
	const args = getToolArgs(toolCall);
	const name = resolveTranscriptToolName(getToolName(toolCall), args);
	const normalized = normalizeToolName(name).toLowerCase();
	const labelKey = LIFECYCLE_TITLE_KEYS[normalized];
	if (labelKey) return getCursorReplayDisplayLabel(labelKey);
	if (normalized === "shell") return "Cursor shell";
	return `Cursor ${normalizeToolName(name)}`;
}

export function buildCursorToolLifecycleLabel(toolCall: unknown, apiKey?: string): string | undefined {
	const args = getToolArgs(toolCall);
	const name = resolveTranscriptToolName(getToolName(toolCall), args);
	const normalized = normalizeToolName(name).toLowerCase();

	const scrub = (value: string | undefined): string | undefined => {
		if (!value?.trim()) return undefined;
		return truncateCursorDisplayLine(scrubSensitiveText(value, apiKey));
	};

	switch (normalized) {
		case "task": {
			return scrub(getString(args, "description"));
		}
		case "shell": {
			return scrub(getString(args, "command")) ?? "shell";
		}
		case "mcp": {
			return scrub(getString(args, "toolName")) ?? "mcp";
		}
		case "generateimage": {
			return (
				scrub(getString(args, "prompt") ?? getString(args, "description")) ??
				scrub(getString(args, "path") ?? getString(args, "filePath")) ??
				"image generation"
			);
		}
		case "recordscreen": {
			return scrub(getString(args, "mode")) ?? scrub(getString(args, "path")) ?? "screen recording";
		}
		case "semsearch": {
			return scrub(getString(args, "query")) ?? "semantic search";
		}
		case "websearch": {
			return scrub(extractWebSearchQuery(args)) ?? "web search";
		}
		case "webfetch": {
			return scrub(extractWebFetchTarget(args)) ?? "web fetch";
		}
		case "createplan": {
			const plan = getString(args, "plan");
			return scrub(plan ? firstNonEmptyLine(plan) ?? plan : undefined) ?? "plan";
		}
		case "updatetodos": {
			const todos = getArray(args, "todos") ?? getArray(args, "items");
			if (todos && todos.length > 0) return truncateArg(`${todos.length} item${todos.length === 1 ? "" : "s"}`);
			return "todos";
		}
		default:
			return undefined;
	}
}

export function formatCursorToolLifecycleProgressText(toolCall: unknown, apiKey?: string): string | undefined {
	const label = buildCursorToolLifecycleLabel(toolCall, apiKey);
	if (!label) return undefined;
	return `${getCursorToolLifecycleTitle(toolCall)}: ${label}\n`;
}
