import { expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Mock @cursor/sdk before importing the module under test
vi.mock("@cursor/sdk", () => {
	const mockCancel = vi.fn().mockResolvedValue(undefined);
	const mockDispose = vi.fn().mockResolvedValue(undefined);
	const mockConfigure = vi.fn();

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
		Cursor: {
			configure: mockConfigure,
		},
		Agent: {
			create: vi.fn().mockResolvedValue(mockAgent),
			resume: vi.fn().mockResolvedValue(mockAgent),
			messages: {
				list: vi.fn().mockResolvedValue([]),
			},
		},
		createAgentPlatform: vi.fn().mockResolvedValue(mockPlatform),
		_mockAgent: mockAgent,
		_mockCancel: mockCancel,
		_mockConfigure: mockConfigure,
		_mockDispose: mockDispose,
		_mockPlatform: mockPlatform,
	};
});

import { Agent, createAgentPlatform, Cursor } from "@cursor/sdk";
import {
	__testUtils as cloudLifecycleTestUtils,
	registerCursorCloudLifecycleLedger,
} from "../../src/cursor-cloud-lifecycle.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../../src/cursor-session-scope.js";
import { __testUtils as cursorSessionResumeTestUtils } from "../../src/cursor-session-agent-resume.js";
import { __testUtils as cursorStateTestUtils } from "../../src/cursor-state.js";
import { __testUtils as cursorHttp1TestUtils } from "../../src/cursor-http1.js";
import { CURSOR_HTTP1_ENV } from "../../src/cursor-config.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../../src/cursor-provider.js";
import { registerCursorPiToolBridge, __testUtils as cursorPiToolBridgeTestUtils } from "../../src/cursor-pi-tool-bridge.js";
import { __testUtils as modelDiscoveryTestUtils } from "../../src/model-discovery.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../../src/cursor-native-tool-display-state.js";
import { registerCursorNativeToolDisplay } from "../../src/cursor-native-tool-display-registration.js";
import type { CursorNativeToolDisplayExtensionApi } from "../../src/cursor-native-tool-display-registration.js";
import type { ModelListItem, Run, SDKAgent, SendOptions } from "@cursor/sdk";
import type { AssistantMessage, AssistantMessageEvent, TextContent, ImageContent, ToolCall } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { installCursorSessionStoreMock } from "./cursor-session-store.js";
import {
	collectAssistantEvents,
	createBridgePiHarness,
	createBuiltinToolInfo,
	createExtensionCommandContext,
	createExtensionTestContext,
	createPiHarness,
	getCursorPiBridgeMcpUrl,
	makeAssistantMessage,
	makeContext,
	makeModel,
	type ExtensionContextOverrides,
	type RegisteredTool,
} from "./pi-harness.js";

export {
	collectAssistantEvents,
	createBridgePiHarness,
	createBuiltinToolInfo,
	createExtensionCommandContext,
	createExtensionTestContext,
	createPiHarness,
	createTestToolInfo,
	getCursorPiBridgeMcpUrl,
	makeAssistantMessage,
	makeContext,
	makeModel,
	type ExtensionContextOverrides,
	type RegisteredTool,
} from "./pi-harness.js";

// Access the mocks via the module
export const mockedCreate = vi.mocked(Agent.create);
export const mockedResume = vi.mocked(Agent.resume);
export const mockedMessagesList = vi.mocked(Agent.messages.list);
export const mockedConfigureCursor = vi.mocked(Cursor.configure);
export const mockedCreateAgentPlatform = vi.mocked(createAgentPlatform, { partial: true });

export type MockSdkAgent = Awaited<ReturnType<typeof Agent.create>>;

export function asMockSdkAgent(
	agent: Pick<MockSdkAgent, "send"> & Partial<Omit<MockSdkAgent, "send">>,
): MockSdkAgent {
	return {
		agentId: "agent-1",
		[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		...agent,
	} as MockSdkAgent;
}

export function mockCreatedAgent(
	agent: Pick<MockSdkAgent, "send"> & Partial<Omit<MockSdkAgent, "send">>,
): void {
	mockedCreate.mockResolvedValue(asMockSdkAgent(agent));
}

export function asMockCursorRun(
	run: Pick<Run, "id" | "agentId" | "status" | "wait"> & Partial<Run>,
): Run {
	return {
		cancel: vi.fn(),
		supports: () => true,
		unsupportedReason: () => undefined,
		stream: {} as Run["stream"],
		conversation: {} as Run["conversation"],
		onDidChangeStatus: vi.fn(),
		...run,
	} as Run;
}

export function getPiToolsMcpUrlFromAgentCreateOptions(options: CursorAgentCreateOptions): string {
	if (!options.mcpServers?.pi_tools) {
		throw new Error("Expected pi_tools MCP server in Agent.create options");
	}
	return getCursorPiBridgeMcpUrl({ mcpServers: options.mcpServers });
}

export function textFromToolResultBlock(block: TextContent | ImageContent | undefined): string {
	return block?.type === "text" ? block.text : "";
}

export function registerBridgeForProviderTest(options: { active: string[]; tools: ToolInfo[] }) {
	const pi = createBridgePiHarness(options);
	registerCursorPiToolBridge(pi);
	return { pi, runSessionShutdown: pi.runSessionShutdown.bind(pi) };
}

export async function connectMcpClient(url: string) {
	const client = new Client({ name: "pi-cursor-sdk-provider-test", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(url));
	await client.connect(transport);
	return { client, transport };
}

export const delayBeforeToolCompletion = () => new Promise((resolve) => setTimeout(resolve, 120));

export async function collectEvents(stream: ReturnType<typeof streamCursor>): Promise<AssistantMessageEvent[]> {
	return collectAssistantEvents(stream);
}

export type AssistantStreamEventType = AssistantMessageEvent["type"];
export type AssistantStreamEvent<TType extends AssistantStreamEventType> = Extract<AssistantMessageEvent, { type: TType }>;
export type CursorDeltaHandler = (event: { update: unknown }) => void;
export type CursorStepHandler = (event: { step: unknown }) => void;
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
export type CursorAgentPlatformForTest = Partial<Awaited<ReturnType<typeof createAgentPlatform>>> & {
	checkpointStore: Awaited<ReturnType<typeof createAgentPlatform>>["checkpointStore"];
};

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
			saveCheckpoint: vi.fn().mockResolvedValue({ blobId: "checkpoint-1", storeKind: "test" }),
			getBlobStore: vi.fn().mockResolvedValue({}),
			getFullConversation: vi.fn().mockResolvedValue({}),
		},
	};
}

export interface NativeToolDisplayTestPi {
	getActiveTools: ExtensionAPI["getActiveTools"];
	setActiveTools: ExtensionAPI["setActiveTools"];
	runTurnStart: (ctxOverrides?: ExtensionContextOverrides) => Promise<void>;
}

export async function createNativeToolDisplayPiForTest(registeredTools: RegisteredTool[] = []): Promise<NativeToolDisplayTestPi> {
	const pi = createPiHarness({
		initialTools: ["read", "bash", "grep", "find", "ls", "edit", "write", "cursor"].map((name) =>
			createBuiltinToolInfo(name),
		),
	});
	const nativePi: CursorNativeToolDisplayExtensionApi = {
		on: pi.on as CursorNativeToolDisplayExtensionApi["on"],
		registerTool: (tool) => {
			registeredTools.push(tool as RegisteredTool);
			pi.registerTool(tool as RegisteredTool);
		},
		getAllTools: pi.getAllTools,
		getActiveTools: pi.getActiveTools,
		setActiveTools: pi.setActiveTools,
	};
	registerCursorNativeToolDisplay(nativePi);
	await pi.runSessionStart({ hasUI: false });
	return {
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (toolNames) => {
			pi.setActiveTools(toolNames);
		},
		runTurnStart: (ctxOverrides = {}) => pi.runTurnStart({ hasUI: false, ...ctxOverrides }),
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
	installCursorSessionStoreMock();
	cloudLifecycleTestUtils.reset();
	cloudLifecycleTestUtils.setDurableWriter(() => true);
	registerCursorCloudLifecycleLedger(createPiHarness());
	await cursorPiToolBridgeTestUtils.resetRegisteredBridgeForTests();
	vi.clearAllMocks();
	delete process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
	delete process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS;
	delete process.env.PI_CURSOR_SETTING_SOURCES;
	delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
	delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
	delete process.env.PI_CURSOR_TASK_PRESENTATION;
	delete process.env.PI_CURSOR_RUNTIME;
	delete process.env.PI_CURSOR_CLOUD_REPO;
	delete process.env.PI_CURSOR_CLOUD_BRANCH;
	delete process.env.PI_CURSOR_CLOUD_CONTEXT;
	delete process.env.PI_CURSOR_CLOUD_DIRECT_PUSH;
	delete process.env.PI_CURSOR_CLOUD_AUTO_CREATE_PR;
	delete process.env.PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST;
	delete process.env.PI_CURSOR_CLOUD_ACK;
	delete process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE;
	delete process.env.PI_CURSOR_CLOUD_ENV;
	delete process.env.PI_CURSOR_CLOUD_ENV_FROM_FILES;
	delete process.env.PI_CURSOR_CLOUD_ENV_TYPE;
	delete process.env.PI_CURSOR_CLOUD_ENV_NAME;
	delete process.env.PI_CURSOR_AUTO_REVIEW;
	delete process.env.PI_CURSOR_SANDBOX;
	delete process.env.PI_CURSOR_LOCAL_FORCE;
	delete process.env.PI_CURSOR_LOCAL_RESUME;
	delete process.env[CURSOR_HTTP1_ENV];
	process.env.PI_CURSOR_TOOL_MANIFEST = "0";
	expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
	cursorProviderTestUtils.resetCursorNativeReplayIdleDisposeMs();
	await cursorProviderTestUtils.resetSessionCursorAgents();
	cursorProviderTestUtils.resetSessionTurnQueue();
	cursorSessionScopeTestUtils.reset();
	cursorSessionResumeTestUtils.reset();
	cursorStateTestUtils.resetCursorModeStateForTests();
	cursorHttp1TestUtils.reset();
	nativeToolDisplayTestUtils.reset();
	modelDiscoveryTestUtils.registerModelItems(cursorModelItems);
	mockCreatedAgent({ send: vi.fn() });
	mockedMessagesList.mockResolvedValue([]);
	mockedCreateAgentPlatform.mockResolvedValue(createMockAgentPlatform());
}
