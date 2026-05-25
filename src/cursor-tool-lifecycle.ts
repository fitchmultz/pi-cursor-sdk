import { truncateCursorDisplayLine } from "./cursor-display-text.js";
import { getCursorReplayDisplayLabel, type CursorReplayLegacyToolName } from "./cursor-tool-names.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import { extractWebSearchQuery, resolveTranscriptToolName } from "./cursor-web-tool-activity.js";
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

/** Prefixes that commonly introduce path/URI values in free-text pending lifecycle details. */
const LIFECYCLE_DETAIL_PATH_PREFIX = String.raw`(?:^|[\s'"({=,:;\[\]{}])`;

function containsCursorLifecycleUnsafeDetail(text: string): boolean {
	if (/\b[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true;
	if (/\bwww\.\S+/i.test(text)) return true;
	if (new RegExp(`${LIFECYCLE_DETAIL_PATH_PREFIX}~\\/\\S*`).test(text)) return true;
	if (new RegExp(`${LIFECYCLE_DETAIL_PATH_PREFIX}\\/\\S+`).test(text)) return true;
	if (new RegExp(`${LIFECYCLE_DETAIL_PATH_PREFIX}[A-Za-z]:[\\\\/]`).test(text)) return true;
	return false;
}

function scrubLifecycleDetail(value: string | undefined, apiKey?: string): string | undefined {
	if (!value?.trim()) return undefined;
	const scrubbed = truncateCursorDisplayLine(scrubSensitiveText(value, apiKey));
	if (containsCursorLifecycleUnsafeDetail(scrubbed)) return undefined;
	return scrubbed;
}

export function buildCursorToolLifecycleLabel(toolCall: unknown, apiKey?: string): string | undefined {
	const args = getToolArgs(toolCall);
	const name = resolveTranscriptToolName(getToolName(toolCall), args);
	const normalized = normalizeToolName(name).toLowerCase();

	switch (normalized) {
		case "task": {
			return scrubLifecycleDetail(getString(args, "description"), apiKey) ?? "task";
		}
		case "shell": {
			return "shell";
		}
		case "mcp": {
			return scrubLifecycleDetail(getString(args, "toolName"), apiKey) ?? "mcp";
		}
		case "generateimage": {
			return scrubLifecycleDetail(getString(args, "prompt") ?? getString(args, "description"), apiKey) ?? "image generation";
		}
		case "recordscreen": {
			return scrubLifecycleDetail(getString(args, "mode"), apiKey) ?? "screen recording";
		}
		case "semsearch": {
			return scrubLifecycleDetail(getString(args, "query"), apiKey) ?? "semantic search";
		}
		case "websearch": {
			return scrubLifecycleDetail(extractWebSearchQuery(args), apiKey) ?? "web search";
		}
		case "webfetch": {
			return "web fetch";
		}
		case "createplan": {
			const plan = getString(args, "plan");
			return scrubLifecycleDetail(plan ? firstNonEmptyLine(plan) ?? plan : undefined, apiKey) ?? "plan";
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
