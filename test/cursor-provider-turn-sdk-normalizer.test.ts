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
		expect(resolveCursorToolCompletion({
			source: "delta", callId: "bridge-1", toolCall: { toolName: "pi__run_test" }, ledger, shellOutput,
		}).action).toBe("handle");
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
