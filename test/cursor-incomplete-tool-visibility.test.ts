import { describe, expect, it } from "vitest";
import {
	buildIncompleteCursorToolDisplay,
	buildIncompleteCursorToolRunOutcome,
	formatIncompleteCursorToolReasonText,
	formatIncompleteCursorToolTrace,
	getIncompleteCursorToolActivityTitle,
	resolveIncompleteCursorToolVisibility,
} from "../src/cursor-incomplete-tool-visibility.js";
import { DISCARDED_INCOMPLETE_TOOL_CALL_REASON } from "../src/cursor-sdk-event-debug.js";
import { CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME } from "../src/cursor-replay-tool-details.js";

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

	it("maps SDK run status and abort state into incomplete run outcome", () => {
		expect(buildIncompleteCursorToolRunOutcome({ status: "finished", assistantTextProduced: true })).toEqual({
			reason: DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
			assistantTextProduced: true,
		});
		expect(buildIncompleteCursorToolRunOutcome({ status: "cancelled" })).toEqual({
			reason: "abort",
			assistantTextProduced: false,
		});
		expect(buildIncompleteCursorToolRunOutcome({ status: "finished", signalAborted: true })).toEqual({
			reason: "abort",
			assistantTextProduced: false,
		});
		expect(buildIncompleteCursorToolRunOutcome({ status: "error" })).toEqual({
			reason: "sdk-failure",
			assistantTextProduced: false,
		});
	});

	it("keeps fast local stale-start suppression in the incomplete visibility policy", () => {
		expect(
			resolveIncompleteCursorToolVisibility(
				{ name: "glob", args: { pattern: "src/**/*.ts" } },
				buildIncompleteCursorToolRunOutcome({
					assistantTextProduced: true,
					reason: DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
				}),
			),
		).toBe("debugOnly");
		expect(
			resolveIncompleteCursorToolVisibility(
				{ name: "mcp", args: { toolName: "git" } },
				buildIncompleteCursorToolRunOutcome({
					assistantTextProduced: true,
					reason: DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
				}),
			),
		).toBe("emit");
		expect(
			resolveIncompleteCursorToolVisibility(
				{ name: "glob", args: { pattern: "src/**/*.ts" } },
				buildIncompleteCursorToolRunOutcome({ assistantTextProduced: true, reason: "abort" }),
			),
		).toBe("emit");
	});

	it("treats a stale shell start as debug-only only after a successful text-producing turn", () => {
		const missingCompletionWithText = buildIncompleteCursorToolRunOutcome({
			assistantTextProduced: true,
			reason: DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
		});
		for (const toolCall of [
			{ name: "shell", args: { command: "echo ok" } },
			{ name: "bash", args: { command: "echo ok" } },
			{ name: "run_terminal_cmd", args: { command: "echo ok" } },
		]) {
			expect(resolveIncompleteCursorToolVisibility(toolCall, missingCompletionWithText)).toBe("debugOnly");
		}
		expect(
			resolveIncompleteCursorToolVisibility(
				{ name: "shell", args: { command: "echo ok" } },
				buildIncompleteCursorToolRunOutcome({
					assistantTextProduced: false,
					reason: DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
				}),
			),
		).toBe("emit");
		expect(
			resolveIncompleteCursorToolVisibility(
				{ name: "shell", args: { command: "echo ok" } },
				buildIncompleteCursorToolRunOutcome({ assistantTextProduced: true, reason: "abort" }),
			),
		).toBe("emit");
		expect(
			resolveIncompleteCursorToolVisibility(
				{ name: "shell", args: { command: "echo ok" } },
				buildIncompleteCursorToolRunOutcome({ assistantTextProduced: true, reason: "sdk-failure" }),
			),
		).toBe("emit");
		expect(
			resolveIncompleteCursorToolVisibility(
				{ name: "edit", args: { path: "README.md" } },
				missingCompletionWithText,
			),
		).toBe("emit");
	});

	it("labels incomplete generateImage as activity instead of a generateImage result card", () => {
		const display = buildIncompleteCursorToolDisplay(
			{ name: "generateImage", args: { prompt: "a red circle" } },
			DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
		);
		expect(display.result.details).toMatchObject({
			variant: "activity",
			sourceToolName: CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME,
			title: "Cursor image generation did not complete",
			summary: "missing completion",
		});
		expect(formatIncompleteCursorToolTrace(display)).toContain(
			"Cursor image generation did not complete: missing completion",
		);
	});

	it("maps discard reasons to bounded user-facing text", () => {
		expect(formatIncompleteCursorToolReasonText("abort")).toBe("aborted");
		expect(formatIncompleteCursorToolReasonText("sdk-failure")).toBe("SDK run failed");
		expect(formatIncompleteCursorToolReasonText("run-drain")).toBe("run ended during drain");
	});
});
