import { normalizeToolName } from "./cursor-transcript-utils.js";

export type CursorWebToolKind = "webSearch" | "webFetch";

const WEB_SEARCH_NAME_PATTERN =
	/^(?:web[-_ ]?search|search[-_ ]?web|websearch|browser[-_ ]?search|cursor[-_ ]?web[-_ ]?search)$/i;
const WEB_FETCH_NAME_PATTERN =
	/^(?:web[-_ ]?fetch|fetch[-_ ]?web|webfetch|browser[-_ ]?fetch|fetch[-_ ]?url|cursor[-_ ]?web[-_ ]?fetch)$/i;

function normalizeWebToolLookupName(name: string): string {
	return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export function classifyCursorWebToolKind(name: string | undefined): CursorWebToolKind | undefined {
	if (!name) return undefined;
	const normalized = normalizeWebToolLookupName(name);
	if (WEB_SEARCH_NAME_PATTERN.test(normalized) || normalized === "websearch" || normalized === "web_search") {
		return "webSearch";
	}
	if (WEB_FETCH_NAME_PATTERN.test(normalized) || normalized === "webfetch" || normalized === "web_fetch") {
		return "webFetch";
	}
	return undefined;
}

function getNestedMcpArgs(args: Record<string, unknown>): Record<string, unknown> {
	const nested = args.args;
	return nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {};
}

function getMcpToolName(args: Record<string, unknown>): string | undefined {
	const toolName = typeof args.toolName === "string" ? args.toolName : typeof args.tool_name === "string" ? args.tool_name : undefined;
	const trimmed = toolName?.trim();
	return trimmed || undefined;
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

export function extractWebSearchQuery(args: Record<string, unknown>): string | undefined {
	const nested = getNestedMcpArgs(args);
	return firstNonEmptyString(
		typeof args.search_term === "string" ? args.search_term : undefined,
		typeof args.searchTerm === "string" ? args.searchTerm : undefined,
		typeof args.query === "string" ? args.query : undefined,
		typeof args.q === "string" ? args.q : undefined,
		typeof nested.search_term === "string" ? nested.search_term : undefined,
		typeof nested.searchTerm === "string" ? nested.searchTerm : undefined,
		typeof nested.query === "string" ? nested.query : undefined,
		typeof nested.q === "string" ? nested.q : undefined,
	);
}

export function extractWebFetchTarget(args: Record<string, unknown>): string | undefined {
	const nested = getNestedMcpArgs(args);
	return firstNonEmptyString(
		typeof args.url === "string" ? args.url : undefined,
		typeof args.uri === "string" ? args.uri : undefined,
		typeof args.href === "string" ? args.href : undefined,
		typeof nested.url === "string" ? nested.url : undefined,
		typeof nested.uri === "string" ? nested.uri : undefined,
		typeof nested.href === "string" ? nested.href : undefined,
	);
}

/**
 * Maps SDK/host/MCP tool names to transcript display keys.
 * Web search/fetch often arrives as MCP `toolName` values, not dedicated SDK ToolTypes.
 */
export function resolveTranscriptToolName(rawName: string, args: Record<string, unknown>): string {
	const normalized = normalizeToolName(rawName);
	const directWebKind = classifyCursorWebToolKind(rawName) ?? classifyCursorWebToolKind(normalized);
	if (directWebKind) return directWebKind;
	if (normalized === "mcp") {
		const mcpWebKind = classifyCursorWebToolKind(getMcpToolName(args));
		if (mcpWebKind) return mcpWebKind;
	}
	return normalized;
}
