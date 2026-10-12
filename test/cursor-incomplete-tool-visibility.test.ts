import { describe, expect, it } from "vitest";
import {
	buildIncompleteCursorToolDisplay,
	buildIncompleteCursorToolRunOutcome,
	formatIncompleteCursorToolReasonText,
	formatIncompleteCursorToolTrace,
	getIncompleteCursorToolActivityTitle,
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
