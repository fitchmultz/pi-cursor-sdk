import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState,
	mockedCreate,
	makeModel,
	makeContext,
	collectEvents,
	collectThinkingDeltas,
	getDoneEvent,
	isToolCallBlock,
	registerNativeToolDisplayForTest,
	type CursorDeltaHandler,
	type RegisteredTool,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";

const delayBeforeToolCompletion = () => new Promise((resolve) => setTimeout(resolve, 120));

describe("streamCursor Cursor tool lifecycle", () => {
	beforeEach(resetCursorProviderTestState);

	it("surfaces deferred MCP lifecycle progress then a single completed replay card", async () => {
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
					toolCall: { name: "mcp", args: { toolName: "external_search" } },
					callId: "mcp-1",
				},
			});
			await delayBeforeToolCompletion();
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "mcp",
						args: { toolName: "external_search" },
						result: { status: "success", value: { content: [{ type: "text", text: "ok" }] } },
					},
					callId: "mcp-1",
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
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(firstEvents);
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(trace).toContain("Cursor MCP: external_search");
		expect(trace.match(/Cursor MCP: external_search/g)?.length).toBe(1);
		expect(toolCall?.name).toBe("cursor");

		resolveRun({ id: "run-1", status: "finished", result: "Done." });
		const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
		const toolResult = await cursorTool!.execute(toolCall!.id, toolCall!.arguments, undefined, undefined, {});

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
		await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
	});

	it("does not emit lifecycle progress for fast read completions", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "read-1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "read", result: { status: "success", value: { content: "readme" } } },
					callId: "read-1",
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
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(trace).not.toMatch(/Cursor (read|grep|glob):/);
		expect(trace).toContain("read README.md");
	});

	it("does not emit lifecycle progress for pi bridge MCP starts", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: {
						name: "mcp",
						args: { toolName: "pi__read", description: "bridge read should stay silent" },
					},
					callId: "bridge-1",
				},
			});
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "mcp",
						args: { toolName: "pi__read" },
						result: { status: "success", value: { content: "ok" } },
					},
					callId: "bridge-1",
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
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(trace).not.toContain("Cursor MCP:");
		expect(trace).not.toContain("bridge read should stay silent");
	});
});
