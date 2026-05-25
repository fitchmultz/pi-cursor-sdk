import { expect, vi } from "vitest";
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
import { __testUtils as cursorSessionCwdTestUtils } from "../../src/cursor-session-cwd.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../../src/cursor-provider.js";
import { registerCursorPiToolBridge, __testUtils as cursorPiToolBridgeTestUtils } from "../../src/cursor-pi-tool-bridge.js";
import { __testUtils as modelDiscoveryTestUtils } from "../../src/model-discovery.js";
import { __testUtils as nativeToolDisplayTestUtils, registerCursorNativeToolDisplay } from "../../src/cursor-native-tool-display.js";
import type { ModelListItem, SendOptions } from "@cursor/sdk";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

// Access the mocks via the module
export const mockedCreate = vi.mocked(Agent.create);
export const mockedCreateAgentPlatform = vi.mocked(createAgentPlatform);

export type RegisteredTool = ToolDefinition<TSchema, unknown, unknown>;
export type TestExtensionContext = Pick<ExtensionContext, "cwd" | "hasUI"> & { ui: Pick<ExtensionContext["ui"], "notify"> };
export type TestEventHandler = (event: unknown, ctx: TestExtensionContext) => Promise<void> | void;

export function createBuiltinToolInfo(name: string, parameters: TSchema = Type.Object({}), description = ""): ToolInfo {
	return {
		name,
		description,
		parameters,
		sourceInfo: { source: "builtin", path: `<builtin:${name}>`, scope: "temporary", origin: "top-level" },
	};
}

export function createBridgeToolInfo(name: string, parameters: TSchema = Type.Object({}), description = `${name} tool`): ToolInfo {
	return {
		name,
		description,
		parameters,
		sourceInfo: { source: "test", path: `test:${name}`, scope: "temporary", origin: "top-level" },
	};
}

export function registerBridgeForProviderTest(options: { active: string[]; tools: ToolInfo[] }) {
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

export async function connectMcpClient(url: string) {
	const client = new Client({ name: "pi-cursor-sdk-provider-test", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(url));
	await client.connect(transport);
	return { client, transport };
}

export function makeModel(id = "test-model"): Model<"cursor-sdk"> {
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

export const delayBeforeToolCompletion = () => new Promise((resolve) => setTimeout(resolve, 120));

export function makeContext(): Context {
	return {
		systemPrompt: "Be helpful.",
		messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	};
}

export function makeAssistantMessage(text = "Done", timestamp = 2): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "cursor-sdk",
		provider: "cursor",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp,
	};
}

export async function collectEvents(stream: ReturnType<typeof streamCursor>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

export type AssistantStreamEventType = AssistantMessageEvent["type"];
export type AssistantStreamEvent<TType extends AssistantStreamEventType> = Extract<AssistantMessageEvent, { type: TType }>;
export type CursorDeltaHandler = NonNullable<SendOptions["onDelta"]>;
export type CursorStepHandler = NonNullable<SendOptions["onStep"]>;
export type CursorToolStreamEventType = "toolcall_start" | "toolcall_delta" | "toolcall_end";

export const CURSOR_TOOL_STREAM_EVENT_TYPES = new Set<AssistantStreamEventType>(["toolcall_start", "toolcall_delta", "toolcall_end"]);

export function isEventType<TType extends AssistantStreamEventType>(
	event: AssistantMessageEvent,
	type: TType,
): event is AssistantStreamEvent<TType> {
	return event.type === type;
}

export function collectTextDeltas(events: readonly AssistantMessageEvent[]): string {
	return events.filter((event): event is AssistantStreamEvent<"text_delta"> => isEventType(event, "text_delta")).map((event) => event.delta).join("");
}

export function collectThinkingDeltas(events: readonly AssistantMessageEvent[]): string {
	return events.filter((event): event is AssistantStreamEvent<"thinking_delta"> => isEventType(event, "thinking_delta")).map((event) => event.delta).join("");
}

export function getRequiredEvent<TType extends AssistantStreamEventType>(
	events: readonly AssistantMessageEvent[],
	type: TType,
): AssistantStreamEvent<TType> {
	const event = events.find((candidate): candidate is AssistantStreamEvent<TType> => isEventType(candidate, type));
	if (!event) throw new Error(`Expected ${type} event`);
	return event;
}

export function getEventsOfType<TType extends AssistantStreamEventType>(
	events: readonly AssistantMessageEvent[],
	type: TType,
): AssistantStreamEvent<TType>[] {
	return events.filter((event): event is AssistantStreamEvent<TType> => isEventType(event, type));
}

export function hasEventType(events: readonly AssistantMessageEvent[], type: AssistantStreamEventType): boolean {
	return events.some((event) => event.type === type);
}

export function isCursorToolStreamEvent(event: AssistantMessageEvent): event is AssistantStreamEvent<CursorToolStreamEventType> {
	return CURSOR_TOOL_STREAM_EVENT_TYPES.has(event.type);
}

export function getDoneEvent(events: readonly AssistantMessageEvent[]): AssistantStreamEvent<"done"> {
	return getRequiredEvent(events, "done");
}

export function getErrorEvent(events: readonly AssistantMessageEvent[]): AssistantStreamEvent<"error"> {
	return getRequiredEvent(events, "error");
}

export function getTextEndEvent(events: readonly AssistantMessageEvent[]): AssistantStreamEvent<"text_end"> {
	return getRequiredEvent(events, "text_end");
}

export function isToolCallBlock(block: AssistantMessage["content"][number]): block is ToolCall {
	return block.type === "toolCall";
}

export type CursorAgentCreateOptions = NonNullable<Parameters<typeof Agent.create>[0]>;
export type CursorAgentPlatformForTest = Awaited<ReturnType<typeof createAgentPlatform>>;

export function getCreatedAgentOptions(callIndex = 0): CursorAgentCreateOptions {
	const options = mockedCreate.mock.calls[callIndex]?.[0];
	if (!options) throw new Error(`Expected Agent.create call ${callIndex}`);
	return options;
}

export function createMockAgentPlatform(
	loadLatest = vi.fn().mockResolvedValue(undefined),
): CursorAgentPlatformForTest {
	return {
		checkpointStore: {
			loadLatest,
		},
	} as CursorAgentPlatformForTest;
}

export interface NativeToolDisplayTestPi {
	getActiveTools: ReturnType<typeof vi.fn>;
	setActiveTools: ReturnType<typeof vi.fn>;
	runEventHandlers: (event: string, ctx?: Record<string, unknown>) => Promise<void>;
}

export async function createNativeToolDisplayPiForTest(registeredTools: RegisteredTool[] = []): Promise<NativeToolDisplayTestPi> {
	const handlers = new Map<string, TestEventHandler[]>();
	let activeToolNames = ["read", "bash", "edit", "write"];
	const notify = vi.fn();
	const baseCtx = { cwd: process.cwd(), hasUI: false, ui: { notify } };
	const pi = {
		on: vi.fn((event: string, handler: TestEventHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}),
		registerTool: vi.fn((tool: RegisteredTool) => {
			registeredTools.push(tool);
		}),
		getAllTools: vi.fn(() => {
			const toolsByName = new Map<string, ToolInfo>();
			for (const name of ["read", "bash", "grep", "find", "ls", "edit", "write", "cursor"]) {
				toolsByName.set(name, createBuiltinToolInfo(name));
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
	};
	registerCursorNativeToolDisplay(pi as never);
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, baseCtx);
	}
	return {
		getActiveTools: pi.getActiveTools,
		setActiveTools: pi.setActiveTools,
		runEventHandlers: async (event, ctx = {}) => {
			for (const handler of handlers.get(event) ?? []) {
				await handler({ type: event }, { ...baseCtx, ...ctx });
			}
		},
	};
}

export async function registerNativeToolDisplayForTest(registeredTools: RegisteredTool[]): Promise<void> {
	await createNativeToolDisplayPiForTest(registeredTools);
}

export const cursorModelItems: ModelListItem[] = [
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

export async function resetCursorProviderTestState(): Promise<void> {
	vi.useRealTimers();
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
	mockedCreate.mockResolvedValue({
		agentId: "agent-1",
		send: vi.fn(),
		[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
	});
	mockedCreateAgentPlatform.mockResolvedValue(createMockAgentPlatform());
}
