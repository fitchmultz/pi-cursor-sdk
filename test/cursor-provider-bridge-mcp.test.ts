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
import { __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as cursorPiToolBridgeTestUtils } from "../src/cursor-pi-tool-bridge.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display.js";
import type { Context } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";



describe("streamCursor bridge MCP", () => {
	beforeEach(resetCursorProviderTestState);

	it("surfaces empty live-run error status with run metadata", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "partial" } });
			return {
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
			};
		});
		mockedCreate.mockResolvedValue({
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
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "error",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "error", result: "MCP tool call timed out after 60s" }),
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
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));

		const createOptions = getCreatedAgentOptions();
		const { client, transport } = await connectMcpClient(createOptions.mcpServers!.pi_tools.url);
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
		mockedCreate.mockResolvedValue({
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
			tools: [createBridgeToolInfo("sem_reindex", Type.Object({ target: Type.String() }), "Reindex semantic cache")],
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
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));

		const createOptions = getCreatedAgentOptions();
		expect(createOptions.local).toEqual({ cwd: process.cwd(), settingSources: ["all"] });
		expect(createOptions.mcpServers?.pi_tools?.type).toBe("http");
		const url = new URL(createOptions.mcpServers.pi_tools.url);
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
		mockedCreate.mockResolvedValue({
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
		mockedCreate.mockResolvedValue({
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
			tools: [createBridgeToolInfo("read")],
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
		mockedCreate.mockResolvedValue({
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
		nativeToolDisplayTestUtils.registerNativeToolNameForTests("cursor");
		nativeToolDisplayTestUtils.registerNativeToolNameForTests("cursor_edit");
		vi.clearAllMocks();
		registerBridgeForProviderTest({
			active: ["cursor", "cursor_edit"],
			tools: [createBridgeToolInfo("cursor"), createBridgeToolInfo("cursor_edit")],
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-2",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		expect(getCreatedAgentOptions().mcpServers).toBeUndefined();
	});

	it("emits bridge MCP requests as real pi tool calls and resumes the same Cursor run after tool results", async () => {
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

		const firstEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		const createOptions = getCreatedAgentOptions();
		const { client, transport } = await connectMcpClient(createOptions.mcpServers.pi_tools.url);
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
				},
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

			const replayEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), replayContext, { apiKey: "test-key" }));
			await expect(readCallPromise).resolves.toMatchObject({ content: [{ type: "text", text: "file contents" }] });
			await expect(bashCallPromise).resolves.toMatchObject({ content: [{ type: "text", text: "/repo" }] });
			resolveRun({ id: "run-1", status: "finished", result: "Bridge complete." });
			const replayEvents = await replayEventsPromise;
			const replayText = collectTextDeltas(replayEvents);
			const replayDone = getDoneEvent(replayEvents);

			expect(mockedCreate).toHaveBeenCalledTimes(1);
			expect(mockSend).toHaveBeenCalledTimes(1);
			expect(runWait).toHaveBeenCalledTimes(1);
			expect(replayText).toBe("Bridge complete.");
			expect(replayDone.reason).toBe("stop");
			expect(replayDone.message.usage.input).toBe(
				estimateCursorPromptMessageTokens(readToolResultMessage) + estimateCursorPromptMessageTokens(bashToolResultMessage),
			);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it("keeps non-bridge Cursor MCP replay visible while suppressing only bridge MCP calls", async () => {
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBridgeToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
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
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
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

		const events = await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("external_search");
		expect(trace).toContain("external result");
		expect(hasEventType(events, "toolcall_start")).toBe(false);
	});

	it("rejects pending bridge MCP waits, clears live runs on idle disposal, and abandons the session agent", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		cursorProviderTestUtils.setCursorNativeReplayIdleDisposeMs(1);
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBridgeToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
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
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		});

		const firstEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		const createOptions = getCreatedAgentOptions();
		const { client, transport } = await connectMcpClient(createOptions.mcpServers.pi_tools.url);
		try {
			const callErrorPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } }).catch((error: unknown) => error);
			const firstEvents = await firstEventsPromise;
			const firstDone = getDoneEvent(firstEvents);

			expect(firstDone.reason).toBe("toolUse");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);

			await vi.waitFor(() => expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0));
			const error = await callErrorPromise;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/disposed|cancelled|MCP error/i);
			expect(mockDispose).toHaveBeenCalledTimes(1);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it("surfaces incomplete Cursor tools as transcript traces in bridge-only live runs", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
		});

		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "read", args: { path: "README.md" } },
					callId: "c-incomplete",
				},
			});
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
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
		const trace = collectThinkingDeltas(events);

		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(trace).toContain("Cursor read did not complete");
		expect(trace).toContain("missing completion");
	});
});
