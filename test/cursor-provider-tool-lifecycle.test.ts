import { describe, it, expect, vi, beforeEach } from "vitest";
import { Type } from "typebox";
import {
	resetCursorProviderTestState,
	mockedCreate,
	makeModel,
	makeContext,
	collectEvents,
	collectThinkingDeltas,
	collectTextDeltas,
	getDoneEvent,
	getErrorEvent,
	isToolCallBlock,
	registerBridgeForProviderTest,
	registerNativeToolDisplayForTest,
	createBridgeToolInfo,
	delayBeforeToolCompletion,
	type CursorDeltaHandler,
	type RegisteredTool,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { CursorSdkEventDebugSink } from "../src/cursor-sdk-event-debug.js";
import { __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { CURSOR_TOOL_LIFECYCLE_DEFER_MS } from "../src/cursor-tool-lifecycle.js";

const delayBeyondLifecycleDefer = () =>
	new Promise((resolve) => setTimeout(resolve, CURSOR_TOOL_LIFECYCLE_DEFER_MS + 80));

const lifecycleShellProgressPattern = /Cursor shell: (shell|npm test)/;

const slowCleanupMs = CURSOR_TOOL_LIFECYCLE_DEFER_MS + 120;

const mockSlowSessionAgentDispose = () =>
	vi.spyOn(sessionAgentTestUtils, "resetSessionCursorAgent").mockImplementation(
		() => new Promise((resolve) => setTimeout(resolve, slowCleanupMs)),
	);

const mockSlowDebugCapture = () =>
	vi.spyOn(CursorSdkEventDebugSink.prototype, "captureRunArtifacts").mockImplementation(
		async () => {
			await new Promise((resolve) => setTimeout(resolve, slowCleanupMs));
		},
	);

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

	it("does not emit lifecycle progress for fast lifecycle-eligible MCP completions", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "mcp", args: { toolName: "external_search" } },
					callId: "mcp-fast-1",
				},
			});
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "mcp",
						args: { toolName: "external_search" },
						result: { status: "success", value: { content: [{ type: "text", text: "ok" }] } },
					},
					callId: "mcp-fast-1",
				},
			});
			await delayBeyondLifecycleDefer();
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
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(trace).not.toContain("Cursor MCP:");
		expect(trace).toContain("external_search");
		expect(trace).toContain("ok");
	});

	it("does not emit lifecycle progress for delayed pi bridge MCP calls", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		registerBridgeForProviderTest({
			active: ["sem_reindex"],
			tools: [createBridgeToolInfo("sem_reindex", Type.Object({ target: Type.String() }), "Reindex semantic cache")],
		});

		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: {
						name: "mcp",
						args: { toolName: "pi__sem_reindex", description: "bridge semantic reindex should stay silent" },
					},
					callId: "bridge-mcp-1",
				},
			});
			await delayBeyondLifecycleDefer();
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "mcp",
						args: { toolName: "pi__sem_reindex" },
						result: { status: "success", value: { content: [{ type: "text", text: "ok" }] } },
					},
					callId: "bridge-mcp-1",
				},
			});
			opts.onDelta({ update: { type: "text-delta", text: "done" } });
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

		expect(trace).not.toContain("Cursor MCP:");
		expect(trace).not.toContain("bridge semantic reindex should stay silent");
	});

	it("does not append deferred lifecycle progress after non-live run.wait rejection", async () => {
		const disposeSpy = mockSlowSessionAgentDispose();
		const waitError = new Error("run wait failed");
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "shell", args: { command: "npm test" } },
					callId: "shell-wait-fail-1",
				},
			});
			return {
				id: "run-shell-fail",
				agentId: "agent-1",
				status: "running",
				wait: vi.fn().mockRejectedValue(waitError),
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
		expect(collectThinkingDeltas(events)).not.toMatch(lifecycleShellProgressPattern);
		expect(collectThinkingDeltas(events)).toContain("Cursor shell did not complete");
		const contentSnapshot = [...error.error.content];
		expect(contentSnapshot.some((block) => block.type === "thinking")).toBe(true);

		await delayBeyondLifecycleDefer();

		expect(error.error.content).toEqual(contentSnapshot);
		expect(collectThinkingDeltas(events)).not.toMatch(lifecycleShellProgressPattern);
		disposeSpy.mockRestore();
	});

	it("does not append deferred lifecycle progress after non-live run.wait resolves before slow debug capture", async () => {
		process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
		process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = "/tmp/pi-cursor-sdk-lifecycle-wait-finished";
		const captureSpy = mockSlowDebugCapture();
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "shell", args: { command: "npm test" } },
					callId: "shell-wait-finished-1",
				},
			});
			return {
				id: "run-shell-finished",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-shell-finished", status: "finished", result: "Done." }),
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
		expect(trace).not.toMatch(lifecycleShellProgressPattern);

		await delayBeyondLifecycleDefer();

		expect(collectThinkingDeltas(events)).not.toMatch(lifecycleShellProgressPattern);
		captureSpy.mockRestore();
		delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
		delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
	});

	it("does not append deferred lifecycle progress after live background run.wait resolves before slow debug capture", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
		process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = "/tmp/pi-cursor-sdk-lifecycle-live-wait-finished";
		const captureSpy = mockSlowDebugCapture();
		await registerNativeToolDisplayForTest([]);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "shell", args: { command: "npm test" } },
					callId: "shell-live-wait-finished-1",
				},
			});
			return {
				id: "run-shell-live-finished",
				agentId: "agent-1",
				status: "running",
				wait: vi.fn().mockResolvedValue({ id: "run-shell-live-finished", status: "finished", result: "Done." }),
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
		expect(collectThinkingDeltas(events)).not.toMatch(lifecycleShellProgressPattern);

		const incompleteToolCall = done.message.content.find(isToolCallBlock);
		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			done.message,
			{
				role: "toolResult" as const,
				toolCallId: incompleteToolCall!.id,
				toolName: "cursor",
				content: [{ type: "text" as const, text: "Cursor shell did not complete" }],
				isError: true,
				timestamp: 2,
			},
		];
		const finalEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		expect(getDoneEvent(finalEvents).reason).toBe("stop");
		expect(collectTextDeltas(finalEvents)).toBe("Done.");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);

		await delayBeyondLifecycleDefer();

		expect(collectThinkingDeltas(events)).not.toMatch(lifecycleShellProgressPattern);
		captureSpy.mockRestore();
		delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
		delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
	});

	it("does not append deferred lifecycle progress after live background run.wait rejection", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
		process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = "/tmp/pi-cursor-sdk-lifecycle-wait-fail";
		const captureSpy = mockSlowDebugCapture();
		await registerNativeToolDisplayForTest([]);
		const waitError = new Error("run wait failed");
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "shell", args: { command: "npm test" } },
					callId: "shell-live-wait-fail-1",
				},
			});
			return {
				id: "run-shell-live-fail",
				agentId: "agent-1",
				status: "running",
				wait: vi.fn().mockRejectedValue(waitError),
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
		expect(firstDone.reason).toBe("toolUse");
		const incompleteToolCall = firstDone.message.content.find(isToolCallBlock);
		expect(incompleteToolCall).toMatchObject({
			name: "cursor",
			arguments: { activityTitle: "Cursor shell", activitySummary: "SDK run failed" },
		});
		expect(collectThinkingDeltas(firstEvents)).not.toMatch(lifecycleShellProgressPattern);

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult" as const,
				toolCallId: incompleteToolCall!.id,
				toolName: "cursor",
				content: [{ type: "text" as const, text: "Cursor shell did not complete" }],
				isError: true,
				timestamp: 2,
			},
		];
		const secondEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		expect(getErrorEvent(secondEvents).reason).toBe("error");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);

		await delayBeyondLifecycleDefer();

		expect(collectThinkingDeltas(firstEvents)).not.toMatch(lifecycleShellProgressPattern);
		expect(collectThinkingDeltas(secondEvents)).not.toMatch(lifecycleShellProgressPattern);
		captureSpy.mockRestore();
		delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
		delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
	});
});
