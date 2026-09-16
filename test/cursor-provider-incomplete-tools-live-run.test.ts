import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState,
	mockedCreate,
	makeModel,
	makeContext,
	collectEvents,
	collectTextDeltas,
	collectThinkingDeltas,
	getEventsOfType,
	getDoneEvent,
	getErrorEvent,
	hasEventType,
	isToolCallBlock,
	registerNativeToolDisplayForTest,
	type CursorDeltaHandler,
	type RegisteredTool,
	mockCreatedAgent,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display-state.js";


describe("streamCursor incomplete native replay tools", () => {
	beforeEach(resetCursorProviderTestState);

	it("surfaces incomplete started Cursor tools on abort when a completed native replay tool is already queued", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const controller = new AbortController();
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const cancelRun = vi.fn().mockResolvedValue(undefined);
		const runWait = vi.fn(() => new Promise<{ id: string; status: "finished"; result: string }>(() => {}));
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "read",
						result: { status: "success", value: { content: "# readme" } },
					},
					callId: "c1",
				},
			});
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "grep", args: { pattern: "foo" } }, callId: "c2" } });
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: cancelRun,
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockCreatedAgent({ send: mockSend, [Symbol.asyncDispose]: mockDispose });

		const eventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		controller.abort();
		const events = await eventsPromise;

		expect(getErrorEvent(events).reason).toBe("aborted");
		expect(collectThinkingDeltas(events)).toContain("Cursor grep did not complete");
		expect(collectThinkingDeltas(events)).toContain("aborted");
		expect(getEventsOfType(events, "toolcall_start")).toHaveLength(0);
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		expect(cancelRun).toHaveBeenCalled();
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("surfaces incomplete started Cursor tools when aborting a scoped native live run", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const controller = new AbortController();
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const cancelRun = vi.fn().mockResolvedValue(undefined);
		const runWait = vi.fn(() => new Promise<{ id: string; status: "finished"; result: string }>(() => {}));
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: cancelRun,
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockCreatedAgent({ send: mockSend, [Symbol.asyncDispose]: mockDispose });

		const eventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		controller.abort();
		const events = await eventsPromise;

		expect(getErrorEvent(events).reason).toBe("aborted");
		expect(collectThinkingDeltas(events)).toContain("Cursor read did not complete");
		expect(collectThinkingDeltas(events)).toContain("aborted");
		expect(getEventsOfType(events, "toolcall_start")).toHaveLength(0);
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		expect(cancelRun).toHaveBeenCalled();
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("does not replay a stale incomplete shell start as an error card after a successful text-producing turn", async () => {
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
					toolCall: { name: "shell", args: { command: "echo cursor-stuck-probe-ok" } },
					callId: "c-shell-stale",
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

		const eventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		resolveRun({ id: "run-1", status: "finished", result: "done after stale shell" });
		const events = await eventsPromise;
		const done = getDoneEvent(events);

		expect(done.reason).toBe("stop");
		expect(done.message.content.filter(isToolCallBlock)).toHaveLength(0);
		expect(collectThinkingDeltas(events)).not.toContain("Cursor shell did not complete");
		expect(collectThinkingDeltas(events)).not.toContain("missing completion");
		expect(collectTextDeltas(events)).toBe("done after stale shell");
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
	});

	it("replays incomplete external Cursor tools as neutral cursor activity cards before final text", async () => {
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
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "mcp", args: { toolName: "demo" } }, callId: "c1" } });
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

		const firstEventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		resolveRun({ id: "run-1", status: "finished", result: "done after incomplete MCP" });
		const firstEvents = await firstEventsPromise;
		const firstDone = getDoneEvent(firstEvents);
		const toolCalls = firstDone.message.content.filter(isToolCallBlock);

		expect(firstDone.reason).toBe("toolUse");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]?.name).toBe("cursor");
		expect(toolCalls[0]?.arguments).toMatchObject({
			activityTitle: "Cursor MCP",
			activitySummary: "missing completion",
		});
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(1);

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult" as const,
				toolCallId: toolCalls[0]!.id,
				toolName: "cursor",
				content: [{ type: "text" as const, text: "Cursor MCP did not complete" }],
				isError: true,
				timestamp: 2,
			},
		];
		const finalEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		expect(getDoneEvent(finalEvents).reason).toBe("stop");
		expect(collectTextDeltas(finalEvents)).toBe("done after incomplete MCP");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
	});

	it("does not replay a stale incomplete edit after the completed edit used a different delta id", async () => {
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
					toolCall: { name: "edit_file", args: { path: ".scratchpad.md" } },
					callId: "started-edit",
				},
			});
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "edit_file",
						args: { path: ".scratchpad.md" },
						result: { status: "success", value: { diff: "+done" } },
					},
					callId: "completed-edit",
				},
			});
			opts.onDelta({ update: { type: "text-delta", text: "daily refresh complete" } });
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

		const firstEventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		resolveRun({ id: "run-1", status: "finished", result: "daily refresh complete" });
		const firstDone = getDoneEvent(await firstEventsPromise);
		const completedToolCall = firstDone.message.content.find(isToolCallBlock);

		expect(firstDone.reason).toBe("toolUse");
		expect(completedToolCall).toMatchObject({
			name: "cursor",
			arguments: { activityTitle: "Cursor edit", activitySummary: ".scratchpad.md" },
		});

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult" as const,
				toolCallId: completedToolCall!.id,
				toolName: "cursor",
				content: [{ type: "text" as const, text: "edit .scratchpad.md" }],
				isError: false,
				timestamp: 2,
			},
		];
		const finalEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const finalDone = getDoneEvent(finalEvents);

		expect(finalDone.reason).toBe("stop");
		expect(collectTextDeltas(finalEvents)).toBe("daily refresh complete");
		expect(finalDone.message.content.find(isToolCallBlock)).toBeUndefined();
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
	});

	it("suppresses incomplete fast local Cursor glob tools when the run finishes with text", async () => {
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
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "glob", args: { pattern: "src/**/*.ts" } }, callId: "c1" } });
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

		const firstEventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		resolveRun({ id: "run-1", status: "finished", result: "done after glob" });
		const firstEvents = await firstEventsPromise;
		const firstDone = getDoneEvent(firstEvents);

		expect(firstDone.reason).toBe("stop");
		expect(collectTextDeltas(firstEvents)).toBe("done after glob");
		expect(firstDone.message.content.find(isToolCallBlock)).toBeUndefined();
		expect(hasEventType(firstEvents, "toolcall_start")).toBe(false);
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);
	});

	it("surfaces incomplete fast local Cursor glob tools when the run finishes without text", async () => {
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
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "glob", args: { pattern: "src/**/*.ts" } }, callId: "c1" } });
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

		const firstEventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		resolveRun({ id: "run-1", status: "finished", result: "" });
		const firstEvents = await firstEventsPromise;
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(firstDone.reason).toBe("toolUse");
		expect(toolCall).toMatchObject({
			name: "cursor",
			arguments: { activityTitle: "Cursor find", activitySummary: "missing completion" },
		});
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(1);

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult" as const,
				toolCallId: toolCall!.id,
				toolName: "cursor",
				content: [{ type: "text" as const, text: "Cursor find did not complete" }],
				isError: true,
				timestamp: 2,
			},
		];
		const finalEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		expect(getDoneEvent(finalEvents).reason).toBe("stop");
		expect(collectTextDeltas(finalEvents)).toBe("");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
	});
});
