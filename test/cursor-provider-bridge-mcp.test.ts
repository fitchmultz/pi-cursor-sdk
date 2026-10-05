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
	createPiHarness,
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
} from "./helpers/cursor-provider-harness.js";
import { registerCursorQuestionTool } from "../src/cursor-question-tool.js";
import { createExtensionTestContext } from "./helpers/pi-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { estimateCursorPromptMessageTokens } from "../src/context.js";
import { registerCursorRuntimeControls } from "../src/cursor-state.js";
import { registerCursorSessionScope } from "../src/cursor-session-scope.js";
import { __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as cursorPiToolBridgeTestUtils } from "../src/cursor-pi-tool-bridge.js";
import { registerCursorNativeToolDisplayState, __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display-state.js";
import type { Context } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertPiContentToMcpContent } from "../src/cursor-pi-tool-bridge-mcp.js";


async function setCursorModeForBridgeTest(mode: "agent" | "plan"): Promise<void> {
	const pi = createPiHarness({ flagValues: { "cursor-mode": mode } });
	registerCursorSessionScope(pi);
	registerCursorRuntimeControls(pi);
	await pi.runSessionStart({ model: makeModel("composer-2") });
}

describe("streamCursor bridge MCP", () => {
	beforeEach(resetCursorProviderTestState);

	it("preserves unknown array and object content blocks as text fallbacks", () => {
		expect(convertPiContentToMcpContent([["unexpected", "block"], { custom: true }])).toEqual([
			{ type: "text", text: '["unexpected","block"]' },
			{ type: "text", text: '{"custom":true}' },
		]);
	});

	it("safely stringifies non-array MCP content fallbacks", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const throwing = { toJSON: () => { throw new Error("boom"); } };

		expect(convertPiContentToMcpContent(undefined)).toEqual([{ type: "text", text: "" }]);
		expect(convertPiContentToMcpContent(BigInt(1))).toEqual([{ type: "text", text: "1" }]);
		expect(convertPiContentToMcpContent(circular)).toEqual([{ type: "text", text: "[object Object]" }]);
		expect(convertPiContentToMcpContent(throwing)).toEqual([{ type: "text", text: "[object Object]" }]);
	});

	it("surfaces empty live-run error status with run metadata", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "partial" } });
			return asMockCursorRun({
				id: "run-abc123456789",
				agentId: "agent-1",
				status: "error",
				wait: vi.fn().mockResolvedValue({
					id: "run-abc123456789",
					status: "error",
					result: "Cursor SDK run failed",
					durationMs: 900,
					model: { id: "composer-2.5" },
				}),
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

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const error = getErrorEvent(events);

		expect(error.reason).toBe("error");
		expect(error.error.errorMessage).toContain("model composer-2.5");
		expect(error.error.errorMessage).toContain("900ms");
		expect(error.error.errorMessage).not.toBe("Cursor SDK run failed");
		expect(hasEventType(events, "done")).toBe(false);
	});

	it("surfaces live-run wait error status as a provider error", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "partial" } });
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "error",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "error", result: "MCP tool call timed out after 60s" }),
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

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const error = getErrorEvent(events);

		expect(error.reason).toBe("error");
		expect(error.error.errorMessage).toContain("MCP tool call timed out after 60s");
		expect(hasEventType(events, "done")).toBe(false);
	});

	it("rejects late bridge MCP calls after a successful live run is released", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
		});

		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Hello" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));

		const createOptions = getCreatedAgentOptions();
		const { client, transport } = await connectMcpClient(getPiToolsMcpUrlFromAgentCreateOptions(createOptions));
		try {
			const callPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			const error = await callPromise.catch((callError: unknown) => callError);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/no active live run|MCP error/i);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it("redacts common secret-bearing fields in Cursor SDK error messages", async () => {
		const mockSend = vi.fn().mockRejectedValue(
			new Error(
				'request failed {"apiKey":"super-secret-key-12345","token":"token-value","session_id":"session-value"} cookie: foo=bar; baz=qux',
			),
		);
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "super-secret-key-12345" });
		const events = await collectEvents(stream);

		const error = getErrorEvent(events);
		const message = error.error.errorMessage;
		expect(message).toContain('"apiKey":"[redacted]"');
		expect(message).toContain('"token":"[redacted]"');
		expect(message).toContain('"session_id":"[redacted]"');
		expect(message).toContain("cookie: [redacted]");
		expect(message).not.toContain("super-secret-key-12345");
		expect(message).not.toContain("token-value");
		expect(message).not.toContain("session-value");
		expect(message).not.toContain("foo=bar");
		expect(message).not.toContain("baz=qux");
	});

	it("passes bridge MCP servers into Agent.create when active pi tools are exposed", async () => {
		registerBridgeForProviderTest({
			active: ["sem_reindex"],
			tools: [createTestToolInfo("sem_reindex", Type.Object({ target: Type.String() }), "Reindex semantic cache")],
		});
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

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));

		const createOptions = getCreatedAgentOptions();
		expect(createOptions.local).toMatchObject({
			cwd: process.cwd(),
			settingSources: ["all"],
			store: expect.any(Object),
		});
		expect(createOptions.mcpServers?.pi_tools?.type).toBe("http");
		const url = new URL(getPiToolsMcpUrlFromAgentCreateOptions(createOptions));
		expect(url.hostname).toBe("127.0.0.1");
		expect(url.pathname).toContain("/cursor-pi-tool-bridge/");
	});


	it("omits overlapping pi built-ins from Agent.create by default and exposes them with explicit opt-in", async () => {
		registerBridgeForProviderTest({
			active: ["read", "bash"],
			tools: [
				createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files"),
				createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run commands"),
			],
		});
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

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		expect(getCreatedAgentOptions().mcpServers).toBeUndefined();

		await cursorPiToolBridgeTestUtils.resetRegisteredBridgeForTests();
		await cursorProviderTestUtils.resetSessionCursorAgents();
		vi.clearAllMocks();
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		registerBridgeForProviderTest({
			active: ["read", "bash"],
			tools: [
				createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files"),
				createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run commands"),
			],
		});
		mockCreatedAgent({
			agentId: "agent-2",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		expect(getCreatedAgentOptions().mcpServers?.pi_tools?.type).toBe("http");
	});

	it("omits bridge MCP servers from Agent.create when disabled or when the active snapshot is empty", async () => {
		process.env.PI_CURSOR_PI_TOOL_BRIDGE = "0";
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createTestToolInfo("read")],
		});
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

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		expect(getCreatedAgentOptions().mcpServers).toBeUndefined();

		await cursorPiToolBridgeTestUtils.resetRegisteredBridgeForTests();
		await cursorProviderTestUtils.resetSessionCursorAgents();
		delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
		delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
		vi.clearAllMocks();
		const { pi } = registerBridgeForProviderTest({
			active: ["cursor"],
			tools: [createTestToolInfo("cursor")],
		});
		registerCursorNativeToolDisplayState(pi);
		nativeToolDisplayTestUtils.registerNativeToolNameForTests("cursor", pi);
		mockCreatedAgent({
			agentId: "agent-2",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		expect(getCreatedAgentOptions().mcpServers).toBeUndefined();
	});

	it("emits bridge MCP requests as real pi tool calls and resumes the same Cursor run after tool results in plan mode", async () => {
		const model = { ...makeModel("composer-2"), cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 } };
		await setCursorModeForBridgeTest("plan");
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		registerBridgeForProviderTest({
			active: ["read", "bash"],
			tools: [
				createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files"),
				createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run commands"),
			],
		});

		let onDelta: CursorDeltaHandler | undefined;
		let onStep: CursorStepHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler; onStep: CursorStepHandler }) => {
			onDelta = opts.onDelta;
			onStep = opts.onStep;
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

		const firstEventsPromise = collectEvents(streamCursor(model, makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		const createOptions = getCreatedAgentOptions();
		const { client, transport } = await connectMcpClient(getPiToolsMcpUrlFromAgentCreateOptions(createOptions));
		try {
			const readCallPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			const bashCallPromise = client.callTool({ name: "pi__bash", arguments: { command: "pwd" } });
			onDelta?.({ update: { type: "tool-call-started", callId: "mcp-read", toolCall: { name: "mcp", args: { toolName: "pi__read" } } } });
			onDelta?.({
				update: {
					type: "tool-call-completed",
					callId: "mcp-read",
					toolCall: {
						name: "mcp",
						result: { status: "success", value: { content: "duplicate bridge replay should be suppressed" } },
					},
				},
			});
			onDelta?.({ update: { type: "tool-call-started", callId: "mcp-read-step", toolCall: { name: "mcp", args: { toolName: "pi__read" } } } });
			onStep?.({
				step: {
					type: "toolCall",
					id: "mcp-read-step",
					message: {
						name: "mcp",
						result: { status: "success", value: { content: "duplicate bridge onStep replay should be suppressed" } },
					},
				} as unknown as Parameters<NonNullable<import("@cursor/sdk").SendOptions["onStep"]>>[0]["step"],
			});
			onDelta?.({ update: { type: "tool-call-started", callId: "mcp-bash-start-only", toolCall: { name: "mcp", args: { toolName: "pi__bash" } } } });

			const firstEvents = await firstEventsPromise;
			const firstDone = getDoneEvent(firstEvents);
			const toolCalls = firstDone.message.content.filter(isToolCallBlock);
			const trace = collectThinkingDeltas(firstEvents);

			expect(firstDone.reason).toBe("toolUse");
			expect(toolCalls.map((toolCall) => toolCall.name)).toEqual(["read", "bash"]);
			expect(toolCalls[0].id).not.toBe(toolCalls[1].id);
			expect(toolCalls[0].id).toContain("cursor-pi-bridge-");
			expect(toolCalls[0].arguments).toEqual({ path: "README.md" });
			expect(toolCalls[1].arguments).toEqual({ command: "pwd" });
			expect(trace).not.toContain("duplicate bridge replay");
			expect(trace).not.toContain("duplicate bridge onStep");
			expect(trace).not.toContain("Cursor task:");
			expect(trace).not.toContain("Cursor MCP did not complete");
			expect(trace).not.toContain("Cursor tool started without a completion event");
			expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);

			const readToolResultMessage = {
				role: "toolResult" as const,
				toolCallId: toolCalls[0].id,
				toolName: "read",
				content: [{ type: "text" as const, text: "file contents" }],
				isError: false,
				timestamp: 2,
			};
			const bashToolResultMessage = {
				role: "toolResult" as const,
				toolCallId: toolCalls[1].id,
				toolName: "bash",
				content: [{ type: "text" as const, text: "/repo" }],
				isError: false,
				timestamp: 3,
			};
			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				readToolResultMessage,
				bashToolResultMessage,
			];

			const replayEventsPromise = collectEvents(streamCursor(model, replayContext, { apiKey: "test-key" }));
			await expect(readCallPromise).resolves.toMatchObject({ content: [{ type: "text", text: "file contents" }] });
			await expect(bashCallPromise).resolves.toMatchObject({ content: [{ type: "text", text: "/repo" }] });
			resolveRun({ id: "run-1", status: "finished", result: "Bridge complete." });
			const replayEvents = await replayEventsPromise;
			const replayText = collectTextDeltas(replayEvents);
			const replayDone = getDoneEvent(replayEvents);

			expect(mockedCreate).toHaveBeenCalledTimes(1);
			expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ mode: "plan" }));
			expect(mockSend).toHaveBeenCalledTimes(1);
			expect(mockSend.mock.calls[0]?.[1]).toMatchObject({ mode: "plan" });
			expect(runWait).toHaveBeenCalledTimes(1);
			expect(replayText).toBe("Bridge complete.");
			expect(replayDone.reason).toBe("stop");
			expect(firstDone.message.usage.cost.input).toBeGreaterThan(0);
			expect(firstDone.message.usage.cost.total).toBeCloseTo(
				(firstDone.message.usage.input + firstDone.message.usage.output * 2) / 1_000_000, 10,
			);
			expect(replayDone.message.usage.cost.total).toBeCloseTo(
				(replayDone.message.usage.input + replayDone.message.usage.output * 2) / 1_000_000, 10,
			);
			expect(replayDone.message.usage.input).toBeGreaterThanOrEqual(
				estimateCursorPromptMessageTokens(readToolResultMessage) + estimateCursorPromptMessageTokens(bashToolResultMessage),
			);
			expect(replayDone.message.usage.totalTokens).toBeGreaterThanOrEqual(
				replayDone.message.usage.input + replayDone.message.usage.output,
			);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it("keeps non-bridge Cursor MCP replay visible while suppressing only bridge MCP calls", async () => {
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createTestToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
		});
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					callId: "external-mcp",
					toolCall: {
						name: "mcp",
						args: { toolName: "external_search" },
						result: { status: "success", value: { content: "external result" } },
					},
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
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("external_search");
		expect(trace).toContain("external result");
		expect(hasEventType(events, "toolcall_start")).toBe(false);
	});

	it("answers a real question after five minutes and continues the same SDK run", async () => {
		process.env.PI_CURSOR_ASK_QUESTION = "1";
		cursorProviderTestUtils.setCursorNativeReplayIdleDisposeMs(300_000);
		const pi = createPiHarness();
		registerCursorQuestionTool(pi);
		const question = pi._tools.find((tool) => tool.name === "cursor_ask_question")!;
		registerBridgeForProviderTest({ active: [question.name], tools: [createTestToolInfo(question.name, question.parameters, question.description)] });
		let finishRun = (_result: { id: string; status: "finished"; result: string }) => {};
		const cancel = vi.fn();
		const wait = vi.fn(() => new Promise<{ id: string; status: "finished"; result: string }>((resolve) => { finishRun = resolve; }));
		const send = vi.fn().mockResolvedValue(asMockCursorRun({ id: "run-question", agentId: "agent-question", status: "running", wait, cancel,
			supports: () => true, unsupportedReason: () => undefined }));
		mockCreatedAgent({ agentId: "agent-question", send, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const first = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
		const { client, transport } = await connectMcpClient(getPiToolsMcpUrlFromAgentCreateOptions(getCreatedAgentOptions()));
		try {
			vi.useFakeTimers();
			const mcp = client.callTool({ name: "pi__cursor_ask_question", arguments: { question: "Pick one", options: ["Yes", "No"], allowCustom: false } }, { timeout: 600_000 });
			void mcp.catch(() => {}); // Baseline causal probes can reject before the assertion fails.
			let firstEvents: Awaited<typeof first> | undefined;
			void first.then((events) => { firstEvents = events; });
			await vi.waitFor(() => expect(firstEvents).toBeDefined());
			const firstDone = getDoneEvent(firstEvents!);
			const call = firstDone.message.content.find(isToolCallBlock)!;
			let answer = (_value: string) => {};
			const ctx = createExtensionTestContext({ hasUI: true });
			ctx.ui.select = vi.fn(() => new Promise<string>((resolve) => { answer = resolve; }));
			const result = question.execute(call.id, call.arguments, undefined, undefined, ctx);
			expect(ctx.ui.select).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(300_001);
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);
			expect(cancel).not.toHaveBeenCalled();
			vi.useRealTimers();
			answer("Yes");
			const response = await result;
			const context = makeContext();
			context.messages.push(firstDone.message, { role: "toolResult", toolCallId: call.id, toolName: question.name,
				content: response.content, isError: false, timestamp: 2 });
			const resumed = collectEvents(streamCursor(makeModel(), context, { apiKey: "test-key" }));
			await expect(mcp).resolves.toMatchObject({ content: [{ type: "text", text: "User answered: Yes" }] });
			finishRun({ id: "run-question", status: "finished", result: "Answer accepted" });
			expect(getDoneEvent(await resumed).reason).toBe("stop");
			expect(send).toHaveBeenCalledOnce();
			expect(mockedCreate).toHaveBeenCalledOnce();
			expect(cancel).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
			await cursorProviderTestUtils.releaseAllPendingCursorLiveRunsForTests();
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it.each(["explicit release", "bridge deadline"] as const)("protects pending bridge MCP waits until %s and still abandons the session agent", async (cleanup) => {
		const previousBridgeTimeout = process.env.PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS;
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		cursorProviderTestUtils.setCursorNativeReplayIdleDisposeMs(1);
		if (cleanup === "bridge deadline") process.env.PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS = "500";
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createTestToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
		});
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const runWait = vi.fn(() => new Promise<{ id: string; status: "finished"; result: string }>(() => {}));
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "running",
			wait: runWait,
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		});

		const firstEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		const createOptions = getCreatedAgentOptions();
		const { client, transport } = await connectMcpClient(getPiToolsMcpUrlFromAgentCreateOptions(createOptions));
		try {
			const callErrorPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } }).catch((error: unknown) => error);
			const firstEvents = await firstEventsPromise;
			const firstDone = getDoneEvent(firstEvents);

			expect(firstDone.reason).toBe("toolUse");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);

			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);
			expect(mockDispose).not.toHaveBeenCalled();
			if (cleanup === "explicit release") await cursorProviderTestUtils.releaseAllPendingCursorLiveRunsForTests();
			const error = await callErrorPromise;
			await vi.waitFor(() => expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0));
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(cleanup === "bridge deadline" ? /timed out|MCP error/i : /disposed|cancelled|released|MCP error/i);
			await vi.waitFor(() => expect(mockDispose).toHaveBeenCalledTimes(1));
		} finally {
			if (previousBridgeTimeout === undefined) delete process.env.PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS;
			else process.env.PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS = previousBridgeTimeout;
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it("surfaces incomplete external Cursor tools as transcript traces in bridge-only live runs", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
		});

		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "mcp", args: { toolName: "demo" } },
					callId: "c-incomplete",
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
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(trace).toContain("Cursor MCP did not complete");
		expect(trace).toContain("missing completion");
	});
});
