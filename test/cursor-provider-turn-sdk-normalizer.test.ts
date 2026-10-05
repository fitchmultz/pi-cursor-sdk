import { describe, expect, it, vi } from "vitest";
import { resolveCursorToolCompletion } from "../src/cursor-provider-turn-sdk-normalizer.js";
import { CursorShellOutputTracker } from "../src/cursor-provider-turn-shell-output.js";
import { CursorToolCompletionLedger } from "../src/cursor-provider-turn-tool-ledger.js";

describe("resolveCursorToolCompletion", () => {
	// Compatibility inputs, not captured or public SDK 1.0.35 callback payloads.
	it.each(["delta", "step"] as const)("reconciles a legacy shell alias in a %s completion with a different ID", source => {
		const ledger = new CursorToolCompletionLedger();
		const shellOutput = new CursorShellOutputTracker();
		ledger.registerStartedToolCall("started-shell", { name: "shell", args: { command: "echo done" } });
		shellOutput.onShellToolStarted("started-shell");
		shellOutput.appendShellOutputDelta({ stream: "stdout", data: "done" });
		const clear = vi.fn();
		const resolution = resolveCursorToolCompletion({
			source, callId: "completed-shell", toolCall: {
				name: "bash", args: { command: "echo done" }, result: { status: "success", value: {} },
			}, ledger, shellOutput, onClearStartedCallId: clear,
		});
		expect(resolution).toMatchObject({ action: "handle", matchedStartedCallId: "started-shell", toolCall: { result: { value: { stdout: "done" } } } });
		expect(clear).toHaveBeenCalledWith("started-shell");
		expect([...ledger.startedToolCallEntries()]).toEqual([]);
	});

	it("keeps started tool args when the completed Cursor update only contains a result", () => {
		const ledger = new CursorToolCompletionLedger();
		const shellOutput = new CursorShellOutputTracker();
		ledger.registerStartedToolCall("read-1", {
			name: "read",
			args: { path: "src/index.ts" },
		});

		const resolution = resolveCursorToolCompletion({
			source: "delta",
			callId: "read-1",
			toolCall: {
				name: "read",
				result: { status: "success", value: { content: "export default" } },
			},
			startedToolCall: ledger.getStartedToolCall("read-1"),
			ledger,
			shellOutput,
		});

		expect(resolution).toMatchObject({
			action: "handle",
			identity: "cursor-tool:read-1",
			source: "started",
		});
		if (resolution.action !== "handle") return;
		expect(resolution.toolCall).toMatchObject({
			name: "read",
			args: { path: "src/index.ts" },
			result: { status: "success", value: { content: "export default" } },
		});
	});

	it("merges shell-output deltas into delta completions", () => {
		const ledger = new CursorToolCompletionLedger();
		const shellOutput = new CursorShellOutputTracker();
		ledger.registerStartedToolCall("shell-1", {
			name: "shell",
			args: { command: "printf done" },
		});
		shellOutput.onShellToolStarted("shell-1");
		shellOutput.appendShellOutputDelta({ stream: "stdout", data: "delta\n" });

		const resolution = resolveCursorToolCompletion({
			source: "delta",
			callId: "shell-1",
			toolCall: {
				name: "shell",
				result: { status: "success", value: { stdout: "", stderr: "" } },
			},
			startedToolCall: ledger.getStartedToolCall("shell-1"),
			ledger,
			shellOutput,
		});

		expect(resolution).toMatchObject({
			action: "handle",
			identity: "cursor-tool:shell-1",
			source: "started",
		});
		if (resolution.action !== "handle") return;
		expect(resolution.toolCall).toMatchObject({
			result: { status: "success", value: { stdout: "delta\n" } },
		});
	});

	it("ignores bridge MCP tool completions after bridge start", () => {
		const ledger = new CursorToolCompletionLedger();
		const shellOutput = new CursorShellOutputTracker();
		ledger.markBridgeStarted("bridge-1");

		const resolution = resolveCursorToolCompletion({
			source: "delta",
			callId: "bridge-1",
			toolCall: { toolName: "pi__run_test" },
			ledger,
			shellOutput,
			liveRun: {
				bridgeRun: { isBridgeMcpToolCall: () => false },
			} as never,
		});

		expect(resolution).toEqual({
			action: "ignore-bridge",
			identity: "cursor-tool:bridge-1",
		});
	});

	it("ignores bridge tool calls detected on the live run", () => {
		const ledger = new CursorToolCompletionLedger();
		const shellOutput = new CursorShellOutputTracker();
		const isBridgeMcpToolCall = vi.fn(() => true);

		const resolution = resolveCursorToolCompletion({
			source: "delta",
			callId: "call-1",
			toolCall: { toolName: "pi__cursor_ask_question" },
			ledger,
			shellOutput,
			liveRun: { bridgeRun: { isBridgeMcpToolCall } } as never,
		});

		expect(resolution.action).toBe("ignore-bridge");
		expect(isBridgeMcpToolCall).toHaveBeenCalled();
	});
});
