import { describe, it, expect, vi, beforeEach } from "vitest";
import { Type } from "typebox";
import {
	resetCursorProviderTestState,
	mockedCreate,
	mockedCreateAgentPlatform,
	makeModel,
	makeContext,
	makeAssistantMessage,
	collectEvents,
	collectTextDeltas,
	collectThinkingDeltas,
	getEventsOfType,
	getDoneEvent,
	getErrorEvent,
	getTextEndEvent,
	hasEventType,
	isToolCallBlock,
	isCursorToolStreamEvent,
	getCreatedAgentOptions,
	createMockAgentPlatform,
	registerBridgeForProviderTest,
	registerNativeToolDisplayForTest,
	connectMcpClient,
	createBuiltinToolInfo,
	createBridgeToolInfo,
	cursorModelItems,
	type CursorDeltaHandler,
	type CursorStepHandler,
	type RegisteredTool,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { estimateCursorPromptMessageTokens } from "../src/context.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display.js";
import type { Context } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


describe("streamCursor native replay text and usage", () => {
	beforeEach(resetCursorProviderTestState);

it("replays Cursor createPlan as a neutral cursor card before final plan text", async () => {
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
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "createPlan", args: {} }, callId: "plan-1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "createPlan", args: {}, result: { status: "success", value: {} } },
					callId: "plan-1",
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(firstDone.reason).toBe("toolUse");
		expect(firstDone.message.content.map((block) => block.type)).toEqual(["toolCall"]);
		expect(toolCall.name).toBe("cursor");
		expect(toolCall.arguments).toMatchObject({ totalCount: 0 });

		const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
		const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		expect(toolResult.content[0].text).toContain("createPlan");
		expect(toolResult.details).toMatchObject({ cursorToolName: "createPlan" });

		resolveRun({ id: "run-1", status: "finished", result: "Final Cursor plan text." });

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "cursor",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const replayText = collectTextDeltas(replayEvents);
		const replayDone = getDoneEvent(replayEvents);

		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(replayText).toBe("Final Cursor plan text.");
		expect(replayDone.reason).toBe("stop");
		expect(replayDone.message.content).toEqual([{ type: "text", text: "Final Cursor plan text." }]);
	});

	it("prefers distinct Cursor final result text after pre-plan native replay text", async () => {
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
			opts.onDelta({ update: { type: "text-delta", text: "Compiling the tool inventory and execution status.\n" } });
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "createPlan", args: {} }, callId: "plan-1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "createPlan", args: {}, result: { status: "success", value: {} } },
					callId: "plan-1",
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
		const firstDone = getDoneEvent(firstEvents);
		const firstText = collectTextDeltas(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(firstText).toBe("Compiling the tool inventory and execution status.\n");
		expect(firstDone.reason).toBe("toolUse");
		expect(firstDone.message.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
		expect(toolCall.name).toBe("cursor");

		const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
		const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		resolveRun({ id: "run-1", status: "finished", result: "Final plan:\n1. Summarize available tools.\n2. Report execution status." });

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "cursor",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const replayText = collectTextDeltas(replayEvents);
		const replayDone = getDoneEvent(replayEvents);

		expect(replayText).toBe("Final plan:\n1. Summarize available tools.\n2. Report execution status.");
		expect(replayText).not.toContain("Compiling the tool inventory");
		expect(replayDone.message.content).toEqual([
			{ type: "text", text: "Final plan:\n1. Summarize available tools.\n2. Report execution status." },
		]);
	});

	it("emits distinct final result text even after post-replay text deltas", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let onDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			onDelta = opts.onDelta;
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "createPlan", args: {} }, callId: "plan-1" } });
			onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "createPlan", args: {}, result: { status: "success", value: {} } },
					callId: "plan-1",
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
		const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "cursor",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents: AssistantMessageEvent[] = [];
		let sawPostReplayText: () => void = () => {};
		const postReplayTextSeen = new Promise<void>((resolve) => {
			sawPostReplayText = resolve;
		});
		const replayDonePromise = (async () => {
			for await (const event of streamCursor(makeModel(), replayContext, { apiKey: "test-key" })) {
				replayEvents.push(event);
				if (event.type === "text_delta" && event.delta === "Compiling after replay.\n") sawPostReplayText();
			}
		})();

		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "Compiling after replay.\n" } });
		await Promise.race([
			postReplayTextSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for post-replay text")), 500)),
		]);
		resolveRun({ id: "run-1", status: "finished", result: "Final Cursor plan text." });
		await replayDonePromise;

		const replayText = collectTextDeltas(replayEvents);
		const replayDone = getDoneEvent(replayEvents);

		expect(replayText).toBe("Compiling after replay.\nFinal Cursor plan text.");
		expect(replayDone.reason).toBe("stop");
		expect(replayDone.message.content).toEqual([
			{ type: "text", text: "Compiling after replay.\n" },
			{ type: "text", text: "Final Cursor plan text." },
		]);
	});

	it("surfaces incomplete Cursor tool starts during native replay before final text", async () => {
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
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "read",
						result: { status: "success", value: { content: "# pi-cursor-sdk" } },
					},
					callId: "c1",
				},
			});
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "mcp", args: { toolName: "demo" } }, callId: "c2" } });
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "read",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEventsPromise = collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		await Promise.resolve();
		resolveRun({ id: "run-1", status: "finished", result: "Done." });
		const replayEvents = await replayEventsPromise;
		const replayDone = getDoneEvent(replayEvents);
		const replayText = collectTextDeltas(replayEvents);
		const incompleteToolCall = replayDone.message.content.find(isToolCallBlock);

		expect(replayDone.reason).toBe("toolUse");
		expect(replayText).toBe("");
		expect(incompleteToolCall).toMatchObject({
			name: "cursor",
			arguments: { activityTitle: "Cursor MCP", activitySummary: "missing completion" },
		});
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(1);

		const incompleteReplayContext = makeContext();
		incompleteReplayContext.messages = [
			...incompleteReplayContext.messages,
			firstDone.message,
			{
				role: "toolResult" as const,
				toolCallId: toolCall.id,
				toolName: "read",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
			replayDone.message,
			{
				role: "toolResult" as const,
				toolCallId: incompleteToolCall!.id,
				toolName: "cursor",
				content: [{ type: "text" as const, text: "Cursor MCP did not complete" }],
				isError: true,
				timestamp: 4,
			},
		];
		const finalEvents = await collectEvents(streamCursor(makeModel(), incompleteReplayContext, { apiKey: "test-key" }));
		expect(getDoneEvent(finalEvents).reason).toBe("stop");
		expect(collectTextDeltas(finalEvents)).toBe("Done.");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
	});

	it("surfaces incomplete native replay runs that only have started Cursor tool calls", async () => {
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
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
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

		const eventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(runWait).toHaveBeenCalledTimes(1));
		resolveRun({ id: "run-1", status: "finished", result: "Done." });
		const events = await eventsPromise;
		const done = getDoneEvent(events);
		const text = collectTextDeltas(events);

		expect(done.reason).toBe("toolUse");
		expect(text).toBe("");
		expect(done.message.content.find(isToolCallBlock)).toMatchObject({
			name: "cursor",
			arguments: { activityTitle: "Cursor read", activitySummary: "missing completion" },
		});
		expect(hasEventType(events, "toolcall_start")).toBe(true);
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(1);

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			done.message,
			{
				role: "toolResult" as const,
				toolCallId: done.message.content.find(isToolCallBlock)!.id,
				toolName: "cursor",
				content: [{ type: "text" as const, text: "Cursor read did not complete" }],
				isError: true,
				timestamp: 2,
			},
		];
		const finalEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		expect(getDoneEvent(finalEvents).reason).toBe("stop");
		expect(collectTextDeltas(finalEvents)).toBe("Done.");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
	});

	it("counts thinking plus tool-call replay turns as nonzero assistant activity", async () => {
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
			opts.onDelta({ update: { type: "thinking-delta", text: "Need to inspect the file." } });
			opts.onDelta({ update: { type: "thinking-completed" } });
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "read",
						result: { status: "success", value: { content: "# pi-cursor-sdk" } },
					},
					callId: "c1",
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

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const done = getDoneEvent(events);

		expect(done.reason).toBe("toolUse");
		expect(done.message.content.map((block) => block.type)).toEqual(["thinking", "toolCall"]);
		expect(done.message.usage.output).toBeGreaterThan(0);
		expect(done.message.usage.totalTokens).toBeGreaterThan(done.message.usage.input);

		const toolCall = done.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			done.message,
			{
				role: "toolResult" as const,
				toolCallId: toolCall.id,
				toolName: "read",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];
		resolveRun({ id: "run-1", status: "finished", result: "" });
		await Promise.resolve();
		await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
	});

	it("gives empty final replay turns context total without recounting the original prompt", async () => {
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
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "read",
						result: { status: "success", value: { content: "# pi-cursor-sdk" } },
					},
					callId: "c1",
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		const toolResultMessage = {
			role: "toolResult" as const,
			toolCallId: toolCall.id,
			toolName: "read",
			content: toolResult.content,
			details: toolResult.details,
			isError: false,
			timestamp: 2,
		};
		const replayContext = makeContext();
		replayContext.messages = [...replayContext.messages, firstDone.message, toolResultMessage];

		expect(runWait).toHaveBeenCalledTimes(1);
		resolveRun({ id: "run-1", status: "finished", result: "" });
		await Promise.resolve();

		const finalEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const finalDone = getDoneEvent(finalEvents);

		expect(finalDone.reason).toBe("stop");
		expect(finalDone.message.content).toEqual([]);
		expect(finalDone.message.usage.input).toBe(estimateCursorPromptMessageTokens(toolResultMessage));
		expect(finalDone.message.usage.input).toBeLessThan(firstDone.message.usage.input);
		expect(finalDone.message.usage.output).toBe(0);
		expect(finalDone.message.usage.totalTokens).toBeGreaterThan(finalDone.message.usage.input);
	});
});
