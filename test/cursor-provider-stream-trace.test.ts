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
import { __testUtils as contextWindowCacheTestUtils } from "../src/context-window-cache.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import { __testUtils as sdkEventDebugTestUtils } from "../src/cursor-sdk-event-debug.js";
import type { Context } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";



describe("streamCursor trace and streaming", () => {
	beforeEach(resetCursorProviderTestState);

it("detects trailing user messages only after tool results", () => {
		const base = makeContext();
		const toolResult: Context["messages"][number] = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 3,
		};

		expect(cursorProviderTestUtils.hasTrailingUserMessagesAfterToolResults(base)).toBe(false);
		expect(
			cursorProviderTestUtils.hasTrailingUserMessagesAfterToolResults({
				...base,
				messages: [...base.messages, makeAssistantMessage(), { role: "user", content: "follow up", timestamp: 4 }],
			}),
		).toBe(false);
		expect(
			cursorProviderTestUtils.hasTrailingUserMessagesAfterToolResults({
				...base,
				messages: [...base.messages, makeAssistantMessage(), toolResult, { role: "user", content: "follow up", timestamp: 4 }],
			}),
		).toBe(true);
	});

	it("emits text deltas as pi text stream events", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "Hello " } });
			opts.onDelta({ update: { type: "text-delta", text: "world" } });
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

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const textDeltas = getEventsOfType(events, "text_delta");
		expect(textDeltas).toHaveLength(2);
		expect(textDeltas[0].delta).toBe("Hello ");
		expect(textDeltas[1].delta).toBe("world");

		const done = getDoneEvent(events);
		expect(done).toBeDefined();
	});

	it("captures provider debug artifacts through streamCursor when enabled", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-provider-debug-"));
		const previousDebug = process.env.PI_CURSOR_SDK_EVENT_DEBUG;
		const previousRunDir = process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
		process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
		process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = artifactDir;

		try {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "text-delta", text: "debugged" } });
				return {
					id: "run-debug",
					agentId: "agent-debug",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-debug", status: "finished" }),
					cancel: vi.fn(),
					supports: () => false,
					unsupportedReason: () => "conversation unsupported",
					stream: async function* () {
						yield { type: "assistant", message: { content: [{ type: "text", text: "debugged" }] } };
					},
				};
			});
			mockedCreate.mockResolvedValue({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));

			expect(readFileSync(join(artifactDir, "on-delta.jsonl"), "utf8")).toContain('"text-delta"');
			expect(readFileSync(join(artifactDir, "pi-stream-events.jsonl"), "utf8")).toContain('"text_delta"');
			expect(readFileSync(join(artifactDir, "stream-events.jsonl"), "utf8")).toContain('"assistant"');
			expect(JSON.parse(readFileSync(join(artifactDir, "summary.json"), "utf8"))).toMatchObject({
				artifactDir,
				waitResultRecorded: true,
			});
		} finally {
			if (previousDebug === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
			else process.env.PI_CURSOR_SDK_EVENT_DEBUG = previousDebug;
			if (previousRunDir === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
			else process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = previousRunDir;
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});

	it("records continuation drain artifacts on the next turn debug sink", async () => {
		const previousNativeDisplay = process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const baseDir = mkdtempSync(join(tmpdir(), "pi-cursor-provider-debug-continuation-"));
		const sessionFile = join(baseDir, "session.jsonl");
		const eventsDir = join(baseDir, "events");
		const previousDebug = process.env.PI_CURSOR_SDK_EVENT_DEBUG;
		const previousDebugDir = process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR;
		const { __testUtils: scopeTestUtils } = await import("../src/cursor-session-scope.js");

		sdkEventDebugTestUtils.resetSessionDebugState();
		scopeTestUtils.set(baseDir, sessionFile);
		process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
		process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR = eventsDir;

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

		try {
			const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			expect(getDoneEvent(firstEvents).reason).toBe("toolUse");

			firstOnDelta?.({ update: { type: "text-delta", text: "Late scoped text." } });
			const secondEventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			await Promise.resolve();
			resolveRun({ id: "run-1", status: "finished", result: "Late scoped final." });
			await secondEventsPromise;

			const sessionSlug = sdkEventDebugTestUtils.slugSessionKey(sessionFile);
			const manifest = JSON.parse(
				readFileSync(join(eventsDir, "sessions", sessionSlug, sdkEventDebugTestUtils.SESSION_MANIFEST), "utf8"),
			);
			expect(manifest.turns).toHaveLength(2);

			const parseDrainPhases = (artifactDir: string): string[] =>
				readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.drainEvents), "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line).phase as string);

			expect(parseDrainPhases(manifest.turns[0].artifactDir)).toContain("turn_end");
			expect(parseDrainPhases(manifest.turns[1].artifactDir)).toEqual(
				expect.arrayContaining(["pre_send_start", "turn_start", "turn_end", "pre_send_end"]),
			);
		} finally {
			sdkEventDebugTestUtils.resetSessionDebugState();
			scopeTestUtils.reset();
			if (previousDebug === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
			else process.env.PI_CURSOR_SDK_EVENT_DEBUG = previousDebug;
			if (previousDebugDir === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR;
			else process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR = previousDebugDir;
			if (previousNativeDisplay === undefined) delete process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
			else process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = previousNativeDisplay;
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("records turn_end and pre_send_end when aborting during live-run progress wait", async () => {
		const previousNativeDisplay = process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const baseDir = mkdtempSync(join(tmpdir(), "pi-cursor-provider-debug-abort-"));
		const sessionFile = join(baseDir, "session.jsonl");
		const eventsDir = join(baseDir, "events");
		const previousDebug = process.env.PI_CURSOR_SDK_EVENT_DEBUG;
		const previousDebugDir = process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR;
		const { __testUtils: scopeTestUtils } = await import("../src/cursor-session-scope.js");

		sdkEventDebugTestUtils.resetSessionDebugState();
		scopeTestUtils.set(baseDir, sessionFile);
		process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
		process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR = eventsDir;

		const controller = new AbortController();
		let firstOnDelta: CursorDeltaHandler | undefined;
		const runWait = vi.fn(() => new Promise<{ id: string; status: "finished"; result: string }>(() => {}));
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

		const parseDrainEvents = (artifactDir: string): Array<{ phase: string; payload?: { outcome?: string; reason?: string } }> =>
			readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.drainEvents), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));

		try {
			const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			expect(getDoneEvent(firstEvents).reason).toBe("toolUse");

			firstOnDelta?.({ update: { type: "text-delta", text: "Late scoped text." } });
			const secondEventsPromise = collectEvents(
				streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal }),
			);
			await Promise.resolve();
			controller.abort();
			const secondEvents = await secondEventsPromise;
			expect(getErrorEvent(secondEvents).reason).toBe("aborted");

			const sessionSlug = sdkEventDebugTestUtils.slugSessionKey(sessionFile);
			const manifest = JSON.parse(
				readFileSync(join(eventsDir, "sessions", sessionSlug, sdkEventDebugTestUtils.SESSION_MANIFEST), "utf8"),
			);
			expect(manifest.turns).toHaveLength(2);

			const drainEvents = parseDrainEvents(manifest.turns[1].artifactDir);
			expect(drainEvents.map((event) => event.phase)).toEqual(
				expect.arrayContaining(["pre_send_start", "turn_start", "turn_end", "pre_send_end"]),
			);
			expect(drainEvents.find((event) => event.phase === "turn_end")?.payload).toMatchObject({ outcome: "aborted", reason: "signal_aborted" });
			expect(drainEvents.find((event) => event.phase === "pre_send_end")?.payload).toMatchObject({ outcome: "aborted", reason: "signal_aborted" });
		} finally {
			sdkEventDebugTestUtils.resetSessionDebugState();
			scopeTestUtils.reset();
			if (previousDebug === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
			else process.env.PI_CURSOR_SDK_EVENT_DEBUG = previousDebug;
			if (previousDebugDir === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR;
			else process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR = previousDebugDir;
			if (previousNativeDisplay === undefined) delete process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
			else process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = previousNativeDisplay;
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("emits createPlan args as final visible text when native replay is unavailable", async () => {
		const plan = "Plan:\n1. Create calculator UI.\n2. Implement addition and subtraction.\n3. Add tests.";
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "Switching to plan mode.\n" } });
			opts.onDelta({ update: { type: "tool-call-completed", toolCall: { name: "createPlan", args: { plan }, result: { status: "success", value: {} } }, callId: "plan-1" } });
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Switching to plan mode.\n" }),
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
		const text = collectTextDeltas(events);
		const trace = collectThinkingDeltas(events);
		const done = getDoneEvent(events);

		expect(text).toBe(`Switching to plan mode.\n${plan}`);
		expect(trace).toContain("Create calculator UI");
		expect(done.message.content[0]).toEqual({ type: "text", text: `Switching to plan mode.\n${plan}` });
	});

	it("emits thinking deltas as pi thinking stream events", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "thinking-delta", text: "hmm" } });
			opts.onDelta({ update: { type: "thinking-delta", text: " let me think" } });
			opts.onDelta({ update: { type: "thinking-completed" } });
			opts.onDelta({ update: { type: "text-delta", text: "answer" } });
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

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const thinkingDeltas = getEventsOfType(events, "thinking_delta");
		expect(thinkingDeltas).toHaveLength(2);

		const thinkingEnd = events.find((event) => event.type === "thinking_end");
		expect(thinkingEnd).toBeDefined();
	});

	it("does not emit pi tool call events for cursor tool deltas", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read_file" }, callId: "c1" } });
			opts.onDelta({ update: { type: "tool-call-completed", toolCall: { name: "read_file" }, callId: "c1" } });
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

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const toolEvents = events.filter(isCursorToolStreamEvent);
		expect(toolEvents).toHaveLength(0);
	});

	it("surfaces cursor tool results as pi-like trace transcript without polluting final text", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "read",
						result: { status: "success", value: { content: "# pi-cursor-sdk\n\nReadme body", totalLines: 3, fileSize: 29 } },
					},
					callId: "c1",
				},
			});
			opts.onDelta({ update: { type: "summary", summary: "Inspected files" } });
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

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const trace = collectThinkingDeltas(events);
		const text = collectTextDeltas(events);
		const done = getDoneEvent(events);

		expect(trace).toContain("read README.md");
		expect(trace).toContain("# pi-cursor-sdk");
		expect(trace).not.toContain("Cursor tool: read started");
		expect(trace).not.toContain("call c1");
		expect(trace).toContain("Cursor summary: Inspected files");
		expect(text).toBe("done");
		expect(done.message.content.map((block) => block.type)).toEqual(["thinking", "thinking", "text"]);
	});

	it("uses Cursor onStep tool-call results when delta tool completion is absent", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onStep: (a: unknown) => void }) => {
			opts.onStep({
				step: {
					type: "toolCall",
					message: {
						type: "read",
						args: { path: "README.md" },
						result: { status: "success", value: { content: "# pi-cursor-sdk" } },
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("read README.md");
		expect(trace).toContain("# pi-cursor-sdk");
	});

	it("does not mark a started tool incomplete when onStep reports its result without a completion delta", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler; onStep: CursorStepHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			opts.onStep({
				step: {
					type: "toolCall",
					message: {
						type: "read",
						args: { path: "README.md" },
						result: { status: "success", value: { content: "# pi-cursor-sdk" } },
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("read README.md");
		expect(trace).toContain("# pi-cursor-sdk");
		expect(trace).not.toContain("Cursor tool started without a completion event");
	});

	it("surfaces incomplete started Cursor tool calls with neutral activity traces", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const trace = collectThinkingDeltas(events);
		const text = collectTextDeltas(events);

		expect(trace).toContain("Cursor read did not complete");
		expect(trace).toContain("missing completion");
		expect(text).toBe("done");
		expect(hasEventType(events, "toolcall_start")).toBe(false);
	});

	it("surfaces incomplete Cursor web search MCP activity with a distinct label", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "mcp", args: { toolName: "WebSearch", args: { search_term: "pi extension" } } },
					callId: "c1",
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);
		expect(trace).toContain("Cursor web search did not complete");
		expect(trace).not.toContain("Cursor MCP did not complete");
	});

	it("surfaces incomplete generic Cursor MCP activity", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "mcp", args: { toolName: "git" } },
					callId: "c1",
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(collectThinkingDeltas(events)).toContain("Cursor MCP did not complete");
	});

	it("records discarded incomplete started tool calls to coordinator-events.jsonl when PI_CURSOR_SDK_EVENT_DEBUG is enabled", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-provider-discarded-debug-"));
		process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
		process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = artifactDir;
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		try {
			await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const coordinatorEvents = readFileSync(join(artifactDir, "coordinator-events.jsonl"), "utf8");
			expect(coordinatorEvents).toContain("discarded-incomplete-started-tool-call");
			expect(coordinatorEvents).toContain('"toolName":"read"');
			expect(coordinatorEvents).toContain('"reason":"no-completion-at-run-end"');
			expect(coordinatorEvents).not.toContain("c1");
		} finally {
			delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
			delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});

	it("still surfaces explicit completed Cursor tool errors", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "cat missing.txt" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "shell",
						args: { command: "cat missing.txt" },
						result: { status: "error", error: "missing.txt: No such file" },
					},
					callId: "c1",
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("$ cat missing.txt");
		expect(trace).toContain("Error: missing.txt: No such file");
	});

	it("still surfaces explicit onStep Cursor tool errors", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler; onStep: CursorStepHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "missing.txt" } }, callId: "c1" } });
			opts.onStep({
				step: {
					type: "toolCall",
					id: "c1",
					message: {
						type: "read",
						args: { path: "missing.txt" },
						result: { status: "error", error: "missing.txt: No such file" },
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("read missing.txt");
		expect(trace).toContain("Error: missing.txt: No such file");
		expect(trace).not.toContain("Cursor tool started without a completion event");
	});

	it("dedupes a completed tool call reported through both delta and step callbacks", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler; onStep: CursorStepHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			opts.onStep({
				step: {
					type: "toolCall",
					message: {
						type: "read",
						args: { path: "README.md" },
						result: { status: "success", value: { content: "# pi-cursor-sdk" } },
					},
				},
			});
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const trace = collectThinkingDeltas(events);

		expect(trace.match(/read README\.md/g)).toHaveLength(1);
		expect(trace.match(/# pi-cursor-sdk/g)).toHaveLength(1);
	});

	it("streams Cursor text deltas live and only falls back to final result when no deltas arrive", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "Final " } });
			opts.onDelta({ update: { type: "text-delta", text: "answer." } });
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Final answer." }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const text = collectTextDeltas(events);

		expect(text).toBe("Final answer.");
		expect(getEventsOfType(events, "text_delta")).toHaveLength(2);
	});

	it("trims same-turn final text when streamed text is only a word prefix", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "Disconnect" } });
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Disconnecting the CDP session..." }),
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
		const text = collectTextDeltas(events);
		const done = getDoneEvent(events);

		expect(text).toBe("Disconnecting the CDP session...");
		expect(done.message.content).toEqual([{ type: "text", text: "Disconnecting the CDP session..." }]);
	});

	it("omits raw cursor call ids while rendering completed cursor tools", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "shell", args: { command: "date" } },
					callId: "call_abc\nfc_secret",
				},
			});
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "shell",
						result: { status: "success", value: { stdout: "Sat May  9\n", stderr: "", exitCode: 0, executionTime: 12 } },
					},
					callId: "call_abc\nfc_secret",
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("$ date\n");
		expect(trace).toContain("Sat May  9");
		expect(trace).toContain("Took 0.0s");
		expect(trace).not.toContain("call_abc");
		expect(trace).not.toContain("fc_secret");
	});

	it("keeps distinct completed tool calls with identical display payloads", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			for (const callId of ["c1", "c2"]) {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "date" } }, callId } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "shell",
							result: { status: "success", value: { stdout: "Thu May 14\n", stderr: "", exitCode: 0 } },
						},
						callId,
					},
				});
			}
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const trace = collectThinkingDeltas(events);

		expect(trace.match(/\$ date/g)).toHaveLength(2);
		expect(trace.match(/Thu May 14/g)).toHaveLength(2);
	});

	it("keeps distinct completed tool calls with identical payloads even without started events", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			for (const callId of ["c1", "c2"]) {
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "shell",
							args: { command: "date" },
							result: { status: "success", value: { stdout: "Thu May 14\n", stderr: "", exitCode: 0 } },
						},
						callId,
					},
				});
			}
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const trace = collectThinkingDeltas(events);

		expect(trace.match(/\$ date/g)).toHaveLength(2);
		expect(trace.match(/Thu May 14/g)).toHaveLength(2);
	});

	it("scrubs secrets from cursor tool transcript output", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "secrets.txt" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "read",
						result: {
							status: "success",
							value: { content: "token=super-secret-key-12345\nAuthorization: Bearer bearer-token-value" },
						},
					},
					callId: "c1",
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "super-secret-key-12345" });
		const events = await collectEvents(stream);
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("read secrets.txt");
		expect(trace).toContain("[redacted]");
		expect(trace).not.toContain("super-secret-key-12345");
		expect(trace).not.toContain("bearer-token-value");
	});

	it("keeps late cursor thinking in the saved content order after live text", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "Final answer" } });
			opts.onDelta({ update: { type: "thinking-delta", text: "late trace" } });
			opts.onDelta({ update: { type: "thinking-completed" } });
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

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const done = getDoneEvent(events);

		expect(done.message.content).toEqual([
			{ type: "text", text: "Final answer" },
			{ type: "thinking", thinking: "late trace" },
		]);
	});

	it("uses pi prompt/output estimates instead of Cursor cumulative internal usage", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "turn-ended",
					usage: {
						inputTokens: 6746960,
						outputTokens: 17701,
						cacheReadTokens: 6559232,
						cacheWriteTokens: 0,
					},
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

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const done = getDoneEvent(events);

		expect(done.message.usage.input).toBeGreaterThan(0);
		expect(done.message.usage.output).toBe(1);
		expect(done.message.usage.cacheRead).toBe(0);
		expect(done.message.usage.cacheWrite).toBe(0);
		expect(done.message.usage.totalTokens).toBeLessThan(1000);
	});
});
