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
import { parseCursorNativeReplayIdleDisposeMs } from "../src/cursor-provider-live-run-drain.js";
import { estimateCursorPromptMessageTokens } from "../src/context.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display-state.js";
import type { Context } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


describe("streamCursor native replay idle dispose", () => {
	beforeEach(resetCursorProviderTestState);

	it.each([
		[undefined, 300000],
		["", 300000],
		["0", 300000],
		["-1", 300000],
		["1.5", 300000],
		[" 1", 300000],
		["1 ", 300000],
		["1e3", 300000],
		["0x10", 300000],
		["2147483648", 300000],
		["999999999999999999999", 300000],
		["1", 1],
		["900000", 900000],
		["2147483647", 2147483647],
	])("parses idle disposal duration %s as %i ms", (raw, expected) => {
		expect(parseCursorNativeReplayIdleDisposeMs(raw)).toBe(expected);
	});

	it("disposes abandoned native replay runs after the idle timeout and abandons the session agent", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		cursorProviderTestUtils.setCursorNativeReplayIdleDisposeMs(1);
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const runWait = vi.fn(() => new Promise<{ id: string; status: "finished"; result: string }>(() => {}));
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
			[Symbol.asyncDispose]: mockDispose,
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const done = getDoneEvent(events);

		expect(done.reason).toBe("toolUse");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(1);
		expect(mockDispose).not.toHaveBeenCalled();

		await vi.waitFor(() => expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0));
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("keeps a streamCursor run past the old short deadline and disposes it at the configured deadline", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		process.env.PI_CURSOR_LIVE_RUN_IDLE_DISPOSE_MS = "900000";
		await registerNativeToolDisplayForTest([]);
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		mockCreatedAgent({
			agentId: "agent-1",
			send: vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: { name: "read", result: { status: "success", value: { content: "# pi-cursor-sdk" } } },
						callId: "c1",
					},
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "running",
					wait: vi.fn(() => new Promise<never>(() => {})),
				});
			}),
			[Symbol.asyncDispose]: mockDispose,
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			expect(getDoneEvent(events).reason).toBe("toolUse");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(300001);
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);
			expect(mockDispose).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(599998);
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
			expect(mockDispose).toHaveBeenCalledTimes(1);
		} finally {
			await cursorProviderTestUtils.releaseAllPendingCursorLiveRunsForTests();
			vi.useRealTimers();
		}
	});

	it("cleans up pending native replay runs when replay aborts mid-flight and abandons the session agent", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const controller = new AbortController();
		const mockDispose = vi.fn().mockResolvedValue(undefined);
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
			[Symbol.asyncDispose]: mockDispose,
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall!.id, toolCall!.arguments, undefined, undefined, createExtensionTestContext());

		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);
		expect(mockDispose).not.toHaveBeenCalled();

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

		const replayEventsPromise = collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key", signal: controller.signal }));
		await Promise.resolve();
		controller.abort();
		const replayEvents = await replayEventsPromise;
		const error = getErrorEvent(replayEvents);

		expect(error.reason).toBe("aborted");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);
		expect(mockDispose).toHaveBeenCalledTimes(1);

		resolveRun({ id: "run-1", status: "finished", result: "late result" });
		await Promise.resolve();
		await Promise.resolve();

		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("cleans up pending native replay runs when the replay signal is already aborted before wait listener registration", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const mockDispose = vi.fn().mockResolvedValue(undefined);
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
			[Symbol.asyncDispose]: mockDispose,
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall!.id, toolCall!.arguments, undefined, undefined, createExtensionTestContext());
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);

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

		let abortedReads = 0;
		const fakeSignal = {
			get aborted() {
				abortedReads += 1;
				return abortedReads >= 2;
			},
			onabort: null,
			reason: undefined,
			throwIfAborted() {
				if (this.aborted) throw this.reason;
			},
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(() => true),
		} satisfies AbortSignal;
		const replayEvents = await Promise.race([
			collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key", signal: fakeSignal })),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for aborted replay")), 100)),
		]);
		const error = getErrorEvent(replayEvents);

		expect(error.reason).toBe("aborted");
		expect(fakeSignal.addEventListener).not.toHaveBeenCalled();
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);
		expect(mockDispose).toHaveBeenCalledTimes(1);

		resolveRun({ id: "run-1", status: "finished", result: "late result" });
		await Promise.resolve();
		await Promise.resolve();

		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});
});
