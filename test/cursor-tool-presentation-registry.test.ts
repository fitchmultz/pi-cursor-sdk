import { describe, expect, it } from "vitest";
import { CURSOR_REPLAY_SOURCE_TOOL_NAMES } from "../src/cursor-replay-source-names.js";
import {
	CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
	classifyCursorWebToolKind,
	getCursorToolActivityTitle,
	getCursorReplayCallSummary,
	getCursorToolVisibilityPolicy,
	isExcludedFromCursorBridgeExposure,
	isCursorReplayToolName,
	normalizeCursorToolName,
} from "../src/cursor-tool-presentation-registry.js";

describe("cursor tool presentation registry", () => {
	it("defines a presentation spec for every replay source tool name", () => {
		for (const name of CURSOR_REPLAY_SOURCE_TOOL_NAMES) expect(getCursorToolVisibilityPolicy(name), name).toBeDefined();
	});

	it("excludes only the canonical neutral replay tool from bridge exposure", () => {
		expect(isCursorReplayToolName(CURSOR_REPLAY_ACTIVITY_TOOL_NAME)).toBe(true);
		expect(isExcludedFromCursorBridgeExposure(CURSOR_REPLAY_ACTIVITY_TOOL_NAME)).toBe(true);
		for (const toolName of ["oldCursorEdit", "oldCursorWrite", "oldCursorMcp", "oldCursorSearch"]) {
			expect(isCursorReplayToolName(toolName)).toBe(false);
			expect(isExcludedFromCursorBridgeExposure(toolName)).toBe(false);
		}
		expect(isExcludedFromCursorBridgeExposure("read")).toBe(false);
		expect(isExcludedFromCursorBridgeExposure("bash")).toBe(false);
		expect(isExcludedFromCursorBridgeExposure("edit")).toBe(false);
		expect(isExcludedFromCursorBridgeExposure("write")).toBe(false);
	});

	it("sanitizes and truncates fallback activity titles for unknown tools", () => {
		const longName = "x".repeat(200);
		const truncatedSegment = `${"x".repeat(119)}…`;
		expect(getCursorToolActivityTitle(longName)).toBe(`Cursor ${truncatedSegment}`);
		expect(getCursorToolActivityTitle("foo\nbar\tbaz")).toBe("Cursor foo bar baz");
		expect(getCursorToolActivityTitle("unknown")).toBe("Cursor tool");
		expect(getCursorToolActivityTitle("read")).toBe("Cursor read");
	});

	it("normalizes aliases from the registry", () => {
		expect(normalizeCursorToolName("read_file")).toBe("read");
		expect(normalizeCursorToolName("run_terminal_cmd")).toBe("shell");
		expect(normalizeCursorToolName("web_search")).toBe("webSearch");
		expect(normalizeCursorToolName("str_replace")).toBe("edit");
	});

	it("classifies web tools from current registry patterns", () => {
		expect(classifyCursorWebToolKind("web-search")).toBe("webSearch");
		expect(classifyCursorWebToolKind("WebFetch")).toBe("webFetch");
		expect(classifyCursorWebToolKind("oldCursorWebFetch")).toBeUndefined();
		expect(classifyCursorWebToolKind("grep")).toBeUndefined();
	});

	it("derives replay call summaries from registry display policy", () => {
		expect(getCursorReplayCallSummary(CURSOR_REPLAY_ACTIVITY_TOOL_NAME, { activitySummary: "summary", toolName: "custom" })).toBe("summary");
		expect(getCursorReplayCallSummary(CURSOR_REPLAY_ACTIVITY_TOOL_NAME, { toolName: "custom" })).toBe("custom");
		expect(getCursorReplayCallSummary("semSearch", { query: "main", targetDirectories: ["src"] })).toBe("main (1 dir)");
		expect(getCursorReplayCallSummary("mcp", { toolName: "git", preview: "status" })).toBe("git · status");
	});
});
