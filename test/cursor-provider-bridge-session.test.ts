import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
	asMockSdkAgent,
	asMockCursorRun,
	getPiToolsMcpUrlFromAgentCreateOptions,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { estimateCursorPromptMessageTokens } from "../src/context.js";
import { __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as cursorPiToolBridgeTestUtils } from "../src/cursor-pi-tool-bridge.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display-state.js";

describe("streamCursor session agent", () => {
	beforeEach(resetCursorProviderTestState);

	it("keeps the session agent alive after a successful text-only turn", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockDispose).not.toHaveBeenCalled();
	});

	it("disposes the session agent after a send error", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn().mockRejectedValue(new Error("boom"));
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("recreates the session agent on the next turn after a send error", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		let sendCallCount = 0;
		const mockSend = vi.fn().mockImplementation(async () => {
			sendCallCount += 1;
			if (sendCallCount === 1) {
				throw new Error("boom");
			}
			return asMockCursorRun({
				id: "run-2",
				agentId: "agent-2",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-2", status: "finished", result: "Recovered" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockedCreate.mockImplementation(async () => asMockSdkAgent({
			agentId: `agent-${mockedCreate.mock.calls.length + 1}`,
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		}));

		const errorEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(getErrorEvent(errorEvents).reason).toBe("error");

		const recoveryEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(getDoneEvent(recoveryEvents).reason).toBe("stop");
		expect(mockedCreate).toHaveBeenCalledTimes(2);
		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("reuses the session agent and keeps bridge guidance on follow-up turns", async () => {
		registerBridgeForProviderTest({
			active: ["mcp", "subagent"],
			tools: [
				createTestToolInfo("mcp", Type.Object({}), "Call an MCP server"),
				createTestToolInfo("subagent", Type.Object({}), "Delegate to a pi subagent"),
			],
		});
		const mockSend = vi.fn().mockImplementation(async (message: { text?: string }) => {
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: message.text ?? "" }),
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

		const firstContext = makeContext();
		await collectEvents(streamCursor(makeModel(), firstContext, { apiKey: "test-key" }));

		const followUpContext = makeContext();
		followUpContext.messages = [
			...firstContext.messages,
			{ role: "assistant", content: [{ type: "text", text: "Hi there." }], api: "cursor-sdk", provider: "cursor", model: "test-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
			{ role: "user", content: "Follow up", timestamp: 3 },
		];
		await collectEvents(streamCursor(makeModel(), followUpContext, { apiKey: "test-key" }));

		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledTimes(2);
		const firstPrompt = mockSend.mock.calls[0]?.[0] as { text?: string };
		const secondPrompt = mockSend.mock.calls[1]?.[0] as { text?: string };
		expect(firstPrompt.text).toContain("Cursor SDK tool boundary:");
		expect(firstPrompt.text).toContain("User: Hello");
		expect(firstPrompt.text).toContain("prefer pi__todo for todos and pi__subagent_spawn for delegation");
		expect(secondPrompt.text).toContain("User: Follow up");
		expect(secondPrompt.text).not.toContain("User: Hello");
		expect(secondPrompt.text).toContain("prefer pi__todo for todos and pi__subagent_spawn for delegation");
	});

	it("recreates the session agent after session-tree invalidation", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "ok" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockImplementation(async () => asMockSdkAgent({
			agentId: `agent-${mockedCreate.mock.calls.length + 1}`,
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		}));

		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		sessionAgentTestUtils.invalidateSessionAgent();
		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));

		expect(mockedCreate).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("bootstraps with branch summary context after /tree navigation", async () => {
		const mockSend = vi.fn().mockImplementation(async (message: { text?: string }) => ({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: message.text ?? "" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		}));
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const treeContext = makeContext();
		treeContext.messages = [
			{ role: "user", content: "Hello", timestamp: 1 },
			{
				role: "branchSummary",
				summary: "We explored approach A and rejected it.",
				fromId: "entry-a",
				timestamp: 2,
			} as unknown as Context["messages"][number],
			{ role: "user", content: "Continue on approach B", timestamp: 3 },
		];

		await collectEvents(streamCursor(makeModel(), treeContext, { apiKey: "test-key" }));

		const prompt = mockSend.mock.calls[0]?.[0] as { text?: string };
		expect(prompt.text).toContain("We explored approach A and rejected it.");
		expect(prompt.text).toContain("User: Continue on approach B");
	});

	it("recreates the session agent when context diverges and sends a full bootstrap prompt", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn().mockImplementation(async () => ({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "ok" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		}));
		mockedCreate.mockImplementation(async () => asMockSdkAgent({
			agentId: `agent-${mockedCreate.mock.calls.length + 1}`,
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		}));

		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));

		const divergentContext = makeContext();
		divergentContext.messages = [{ role: "user", content: "Hello edited", timestamp: 1 }];
		await collectEvents(streamCursor(makeModel(), divergentContext, { apiKey: "test-key" }));

		expect(mockedCreate).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
		const secondPrompt = mockSend.mock.calls[1]?.[0] as { text?: string };
		expect(secondPrompt.text).toContain("Cursor SDK tool boundary:");
		expect(secondPrompt.text).toContain("User: Hello edited");
	});

	it("recreates the session agent when branch-shrunk context diverges", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn().mockImplementation(async () => ({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "ok" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		}));
		mockedCreate.mockImplementation(async () => asMockSdkAgent({
			agentId: `agent-${mockedCreate.mock.calls.length + 1}`,
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		}));

		const firstContext = makeContext();
		await collectEvents(streamCursor(makeModel(), firstContext, { apiKey: "test-key" }));

		const followUpContext = makeContext();
		followUpContext.messages = [
			...firstContext.messages,
			{
				role: "assistant",
				content: [{ type: "text", text: "Hi there." }],
				api: "cursor-sdk",
				provider: "cursor",
				model: "test-model",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "user", content: "Follow up", timestamp: 3 },
		];
		await collectEvents(streamCursor(makeModel(), followUpContext, { apiKey: "test-key" }));

		const shrunkContext = makeContext();
		await collectEvents(streamCursor(makeModel(), shrunkContext, { apiKey: "test-key" }));

		expect(mockedCreate).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
		const thirdPrompt = mockSend.mock.calls[2]?.[0] as { text?: string };
		expect(thirdPrompt.text).toContain("Cursor SDK tool boundary:");
		expect(thirdPrompt.text).toContain("User: Hello");
	});

	it("recreates the session agent when the API key changes between turns", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "key-a" }));
		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "key-b" }));

		expect(mockedCreate).toHaveBeenCalledTimes(2);
	});

	it("rebinds bridge onToolRequest when reusing the session agent on a follow-up turn", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
		});

		let turn2OnDelta: CursorDeltaHandler | undefined;
		let resolveTurn2Run: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		let sendCallCount = 0;
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler; onStep: CursorStepHandler }) => {
			sendCallCount += 1;
			if (sendCallCount === 1) {
				opts.onDelta({ update: { type: "text-delta", text: "Hello" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Hello" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			}

			turn2OnDelta = opts.onDelta;
			return asMockCursorRun({
				id: "run-2",
				agentId: "agent-1",
				status: "running",
				wait: vi.fn(
					() =>
						new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
							resolveTurn2Run = resolve;
						}),
				),
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

		const firstContext = makeContext();
		await collectEvents(streamCursor(makeModel("composer-2"), firstContext, { apiKey: "test-key" }));

		const followUpContext = makeContext();
		followUpContext.messages = [
			...firstContext.messages,
			{ role: "assistant", content: [{ type: "text", text: "Hello" }], api: "cursor-sdk", provider: "cursor", model: "test-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
			{ role: "user", content: "Read README", timestamp: 3 },
		];

		const secondEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), followUpContext, { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));

		const createOptions = getCreatedAgentOptions();
		const { client, transport } = await connectMcpClient(getPiToolsMcpUrlFromAgentCreateOptions(createOptions));
		try {
			const readCallPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			turn2OnDelta?.({ update: { type: "tool-call-started", callId: "mcp-read", toolCall: { name: "mcp", args: { toolName: "pi__read" } } } });

			const secondEvents = await secondEventsPromise;
			const secondDone = getDoneEvent(secondEvents);
			const toolCalls = secondDone.message.content.filter(isToolCallBlock);

			expect(mockedCreate).toHaveBeenCalledTimes(1);
			expect(secondDone.reason).toBe("toolUse");
			expect(toolCalls).toHaveLength(1);
			expect(toolCalls[0]?.name).toBe("read");
			expect(toolCalls[0]?.arguments).toEqual({ path: "README.md" });

			const readToolResultMessage = {
				role: "toolResult" as const,
				toolCallId: toolCalls[0]!.id,
				toolName: "read",
				content: [{ type: "text" as const, text: "file contents" }],
				isError: false,
				timestamp: 4,
			};
			const replayContext = makeContext();
			replayContext.messages = [...followUpContext.messages, secondDone.message, readToolResultMessage];
			const replayEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), replayContext, { apiKey: "test-key" }));
			await expect(readCallPromise).resolves.toMatchObject({ content: [{ type: "text", text: "file contents" }] });
			resolveTurn2Run({ id: "run-2", status: "finished", result: "Done reading." });
			const replayEvents = await replayEventsPromise;

			expect(getDoneEvent(replayEvents).reason).toBe("stop");
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it("injects bootstrap callable-surface manifest into the first send when enabled", async () => {
		process.env.PI_CURSOR_TOOL_MANIFEST = "1";
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "ok" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));

		const firstPrompt = mockSend.mock.calls[0]?.[0] as { text?: string };
		expect(firstPrompt.text).toContain("Callable tool surfaces this run:");
		expect(firstPrompt.text).toContain("Cursor host/MCP");
		expect(firstPrompt.text).not.toContain("pi__cursor_ask_question");
	});
});
