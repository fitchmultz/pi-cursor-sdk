import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState,
	makeModel,
	makeContext,
	collectEvents,
	collectTextDeltas,
	collectThinkingDeltas,
	getEventsOfType,
	getDoneEvent,
	isCursorToolStreamEvent,
	type CursorDeltaHandler,
	mockCreatedAgent,
	asMockCursorRun,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import type { SendOptions } from "@cursor/sdk";

type CursorOnStepPayload = Parameters<NonNullable<SendOptions["onStep"]>>[0];


describe("streamCursor tool trace", () => {
	beforeEach(resetCursorProviderTestState);

		it("surfaces cursor tool results as pi-like trace transcript without polluting final text", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "read",
							result: { status: "success", value: { content: "# pi-cursor-sdk\n\nReadme body", totalLines: 3, fileSize: 29 } },
						},
						callId: "c1",
					},
				});
				opts.onDelta({ update: { type: "summary", summary: "Inspected files" } });
				opts.onDelta({ update: { type: "text-delta", text: "done" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);
			const trace = collectThinkingDeltas(events);
			const text = collectTextDeltas(events);
			const done = getDoneEvent(events);

			expect(trace).toContain("read README.md");
			expect(trace).toContain("# pi-cursor-sdk");
			expect(trace).not.toContain("Cursor tool: read started");
			expect(trace).not.toContain("call c1");
			expect(trace).toContain("Cursor summary: Inspected files");
			expect(text).toBe("done");
			expect(events.filter(isCursorToolStreamEvent)).toHaveLength(0);
			expect(done.message.content.map((block) => block.type)).toEqual(["thinking", "thinking", "text"]);
		});

		it("uses Cursor onStep tool-call results when delta tool completion is absent", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onStep: (a: unknown) => void }) => {
				opts.onStep({
					step: {
						type: "toolCall",
						message: {
							type: "read",
							args: { path: "README.md" },
							result: { status: "success", value: { content: "# pi-cursor-sdk" } },
						},
					} as CursorOnStepPayload["step"],
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);
			const trace = collectThinkingDeltas(events);

			expect(trace).toContain("read README.md");
			expect(trace).toContain("# pi-cursor-sdk");
		});

		it("does not mark a started tool incomplete when onStep reports its result without a completion delta", async () => {
			mockCreatedAgent({ send: vi.fn(async (_msg: unknown, opts: SendOptions = {}) => {
				await opts.onDelta?.({ update: {
					type: "tool-call-started", callId: "shell-1", modelCallId: "model-shell-1",
					toolCall: { type: "shell", args: { command: "echo completed" } },
				} });
				await opts.onStep?.({ step: { type: "toolCall", message: {
					type: "shell", args: { command: "echo completed" },
					result: { status: "success", value: { stdout: "completed\n", stderr: "", exitCode: 0, signal: "", executionTime: 1 } },
				} } });
				return asMockCursorRun({ id: "run-1", agentId: "agent-1", status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
				});
			}) });
			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const trace = collectThinkingDeltas(events);
			expect(trace).toContain("$ echo completed");
			expect(trace).toContain("completed\n");
			expect(trace).not.toContain("did not complete");
		});

		it("renders a completed tool call re-delivered with the same call ID once", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
				for (let delivery = 0; delivery < 2; delivery++) {
					opts.onDelta({
						update: {
							type: "tool-call-completed",
							toolCall: { name: "read", result: { status: "success", value: { content: "# pi-cursor-sdk" } } },
							callId: "c1",
						},
					});
				}
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const trace = collectThinkingDeltas(await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" })));

			expect(trace.match(/read README\.md/g)).toHaveLength(1);
			expect(trace.match(/# pi-cursor-sdk/g)).toHaveLength(1);
		});

		it("streams Cursor text deltas live and only falls back to final result when no deltas arrive", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "text-delta", text: "Final " } });
				opts.onDelta({ update: { type: "text-delta", text: "answer." } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Final answer." }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);
			const text = collectTextDeltas(events);

			expect(text).toBe("Final answer.");
			expect(getEventsOfType(events, "text_delta")).toHaveLength(2);
			expect(getDoneEvent(events).reason).toBe("stop");
		});

		it("trims same-turn final text when streamed text is only a word prefix", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "text-delta", text: "Disconnect" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Disconnecting the CDP session..." }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const text = collectTextDeltas(events);
			const done = getDoneEvent(events);

			expect(text).toBe("Disconnecting the CDP session...");
			expect(done.message.content).toEqual([{ type: "text", text: "Disconnecting the CDP session..." }]);
		});

		it("omits raw cursor call ids while rendering completed cursor tools", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-started",
						toolCall: { name: "shell", args: { command: "date" } },
						callId: "call_abc\nfc_secret",
					},
				});
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "shell",
							result: { status: "success", value: { stdout: "Sat May  9\n", stderr: "", exitCode: 0, executionTime: 12 } },
						},
						callId: "call_abc\nfc_secret",
					},
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);
			const trace = collectThinkingDeltas(events);

			expect(trace).toContain("$ date\n");
			expect(trace).toContain("Sat May  9");
			expect(trace).toContain("Took 0.0s");
			expect(trace).not.toContain("call_abc");
			expect(trace).not.toContain("fc_secret");
		});

		it.each([true, false])("keeps distinct completed tool calls with identical display payloads (started=%s)", async (started) => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				for (const callId of ["c1", "c2"]) {
					if (started) opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "date" } }, callId } });
					opts.onDelta({
						update: {
							type: "tool-call-completed",
							toolCall: {
								name: "shell",
								...(started ? {} : { args: { command: "date" } }),
								result: { status: "success", value: { stdout: "Thu May 14\n", stderr: "", exitCode: 0 } },
							},
							callId,
						},
					});
				}
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);
			const trace = collectThinkingDeltas(events);

			expect(trace.match(/\$ date/g)).toHaveLength(2);
			expect(trace.match(/Thu May 14/g)).toHaveLength(2);
		});

		it("scrubs secrets from cursor tool transcript output", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "secrets.txt" } }, callId: "c1" } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "read",
							result: {
								status: "success",
								value: { content: "token=super-secret-key-12345\nAuthorization: Bearer bearer-token-value" },
							},
						},
						callId: "c1",
					},
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "super-secret-key-12345" });
			const events = await collectEvents(stream);
			const trace = collectThinkingDeltas(events);

			expect(trace).toContain("read secrets.txt");
			expect(trace).toContain("[redacted]");
			expect(trace).not.toContain("super-secret-key-12345");
			expect(trace).not.toContain("bearer-token-value");
		});

});
