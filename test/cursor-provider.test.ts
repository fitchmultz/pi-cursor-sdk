import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Mock @cursor/sdk before importing the module under test
vi.mock("@cursor/sdk", () => {
	const mockCancel = vi.fn().mockResolvedValue(undefined);
	const mockDispose = vi.fn().mockResolvedValue(undefined);

	const mockAgent = {
		agentId: "agent-1",
		send: vi.fn(),
		[Symbol.asyncDispose]: mockDispose,
	};
	const mockPlatform = {
		checkpointStore: {
			loadLatest: vi.fn().mockResolvedValue(undefined),
		},
	};

	return {
		Agent: {
			create: vi.fn().mockResolvedValue(mockAgent),
		},
		createAgentPlatform: vi.fn().mockResolvedValue(mockPlatform),
		_mockAgent: mockAgent,
		_mockCancel: mockCancel,
		_mockDispose: mockDispose,
		_mockPlatform: mockPlatform,
	};
});

import { Agent, createAgentPlatform } from "@cursor/sdk";
import { __testUtils as cursorSessionCwdTestUtils } from "../src/cursor-session-cwd.js";
import { __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { estimateCursorPromptMessageTokens } from "../src/context.js";
import { registerCursorPiToolBridge, __testUtils as cursorPiToolBridgeTestUtils } from "../src/cursor-pi-tool-bridge.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import { __testUtils as contextWindowCacheTestUtils } from "../src/context-window-cache.js";
import { __testUtils as nativeToolDisplayTestUtils, registerCursorNativeToolDisplay } from "../src/cursor-native-tool-display.js";
import type { ModelListItem, SendOptions } from "@cursor/sdk";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

// Access the mocks via the module
const mockedCreate = vi.mocked(Agent.create);
const mockedCreateAgentPlatform = vi.mocked(createAgentPlatform);

type RegisteredTool = ToolDefinition<TSchema, unknown, unknown>;
type TestExtensionContext = Pick<ExtensionContext, "cwd" | "hasUI"> & { ui: Pick<ExtensionContext["ui"], "notify"> };
type TestEventHandler = (event: unknown, ctx: TestExtensionContext) => Promise<void> | void;

function createBuiltinToolInfo(name: string, parameters: TSchema = Type.Object({}), description = ""): ToolInfo {
	return {
		name,
		description,
		parameters,
		sourceInfo: { source: "builtin", path: `<builtin:${name}>`, scope: "temporary", origin: "top-level" },
	};
}

function createBridgeToolInfo(name: string, parameters: TSchema = Type.Object({}), description = `${name} tool`): ToolInfo {
	return {
		name,
		description,
		parameters,
		sourceInfo: { source: "test", path: `test:${name}`, scope: "temporary", origin: "top-level" },
	};
}

function registerBridgeForProviderTest(options: { active: string[]; tools: ToolInfo[] }) {
	const sessionShutdownHandlers: Array<(event: { reason: string }) => Promise<void> | void> = [];
	const pi = {
		getActiveTools: vi.fn(() => [...options.active]),
		getAllTools: vi.fn(() => [...options.tools]),
		setActiveTools: vi.fn(),
		on: vi.fn((event: string, handler: (event: { reason: string }) => Promise<void> | void) => {
			if (event === "session_shutdown") sessionShutdownHandlers.push(handler);
		}),
	};
	registerCursorPiToolBridge(pi);
	return { pi, sessionShutdownHandlers };
}

async function connectMcpClient(url: string) {
	const client = new Client({ name: "pi-cursor-sdk-provider-test", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(url));
	await client.connect(transport);
	return { client, transport };
}

function makeModel(id = "test-model"): Model<"cursor-sdk"> {
	return {
		id,
		name: "Test Model",
		api: "cursor-sdk" as const,
		provider: "cursor",
		baseUrl: "",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function makeContext(): Context {
	return {
		systemPrompt: "Be helpful.",
		messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	};
}

async function collectEvents(stream: ReturnType<typeof streamCursor>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

type AssistantStreamEventType = AssistantMessageEvent["type"];
type AssistantStreamEvent<TType extends AssistantStreamEventType> = Extract<AssistantMessageEvent, { type: TType }>;
type CursorDeltaHandler = NonNullable<SendOptions["onDelta"]>;
type CursorStepHandler = NonNullable<SendOptions["onStep"]>;
type CursorToolStreamEventType = "toolcall_start" | "toolcall_delta" | "toolcall_end";

const CURSOR_TOOL_STREAM_EVENT_TYPES = new Set<AssistantStreamEventType>(["toolcall_start", "toolcall_delta", "toolcall_end"]);

function isEventType<TType extends AssistantStreamEventType>(
	event: AssistantMessageEvent,
	type: TType,
): event is AssistantStreamEvent<TType> {
	return event.type === type;
}

function collectTextDeltas(events: readonly AssistantMessageEvent[]): string {
	return events.filter((event): event is AssistantStreamEvent<"text_delta"> => isEventType(event, "text_delta")).map((event) => event.delta).join("");
}

function collectThinkingDeltas(events: readonly AssistantMessageEvent[]): string {
	return events.filter((event): event is AssistantStreamEvent<"thinking_delta"> => isEventType(event, "thinking_delta")).map((event) => event.delta).join("");
}

function getRequiredEvent<TType extends AssistantStreamEventType>(
	events: readonly AssistantMessageEvent[],
	type: TType,
): AssistantStreamEvent<TType> {
	const event = events.find((candidate): candidate is AssistantStreamEvent<TType> => isEventType(candidate, type));
	if (!event) throw new Error(`Expected ${type} event`);
	return event;
}

function getEventsOfType<TType extends AssistantStreamEventType>(
	events: readonly AssistantMessageEvent[],
	type: TType,
): AssistantStreamEvent<TType>[] {
	return events.filter((event): event is AssistantStreamEvent<TType> => isEventType(event, type));
}

function hasEventType(events: readonly AssistantMessageEvent[], type: AssistantStreamEventType): boolean {
	return events.some((event) => event.type === type);
}

function isCursorToolStreamEvent(event: AssistantMessageEvent): event is AssistantStreamEvent<CursorToolStreamEventType> {
	return CURSOR_TOOL_STREAM_EVENT_TYPES.has(event.type);
}

function getDoneEvent(events: readonly AssistantMessageEvent[]): AssistantStreamEvent<"done"> {
	return getRequiredEvent(events, "done");
}

function getErrorEvent(events: readonly AssistantMessageEvent[]): AssistantStreamEvent<"error"> {
	return getRequiredEvent(events, "error");
}

function getTextEndEvent(events: readonly AssistantMessageEvent[]): AssistantStreamEvent<"text_end"> {
	return getRequiredEvent(events, "text_end");
}

function isToolCallBlock(block: AssistantMessage["content"][number]): block is ToolCall {
	return block.type === "toolCall";
}

type CursorAgentCreateOptions = NonNullable<Parameters<typeof Agent.create>[0]>;
type CursorAgentPlatformForTest = Awaited<ReturnType<typeof createAgentPlatform>>;

function getCreatedAgentOptions(callIndex = 0): CursorAgentCreateOptions {
	const options = mockedCreate.mock.calls[callIndex]?.[0];
	if (!options) throw new Error(`Expected Agent.create call ${callIndex}`);
	return options;
}

function createMockAgentPlatform(
	loadLatest = vi.fn().mockResolvedValue(undefined),
): CursorAgentPlatformForTest {
	return {
		checkpointStore: {
			loadLatest,
		},
	} as CursorAgentPlatformForTest;
}

async function registerNativeToolDisplayForTest(registeredTools: RegisteredTool[]): Promise<void> {
	const handlers: TestEventHandler[] = [];
	let activeToolNames = ["read", "bash", "edit", "write"];
	registerCursorNativeToolDisplay({
		on: vi.fn((event: string, handler: TestEventHandler) => {
			if (event === "session_start") handlers.push(handler);
		}),
		registerTool: vi.fn((tool: RegisteredTool) => {
			registeredTools.push(tool);
		}),
		getAllTools: vi.fn(() => {
			const toolsByName = new Map<string, ToolInfo>();
			for (const name of ["read", "bash", "grep", "find", "ls", "edit", "write"]) {
				const tool = createBuiltinToolInfo(name);
				toolsByName.set(tool.name, tool);
			}
			for (const tool of registeredTools) {
				toolsByName.set(tool.name, {
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					sourceInfo: { source: "test", path: "cursor-native-tool-display-test", scope: "temporary", origin: "top-level" },
				});
			}
			return [...toolsByName.values()];
		}),
		getActiveTools: vi.fn(() => [...activeToolNames]),
		setActiveTools: vi.fn((toolNames: string[]) => {
			activeToolNames = [...toolNames];
		}),
	});
	for (const handler of handlers) {
		await handler({ reason: "startup" }, { cwd: process.cwd(), hasUI: false, ui: { notify: vi.fn() } });
	}
}

const cursorModelItems: ModelListItem[] = [
	{
		id: "gpt-5.5",
		displayName: "GPT-5.5",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] },
			{
				id: "reasoning",
				displayName: "Reasoning",
				values: [
					{ value: "none" },
					{ value: "low" },
					{ value: "medium" },
					{ value: "high" },
					{ value: "extra-high" },
				],
			},
			{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{
				params: [
					{ id: "context", value: "1m" },
					{ id: "fast", value: "false" },
					{ id: "reasoning", value: "medium" },
				],
				displayName: "GPT-5.5",
				isDefault: true,
			},
		],
	},
	{
		id: "claude-opus-4-7",
		displayName: "Opus 4.7",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "1m" }] },
			{ id: "effort", displayName: "Effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
			{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{
				params: [
					{ id: "context", value: "1m" },
					{ id: "effort", value: "xhigh" },
					{ id: "thinking", value: "true" },
				],
				displayName: "Opus 4.7",
				isDefault: true,
			},
		],
	},
	{
		id: "claude-sonnet-4-6",
		displayName: "Sonnet 4.6",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "1m" }] },
			{ id: "effort", displayName: "Effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
			{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{
				params: [
					{ id: "context", value: "1m" },
					{ id: "effort", value: "medium" },
					{ id: "thinking", value: "true" },
				],
				displayName: "Sonnet 4.6",
				isDefault: true,
			},
		],
	},
];

describe("streamCursor", () => {
	beforeEach(async () => {
		await cursorPiToolBridgeTestUtils.resetRegisteredBridgeForTests();
		vi.clearAllMocks();
		delete process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
		delete process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS;
		delete process.env.PI_CURSOR_SETTING_SOURCES;
		delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
		delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		cursorProviderTestUtils.resetCursorNativeReplayIdleDisposeMs();
		await cursorProviderTestUtils.resetSessionCursorAgents();
		cursorSessionCwdTestUtils.reset();
		nativeToolDisplayTestUtils.reset();
		modelDiscoveryTestUtils.registerModelItems(cursorModelItems);
		// Re-setup default mock return after clearing
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: vi.fn(),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		mockedCreateAgentPlatform.mockResolvedValue(createMockAgentPlatform());
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

	it("silently discards started Cursor tool calls that never complete", async () => {
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

		expect(trace).not.toContain("Cursor tool started without a completion event");
		expect(trace).not.toContain("Cursor SDK emitted tool-call-started but no tool-call-completed event");
		expect(text).toBe("done");
		expect(hasEventType(events, "toolcall_start")).toBe(false);
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

	it("replays native Cursor tools as a toolUse turn before final text", async () => {
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
		expect(runWait).toHaveBeenCalledTimes(1);
		const firstDone = getDoneEvent(firstEvents);
		const firstText = collectTextDeltas(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(firstText).toBe("I am checking files.");
		expect(firstDone.reason).toBe("toolUse");
		expect(firstDone.message.stopReason).toBe("toolUse");
		expect(firstDone.message.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
		expect(firstDone.message.content[0]).toEqual({ type: "text", text: "I am checking files." });
		expect(toolCall.name).toBe("read");
		expect(hasEventType(firstEvents, "toolcall_delta")).toBe(true);

		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		expect(toolResult).toEqual({
			content: [{ type: "text", text: "# pi-cursor-sdk" }],
			details: undefined,
			terminate: false,
		});

		resolveRun({ id: "run-1", status: "finished", result: "Final answer only." });

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
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
		expect(replayDone.message.content).toEqual([{ type: "text", text: "Final answer only." }]);
	});

	it("uses Cursor shell-output-delta as display-only fallback when completed shell output is empty", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const command = 'sleep 2 && echo "background job done"';
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { toolName: "run_terminal_cmd", args: { command } }, callId: "shell-1" } });
			opts.onDelta({ update: { type: "shell-output-delta", event: { case: "stdout", value: { data: "background job done\n" } } } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						toolName: "run_terminal_cmd",
						result: { status: "success", value: { stdout: "", stderr: "", exitCode: 0, executionTime: 2015 } },
					},
					callId: "shell-1",
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(firstDone.reason).toBe("toolUse");
		expect(toolCall.name).toBe("bash");
		expect(toolCall.arguments).toEqual({ command });

		const bashTool = registeredTools.find((tool) => tool.name === "bash");
		const toolResult = await bashTool.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		expect(toolResult).toMatchObject({
			content: [{ type: "text", text: "background job done" }],
			terminate: false,
		});

		resolveRun({ id: "run-1", status: "finished", result: "Done." });
		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "bash",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const replayText = collectTextDeltas(replayEvents);
		expect(replayText).toBe("Done.");
	});

	it("drops shell-output-delta fallback data when overlapping shell calls make attribution ambiguous", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "sleep 1" } }, callId: "shell-1" } });
			opts.onDelta({ update: { type: "shell-output-delta", event: { case: "stdout", value: { data: "partial first output\n" } } } });
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "sleep 2" } }, callId: "shell-2" } });
			opts.onDelta({ update: { type: "shell-output-delta", event: { case: "stdout", value: { data: "ambiguous output\n" } } } });
			for (const [callId, command] of [
				["shell-1", "sleep 1"],
				["shell-2", "sleep 2"],
			] as const) {
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "shell",
							args: { command },
							result: { status: "success", value: { stdout: "", stderr: "", exitCode: 0, executionTime: 1 } },
						},
						callId,
					},
				});
			}
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Done." }),
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

		expect(trace).toContain("$ sleep 1");
		expect(trace).toContain("$ sleep 2");
		expect(trace).not.toContain("partial first output");
		expect(trace).not.toContain("ambiguous output");
		expect(trace.match(/\(no output\)/g)).toHaveLength(2);
	});

	it("prefers completed shell stdout over Cursor shell-output-delta fallback data", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "printf done" } }, callId: "shell-1" } });
			opts.onDelta({ update: { type: "shell-output-delta", event: { case: "stdout", value: { data: "delta output\n" } } } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "shell",
						result: { status: "success", value: { stdout: "completed output\n", stderr: "", exitCode: 0, executionTime: 1 } },
					},
					callId: "shell-1",
				},
			});
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Done." }),
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

		expect(trace).toContain("completed output");
		expect(trace).not.toContain("delta output");
	});

	it("replays Cursor createPlan as a neutral cursor card before final plan text", async () => {
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
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "createPlan", args: {} }, callId: "plan-1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "createPlan", args: {}, result: { status: "success", value: {} } },
					callId: "plan-1",
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(firstDone.reason).toBe("toolUse");
		expect(firstDone.message.content.map((block) => block.type)).toEqual(["toolCall"]);
		expect(toolCall.name).toBe("cursor");
		expect(toolCall.arguments).toMatchObject({ totalCount: 0 });

		const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
		const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		expect(toolResult.content[0].text).toContain("createPlan");
		expect(toolResult.details).toMatchObject({ cursorToolName: "createPlan" });

		resolveRun({ id: "run-1", status: "finished", result: "Final Cursor plan text." });

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "cursor",
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
		expect(replayText).toBe("Final Cursor plan text.");
		expect(replayDone.reason).toBe("stop");
		expect(replayDone.message.content).toEqual([{ type: "text", text: "Final Cursor plan text." }]);
	});

	it("prefers distinct Cursor final result text after pre-plan native replay text", async () => {
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
			opts.onDelta({ update: { type: "text-delta", text: "Compiling the tool inventory and execution status.\n" } });
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "createPlan", args: {} }, callId: "plan-1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "createPlan", args: {}, result: { status: "success", value: {} } },
					callId: "plan-1",
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
		const firstDone = getDoneEvent(firstEvents);
		const firstText = collectTextDeltas(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(firstText).toBe("Compiling the tool inventory and execution status.\n");
		expect(firstDone.reason).toBe("toolUse");
		expect(firstDone.message.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
		expect(toolCall.name).toBe("cursor");

		const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
		const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		resolveRun({ id: "run-1", status: "finished", result: "Final plan:\n1. Summarize available tools.\n2. Report execution status." });

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "cursor",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const replayText = collectTextDeltas(replayEvents);
		const replayDone = getDoneEvent(replayEvents);

		expect(replayText).toBe("Final plan:\n1. Summarize available tools.\n2. Report execution status.");
		expect(replayText).not.toContain("Compiling the tool inventory");
		expect(replayDone.message.content).toEqual([
			{ type: "text", text: "Final plan:\n1. Summarize available tools.\n2. Report execution status." },
		]);
	});

	it("emits distinct final result text even after post-replay text deltas", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let onDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			onDelta = opts.onDelta;
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "createPlan", args: {} }, callId: "plan-1" } });
			onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "createPlan", args: {}, result: { status: "success", value: {} } },
					callId: "plan-1",
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
		const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "cursor",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents: AssistantMessageEvent[] = [];
		let sawPostReplayText: () => void = () => {};
		const postReplayTextSeen = new Promise<void>((resolve) => {
			sawPostReplayText = resolve;
		});
		const replayDonePromise = (async () => {
			for await (const event of streamCursor(makeModel(), replayContext, { apiKey: "test-key" })) {
				replayEvents.push(event);
				if (event.type === "text_delta" && event.delta === "Compiling after replay.\n") sawPostReplayText();
			}
		})();

		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "Compiling after replay.\n" } });
		await Promise.race([
			postReplayTextSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for post-replay text")), 500)),
		]);
		resolveRun({ id: "run-1", status: "finished", result: "Final Cursor plan text." });
		await replayDonePromise;

		const replayText = collectTextDeltas(replayEvents);
		const replayDone = getDoneEvent(replayEvents);

		expect(replayText).toBe("Compiling after replay.\nFinal Cursor plan text.");
		expect(replayDone.reason).toBe("stop");
		expect(replayDone.message.content).toEqual([
			{ type: "text", text: "Compiling after replay.\n" },
			{ type: "text", text: "Final Cursor plan text." },
		]);
	});

	it("suppresses Cursor tool starts that never receive completion events during native replay", async () => {
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
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "mcp", args: { toolName: "demo" } }, callId: "c2" } });
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "read",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEventsPromise = collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		await Promise.resolve();
		resolveRun({ id: "run-1", status: "finished", result: "Done." });
		const replayEvents = await replayEventsPromise;
		const replayDone = getDoneEvent(replayEvents);
		const replayText = collectTextDeltas(replayEvents);

		expect(replayDone.reason).toBe("stop");
		expect(replayText).toBe("Done.");
		expect(replayDone.message.content).toEqual([{ type: "text", text: "Done." }]);
		expect(replayDone.message.content.some(isToolCallBlock)).toBe(false);
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);
	});

	it("suppresses a native replay run that only has started Cursor tool calls", async () => {
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
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
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

		const eventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(runWait).toHaveBeenCalledTimes(1));
		resolveRun({ id: "run-1", status: "finished", result: "Done." });
		const events = await eventsPromise;
		const done = getDoneEvent(events);
		const text = collectTextDeltas(events);
		const trace = collectThinkingDeltas(events);

		expect(done.reason).toBe("stop");
		expect(text).toBe("Done.");
		expect(trace).not.toContain("Cursor tool started without a completion event");
		expect(done.message.content).toEqual([{ type: "text", text: "Done." }]);
		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);
	});

	it("counts thinking plus tool-call replay turns as nonzero assistant activity", async () => {
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
			opts.onDelta({ update: { type: "thinking-delta", text: "Need to inspect the file." } });
			opts.onDelta({ update: { type: "thinking-completed" } });
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

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const done = getDoneEvent(events);

		expect(done.reason).toBe("toolUse");
		expect(done.message.content.map((block) => block.type)).toEqual(["thinking", "toolCall"]);
		expect(done.message.usage.output).toBeGreaterThan(0);
		expect(done.message.usage.totalTokens).toBeGreaterThan(done.message.usage.input);

		const toolCall = done.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			done.message,
			{
				role: "toolResult" as const,
				toolCallId: toolCall.id,
				toolName: "read",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];
		resolveRun({ id: "run-1", status: "finished", result: "" });
		await Promise.resolve();
		await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
	});

	it("gives empty final replay turns context total without recounting the original prompt", async () => {
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		const toolResultMessage = {
			role: "toolResult" as const,
			toolCallId: toolCall.id,
			toolName: "read",
			content: toolResult.content,
			details: toolResult.details,
			isError: false,
			timestamp: 2,
		};
		const replayContext = makeContext();
		replayContext.messages = [...replayContext.messages, firstDone.message, toolResultMessage];

		expect(runWait).toHaveBeenCalledTimes(1);
		resolveRun({ id: "run-1", status: "finished", result: "" });
		await Promise.resolve();

		const finalEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const finalDone = getDoneEvent(finalEvents);

		expect(finalDone.reason).toBe("stop");
		expect(finalDone.message.content).toEqual([]);
		expect(finalDone.message.usage.input).toBe(estimateCursorPromptMessageTokens(toolResultMessage));
		expect(finalDone.message.usage.input).toBeLessThan(firstDone.message.usage.input);
		expect(finalDone.message.usage.output).toBe(0);
		expect(finalDone.message.usage.totalTokens).toBeGreaterThan(finalDone.message.usage.input);
	});

	it("replays Cursor grep activity through native grep display", async () => {
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
					toolCall: { type: "grep", args: { pattern: "sem_reindex", path: "src" } },
					callId: "c1",
				},
			});
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						type: "grep",
						args: { pattern: "sem_reindex", path: "src" },
						result: {
							status: "success",
							value: {
								workspaceResults: {
									src: {
										type: "files",
										output: { files: ["src/tools/reindex.ts"] },
									},
								},
							},
						},
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

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const trace = collectThinkingDeltas(firstEvents);

		expect(firstDone.reason).toBe("toolUse");
		expect(toolCall.name).toBe("grep");
		expect(toolCall.arguments).toEqual({ pattern: "sem_reindex", path: "src" });
		expect(trace).not.toContain("src/tools/reindex.ts");

		const grepTool = registeredTools.find((tool) => tool.name === "grep");
		const toolResult = await grepTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		expect(toolResult.content[0].text).toContain("src/tools/reindex.ts");

		resolveRun({ id: "run-1", status: "finished", result: "Done." });

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "grep",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];
		await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
	});

	it("replays path-only Cursor edit activity through neutral recorded cursor output without pi edit validation", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		const dir = mkdtempSync(join(tmpdir(), "cursor-edit-replay-"));
		const targetPath = join(dir, ".tool-demo-temp.txt");
		writeFileSync(targetPath, "old\n");

		try {
			let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
			const runWait = vi.fn(
				() =>
					new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
						resolveRun = resolve;
					}),
			);
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { type: "edit", args: { path: targetPath } }, callId: "c1" } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							type: "edit",
							args: { path: targetPath },
							result: {
								status: "success",
								value: { linesAdded: 1, linesRemoved: 1, diffString: `--- a/${targetPath}\n+++ b/${targetPath}` },
							},
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

			const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const firstDone = getDoneEvent(firstEvents);
			const toolCall = firstDone.message.content.find(isToolCallBlock);

			expect(toolCall.name).toBe("cursor");
			expect(toolCall.arguments).toMatchObject({ path: targetPath });
			expect(toolCall.arguments).not.toHaveProperty("edits");
			const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
			expect(cursorTool).toBeDefined();
			const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining(`edit ${targetPath}`) }],
				details: { cursorToolName: "edit", title: "Cursor edit", summary: targetPath, diff: `--- a/${targetPath}\n+++ b/${targetPath}` },
				terminate: false,
			});
			expect(toolResult.content[0].text).not.toContain("Validation failed for tool \"edit\"");
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			const editTool = registeredTools.find((tool) => tool.name === "edit");
			expect(editTool).toBeDefined();
			await expect(
				editTool!.execute(
					"cursor-replay-1-1-tool-999",
					{ path: targetPath, edits: [{ oldText: "old\n", newText: "mutated\n" }] },
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow("replay-only call does not execute file mutations");
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			resolveRun({ id: "run-1", status: "finished", result: "Done." });

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "cursor",
					content: toolResult.content,
					details: toolResult.details,
					isError: false,
					timestamp: 2,
				},
			];
			const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
			const replayText = collectTextDeltas(replayEvents);
			expect(replayText).toBe("Done.");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replays path-only Cursor write activity through neutral recorded cursor output without pi write validation", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		const dir = mkdtempSync(join(tmpdir(), "cursor-write-path-only-replay-"));
		const targetPath = join(dir, "recorded-write.txt");
		writeFileSync(targetPath, "old\n");

		try {
			let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
			const runWait = vi.fn(
				() =>
					new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
						resolveRun = resolve;
					}),
			);
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: { type: "tool-call-started", toolCall: { type: "write", args: { path: targetPath } }, callId: "c1" },
				});
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							type: "write",
							args: { path: targetPath },
							result: {
								status: "success",
								value: { linesCreated: 1, fileSize: 4 },
							},
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

			const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const firstDone = getDoneEvent(firstEvents);
			const toolCall = firstDone.message.content.find(isToolCallBlock);

			expect(toolCall.name).toBe("cursor");
			expect(toolCall.arguments).toMatchObject({ path: targetPath, activityTitle: "Cursor write", activitySummary: targetPath });
			expect(toolCall.arguments).not.toHaveProperty("content");
			const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
			expect(cursorTool).toBeDefined();
			const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining(`write ${targetPath}`) }],
				details: { cursorToolName: "write", title: "Cursor write", path: targetPath },
				terminate: false,
			});
			expect(toolResult.content[0].text).not.toContain("Validation failed for tool \"write\"");
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			resolveRun({ id: "run-1", status: "finished", result: "Done." });

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "cursor",
					content: toolResult.content,
					details: toolResult.details,
					isError: false,
					timestamp: 2,
				},
			];
			const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
			const replayText = collectTextDeltas(replayEvents);
			expect(replayText).toBe("Done.");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replays Cursor StrReplace through schema-valid recorded edit output without mutating files", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		const dir = mkdtempSync(join(tmpdir(), "cursor-strreplace-replay-"));
		const targetPath = join(dir, "recorded-edit.txt");
		writeFileSync(targetPath, "old\n");

		try {
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
						toolCall: { type: "StrReplace", args: { path: targetPath, old_string: "old\n", new_string: "new\n" } },
						callId: "c1",
					},
				});
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							type: "StrReplace",
							args: { path: targetPath, old_string: "old\n", new_string: "new\n" },
							result: {
								status: "success",
								value: { linesAdded: 1, linesRemoved: 1, diffString: `--- a/${targetPath}\n+++ b/${targetPath}\n@@ -1 +1 @@\n-old\n+new` },
							},
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

			const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const firstDone = getDoneEvent(firstEvents);
			const toolCall = firstDone.message.content.find(isToolCallBlock);

			expect(toolCall.name).toBe("edit");
			expect(toolCall.arguments).toEqual({ path: targetPath, edits: [{ oldText: "old\n", newText: "new\n" }] });
			const editTool = registeredTools.find((tool) => tool.name === "edit");
			expect(editTool).toBeDefined();
			const toolResult = await editTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining(`edit ${targetPath}`) }],
				details: { cursorToolName: "edit", diff: expect.stringContaining("-old") },
				terminate: false,
			});
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			resolveRun({ id: "run-1", status: "finished", result: "Done." });

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "edit",
					content: toolResult.content,
					details: toolResult.details,
					isError: false,
					timestamp: 2,
				},
			];
			const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
			const replayText = collectTextDeltas(replayEvents);
			expect(replayText).toBe("Done.");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replays Cursor write activity through native-looking recorded write output without mutating files", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		const dir = mkdtempSync(join(tmpdir(), "cursor-write-replay-"));
		const targetPath = join(dir, "recorded-write.txt");
		writeFileSync(targetPath, "old\n");

		try {
			let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
			const runWait = vi.fn(
				() =>
					new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
						resolveRun = resolve;
					}),
			);
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: { type: "tool-call-started", toolCall: { type: "write", args: { path: targetPath, content: "new\n" } }, callId: "c1" },
				});
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							type: "write",
							args: { path: targetPath, content: "new\n" },
							result: {
								status: "success",
								value: { linesCreated: 1, fileSize: 4, fileContentAfterWrite: "new\n" },
							},
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

			const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const firstDone = getDoneEvent(firstEvents);
			const toolCall = firstDone.message.content.find(isToolCallBlock);

			expect(toolCall.name).toBe("write");
			expect(toolCall.name).not.toContain("cursor");
			expect(toolCall.arguments).toEqual({ path: targetPath, content: "new\n" });
			const writeTool = registeredTools.find((tool) => tool.name === "write");
			expect(writeTool).toBeDefined();
			const toolResult = await writeTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining(`write ${targetPath}`) }],
				details: { cursorToolName: "write", fileContentAfterWrite: "new\n" },
				terminate: false,
			});
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			await expect(
				writeTool!.execute("cursor-replay-1-1-tool-998", { path: targetPath, content: "mutated\n" }, undefined, undefined, {}),
			).rejects.toThrow("replay-only call does not execute file mutations");
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			resolveRun({ id: "run-1", status: "finished", result: "Done." });

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "write",
					content: toolResult.content,
					details: toolResult.details,
					isError: false,
					timestamp: 2,
				},
			];
			const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
			const replayText = collectTextDeltas(replayEvents);
			expect(replayText).toBe("Done.");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
			[Symbol.asyncDispose]: mockDispose,
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);
		expect(mockDispose).not.toHaveBeenCalled();

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
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
			[Symbol.asyncDispose]: mockDispose,
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
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

	it("streams post-tool Cursor thinking and text while a native replay run is still active", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let onDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			onDelta = opts.onDelta;
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			onDelta({
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "read",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayStream = streamCursor(makeModel(), replayContext, { apiKey: "test-key" });
		const replayEvents: AssistantMessageEvent[] = [];
		let sawLiveText: () => void = () => {};
		const liveTextSeen = new Promise<void>((resolve) => {
			sawLiveText = resolve;
		});
		const replayDone = (async () => {
			for await (const event of replayStream) {
				replayEvents.push(event);
				if (event.type === "text_delta" && event.delta === "Final ") sawLiveText();
			}
		})();

		await Promise.resolve();
		onDelta?.({ update: { type: "thinking-delta", text: "Streaming thought." } });
		onDelta?.({ update: { type: "thinking-completed" } });
		onDelta?.({ update: { type: "text-delta", text: "Final " } });
		await Promise.race([
			liveTextSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for live Cursor text")), 500)),
		]);
		onDelta?.({ update: { type: "text-delta", text: "answer." } });
		resolveRun({ id: "run-1", status: "finished", result: "Final answer." });
		await replayDone;

		const replayText = collectTextDeltas(replayEvents);
		const replayThinking = collectThinkingDeltas(replayEvents);
		const finalDone = getDoneEvent(replayEvents);

		expect(runWait).toHaveBeenCalledTimes(1);
		expect(replayThinking).toBe("Streaming thought.");
		expect(replayText).toBe("Final answer.");
		expect(finalDone.reason).toBe("stop");
		expect(finalDone.message.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		expect(getTextEndEvent(replayEvents)?.contentIndex).toBe(1);
	});

	it("trims current-turn post-tool native replay final text when streamed text is only a word prefix", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let onDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			onDelta = opts.onDelta;
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			onDelta({
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "read",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents: AssistantMessageEvent[] = [];
		let sawLiveText: () => void = () => {};
		const liveTextSeen = new Promise<void>((resolve) => {
			sawLiveText = resolve;
		});
		const replayDone = (async () => {
			for await (const event of streamCursor(makeModel(), replayContext, { apiKey: "test-key" })) {
				replayEvents.push(event);
				if (event.type === "text_delta" && event.delta === "Disconnect") sawLiveText();
			}
		})();

		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "Disconnect" } });
		await Promise.race([
			liveTextSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for live Cursor text")), 500)),
		]);
		resolveRun({ id: "run-1", status: "finished", result: "Disconnecting the CDP session..." });
		await replayDone;

		const replayText = collectTextDeltas(replayEvents);
		const finalDone = getDoneEvent(replayEvents);

		expect(runWait).toHaveBeenCalledTimes(1);
		expect(replayText).toBe("Disconnecting the CDP session...");
		expect(finalDone.reason).toBe("stop");
	});

	it("queues post-tool thinking and text that arrive before the native tool-use turn closes", async () => {
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
			opts.onDelta({ update: { type: "thinking-delta", text: "Post-tool thought." } });
			opts.onDelta({ update: { type: "thinking-completed" } });
			opts.onDelta({ update: { type: "text-delta", text: "Final " } });
			opts.onDelta({ update: { type: "text-delta", text: "answer." } });
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

		expect(firstDone.message.content.map((block) => block.type)).toEqual(["toolCall"]);

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "read",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayStream = streamCursor(makeModel(), replayContext, { apiKey: "test-key" });
		const replayEvents: AssistantMessageEvent[] = [];
		let sawLiveText: () => void = () => {};
		const liveTextSeen = new Promise<void>((resolve) => {
			sawLiveText = resolve;
		});
		const replayDone = (async () => {
			for await (const event of replayStream) {
				replayEvents.push(event);
				if (event.type === "text_delta" && event.delta === "Final ") sawLiveText();
			}
		})();

		await Promise.race([
			liveTextSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for queued Cursor text")), 500)),
		]);
		resolveRun({ id: "run-1", status: "finished", result: "Final answer." });
		await replayDone;

		const replayText = collectTextDeltas(replayEvents);
		const replayThinking = collectThinkingDeltas(replayEvents);
		const finalDone = getDoneEvent(replayEvents);

		expect(replayThinking).toBe("Post-tool thought.");
		expect(replayText).toBe("Final answer.");
		expect(finalDone.message.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		expect(getTextEndEvent(replayEvents)?.contentIndex).toBe(1);
	});


	it("does not duplicate text already emitted before a later native replay tool", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let onDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			onDelta = opts.onDelta;
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			onDelta({
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
		const firstDone = getDoneEvent(firstEvents);
		const firstToolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const firstToolResult = await readTool.execute(firstToolCall.id, firstToolCall.arguments, undefined, undefined, {});

		const secondContext = makeContext();
		secondContext.messages = [
			...secondContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: firstToolCall.id,
				toolName: "read",
				content: firstToolResult.content,
				details: firstToolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const secondStream = streamCursor(makeModel(), secondContext, { apiKey: "test-key" });
		const secondEvents: AssistantMessageEvent[] = [];
		let sawSecondTool: () => void = () => {};
		const secondToolSeen = new Promise<void>((resolve) => {
			sawSecondTool = resolve;
		});
		const secondDonePromise = (async () => {
			for await (const event of secondStream) {
				secondEvents.push(event);
				if (event.type === "toolcall_end") sawSecondTool();
			}
		})();

		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "Gathering context.\n" } });
		onDelta?.({ update: { type: "tool-call-started", toolCall: { name: "grep", args: { pattern: "cursor", path: "src" } }, callId: "c2" } });
		onDelta?.({
			update: {
				type: "tool-call-completed",
				toolCall: {
					name: "grep",
					result: { status: "success", value: { matches: ["src/index.ts"] } },
				},
				callId: "c2",
			},
		});
		await Promise.race([
			secondToolSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for second replay tool")), 500)),
		]);
		await secondDonePromise;

		const secondText = collectTextDeltas(secondEvents);
		expect(secondText).toBe("Gathering context.\n");

		const secondToolCall = (getDoneEvent(secondEvents)).message.content.find(
			isToolCallBlock,
		);
		const grepTool = registeredTools.find((tool) => tool.name === "grep");
		const secondToolResult = await grepTool.execute(secondToolCall.id, secondToolCall.arguments, undefined, undefined, {});

		const finalContext = makeContext();
		finalContext.messages = [
			...finalContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: firstToolCall.id,
				toolName: "read",
				content: firstToolResult.content,
				details: firstToolResult.details,
				isError: false,
				timestamp: 2,
			},
			(getDoneEvent(secondEvents)).message,
			{
				role: "toolResult",
				toolCallId: secondToolCall.id,
				toolName: "grep",
				content: secondToolResult.content,
				details: secondToolResult.details,
				isError: false,
				timestamp: 3,
			},
		];

		const finalEventsPromise = collectEvents(streamCursor(makeModel(), finalContext, { apiKey: "test-key" }));
		await Promise.resolve();
		resolveRun({ id: "run-1", status: "finished", result: "Gathering context.\n" });
		const finalEvents = await finalEventsPromise;
		const finalText = collectTextDeltas(finalEvents);
		const finalDone = getDoneEvent(finalEvents);

		expect(finalText).toBe("");
		expect(finalDone.message.content).toEqual([]);
	});


	it("does not duplicate final result after an earlier post-tool text turn", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let onDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			onDelta = opts.onDelta;
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			onDelta({
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
		const readTool = registeredTools.find((tool) => tool.name === "read");

		const context = makeContext();
		const firstEvents = await collectEvents(streamCursor(makeModel(), context, { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const firstToolCall = firstDone.message.content.find(isToolCallBlock);
		const firstToolResult = await readTool.execute(firstToolCall.id, firstToolCall.arguments, undefined, undefined, {});
		const firstToolResultMessage = {
			role: "toolResult" as const,
			toolCallId: firstToolCall.id,
			toolName: "read",
			content: firstToolResult.content,
			details: firstToolResult.details,
			isError: false,
			timestamp: 2,
		};
		context.messages.push(firstDone.message, firstToolResultMessage);

		const secondStream = streamCursor(makeModel(), context, { apiKey: "test-key" });
		const secondDonePromise = collectEvents(secondStream);
		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "I am checking helpers." } });
		onDelta?.({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "src/index.ts" } }, callId: "c2" } });
		onDelta?.({
			update: {
				type: "tool-call-completed",
				toolCall: {
					name: "read",
					result: { status: "success", value: { content: "import type { ExtensionAPI } from \"@earendil-works/pi-coding-agent\";" } },
				},
				callId: "c2",
			},
		});
		const secondEvents = await secondDonePromise;
		const secondDone = getDoneEvent(secondEvents);
		const secondToolCall = secondDone.message.content.find(isToolCallBlock);
		const secondToolResult = await readTool.execute(secondToolCall.id, secondToolCall.arguments, undefined, undefined, {});
		const secondToolResultMessage = {
			role: "toolResult" as const,
			toolCallId: secondToolCall.id,
			toolName: "read",
			content: secondToolResult.content,
			details: secondToolResult.details,
			isError: false,
			timestamp: 3,
		};
		context.messages.push(secondDone.message, secondToolResultMessage);

		const finalStream = streamCursor(makeModel(), context, { apiKey: "test-key" });
		const finalEventsPromise = collectEvents(finalStream);
		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "Final answer." } });
		resolveRun({ id: "run-1", status: "finished", result: "Final answer." });
		const finalEvents = await finalEventsPromise;
		const finalDone = getDoneEvent(finalEvents);
		const finalText = collectTextDeltas(finalEvents);

		expect(runWait).toHaveBeenCalledTimes(1);
		expect(firstDone.message.usage.input).toBeGreaterThan(0);
		expect(firstDone.message.usage.output).toBeGreaterThan(0);
		expect(firstDone.message.usage.totalTokens).toBeGreaterThan(firstDone.message.usage.input + firstDone.message.usage.output);
		expect(secondDone.message.usage.input).toBe(estimateCursorPromptMessageTokens(firstToolResultMessage));
		expect(secondDone.message.usage.input).toBeGreaterThan(0);
		expect(secondDone.message.usage.input).toBeLessThan(firstDone.message.usage.input);
		expect(secondDone.message.usage.output).toBeGreaterThan(0);
		expect(secondDone.message.usage.totalTokens).toBeGreaterThan(secondDone.message.usage.input + secondDone.message.usage.output);
		expect(finalDone.message.usage.input).toBe(estimateCursorPromptMessageTokens(secondToolResultMessage));
		expect(finalDone.message.usage.input).not.toBe(estimateCursorPromptMessageTokens(firstToolResultMessage) + estimateCursorPromptMessageTokens(secondToolResultMessage));
		expect(finalDone.message.usage.input).toBeGreaterThan(0);
		expect(finalDone.message.usage.input).toBeLessThan(firstDone.message.usage.input);
		expect(finalDone.message.usage.output).toBeGreaterThan(0);
		expect(finalDone.message.usage.totalTokens).toBeGreaterThan(finalDone.message.usage.input + finalDone.message.usage.output);
		expect(secondDone.message.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
		expect(finalText).toBe("Final answer.");
		expect(finalDone.message.content).toEqual([{ type: "text", text: "Final answer." }]);
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

	it("aborts after agent creation without sending a prompt when already cancelled", async () => {
		const controller = new AbortController();
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn();
		mockedCreate.mockImplementation(async () => {
			controller.abort();
			return {
				send: mockSend,
				[Symbol.asyncDispose]: mockDispose,
			};
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal });
		const events = await collectEvents(stream);
		const error = getErrorEvent(events);

		expect(error.reason).toBe("aborted");
		expect(error.error.stopReason).toBe("aborted");
		expect(mockSend).not.toHaveBeenCalled();
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("emits actionable error when no API key", async () => {
		const stream = streamCursor(makeModel(), makeContext(), { apiKey: undefined });
		const events = await collectEvents(stream);

		const error = getErrorEvent(events);
		expect(error.error.errorMessage).toContain("/login");
		expect(error.error.errorMessage).toContain("CURSOR_API_KEY");
		expect(error.error.errorMessage).toContain("--api-key");
	});

	it("treats unresolved CURSOR_API_KEY provider placeholders as a missing API key", async () => {
		const originalKey = process.env.CURSOR_API_KEY;
		delete process.env.CURSOR_API_KEY;
		try {
			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "CURSOR_API_KEY" });
			const events = await collectEvents(stream);

			const error = getErrorEvent(events);
			expect(error).toBeDefined();
			expect(error.error.errorMessage).toBe(
				"Cursor SDK runs require a Cursor API key. Run /login -> Use an API key -> Cursor, set CURSOR_API_KEY before starting pi, or restart pi with --api-key.",
			);
			expect(mockedCreate).not.toHaveBeenCalled();
		} finally {
			if (originalKey === undefined) {
				delete process.env.CURSOR_API_KEY;
			} else {
				process.env.CURSOR_API_KEY = originalKey;
			}
		}
	});

	it("resolves CURSOR_API_KEY provider placeholders through the env var when present", async () => {
		const originalKey = process.env.CURSOR_API_KEY;
		process.env.CURSOR_API_KEY = "env-key-123";
		try {
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
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "CURSOR_API_KEY" });
			await collectEvents(stream);

			expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "env-key-123" }));
		} finally {
			if (originalKey === undefined) {
				delete process.env.CURSOR_API_KEY;
			} else {
				process.env.CURSOR_API_KEY = originalKey;
			}
		}
	});

	it("turns generic Cursor SDK failures into actionable setup errors", async () => {
		mockedCreate.mockRejectedValueOnce(new Error("Error"));

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const error = getErrorEvent(events);
		expect(error.error.errorMessage).toContain("Cursor SDK request failed");
		expect(error.error.errorMessage).toContain("/login");
		expect(error.error.errorMessage).toContain("CURSOR_API_KEY");
		expect(error.error.errorMessage).toContain("--api-key");
		expect(error.error.errorMessage).not.toBe("Error");
	});

	it("labels likely auth failures without leaking the supplied API key", async () => {
		mockedCreate.mockRejectedValueOnce(new Error("Unauthorized Bearer super-secret-key-12345"));

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "super-secret-key-12345" });
		const events = await collectEvents(stream);

		const error = getErrorEvent(events);
		const message = error.error.errorMessage;
		expect(message).toContain("invalid or unauthorized");
		expect(message).toContain("/login");
		expect(message).toContain("CURSOR_API_KEY");
		expect(message).not.toContain("super-secret-key-12345");
	});

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
		mockedCreate.mockResolvedValue({
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
		mockedCreate.mockResolvedValue({
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
			return {
				id: "run-2",
				agentId: "agent-2",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-2", status: "finished", result: "Recovered" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockImplementation(async () => ({
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

	it("reuses the session agent and sends an incremental prompt on follow-up turns", async () => {
		const mockSend = vi.fn().mockImplementation(async (message: { text?: string }) => {
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: message.text ?? "" }),
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
		expect(secondPrompt.text).toContain("User: Follow up");
		expect(secondPrompt.text).not.toContain("User: Hello");
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
		mockedCreate.mockImplementation(async () => ({
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
		mockedCreate.mockResolvedValue({
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
			} as Context["messages"][number],
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
		mockedCreate.mockImplementation(async () => ({
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
		mockedCreate.mockImplementation(async () => ({
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
		mockedCreate.mockResolvedValue({
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
				return {
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Hello" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				};
			}

			turn2OnDelta = opts.onDelta;
			return {
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
			};
		});
		mockedCreate.mockResolvedValue({
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
		const { client, transport } = await connectMcpClient(createOptions.mcpServers.pi_tools.url);
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

	it("surfaces live-run wait error status as a provider error", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "partial" } });
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "error",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "error", result: "Cursor SDK run failed" }),
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
		expect(error.error.errorMessage).toContain("Cursor SDK run failed");
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

	it("cancels run on abort signal", async () => {
		const controller = new AbortController();
		const mockCancel = vi.fn().mockResolvedValue(undefined);
		let resolveWait: () => void;
		const waitPromise = new Promise<{ id: string; status: string }>((resolve) => {
			resolveWait = () => resolve({ id: "run-1", status: "cancelled" });
		});
		const mockSend = vi.fn().mockImplementation(async () => {
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: vi.fn().mockReturnValue(waitPromise),
				cancel: mockCancel,
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), {
			apiKey: "test-key",
			signal: controller.signal,
		});

		// Give the async IIFE time to start the run
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());

		// Now abort
		controller.abort();

		// Let the run resolve
		resolveWait!();

		await collectEvents(stream);

		expect(mockCancel).toHaveBeenCalled();
	});

	it("budgets oversized prompt history before Cursor Agent.send", async () => {
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		const context: Context = {
			systemPrompt: "Keep this system prompt.",
			messages: [
				{ role: "user", content: `old request ${"x".repeat(1200)}`, timestamp: 1 },
				{ role: "user", content: "latest request must remain", timestamp: 2 },
			],
		};
		const smallModel = { ...makeModel("gpt-5.5@1m"), contextWindow: 250, maxTokens: 50 };

		const stream = streamCursor(smallModel, context, { apiKey: "test-key" });
		await collectEvents(stream);

		const sentMessage = mockSend.mock.calls[0]?.[0] as { text: string };
		expect(sentMessage.text).toContain("Keep this system prompt.");
		expect(sentMessage.text).toContain("latest request must remain");
		expect(sentMessage.text).toContain("Earlier transcript omitted");
		expect(sentMessage.text).not.toContain("old request");
	});

	it("reserves image tokens when budgeting oversized prompt history", async () => {
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		const context: Context = {
			systemPrompt: "Keep image prompt compact.",
			messages: [
				{ role: "user", content: `old request ${"x".repeat(1200)}`, timestamp: 1 },
				{
					role: "user",
					content: [
						{ type: "text", text: "latest image request" },
						{ type: "image", data: "base64-image", mimeType: "image/png" },
					],
					timestamp: 2,
				},
			],
		};
		const smallModel = { ...makeModel("gpt-5.5@1m"), contextWindow: 250, maxTokens: 50 };

		const stream = streamCursor(smallModel, context, { apiKey: "test-key" });
		await collectEvents(stream);

		const sentMessage = mockSend.mock.calls[0]?.[0] as { text: string; images?: unknown[] };
		expect(sentMessage.text).toContain("latest image request");
		expect(sentMessage.text).toContain("Earlier transcript omitted");
		expect(sentMessage.text).not.toContain("old request");
		expect(sentMessage.images).toEqual([{ data: "base64-image", mimeType: "image/png" }]);
	});

	it("forwards latest user images to Cursor Agent.send", async () => {
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Describe this image" },
						{ type: "image", data: "base64-image", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
		};

		const stream = streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockSend).toHaveBeenCalledWith(
			expect.objectContaining({
				images: [{ data: "base64-image", mimeType: "image/png" }],
			}),
			expect.any(Object),
		);
	});

	it("caches SDK checkpoint context windows after successful runs", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-provider-context-window-"));
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			const loadLatest = vi.fn().mockResolvedValue({ tokenDetails: { usedTokens: 8435, maxTokens: 201000 } });
			mockedCreateAgentPlatform.mockResolvedValue(createMockAgentPlatform(loadLatest));
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
				agentId: "agent-ctx",
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
			await collectEvents(stream);

			expect(loadLatest).toHaveBeenCalledWith("agent-ctx");
			const cache = JSON.parse(readFileSync(contextWindowCacheTestUtils.getCachePath(), "utf-8"));
			expect(cache.contextWindows).toEqual({ "composer-2": 201000 });
		} finally {
			if (originalAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			}
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
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

	it("does not trim final text when pre-tool text is only a word prefix", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
		});

		let onDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			onDelta = opts.onDelta;
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
			onDelta?.({ update: { type: "text-delta", text: "Disconnect" } });
			const readCallPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			const firstEvents = await firstEventsPromise;
			const firstText = collectTextDeltas(firstEvents);
			const firstDone = getDoneEvent(firstEvents);
			const [toolCall] = firstDone.message.content.filter(isToolCallBlock);

			expect(firstText).toBe("Disconnect");
			expect(toolCall.name).toBe("read");

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 2,
				},
			];

			const finalEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), replayContext, { apiKey: "test-key" }));
			await expect(readCallPromise).resolves.toMatchObject({ content: [{ type: "text", text: "file contents" }] });
			resolveRun({ id: "run-1", status: "finished", result: "Disconnecting the CDP session per your choice." });
			const finalEvents = await finalEventsPromise;
			const finalText = collectTextDeltas(finalEvents);
			const finalDone = getDoneEvent(finalEvents);

			expect(mockedCreate).toHaveBeenCalledTimes(1);
			expect(runWait).toHaveBeenCalledTimes(1);
			expect(finalText).toBe("Disconnecting the CDP session per your choice.");
			expect(finalDone.message.content).toEqual([{ type: "text", text: "Disconnecting the CDP session per your choice." }]);
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

	it("loads all Cursor setting sources by default for ambient MCP/tools", async () => {
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: { cwd: process.cwd(), settingSources: ["all"] },
			}),
		);
	});

	it("allows Cursor setting sources to be disabled", async () => {
		process.env.PI_CURSOR_SETTING_SOURCES = "none";
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: { cwd: process.cwd() },
			}),
		);
	});

	it("allows Cursor setting sources to be explicitly enabled", async () => {
		process.env.PI_CURSOR_SETTING_SOURCES = "all";
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: { cwd: process.cwd(), settingSources: ["all"] },
			}),
		);
	});

	it("suppresses all direct Cursor SDK startup writes when setting sources are enabled", async () => {
		process.env.PI_CURSOR_SETTING_SOURCES = "all";
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		const createCollector = (chunks: string[]) =>
			((
				chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
				callback?: (error?: Error | null) => void,
			): boolean => {
				chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
				const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
				done?.();
				return true;
			}) as typeof process.stdout.write;
		process.stdout.write = createCollector(stdoutChunks);
		process.stderr.write = createCollector(stderrChunks) as typeof process.stderr.write;
		const consoleSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
			process.stdout.write(`${String(message)}\n`);
		});
		try {
			const mockSend = vi.fn().mockImplementation(async () => {
				process.stdout.write("VISIBLE non-startup stdout\n");
				process.stderr.write("VISIBLE non-startup stderr\n");
				console.log("VISIBLE non-startup console");
				process.stdout.write('18:05:57.959 INFO  managed_skills.removed ctx=syncBuiltinSkills meta={skill_id: "clone"}\n');
				process.stderr.write('18:05:57.961 INFO  managed_skills.removed ctx=syncBuiltinSkills meta={skill_id: "cursor"}\n');
				console.log('18:05:57.962 INFO  managed_skills.removed ctx=syncBuiltinSkills meta={skill_id: "cursor-sdk"}');
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
			mockedCreate.mockImplementationOnce(async () => {
				process.stdout.write('INFO managed_skills.removed meta={skill_id:"clone"}\n');
				process.stderr.write("INFO managed_skills.removed stderr\n");
				console.log("INFO managed_skills.removed via console");
				process.stdout.write("UNEXPECTED startup stdout with test-key\n");
				process.stderr.write("UNEXPECTED startup stderr with test-key\n");
				console.log("UNEXPECTED startup console with test-key");
				return {
					agentId: "agent-1",
					send: mockSend,
					[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
				};
			});

			await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		} finally {
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
		}

		expect(stdoutChunks.join("")).not.toContain("managed_skills.removed");
		expect(stderrChunks.join("")).not.toContain("managed_skills.removed");
		expect(stdoutChunks.join("")).not.toContain("UNEXPECTED startup");
		expect(stderrChunks.join("")).not.toContain("UNEXPECTED startup");
		expect(stdoutChunks.join("")).not.toContain("test-key");
		expect(stderrChunks.join("")).not.toContain("test-key");
		expect(stdoutChunks.join("")).toContain("VISIBLE non-startup stdout");
		expect(stdoutChunks.join("")).toContain("VISIBLE non-startup console");
		expect(stderrChunks.join("")).toContain("VISIBLE non-startup stderr");
		expect(consoleSpy).not.toHaveBeenCalledWith("INFO managed_skills.removed via console");
		expect(consoleSpy).not.toHaveBeenCalledWith("UNEXPECTED startup console with test-key");
		expect(consoleSpy).not.toHaveBeenCalledWith('18:05:57.962 INFO  managed_skills.removed ctx=syncBuiltinSkills meta={skill_id: "cursor-sdk"}');
		expect(consoleSpy).toHaveBeenCalledWith("VISIBLE non-startup console");
		consoleSpy.mockRestore();
	});

	it("allows Cursor setting sources to be narrowed", async () => {
		process.env.PI_CURSOR_SETTING_SOURCES = "project,user";
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: { cwd: process.cwd(), settingSources: ["project", "user"] },
			}),
		);
	});

	it("passes Cursor alias model selection back to the SDK", async () => {
		modelDiscoveryTestUtils.registerModelItems([
			{
				id: "gpt-5.5",
				displayName: "GPT-5.5",
				aliases: ["gpt-latest"],
				parameters: [
					{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] },
					{ id: "reasoning", displayName: "Reasoning", values: [{ value: "none" }, { value: "medium" }] },
				],
				variants: [
					{
						params: [
							{ id: "context", value: "1m" },
							{ id: "reasoning", value: "medium" },
						],
						displayName: "GPT-5.5",
						isDefault: true,
					},
				],
			},
		]);
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("gpt-latest@272k"), makeContext(), { apiKey: "test-key", reasoning: "medium" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "gpt-latest",
					params: [
						{ id: "context", value: "272k" },
						{ id: "reasoning", value: "medium" },
					],
				},
			}),
		);
	});

	it("passes Cursor model selection with context and pi thinking off to Agent.create", async () => {
		const modelWithParams = makeModel("gpt-5.5@1m");
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "gpt-5.5",
					params: [
						{ id: "context", value: "1m" },
						{ id: "fast", value: "false" },
						{ id: "reasoning", value: "none" },
					],
				},
			}),
		);
	});

	it("applies pi medium thinking level to Cursor reasoning parameter", async () => {
		const modelWithParams = {
			...makeModel("gpt-5.5@1m"),
			reasoning: true,
			thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "extra-high", off: null, minimal: null },
		};
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key", reasoning: "medium" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "gpt-5.5",
					params: [
						{ id: "context", value: "1m" },
						{ id: "fast", value: "false" },
						{ id: "reasoning", value: "medium" },
					],
				},
			}),
		);
	});

	it("maps pi xhigh thinking to Cursor extra-high reasoning for a sibling context", async () => {
		const modelWithParams = {
			...makeModel("gpt-5.5@272k"),
			reasoning: true,
			thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "extra-high", off: null, minimal: null },
		};
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key", reasoning: "xhigh" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "gpt-5.5",
					params: [
						{ id: "context", value: "272k" },
						{ id: "fast", value: "false" },
						{ id: "reasoning", value: "extra-high" },
					],
				},
			}),
		);
	});

	it("applies pi thinking level to Cursor Claude effort and thinking parameters", async () => {
		const modelWithParams = {
			...makeModel("claude-opus-4-7@1m"),
			reasoning: true,
			thinkingLevelMap: {
				off: "false",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
			},
		};
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key", reasoning: "xhigh" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "claude-opus-4-7",
					params: [
						{ id: "context", value: "1m" },
						{ id: "effort", value: "xhigh" },
						{ id: "thinking", value: "true" },
					],
				},
			}),
		);
	});

	it("turns Cursor thinking off when pi thinking is off", async () => {
		const modelWithParams = {
			...makeModel("claude-sonnet-4-6@1m"),
			reasoning: true,
			thinkingLevelMap: { off: "false", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
		};
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "claude-sonnet-4-6",
					params: [
						{ id: "context", value: "1m" },
						{ id: "thinking", value: "false" },
					],
				},
			}),
		);
	});

	it("passes plain model id without params to Agent.create", async () => {
		const plainModel = makeModel("gemini-3.1-pro");
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(plainModel, makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: { id: "gemini-3.1-pro" },
			}),
		);
	});

	it("emits result text when no deltas were received", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "fallback text" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const textEnd = getTextEndEvent(events);
		expect(textEnd).toBeDefined();
		expect(textEnd.content).toBe("fallback text");
	});
});
