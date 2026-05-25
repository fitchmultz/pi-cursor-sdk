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
	it("classifies host and MCP web tool names separately from semSearch", () => {
		expect(classifyCursorWebToolKind("WebSearch")).toBe("webSearch");
		expect(classifyCursorWebToolKind("web_fetch")).toBe("webFetch");
		expect(classifyCursorWebToolKind("semSearch")).toBeUndefined();
		expect(resolveTranscriptToolName("semSearch", {})).toBe("semSearch");
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
		expect(formatCursorToolTranscript(toolCall)).toContain("web search pi mathematics");
		expect(formatCursorToolTranscript(toolCall)).toContain("Example Domain");
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
	});
});
