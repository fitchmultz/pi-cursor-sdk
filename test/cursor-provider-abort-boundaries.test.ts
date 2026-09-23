import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import type { SendOptions } from "@cursor/sdk";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamCursor, __testUtils } from "../src/cursor-provider.js";
import {
	asMockCursorRun, collectEvents, collectTextDeltas, getDoneEvent, getErrorEvent, makeContext, makeModel,
	mockCreatedAgent, registerNativeToolDisplayForTest, resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("AbortSignal during native tool-batch drain", () => {
	beforeEach(resetCursorProviderTestState);
	afterEach(async () => {
		vi.restoreAllMocks();
		await __testUtils.releaseAllPendingCursorLiveRunsForTests();
		await __testUtils.resetSessionCursorAgents();
	});

	it.each([false, true])("keeps cancellation connected until the SDK run settles (finished=%s)", async (finished) => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await registerNativeToolDisplayForTest([]);
		const controller = new AbortController();
		const finishSdk = gate();
		const cancel = vi.fn(async () => { finishSdk.resolve(); });
		const removeListener = vi.spyOn(controller.signal, "removeEventListener");
		mockCreatedAgent({
			send: vi.fn(async (_message: unknown, options: SendOptions = {}) => {
				await options.onDelta?.({ update: {
					type: "tool-call-completed", callId: "read-1", modelCallId: "model-1",
					toolCall: { type: "read", args: { path: "fixture.txt" }, result: { status: "success", value: { content: "RECORDED", fileSize: 8, totalLines: 1 } } },
				} });
				return asMockCursorRun({
					id: "run-1", agentId: "agent-1", status: "running",
					wait: async () => {
						await finishSdk.promise;
						return { id: "run-1", status: "finished" as const, result: "done" };
					},
					cancel,
				});
			}),
		});

		try {
			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal }));
			expect(getDoneEvent(events).reason).toBe("toolUse");
			expect(__testUtils.pendingCursorNativeRunCount()).toBe(1);
			if (finished) {
				removeListener.mockClear();
				finishSdk.resolve();
				await vi.waitFor(() => expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function)));
			}
			controller.abort();
			expect(cancel).toHaveBeenCalledTimes(finished ? 0 : 1);
		} finally {
			finishSdk.resolve();
		}
	});

	it.each([
		{ completed: true, next: "Next", expected: "Working\n\nNext" },
		{ completed: false, next: "Next", expected: "WorkingNext" },
		{ completed: true, next: "", expected: "Working" },
	])("preserves same-partial output (completed=$completed, next='$next')", async ({ completed, next, expected }) => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await registerNativeToolDisplayForTest([]);
		const controller = new AbortController();
		const settling = gate();
		const resumeSettling = gate();
		const workingEmitted = gate();
		const finishSdk = gate();
		// The queue starts with text, so the initial pre-drain settle is a no-op.
		// Hold the real tool-batch wait after Working/completion have been consumed;
		// abort at that synchronization point, not after a guessed wall-clock delay.
		vi.spyOn(scheduler, "wait").mockImplementation(async () => {
			settling.resolve();
			await resumeSettling.promise;
		});
		mockCreatedAgent({
			send: vi.fn(async (_message: unknown, options: SendOptions = {}) => {
				await options.onDelta?.({ update: { type: "text-delta", text: "Working" } });
				if (completed) await options.onStep?.({ step: { type: "assistantMessage", message: { text: "Working" } } });
				await options.onDelta?.({ update: {
					type: "tool-call-started", callId: "read-1", modelCallId: "model-1",
					toolCall: { type: "read", args: { path: "fixture.txt" } },
				} });
				await options.onDelta?.({ update: {
					type: "tool-call-completed", callId: "read-1", modelCallId: "model-1",
					toolCall: { type: "read", args: { path: "fixture.txt" }, result: { status: "success", value: { content: "RECORDED", fileSize: 8, totalLines: 1 } } },
				} });
				if (next) {
					await options.onDelta?.({ update: { type: "text-delta", text: next } });
					await options.onStep?.({ step: { type: "assistantMessage", message: { text: completed ? next : `Working${next}` } } });
				}
				return asMockCursorRun({
					id: "run-1", agentId: "agent-1", status: "running",
					wait: vi.fn(async () => {
						await finishSdk.promise;
						return { id: "run-1", status: "finished" as const, result: "WAIT_RESULT_MUST_NOT_APPEAR" };
					}),
					cancel: vi.fn().mockResolvedValue(undefined),
				});
			}),
		});

		const root = mkdtempSync(join(tmpdir(), "pi-abort-boundary-"));
		const events: AssistantMessageEvent[] = [];
		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal });
		const consumed = (async () => {
			for await (const event of stream) {
				events.push(event);
				if (event.type === "text_delta" && event.delta === "Working") workingEmitted.resolve();
			}
		})();
		try {
			await Promise.all([settling.promise, workingEmitted.promise]);
			expect(collectTextDeltas(events)).toBe("Working");
			expect(events.some((event) => event.type === "toolcall_start")).toBe(false);
			controller.abort();
			finishSdk.resolve();
			resumeSettling.resolve();
			await consumed;

			const error = getErrorEvent(events);
			expect(error.reason).toBe("aborted");
			expect(error.error.stopReason).toBe("aborted");
			expect(events.some((event) => event.type === "done" || event.type === "toolcall_start")).toBe(false);
			// Persist the actual terminal provider message through native SessionManager,
			// then use the same real host accessor as get_last_assistant_text RPC.
			const session = SessionManager.create(root, root);
			session.appendMessage({ role: "user", content: "probe", timestamp: 1 });
			session.appendMessage(error.error);
			const rows = readFileSync(session.getSessionFile()!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const persisted = rows.find((row) => row.type === "message" && row.message.role === "assistant").message as AssistantMessage;
			const rpcText = AgentSession.prototype.getLastAssistantText.call({ messages: [persisted] } as AgentSession);
			expect({
				streamed: collectTextDeltas(events),
				persistedText: persisted.content.filter((block) => block.type === "text").map((block) => block.text).join(""),
				rpcText,
				stopReason: persisted.stopReason,
			}).toEqual({ streamed: expected, persistedText: expected, rpcText: expected, stopReason: "aborted" });
		} finally {
			controller.abort();
			finishSdk.resolve();
			resumeSettling.resolve();
			await consumed;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
