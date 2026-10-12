import { describe, expect, it } from "vitest";
import { CURSOR_REPLAY_ACTIVITY_TOOL_NAME } from "../src/cursor-tool-presentation-registry.js";
import { buildCursorPiToolDisplay, formatCursorToolTranscript } from "../src/cursor-tool-transcript.js";

describe("cursor web tool activity", () => {
	it.each([
		["WebSearch", "webSearch", "Cursor web search", "web search", { query: "pi mathematics" }, "pi mathematics"],
		["web_search", "webSearch", "Cursor web search", "web search", { query: "pi mathematics" }, "pi mathematics"],
		["web-search", "webSearch", "Cursor web search", "web search", { query: "pi mathematics" }, "pi mathematics"],
		["websearch", "webSearch", "Cursor web search", "web search", { query: "pi mathematics" }, "pi mathematics"],
		["WebFetch", "webFetch", "Cursor web fetch", "web fetch", { url: "https://example.com/docs" }, "https://example.com/docs"],
		["web_fetch", "webFetch", "Cursor web fetch", "web fetch", { url: "https://example.com/docs" }, "https://example.com/docs"],
		["web-fetch", "webFetch", "Cursor web fetch", "web fetch", { url: "https://example.com/docs" }, "https://example.com/docs"],
		["webfetch", "webFetch", "Cursor web fetch", "web fetch", { url: "https://example.com/docs" }, "https://example.com/docs"],
	] as const)("displays host tool %s as %s", (name, sourceToolName, title, label, args, summary) => {
		const toolCall = {
			name,
			args,
			result: { status: "success", value: { content: [{ text: { text: "Example Domain" } }] } },
		};
		expect(buildCursorPiToolDisplay(toolCall)).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { ...args, activityTitle: title, activitySummary: summary },
			result: { details: { variant: "activity", sourceToolName, title, summary } },
			isError: false,
		});
		expect(formatCursorToolTranscript(toolCall)).toBe(`${label} ${summary}\n\nExample Domain\n`);
	});

	it.each([
		["WebSearch", "webSearch", "Cursor web search", "web search", { search_term: "pi mathematics" }, { query: "pi mathematics" }, "pi mathematics"],
		["web_search", "webSearch", "Cursor web search", "web search", { search_term: "pi mathematics" }, { query: "pi mathematics" }, "pi mathematics"],
		["WebFetch", "webFetch", "Cursor web fetch", "web fetch", { url: "https://example.com/docs" }, { url: "https://example.com/docs" }, "https://example.com/docs"],
		["web_fetch", "webFetch", "Cursor web fetch", "web fetch", { url: "https://example.com/docs" }, { url: "https://example.com/docs" }, "https://example.com/docs"],
	] as const)("displays MCP tool %s as %s", (name, sourceToolName, title, label, nestedArgs, displayArgs, summary) => {
		for (const key of ["toolName", "tool_name"]) {
			const toolCall = {
				name: "mcp",
				args: { [key]: name, args: nestedArgs },
				result: { status: "success", value: { content: [{ text: { text: "Example Domain" } }] } },
			};
			expect(buildCursorPiToolDisplay(toolCall)).toMatchObject({
				toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
				args: { ...displayArgs, activityTitle: title, activitySummary: summary },
				result: { details: { variant: "activity", sourceToolName, title, summary } },
				isError: false,
			});
			expect(formatCursorToolTranscript(toolCall)).toBe(`${label} ${summary}\n\nExample Domain\n`);
		}
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
			result: { details: { variant: "activity", sourceToolName: "webSearch", title: "Cursor web search" } },
		});
		expect(formatCursorToolTranscript(toolCall)).toContain("web search typescript sdk");
	});
});
