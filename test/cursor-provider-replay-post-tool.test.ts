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
	createTestToolInfo,
	cursorModelItems,
	type CursorDeltaHandler,
	type CursorStepHandler,
	type RegisteredTool,
	mockCreatedAgent,
	asMockCursorRun,
	getPiToolsMcpUrlFromAgentCreateOptions,
	createExtensionTestContext} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { estimateCursorPromptMessageTokens } from "../src/context.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display-state.js";
import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


describe("streamCursor native replay post-tool text", () => {
	beforeEach(resetCursorProviderTestState);

it("streams post-tool Cursor thinking and text while a native replay run is still active", async () => {
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
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "read",
						result: { status: "success", value: { content: "# pi-cursor-sdk" } },
					},
					callId: "c1",
				},
			});
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall!.id, toolCall!.arguments, undefined, undefined, createExtensionTestContext());

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall!.id,
				toolName: "read",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayStream = streamCursor(makeModel(), replayContext, { apiKey: "test-key" });
		const replayEvents: AssistantMessageEvent[] = [];
		let sawLiveText: () => void = () => {};
		const liveTextSeen = new Promise<void>((resolve) => {
			sawLiveText = resolve;
		});
		const replayDone = (async () => {
			for await (const event of replayStream) {
				replayEvents.push(event);
				if (event.type === "text_delta" && event.delta === "Final ") sawLiveText();
			}
		})();

		await Promise.resolve();
		onDelta?.({ update: { type: "thinking-delta", text: "Streaming thought." } });
		onDelta?.({ update: { type: "thinking-completed" } });
		onDelta?.({ update: { type: "text-delta", text: "Final " } });
		await Promise.race([
			liveTextSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for live Cursor text")), 500)),
		]);
		onDelta?.({ update: { type: "text-delta", text: "answer." } });
		resolveRun({ id: "run-1", status: "finished", result: "Final answer." });
		await replayDone;

		const replayText = collectTextDeltas(replayEvents);
		const replayThinking = collectThinkingDeltas(replayEvents);
		const finalDone = getDoneEvent(replayEvents);

		expect(runWait).toHaveBeenCalledTimes(1);
		expect(replayThinking).toBe("Streaming thought.");
		expect(replayText).toBe("Final answer.");
		expect(finalDone.reason).toBe("stop");
		expect(finalDone.message.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		expect(getTextEndEvent(replayEvents)?.contentIndex).toBe(1);
	});

	it("trims current-turn post-tool native replay final text when streamed text is only a word prefix", async () => {
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
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "read",
						result: { status: "success", value: { content: "# pi-cursor-sdk" } },
					},
					callId: "c1",
				},
			});
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall!.id, toolCall!.arguments, undefined, undefined, createExtensionTestContext());

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall!.id,
				toolName: "read",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents: AssistantMessageEvent[] = [];
		let sawLiveText: () => void = () => {};
		const liveTextSeen = new Promise<void>((resolve) => {
			sawLiveText = resolve;
		});
		const replayDone = (async () => {
			for await (const event of streamCursor(makeModel(), replayContext, { apiKey: "test-key" })) {
				replayEvents.push(event);
				if (event.type === "text_delta" && event.delta === "Disconnect") sawLiveText();
			}
		})();

		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "Disconnect" } });
		await Promise.race([
			liveTextSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for live Cursor text")), 500)),
		]);
		resolveRun({ id: "run-1", status: "finished", result: "Disconnecting the CDP session..." });
		await replayDone;

		const replayText = collectTextDeltas(replayEvents);
		const finalDone = getDoneEvent(replayEvents);

		expect(runWait).toHaveBeenCalledTimes(1);
		expect(replayText).toBe("Disconnecting the CDP session...");
		expect(finalDone.reason).toBe("stop");
	});

	it("queues post-tool thinking and text that arrive before the native tool-use turn closes", async () => {
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
			opts.onDelta({ update: { type: "thinking-delta", text: "Post-tool thought." } });
			opts.onDelta({ update: { type: "thinking-completed" } });
			opts.onDelta({ update: { type: "text-delta", text: "Final " } });
			opts.onDelta({ update: { type: "text-delta", text: "answer." } });
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall!.id, toolCall!.arguments, undefined, undefined, createExtensionTestContext());

		expect(firstDone.message.content.map((block) => block.type)).toEqual(["toolCall"]);

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall!.id,
				toolName: "read",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayStream = streamCursor(makeModel(), replayContext, { apiKey: "test-key" });
		const replayEvents: AssistantMessageEvent[] = [];
		let sawLiveText: () => void = () => {};
		const liveTextSeen = new Promise<void>((resolve) => {
			sawLiveText = resolve;
		});
		const replayDone = (async () => {
			for await (const event of replayStream) {
				replayEvents.push(event);
				if (event.type === "text_delta" && event.delta === "Final ") sawLiveText();
			}
		})();

		await Promise.race([
			liveTextSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for queued Cursor text")), 500)),
		]);
		resolveRun({ id: "run-1", status: "finished", result: "Final answer." });
		await replayDone;

		const replayText = collectTextDeltas(replayEvents);
		const replayThinking = collectThinkingDeltas(replayEvents);
		const finalDone = getDoneEvent(replayEvents);

		expect(replayThinking).toBe("Post-tool thought.");
		expect(replayText).toBe("Final answer.");
		expect(finalDone.message.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		expect(getTextEndEvent(replayEvents)?.contentIndex).toBe(1);
	});


	it("does not duplicate text already emitted before a later native replay tool", async () => {
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
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "read",
						result: { status: "success", value: { content: "# pi-cursor-sdk" } },
					},
					callId: "c1",
				},
			});
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const firstToolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const firstToolResult = await readTool!.execute(firstToolCall!.id, firstToolCall!.arguments, undefined, undefined, createExtensionTestContext());

		const secondContext = makeContext();
		secondContext.messages = [
			...secondContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: firstToolCall!.id,
				toolName: "read",
				content: firstToolResult.content,
				details: firstToolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const secondStream = streamCursor(makeModel(), secondContext, { apiKey: "test-key" });
		const secondEvents: AssistantMessageEvent[] = [];
		let sawSecondTool: () => void = () => {};
		const secondToolSeen = new Promise<void>((resolve) => {
			sawSecondTool = resolve;
		});
		const secondDonePromise = (async () => {
			for await (const event of secondStream) {
				secondEvents.push(event);
				if (event.type === "toolcall_end") sawSecondTool();
			}
		})();

		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "Gathering context.\n" } });
		onDelta?.({ update: { type: "tool-call-started", toolCall: { name: "grep", args: { pattern: "cursor", path: "src" } }, callId: "c2" } });
		onDelta?.({
			update: {
				type: "tool-call-completed",
				toolCall: {
					name: "grep",
					result: { status: "success", value: { matches: ["src/index.ts"] } },
				},
				callId: "c2",
			},
		});
		await Promise.race([
			secondToolSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for second replay tool")), 500)),
		]);
		await secondDonePromise;

		const secondText = collectTextDeltas(secondEvents);
		expect(secondText).toBe("Gathering context.\n");

		const secondToolCall = (getDoneEvent(secondEvents)).message.content.find(
			isToolCallBlock,
		);
		const grepTool = registeredTools.find((tool) => tool.name === "grep");
		const secondToolResult = await grepTool!.execute(secondToolCall!.id, secondToolCall!.arguments, undefined, undefined, createExtensionTestContext());

		const finalContext = makeContext();
		finalContext.messages = [
			...finalContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: firstToolCall!.id,
				toolName: "read",
				content: firstToolResult.content,
				details: firstToolResult.details,
				isError: false,
				timestamp: 2,
			},
			(getDoneEvent(secondEvents)).message,
			{
				role: "toolResult",
				toolCallId: secondToolCall!.id,
				toolName: "grep",
				content: secondToolResult.content,
				details: secondToolResult.details,
				isError: false,
				timestamp: 3,
			},
		];

		const finalEventsPromise = collectEvents(streamCursor(makeModel(), finalContext, { apiKey: "test-key" }));
		await Promise.resolve();
		resolveRun({ id: "run-1", status: "finished", result: "Gathering context.\n" });
		const finalEvents = await finalEventsPromise;
		const finalText = collectTextDeltas(finalEvents);
		const finalDone = getDoneEvent(finalEvents);

		expect(finalText).toBe("");
		expect(finalDone.message.content).toEqual([]);
	});


	it("does not duplicate final result after an earlier post-tool text turn", async () => {
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
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "read",
						result: { status: "success", value: { content: "# pi-cursor-sdk" } },
					},
					callId: "c1",
				},
			});
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		const readTool = registeredTools.find((tool) => tool.name === "read");

		const context = makeContext();
		const firstEvents = await collectEvents(streamCursor(makeModel(), context, { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const firstToolCall = firstDone.message.content.find(isToolCallBlock);
		const firstToolResult = await readTool!.execute(firstToolCall!.id, firstToolCall!.arguments, undefined, undefined, createExtensionTestContext());
		const firstToolResultMessage = {
			role: "toolResult" as const,
			toolCallId: firstToolCall!.id,
			toolName: "read",
			content: firstToolResult.content,
			details: firstToolResult.details,
			isError: false,
			timestamp: 2,
		};
		context.messages.push(firstDone.message, firstToolResultMessage);

		const secondStream = streamCursor(makeModel(), context, { apiKey: "test-key" });
		const secondDonePromise = collectEvents(secondStream);
		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "I am checking helpers." } });
		onDelta?.({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "src/index.ts" } }, callId: "c2" } });
		onDelta?.({
			update: {
				type: "tool-call-completed",
				toolCall: {
					name: "read",
					result: { status: "success", value: { content: "import type { ExtensionAPI } from \"@earendil-works/pi-coding-agent\";" } },
				},
				callId: "c2",
			},
		});
		const secondEvents = await secondDonePromise;
		const secondDone = getDoneEvent(secondEvents);
		const secondToolCall = secondDone.message.content.find(isToolCallBlock);
		const secondToolResult = await readTool!.execute(secondToolCall!.id, secondToolCall!.arguments, undefined, undefined, createExtensionTestContext());
		const secondToolResultMessage = {
			role: "toolResult" as const,
			toolCallId: secondToolCall!.id,
			toolName: "read",
			content: secondToolResult.content,
			details: secondToolResult.details,
			isError: false,
			timestamp: 3,
		};
		context.messages.push(secondDone.message, secondToolResultMessage);

		const finalStream = streamCursor(makeModel(), context, { apiKey: "test-key" });
		const finalEventsPromise = collectEvents(finalStream);
		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "Final answer." } });
		resolveRun({ id: "run-1", status: "finished", result: "Final answer." });
		const finalEvents = await finalEventsPromise;
		const finalDone = getDoneEvent(finalEvents);
		const finalText = collectTextDeltas(finalEvents);

		expect(runWait).toHaveBeenCalledTimes(1);
		expect(firstDone.message.usage.input).toBeGreaterThan(0);
		expect(firstDone.message.usage.output).toBeGreaterThan(0);
		expect(firstDone.message.usage.totalTokens).toBeGreaterThanOrEqual(firstDone.message.usage.input + firstDone.message.usage.output);
		expect(secondDone.message.usage.input).toBeGreaterThanOrEqual(estimateCursorPromptMessageTokens(firstToolResultMessage));
		expect(secondDone.message.usage.input).toBeGreaterThan(0);
		expect(secondDone.message.usage.output).toBeGreaterThan(0);
		expect(secondDone.message.usage.totalTokens).toBeGreaterThanOrEqual(secondDone.message.usage.input + secondDone.message.usage.output);
		expect(finalDone.message.usage.input).toBeGreaterThanOrEqual(estimateCursorPromptMessageTokens(secondToolResultMessage));
		expect(finalDone.message.usage.input).not.toBe(estimateCursorPromptMessageTokens(firstToolResultMessage) + estimateCursorPromptMessageTokens(secondToolResultMessage));
		expect(finalDone.message.usage.input).toBeGreaterThan(0);
		expect(finalDone.message.usage.output).toBeGreaterThan(0);
		expect(finalDone.message.usage.totalTokens).toBeGreaterThanOrEqual(finalDone.message.usage.input + finalDone.message.usage.output);
		expect(secondDone.message.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
		expect(finalText).toBe("Final answer.");
		expect(finalDone.message.content).toEqual([{ type: "text", text: "Final answer." }]);
	});

	it("does not trim final text when pre-tool text is only a word prefix", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
		});

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
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		const createOptions = getCreatedAgentOptions();
		const { client, transport } = await connectMcpClient(getPiToolsMcpUrlFromAgentCreateOptions(createOptions));
		try {
			onDelta?.({ update: { type: "text-delta", text: "Disconnect" } });
			const readCallPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			const firstEvents = await firstEventsPromise;
			const firstText = collectTextDeltas(firstEvents);
			const firstDone = getDoneEvent(firstEvents);
			const [toolCall] = firstDone.message.content.filter(isToolCallBlock);

			expect(firstText).toBe("Disconnect");
			expect(toolCall!.name).toBe("read");

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall!.id,
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 2,
				},
			];

			const finalEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), replayContext, { apiKey: "test-key" }));
			await expect(readCallPromise).resolves.toMatchObject({ content: [{ type: "text", text: "file contents" }] });
			resolveRun({ id: "run-1", status: "finished", result: "Disconnecting the CDP session per your choice." });
			const finalEvents = await finalEventsPromise;
			const finalText = collectTextDeltas(finalEvents);
			const finalDone = getDoneEvent(finalEvents);

			expect(mockedCreate).toHaveBeenCalledTimes(1);
			expect(runWait).toHaveBeenCalledTimes(1);
			expect(finalText).toBe("Disconnecting the CDP session per your choice.");
			expect(finalDone.message.content).toEqual([{ type: "text", text: "Disconnecting the CDP session per your choice." }]);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});
});
