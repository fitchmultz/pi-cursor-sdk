import { describe, expect, it } from "vitest";
import {
	buildIncompleteCursorToolDisplay,
	formatIncompleteCursorToolReasonText,
	formatIncompleteCursorToolTrace,
	getIncompleteCursorToolActivityTitle,
} from "../src/cursor-incomplete-tool-visibility.js";
import { DISCARDED_INCOMPLETE_TOOL_CALL_REASON } from "../src/cursor-sdk-event-debug.js";

describe("cursor incomplete tool visibility", () => {
	it("labels ordinary native Cursor tools", () => {
		expect(getIncompleteCursorToolActivityTitle({ name: "read", args: { path: "README.md" } })).toBe("Cursor read");
		const display = buildIncompleteCursorToolDisplay(
			{ name: "read", args: { path: "README.md" } },
			DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
		);
		expect(formatIncompleteCursorToolTrace(display)).toContain("Cursor read did not complete: missing completion");
	});

	it("labels web search MCP activity distinctly from generic MCP", () => {
		const webSearchDisplay = buildIncompleteCursorToolDisplay(
			{ name: "mcp", args: { toolName: "WebSearch", args: { search_term: "pi extension" } } },
			DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
		);
		expect(webSearchDisplay.args.activityTitle).toBe("Cursor web search");
		expect(formatIncompleteCursorToolTrace(webSearchDisplay)).toContain("Cursor web search did not complete");

		const mcpDisplay = buildIncompleteCursorToolDisplay(
			{ name: "mcp", args: { toolName: "git" } },
			DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
		);
		expect(mcpDisplay.args.activityTitle).toBe("Cursor MCP");
		expect(formatIncompleteCursorToolTrace(mcpDisplay)).toContain("Cursor MCP did not complete");
	});

	it("maps discard reasons to bounded user-facing text", () => {
		expect(formatIncompleteCursorToolReasonText("abort")).toBe("aborted");
		expect(formatIncompleteCursorToolReasonText("sdk-failure")).toBe("SDK run failed");
		expect(formatIncompleteCursorToolReasonText("run-drain")).toBe("run ended during drain");
	});
});
