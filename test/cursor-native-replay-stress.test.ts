import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Type } from "typebox";
import { installCursorProviderVirtualTime } from "./helpers/cursor-provider-virtual-time.js";
import {
	resetCursorProviderTestState,
	makeModel,
	makeContext,
	collectEvents,
	collectThinkingDeltas,
	getDoneEvent,
	isToolCallBlock,
	hasEventType,
	createNativeToolDisplayPiForTest,
	type CursorDeltaHandler,
	mockCreatedAgent,
	asMockCursorRun,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";

const CURSOR_MODEL = makeModel();

function mockFinishedToolSend(toolCall: unknown, callId: string) {
	return vi.fn(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
		opts.onDelta({ update: { type: "tool-call-completed", toolCall, callId } });
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
}

describe("native replay stress", () => {
	beforeEach(async () => {
		cursorProviderTestUtils.setCursorNativeReplayIdleDisposeMs(0);
		await resetCursorProviderTestState();
	});

	installCursorProviderVirtualTime();

	afterEach(async () => {
		await cursorProviderTestUtils.releaseAllPendingCursorLiveRunsForTests();
		await cursorProviderTestUtils.resetSessionCursorAgents();
	});

	it.each([
		{
			name: "grep",
			args: { pattern: "sidebar", path: "src" },
			result: { matches: ["src/a.css"] },
			expected: { name: "grep", arguments: { pattern: "sidebar", path: "src" } },
		},
		{
			name: "task",
			args: { description: "Verify plan-strip resync" },
			result: { result: { success: { command: "echo ok", stdout: "ok\n" } } },
			expected: { name: "cursor", arguments: { activityTitle: "Cursor subagent", activitySummary: "Verify plan-strip resync: $ echo ok" } },
		},
	])("plan strip then turn_start resync replays $name when context.tools match active tools", async ({ name, args, result, expected }) => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const pi = await createNativeToolDisplayPiForTest();
		pi.setActiveTools(["read", "bash", "edit", "write"]);
		await pi.runTurnStart({ model: CURSOR_MODEL });
		expect(pi.getActiveTools()).toEqual(expect.arrayContaining([expected.name, "cursor"]));

		mockCreatedAgent({
			agentId: "agent-1",
			send: mockFinishedToolSend({ name, args, result: { status: "success", value: result } }, `${name}-1`),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const context = makeContext();
		context.tools = pi.getActiveTools().map((name) => ({ name, description: name, parameters: Type.Object({}) }));
		const events = await collectEvents(streamCursor(CURSOR_MODEL, context, { apiKey: "test-key" }));
		const done = getDoneEvent(events);
		expect(done.reason).toBe("toolUse");
		expect(hasEventType(events, "toolcall_start")).toBe(true);
		expect(done.message.content.filter(isToolCallBlock)).toMatchObject([expected]);
	});

	it.each([
		["grep", { pattern: "sidebar", path: "src" }, { matches: ["src/a.css"] }, /grep|sidebar/i],
		["edit", { path: "src/app.tsx" }, {}, /Cursor edit:|edit.*completed/i],
		["find", { pattern: "**/*", path: "." }, {}, /find/i],
	] as const)("inactive %s in context uses trace fallback instead of toolUse", async (name, args, result, traceMatcher) => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await createNativeToolDisplayPiForTest();
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockFinishedToolSend({ name, args, result: { status: "success", value: result } }, `${name}-1`),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const context = makeContext();
		context.tools = [{ name: "read", description: "Read", parameters: Type.Object({}) }];
		const events = await collectEvents(streamCursor(makeModel(), context, { apiKey: "test-key" }));
		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(collectThinkingDeltas(events)).toMatch(traceMatcher);
	});

	it("inactive MCP trace scrubs secrets from collapsed summary", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await createNativeToolDisplayPiForTest();
		const secret = "super-secret-key-12345";
		mockCreatedAgent({
			agentId: "agent-1",
			send: vi.fn(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "mcp",
							args: { toolName: "auth" },
							result: {
								status: "success",
								value: {
									content: [{ text: { text: `apiKey=${secret}\nBearer bearer-token-value` } }],
								},
							},
						},
						callId: "mcp-1",
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
			}),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const context = makeContext();
		context.tools = [{ name: "read", description: "Read", parameters: Type.Object({}) }];
		const events = await collectEvents(streamCursor(makeModel(), context, { apiKey: secret }));
		const trace = collectThinkingDeltas(events);

		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(trace).toMatch(/Cursor MCP/i);
		expect(trace).toContain("[redacted]");
		expect(trace).not.toContain(secret);
		expect(trace).not.toContain("bearer-token-value");
	});

	it("incomplete started external tool uses inactive trace when cursor is not in context", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await createNativeToolDisplayPiForTest();
		mockCreatedAgent({
			agentId: "agent-1",
			send: vi.fn(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-started",
						toolCall: { name: "mcp", args: { toolName: "demo" } },
						callId: "mcp-incomplete-1",
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
			}),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const context = makeContext();
		context.tools = [{ name: "read", description: "Read", parameters: Type.Object({}) }];
		const events = await collectEvents(streamCursor(makeModel(), context, { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(trace).toContain("Cursor MCP did not complete");
		expect(trace).toContain("missing completion");
	});

	it("incomplete started external tool uses transcript trace when native replay is unavailable", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS = "0";
		mockCreatedAgent({
			agentId: "agent-1",
			send: vi.fn(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-started",
						toolCall: { name: "mcp", args: { toolName: "demo" } },
						callId: "mcp-incomplete-2",
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
			}),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(trace).toContain("Cursor MCP did not complete");
		expect(trace).toContain("missing completion");
	});
});
