import { describe, expect, it } from "vitest";
import {
	classifyCursorWebToolKind,
	extractWebFetchTarget,
	extractWebSearchQuery,
	resolveTranscriptToolName,
} from "../src/cursor-web-tool-activity.js";
import { buildCursorPiToolDisplay, formatCursorToolTranscript } from "../src/cursor-tool-transcript.js";
import { CURSOR_REPLAY_ACTIVITY_TOOL_NAME } from "../src/cursor-tool-names.js";

describe("cursor web tool activity", () => {
	it.each([
		["WebSearch", "webSearch"],
		["web_search", "webSearch"],
		["web-search", "webSearch"],
		["websearch", "webSearch"],
		["WebFetch", "webFetch"],
		["web_fetch", "webFetch"],
		["web-fetch", "webFetch"],
		["webfetch", "webFetch"],
	])("classifies host tool name %s as %s", (name, expected) => {
		expect(classifyCursorWebToolKind(name)).toBe(expected);
		expect(resolveTranscriptToolName(name, {})).toBe(expected);
	});

	it.each([
		["WebSearch", "webSearch"],
		["web_search", "webSearch"],
		["WebFetch", "webFetch"],
		["web_fetch", "webFetch"],
	])("reclassifies MCP toolName %s to %s display", (mcpToolName, expected) => {
		expect(resolveTranscriptToolName("mcp", { toolName: mcpToolName })).toBe(expected);
		expect(resolveTranscriptToolName("mcp", { tool_name: mcpToolName })).toBe(expected);
	});

	it("keeps semSearch separate from web search", () => {
		expect(classifyCursorWebToolKind("semSearch")).toBeUndefined();
		expect(resolveTranscriptToolName("semSearch", {})).toBe("semSearch");
	});

	it("leaves non-web MCP tools on the generic mcp path", () => {
		expect(resolveTranscriptToolName("mcp", { toolName: "git" })).toBe("mcp");
	});

	it("reclassifies MCP WebSearch completions to webSearch display", () => {
		const toolCall = {
			name: "mcp",
			args: { toolName: "WebSearch", args: { search_term: "pi mathematics" } },
			result: {
				status: "success",
				value: { content: [{ text: { text: "Example Domain\nhttps://example.com" } }], isError: false },
			},
		};

		expect(resolveTranscriptToolName("mcp", toolCall.args)).toBe("webSearch");
		expect(extractWebSearchQuery(toolCall.args)).toBe("pi mathematics");

		const display = buildCursorPiToolDisplay(toolCall);
		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { query: "pi mathematics", activityTitle: "Cursor web search", activitySummary: "pi mathematics" },
			result: { details: { cursorToolName: "webSearch", title: "Cursor web search", summary: "web search pi mathematics" } },
			isError: false,
		});
		expect(display.args).not.toMatchObject({ activityTitle: "Cursor MCP" });
		expect(formatCursorToolTranscript(toolCall)).toContain("web search pi mathematics");
		expect(formatCursorToolTranscript(toolCall)).toContain("Example Domain");
	});

	it("formats MCP web_search completions as Cursor web search activity", () => {
		const toolCall = {
			name: "mcp",
			args: { toolName: "web_search", args: { query: "typescript sdk" } },
			result: { status: "success", value: { content: [{ text: { text: "SDK docs" } }], isError: false } },
		};

		const display = buildCursorPiToolDisplay(toolCall);
		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { query: "typescript sdk", activityTitle: "Cursor web search", activitySummary: "typescript sdk" },
			result: { details: { cursorToolName: "webSearch", title: "Cursor web search" } },
		});
		expect(formatCursorToolTranscript(toolCall)).toContain("web search typescript sdk");
	});

	it("formats host WebFetch completions as Cursor web fetch activity", () => {
		const toolCall = {
			name: "WebFetch",
			args: { url: "https://example.com" },
			result: {
				status: "success",
				value: { content: [{ text: { text: "Example Domain" } }], isError: false },
			},
		};

		expect(resolveTranscriptToolName("WebFetch", toolCall.args)).toBe("webFetch");
		expect(extractWebFetchTarget(toolCall.args)).toBe("https://example.com");

		const display = buildCursorPiToolDisplay(toolCall);
		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { url: "https://example.com", activityTitle: "Cursor web fetch", activitySummary: "https://example.com" },
			result: { details: { cursorToolName: "webFetch", title: "Cursor web fetch" } },
		});
		expect(display.args).not.toMatchObject({ activityTitle: "Cursor MCP" });
	});

	it("formats MCP web_fetch completions as Cursor web fetch activity", () => {
		const toolCall = {
			name: "mcp",
			args: { toolName: "web_fetch", args: { url: "https://example.org/page" } },
			result: { status: "success", value: { content: [{ text: { text: "Fetched page" } }], isError: false } },
		};

		const display = buildCursorPiToolDisplay(toolCall);
		expect(display).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { url: "https://example.org/page", activityTitle: "Cursor web fetch", activitySummary: "https://example.org/page" },
			result: { details: { cursorToolName: "webFetch", title: "Cursor web fetch" } },
		});
		expect(formatCursorToolTranscript(toolCall)).toContain("web fetch https://example.org/page");
	});
});
