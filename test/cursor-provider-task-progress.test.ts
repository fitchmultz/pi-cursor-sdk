import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState,
	makeModel,
	makeContext,
	collectEvents,
	collectThinkingDeltas,
	collectTextDeltas,
	getDoneEvent,
	isToolCallBlock,
	registerNativeToolDisplayForTest,
	createExtensionTestContext,
	mockCreatedAgent,
	type CursorDeltaHandler,
	type RegisteredTool,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { installCursorProviderVirtualTime } from "./helpers/cursor-provider-virtual-time.js";

const delayBeforeToolCompletion = () => vi.advanceTimersByTimeAsync(120);

describe("streamCursor Cursor task progress", () => {
	beforeEach(resetCursorProviderTestState);
	installCursorProviderVirtualTime();

	it("surfaces SDK task descriptions as thinking progress before completion in native replay", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "task", args: { description: "Explore AI/automation projects" } },
					callId: "task-1",
				},
			});
			await delayBeforeToolCompletion();
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "task",
						args: { description: "Explore AI/automation projects" },
						result: { status: "success", value: { description: "Explore AI/automation projects", result: { success: { stdout: "done" } } } },
					},
					callId: "task-1",
				},
			});
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockCreatedAgent({ send: mockSend });

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(firstEvents);
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(trace).toContain("Cursor subagent: Explore AI/automation projects");
		expect(trace).not.toContain("Cursor tool: task started");
		expect(firstDone.reason).toBe("toolUse");
		expect(toolCall?.name).toBe("cursor");
		expect(firstEvents.findIndex((event) => event.type === "thinking_delta" && event.delta.includes("Cursor subagent:"))).toBeLessThan(
			firstEvents.findIndex((event) => event.type === "toolcall_start"),
		);

		resolveRun({ id: "run-1", status: "finished", result: "Final answer." });
		const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
		const toolResult = await cursorTool!.execute(
			toolCall!.id,
			toolCall!.arguments,
			undefined,
			undefined,
			createExtensionTestContext(),
		);

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall!.id,
				toolName: "cursor",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];
		const finalEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		expect(getDoneEvent(finalEvents).reason).toBe("stop");
		expect(collectTextDeltas(finalEvents)).toBe("Final answer.");
	});

	it("can preserve SDK task wording through the experiment opt-out", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		process.env.PI_CURSOR_TASK_PRESENTATION = "task";
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "task", args: { description: "Review API auth flow" } },
					callId: "task-1",
				},
			});
			await delayBeforeToolCompletion();
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "task",
						args: { description: "Review API auth flow" },
						result: { status: "success", value: { description: "Review API auth flow" } },
					},
					callId: "task-1",
				},
			});
			opts.onDelta({ update: { type: "text-delta", text: "done" } });
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockCreatedAgent({ send: mockSend });

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("Cursor task: Review API auth flow");
		expect(trace).not.toContain("Cursor subagent: Review API auth flow");
	});

	it("does not emit task progress for normal read or bash starts", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "read-1" } });
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "bash-1" } });
			await delayBeforeToolCompletion();
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "read", result: { status: "success", value: { content: "readme" } } },
					callId: "read-1",
				},
			});
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "bash", result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } } },
					callId: "bash-1",
				},
			});
			opts.onDelta({ update: { type: "text-delta", text: "done" } });
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockCreatedAgent({ send: mockSend });

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(trace).not.toContain("Cursor task:");
		expect(trace).not.toContain("Cursor subagent:");
		expect(trace).not.toContain("Cursor tool: read started");
		expect(trace).not.toContain("Cursor tool: bash started");
		expect(trace).not.toMatch(/Cursor (read|grep|glob):/);
		expect(trace).toContain("read README.md");
		expect(trace).toContain("Cursor shell: git status");
	});

	it("deduplicates repeated partial and started updates for the same task call ID", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "partial-tool-call",
					toolCall: { name: "task", args: { description: "Explore AI/automation projects" } },
					callId: "task-1",
					modelCallId: "model-1",
				},
			});
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "task", args: { description: "Explore AI/automation projects" } },
					callId: "task-1",
				},
			});
			opts.onDelta({
				update: {
					type: "partial-tool-call",
					toolCall: { name: "task", args: { description: "Explore AI/automation projects" } },
					callId: "task-1",
					modelCallId: "model-1",
				},
			});
			await delayBeforeToolCompletion();
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "task",
						args: { description: "Explore AI/automation projects" },
						result: { status: "success", value: { description: "Explore AI/automation projects" } },
					},
					callId: "task-1",
				},
			});
			opts.onDelta({ update: { type: "text-delta", text: "done" } });
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockCreatedAgent({ send: mockSend });

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);
		const progressMatches = trace.match(/Cursor subagent: Explore AI\/automation projects/g) ?? [];

		expect(progressMatches).toHaveLength(1);
	});

	it("scrubs and bounds task progress labels", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		const secretKey = "cursor-task-secret-key-123";
		const longDescription = `Bearer ${secretKey} ${"x".repeat(300)}`;
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "task", args: { description: longDescription } },
					callId: "task-1",
				},
			});
			await delayBeforeToolCompletion();
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "task",
						args: { description: longDescription },
						result: { status: "success", value: { description: longDescription } },
					},
					callId: "task-1",
				},
			});
			opts.onDelta({ update: { type: "text-delta", text: "done" } });
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockCreatedAgent({ send: mockSend });

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: secretKey }));
		const trace = collectThinkingDeltas(events);
		const progressLine = trace.split("\n").find((line) => line.includes("Cursor subagent:")) ?? "";

		expect(progressLine).toContain("Cursor subagent:");
		expect(progressLine).not.toContain(secretKey);
		expect(progressLine).toContain("Bearer [redacted]");
		expect(progressLine).toContain("…");
		expect(progressLine.length).toBeLessThan(280);
	});

	it("does not emit Cursor subagent progress for MCP envelope starts", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: {
						name: "mcp",
						args: { toolName: "external_search", description: "Should not surface as Cursor task progress" },
					},
					callId: "mcp-1",
				},
			});
			await delayBeforeToolCompletion();
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "mcp",
						args: { toolName: "external_search", description: "Should not surface as Cursor task progress" },
						result: { status: "success", value: { content: "ok" } },
					},
					callId: "mcp-1",
				},
			});
			opts.onDelta({ update: { type: "text-delta", text: "done" } });
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockCreatedAgent({ send: mockSend });

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(trace).not.toContain("Cursor task:");
		expect(trace).not.toContain("Cursor subagent:");
		expect(trace).not.toContain("Should not surface as Cursor task progress");
		expect(trace).toContain("Cursor MCP: external_search");
	});
});
