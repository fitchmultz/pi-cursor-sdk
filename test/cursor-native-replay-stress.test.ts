import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Type } from "typebox";
import {
	resetCursorProviderTestState,
	mockedCreate,
	makeModel,
	makeContext,
	collectEvents,
	collectThinkingDeltas,
	hasEventType,
	createNativeToolDisplayPiForTest,
	type CursorDeltaHandler,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";

const CURSOR_MODEL = makeModel();

function mockFinishedGrepSend() {
	return vi.fn(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
		opts.onDelta({
			update: {
				type: "tool-call-completed",
				toolCall: {
					name: "grep",
					args: { pattern: "sidebar", path: "src" },
					result: { status: "success", value: { matches: ["src/a.css"] } },
				},
				callId: "grep-1",
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
}

function mockFinishedTaskSend() {
	return vi.fn(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
		opts.onDelta({
			update: {
				type: "tool-call-completed",
				toolCall: {
					name: "task",
					args: { description: "Verify plan-strip resync" },
					result: {
						status: "success",
						value: { result: { success: { command: "echo ok", stdout: "ok\n" } } },
					},
				},
				callId: "task-1",
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
}

describe("native replay stress", () => {
	beforeEach(async () => {
		cursorProviderTestUtils.setCursorNativeReplayIdleDisposeMs(0);
		await resetCursorProviderTestState();
	});

	afterEach(async () => {
		await cursorProviderTestUtils.releaseAllPendingCursorLiveRunsForTests();
		await cursorProviderTestUtils.resetSessionCursorAgents();
	});

	it("plan strip then turn_start resync replays grep when context.tools match active tools", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const pi = await createNativeToolDisplayPiForTest();
		pi.setActiveTools(["read", "bash", "edit", "write"]);
		await pi.runEventHandlers("turn_start", { model: CURSOR_MODEL });
		expect(pi.getActiveTools()).toContain("grep");
		expect(pi.getActiveTools()).toContain("cursor");

		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockFinishedGrepSend(),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const context = makeContext();
		context.tools = pi.getActiveTools().map((name) => ({ name, description: name, parameters: Type.Object({}) }));
		const events = await collectEvents(streamCursor(CURSOR_MODEL, context, { apiKey: "test-key" }));
		expect(hasEventType(events, "toolcall_start")).toBe(true);
	});

	it("plan strip then turn_start resync replays neutral task activity when context.tools match active tools", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const pi = await createNativeToolDisplayPiForTest();
		pi.setActiveTools(["read", "bash", "edit", "write"]);
		await pi.runEventHandlers("turn_start", { model: CURSOR_MODEL });
		expect(pi.getActiveTools()).toContain("cursor");

		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockFinishedTaskSend(),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const context = makeContext();
		context.tools = pi.getActiveTools().map((name) => ({ name, description: name, parameters: Type.Object({}) }));
		const events = await collectEvents(streamCursor(CURSOR_MODEL, context, { apiKey: "test-key" }));
		expect(hasEventType(events, "toolcall_start")).toBe(true);
	});

	it("stale context.tools without grep still avoids toolUse (coordinator guard)", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await createNativeToolDisplayPiForTest();
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: vi.fn(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "grep",
							args: { pattern: "sidebar", path: "src" },
							result: { status: "success", value: { matches: ["src/a.css"] } },
						},
						callId: "grep-1",
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
			}),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const context = makeContext();
		context.tools = [{ name: "read", description: "Read", parameters: Type.Object({}) }];
		const events = await collectEvents(streamCursor(makeModel(), context, { apiKey: "test-key" }));
		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(collectThinkingDeltas(events)).toMatch(/grep|sidebar/i);
	});

	it("inactive cursor edit maps to trace text, not broken toolUse", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await createNativeToolDisplayPiForTest();
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: vi.fn(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "edit",
							args: { path: "src/app.tsx" },
							result: { status: "success", value: {} },
						},
						callId: "edit-1",
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
			}),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const context = makeContext();
		context.tools = [{ name: "read", description: "Read", parameters: Type.Object({}) }];
		const events = await collectEvents(streamCursor(makeModel(), context, { apiKey: "test-key" }));
		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(collectThinkingDeltas(events)).toMatch(/Cursor edit:|edit.*completed/i);
	});

	it("find inactive in context uses trace fallback", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await createNativeToolDisplayPiForTest();
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: vi.fn(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: { name: "find", args: { pattern: "**/*", path: "." }, result: { status: "success", value: {} } },
						callId: "find-1",
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
			}),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const context = makeContext();
		context.tools = [{ name: "read", description: "Read", parameters: Type.Object({}) }];
		const events = await collectEvents(streamCursor(makeModel(), context, { apiKey: "test-key" }));
		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(collectThinkingDeltas(events)).toMatch(/find/i);
	});

	it("inactive MCP trace scrubs secrets from collapsed summary", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await createNativeToolDisplayPiForTest();
		const secret = "super-secret-key-12345";
		mockedCreate.mockResolvedValue({
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
				return {
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				};
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

	it("incomplete started read uses inactive trace when cursor is not in context", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await createNativeToolDisplayPiForTest();
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: vi.fn(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-started",
						toolCall: { name: "read", args: { path: "README.md" } },
						callId: "read-incomplete-1",
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
			}),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const context = makeContext();
		context.tools = [{ name: "read", description: "Read", parameters: Type.Object({}) }];
		const events = await collectEvents(streamCursor(makeModel(), context, { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(trace).toContain("Cursor read did not complete");
		expect(trace).toContain("missing completion");
	});

	it("incomplete started read uses transcript trace when native replay is unavailable", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS = "0";
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: vi.fn(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-started",
						toolCall: { name: "read", args: { path: "README.md" } },
						callId: "read-incomplete-2",
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
			}),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(trace).toContain("Cursor read did not complete");
		expect(trace).toContain("missing completion");
	});
});
