import { describe, expect, it } from "vitest";
import {
	CursorShellOutputTracker,
	formatCursorShellOutputProgressText,
} from "../src/cursor-provider-turn-shell-output.js";

describe("CursorShellOutputTracker", () => {
	it("buffers stdout/stderr for a single active shell call", () => {
		const tracker = new CursorShellOutputTracker();
		tracker.onShellToolStarted("shell-1");
		expect(tracker.appendShellOutputDelta({ stream: "stdout", data: "line one\n" })).toEqual({
			callId: "shell-1",
			stream: "stdout",
			data: "line one\n",
		});
		expect(tracker.appendShellOutputDelta({ stream: "stderr", data: "warn\n" })).toEqual({
			callId: "shell-1",
			stream: "stderr",
			data: "warn\n",
		});
		expect(tracker.takeDeltasForCall("shell-1")).toEqual({
			stdout: ["line one\n"],
			stderr: ["warn\n"],
		});
	});

	it("does not count blank shell output chunks against the visible progress budget", () => {
		const tracker = new CursorShellOutputTracker();
		tracker.onShellToolStarted("shell-1");
		expect(tracker.appendShellOutputDelta({ stream: "stdout", data: "\n\n" })).toBeUndefined();
		expect(tracker.appendShellOutputDelta({ stream: "stdout", data: " \t \n" })).toBeUndefined();
		expect(tracker.appendShellOutputDelta({ stream: "stdout", data: "one\n" })).toBeDefined();
		expect(tracker.appendShellOutputDelta({ stream: "stdout", data: "two\n" })).toBeDefined();
		expect(tracker.appendShellOutputDelta({ stream: "stdout", data: "three\n" })).toBeDefined();
		expect(tracker.appendShellOutputDelta({ stream: "stdout", data: "four\n" })).toBeUndefined();
		expect(tracker.takeDeltasForCall("shell-1")?.stdout.join("")).toBe("\n\n \t \none\ntwo\nthree\nfour\n");
	});
});

describe("formatCursorShellOutputProgressText", () => {
	it("scrubs API keys from shell output progress", () => {
		expect(formatCursorShellOutputProgressText(
			{ callId: "shell-1", stream: "stderr", data: "Bearer secret-key\n" },
			"secret-key",
		)).not.toContain("secret-key");
	});
});
