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
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { estimateCursorPromptMessageTokens } from "../src/context.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display-state.js";
import type { Context } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


describe("streamCursor native replay live run", () => {
	beforeEach(resetCursorProviderTestState);

	it("uses completed run spend with bounded occupancy when no turn-ended usage arrives", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let resolveRun: (result: {
			id: string;
			status: "finished";
			result: string;
			usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number };
		}) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{
					id: string;
					status: "finished";
					result: string;
					usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number };
				}>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "I am checking files." } });
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
		expect(firstDone.reason).toBe("toolUse");

		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall!.id, toolCall!.arguments, undefined, undefined, createExtensionTestContext());

		resolveRun({
			id: "run-1",
			status: "finished",
			result: "Final answer only.",
			usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 10, totalTokens: 960 },
		});

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

		const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const replayDone = getDoneEvent(replayEvents);

		expect(replayDone.reason).toBe("stop");
		expect(collectTextDeltas(replayEvents)).toBe("Final answer only.");
		expect(replayDone.message.usage.cacheRead).toBe(400);
		expect(replayDone.message.usage.cacheWrite).toBe(10);
		expect(replayDone.message.usage.input).toBe(90);
		expect(replayDone.message.usage.output).toBe(50);
		expect(replayDone.message.usage.totalTokens).toBeLessThan(500);
	});

	it("waits for delayed turn-ended usage before emitting a native toolUse turn", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let resolveRun: (result: {
			id: string;
			status: "finished";
			result: string;
			usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number };
		}) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{
					id: string;
					status: "finished";
					result: string;
					usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number };
				}>((resolve) => {
					resolveRun = resolve;
				}),
		);
		let firstOnDelta: CursorDeltaHandler | undefined;
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			firstOnDelta = opts.onDelta;
			opts.onDelta({ update: { type: "text-delta", text: "I am checking files." } });
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
			setTimeout(() => {
				opts.onDelta({
					update: {
						type: "turn-ended",
						usage: { inputTokens: 25_432, outputTokens: 612, cacheReadTokens: 24_000, cacheWriteTokens: 123 },
					},
				});
			}, 100);
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
		expect(runWait).toHaveBeenCalledTimes(1);
		const firstDone = getDoneEvent(firstEvents);
		const firstText = collectTextDeltas(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(firstText).toBe("I am checking files.");
		expect(firstDone.reason).toBe("toolUse");
		expect(firstDone.message.stopReason).toBe("toolUse");
		expect(firstDone.message.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
		expect(firstDone.message.content[0]).toEqual({ type: "text", text: "I am checking files." });
		expect(firstDone.message.usage).toMatchObject({
			input: 25_432 - 24_000 - 123,
			output: 612,
			cacheRead: 24_000,
			cacheWrite: 123,
			totalTokens: 25_432 + 612,
		});
		expect(toolCall!.name).toBe("read");
		expect(hasEventType(firstEvents, "toolcall_delta")).toBe(true);

		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall!.id, toolCall!.arguments, undefined, undefined, createExtensionTestContext());
		expect(toolResult).toEqual({
			content: [{ type: "text", text: "# pi-cursor-sdk" }],
			details: undefined,
			terminate: false,
		});

		resolveRun({
			id: "run-1",
			status: "finished",
			result: "Final answer only.",
			usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 10, totalTokens: 960 },
		});

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

		const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const replayText = collectTextDeltas(replayEvents);
		const replayDone = getDoneEvent(replayEvents);

		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(replayText).toBe("Final answer only.");
		expect(replayDone.reason).toBe("stop");
		expect(replayDone.message.usage.input).not.toBe(25_432);
		expect(replayDone.message.usage.input).not.toBe(500);
		expect(replayDone.message.usage.cacheRead).toBe(0);
		expect(replayDone.message.content).toEqual([{ type: "text", text: "Final answer only." }]);
	});

	it("ignores later SDK usage after a split turn times out waiting for usage", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let firstOnDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			firstOnDelta = opts.onDelta;
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "late-1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "read", result: { status: "success", value: { content: "# pi-cursor-sdk" } } },
					callId: "late-1",
				},
			});
			return asMockCursorRun({
				id: "run-late",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({ agentId: "agent-1", send: mockSend, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });

		const firstEventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		while (!firstOnDelta) await new Promise((resolve) => setTimeout(resolve, 0));
		const firstDone = getDoneEvent(await firstEventsPromise);
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

		await new Promise((resolve) => setTimeout(resolve, 300));
		const secondEventsPromise = collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		setTimeout(() => {
			firstOnDelta?.({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "package.json" } }, callId: "second-1" } });
			firstOnDelta?.({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "read", result: { status: "success", value: { content: "{\"name\":\"pi-cursor-sdk\"}" } } },
					callId: "second-1",
				},
			});
			firstOnDelta?.({
				update: {
					type: "turn-ended",
					usage: { inputTokens: 40_000, outputTokens: 800, cacheReadTokens: 39_000, cacheWriteTokens: 0 },
				},
			});
		}, 0);

		const secondDone = getDoneEvent(await secondEventsPromise);
		const secondToolCall = secondDone.message.content.find(isToolCallBlock);
		expect(secondDone.reason).toBe("toolUse");
		expect(secondDone.message.usage.input).not.toBe(40_000);
		expect(secondDone.message.usage.cacheRead).toBe(0);
		expect(secondDone.message.usage.cacheWrite).toBe(0);

		const secondToolResult = await readTool!.execute(secondToolCall!.id, secondToolCall!.arguments, undefined, undefined, createExtensionTestContext());
		resolveRun({ id: "run-late", status: "finished", result: "Final answer." });
		replayContext.messages.push(
			secondDone.message,
			{
				role: "toolResult",
				toolCallId: secondToolCall!.id,
				toolName: "read",
				content: secondToolResult.content,
				details: secondToolResult.details,
				isError: false,
				timestamp: 3,
			},
		);
		expect(getDoneEvent(await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }))).reason).toBe("stop");
	});

	it("keeps delayed usage for inactive-only replay and applies it to the emitted final turn", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let firstOnDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			firstOnDelta = opts.onDelta;
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "task", args: { description: "Inspect campaign pages" } },
					callId: "task-1",
				},
			});
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "task",
						args: { description: "Inspect campaign pages" },
						result: { status: "success", value: { summary: "done" } },
					},
					callId: "task-1",
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

		const context = makeContext();
		context.tools = [{ name: "read", description: "Read files", parameters: Type.Object({}) }];

		const eventsPromise = collectEvents(streamCursor(makeModel(), context, { apiKey: "test-key" }));
		while (!firstOnDelta) await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 200));
		firstOnDelta?.({
			update: {
				type: "turn-ended",
				usage: { inputTokens: 31_000, outputTokens: 700, cacheReadTokens: 30_000, cacheWriteTokens: 0 },
			},
		});
		resolveRun({ id: "run-1", status: "finished", result: "Task complete." });
		const events = await eventsPromise;
		const done = getDoneEvent(events);

		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(collectThinkingDeltas(events)).toContain("Cursor subagent");
		expect(done.reason).toBe("stop");
		expect(done.message.usage).toMatchObject({ input: 1_000, output: 700, cacheRead: 30_000, cacheWrite: 0, totalTokens: 31_700 });
	});

	it("does not replay queued live-run tools that became inactive after the run started", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let firstOnDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			firstOnDelta = opts.onDelta;
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "read-1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "read", result: { status: "success", value: { content: "# Project" } } },
					callId: "read-1",
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
		const readCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const readResult = await readTool!.execute(readCall!.id, readCall!.arguments, undefined, undefined, createExtensionTestContext());

		firstOnDelta?.({ update: { type: "tool-call-started", toolCall: { name: "grep", args: { pattern: "metric-link", path: "src/app/globals.css" } }, callId: "grep-1" } });
		firstOnDelta?.({
			update: {
				type: "tool-call-completed",
				toolCall: { name: "grep", result: { status: "success", value: { matches: ["src/app/globals.css"] } } },
				callId: "grep-1",
			},
		});
		resolveRun({ id: "run-1", status: "finished", result: "Done." });

		const replayContext = makeContext();
		replayContext.tools = [{ name: "read", description: "Read files", parameters: Type.Object({}) }];
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: readCall!.id,
				toolName: "read",
				content: readResult.content,
				details: readResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));

		expect(hasEventType(replayEvents, "toolcall_start")).toBe(false);
		expect(collectThinkingDeltas(replayEvents)).toContain("grep");
	});

	it("resumes an active live run when a steering user message follows tool results", async () => {
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
		let sendCallCount = 0;
		let firstOnDelta: CursorDeltaHandler | undefined;
		const mockSend = vi.fn().mockImplementation(async (message: { text?: string }, opts: { onDelta: CursorDeltaHandler }) => {
			sendCallCount += 1;
			if (sendCallCount === 1) {
				firstOnDelta = opts.onDelta;
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "c1" } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "bash",
							result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } },
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
			}

			return asMockCursorRun({
				id: "run-2",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-2", status: "finished", result: message.text ?? "" }),
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
		expect(toolCall?.name).toBe("bash");
		expect(firstDone.reason).toBe("toolUse");

		const bashTool = registeredTools.find((tool) => tool.name === "bash");
		const toolResult = await bashTool!.execute(toolCall!.id, toolCall!.arguments, undefined, undefined, createExtensionTestContext());

		const steerContext = makeContext();
		steerContext.messages = [
			...steerContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall!.id,
				toolName: "bash",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "and push", timestamp: 3 },
		];

		const steerEventsPromise = collectEvents(streamCursor(makeModel(), steerContext, { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));

		firstOnDelta?.({ update: { type: "text-delta", text: "Old run text that should not leak." } });
		resolveRun({ id: "run-1", status: "finished", result: "Would have kept going without steer." });

		const steerEvents = await steerEventsPromise;
		expect(steerEvents.some((event) => event.type === "error")).toBe(false);
		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockedCreate).toHaveBeenCalledTimes(2);

		const steerPrompt = mockSend.mock.calls[1]?.[0] as { text?: string };
		expect(steerPrompt.text).toContain("User: and push");
		expect(collectTextDeltas(steerEvents)).not.toContain("Old run text that should not leak.");
		const steerDone = getDoneEvent(steerEvents);
		expect(steerDone.reason).toBe("stop");
	});

	it("settles a scope-active live run directly when context has no matching tool results", async () => {
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
		let firstOnDelta: CursorDeltaHandler | undefined;
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			firstOnDelta = opts.onDelta;
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "bash",
						result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } },
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
		expect(getDoneEvent(firstEvents).reason).toBe("toolUse");

		firstOnDelta?.({ update: { type: "text-delta", text: "Late scoped text." } });
		const scopedEventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await Promise.resolve();
		resolveRun({ id: "run-1", status: "finished", result: "Late scoped final." });

		const scopedEvents = await Promise.race([
			scopedEventsPromise,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("scope-active live run settlement timed out")), 1000)),
		]);

		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(collectTextDeltas(scopedEvents)).toContain("Late scoped text.");
		expect(getDoneEvent(scopedEvents).reason).toBe("stop");
	});


	it("does not let idle disposal release an active run while pre-send drain owns it", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		cursorProviderTestUtils.setCursorNativeReplayIdleDisposeMs(10);
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const cancelRun = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "bash",
						result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } },
					},
					callId: "c1",
				},
			});
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: cancelRun,
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
		expect(getDoneEvent(firstEvents).reason).toBe("toolUse");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);

		const scopedEventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);
		expect(cancelRun).not.toHaveBeenCalled();
		expect(mockSend).toHaveBeenCalledTimes(1);

		resolveRun({ id: "run-1", status: "finished", result: "Scoped final." });
		const scopedEvents = await scopedEventsPromise;

		expect(collectTextDeltas(scopedEvents)).toBe("Scoped final.");
		expect(getDoneEvent(scopedEvents).reason).toBe("stop");
		expect(cancelRun).not.toHaveBeenCalled();
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
	});

	it("drops additional old-run tool batches when steering user input should start a fresh send", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const runWait = vi.fn(() => new Promise<{ id: string; status: "finished"; result: string }>(() => {}));
		const cancelRun = vi.fn().mockResolvedValue(undefined);
		let sendCallCount = 0;
		let firstOnDelta: CursorDeltaHandler | undefined;
		const mockSend = vi.fn().mockImplementation(async (_message: { text?: string }, opts: { onDelta: CursorDeltaHandler }) => {
			sendCallCount += 1;
			if (sendCallCount === 1) {
				firstOnDelta = opts.onDelta;
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "c1" } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "bash",
							result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } },
						},
						callId: "c1",
					},
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "running",
					wait: runWait,
					cancel: cancelRun,
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			}

			return asMockCursorRun({
				id: "run-2",
				agentId: "agent-2",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-2", status: "finished", result: "Fresh chained answer." }),
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
		const bashTool = registeredTools.find((tool) => tool.name === "bash");
		const firstToolResult = await bashTool!.execute(firstToolCall!.id, firstToolCall!.arguments, undefined, undefined, createExtensionTestContext());

		const steerContext = makeContext();
		steerContext.messages = [
			...steerContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: firstToolCall!.id,
				toolName: "bash",
				content: firstToolResult.content,
				details: firstToolResult.details,
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "and push after the first tool", timestamp: 3 },
		];

		const steerEventsPromise = collectEvents(streamCursor(makeModel(), steerContext, { apiKey: "test-key" }));
		await Promise.resolve();
		firstOnDelta?.({ update: { type: "text-delta", text: "Old run text that should not leak." } });
		firstOnDelta?.({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git log -1" } }, callId: "c2" } });
		firstOnDelta?.({
			update: {
				type: "tool-call-completed",
				toolCall: {
					name: "bash",
					result: { status: "success", value: { stdout: "commit abc", stderr: "", exitCode: 0 } },
				},
				callId: "c2",
			},
		});
		const steerEvents = await steerEventsPromise;

		expect(cancelRun).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledTimes(2);
		const freshPrompt = mockSend.mock.calls[1]?.[0] as { text?: string };
		expect(freshPrompt.text).toContain("and push after the first tool");
		expect(collectTextDeltas(steerEvents)).toBe("Fresh chained answer.");
		expect(collectTextDeltas(steerEvents)).not.toContain("Old run text");
		expect(getEventsOfType(steerEvents, "toolcall_start")).toHaveLength(0);
		expect(getDoneEvent(steerEvents).reason).toBe("stop");
	});

	it("awaits pooled-agent idle before compaction-style follow-up send", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let sendCallCount = 0;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_message: { text?: string }, opts: { onDelta: CursorDeltaHandler }) => {
			sendCallCount += 1;
			if (sendCallCount === 1) {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "c1" } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "bash",
							result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } },
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
			}

			opts.onDelta({ update: { type: "text-delta", text: "Follow-up answer." } });
			return asMockCursorRun({
				id: "run-2",
				agentId: "agent-1",
				status: "running",
				wait: vi.fn().mockResolvedValue({ id: "run-2", status: "finished", result: "Follow-up answer." }),
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

		const scopeKey = cursorSessionScopeTestUtils.ANONYMOUS_SESSION_SCOPE_KEY;
		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(getDoneEvent(firstEvents).reason).toBe("toolUse");
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(scopeKey).status).toBe("busy");

		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		expect(toolCall).toBeDefined();
		const followUpContext = makeContext();
		followUpContext.messages = [
			...followUpContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall!.id,
				toolName: toolCall!.name,
				content: [{ type: "text", text: "clean" }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: [{ type: "text", text: "Continue with the summary." }], timestamp: 3 },
		];
		const followUpEventsPromise = collectEvents(streamCursor(makeModel(), followUpContext, { apiKey: "test-key" }));
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(mockSend).toHaveBeenCalledTimes(1);

		resolveRun({ id: "run-1", status: "finished", result: "Follow-up answer." });
		const followUpEvents = await followUpEventsPromise;

		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(collectTextDeltas(followUpEvents)).toBe("Follow-up answer.");
		expect(getDoneEvent(followUpEvents).reason).toBe("stop");
	});

	it("aborts while waiting for an active scoped live run and releases it once", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const controller = new AbortController();
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const cancelRun = vi.fn().mockResolvedValue(undefined);
		const runWait = vi.fn(() => new Promise<{ id: string; status: "finished"; result: string }>(() => {}));
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "bash",
						result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } },
					},
					callId: "c1",
				},
			});
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: cancelRun,
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(getDoneEvent(firstEvents).reason).toBe("toolUse");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);

		const scopedEventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal }));
		await Promise.resolve();
		controller.abort();
		const scopedEvents = await scopedEventsPromise;

		expect(getErrorEvent(scopedEvents).reason).toBe("aborted");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		expect(cancelRun).toHaveBeenCalledTimes(1);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});
});
