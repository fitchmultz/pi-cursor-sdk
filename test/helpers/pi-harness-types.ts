import type { MockedFunction } from "vitest";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProviderConfig,
	RegisteredCommand,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	SessionBeforeTreeEvent,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
	ToolInfo,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export type RegisteredTool = ToolDefinition<TSchema, unknown, unknown>;

export type ExtensionContextOverrides = Omit<Partial<ExtensionContext>, "sessionManager" | "ui"> & {
	sessionManager?: Partial<ExtensionContext["sessionManager"]>;
	ui?: Partial<ExtensionContext["ui"]>;
};

export type ExtensionCommandContextOverrides = Omit<
	Partial<ExtensionCommandContext>,
	"sessionManager" | "ui"
> & {
	sessionManager?: Partial<ExtensionCommandContext["sessionManager"]>;
	ui?: Partial<ExtensionCommandContext["ui"]>;
};

export type RegisteredCommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export type HarnessOn = ExtensionAPI["on"];

export type HarnessEventName =
	| "session_start"
	| "session_info_changed"
	| "model_select"
	| "before_agent_start"
	| "turn_start"
	| "turn_end"
	| "session_shutdown"
	| "session_before_compact"
	| "session_compact"
	| "session_tree"
	| "session_before_tree"
	| "tool_call"
	| "tool_result";

/** Matches installed pi `ModelSelectEvent` (not re-exported from package root). */
export type HarnessModelSelectEvent = {
	type: "model_select";
	model: NonNullable<ExtensionContext["model"]>;
	previousModel: ExtensionContext["model"];
	source: "set" | "cycle" | "restore";
};

export type HarnessEventMap = {
	session_start: SessionStartEvent;
	session_info_changed: SessionInfoChangedEvent;
	model_select: HarnessModelSelectEvent;
	before_agent_start: BeforeAgentStartEvent;
	turn_start: TurnStartEvent;
	turn_end: TurnEndEvent;
	session_shutdown: SessionShutdownEvent;
	session_before_compact: SessionBeforeCompactEvent;
	session_compact: SessionCompactEvent;
	session_tree: SessionTreeEvent;
	session_before_tree: SessionBeforeTreeEvent;
	tool_call: ToolCallEvent;
	tool_result: ToolResultEvent;
};

/** Combined invoke result for before_agent_start (matches installed pi ExtensionRunner). */
export type HarnessBeforeAgentStartCombinedResult = {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string;
};

/** Combined invoke result for tool_result (matches installed pi ExtensionRunner.emitToolResult). */
export type HarnessToolResultCombinedResult = {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
};

/** Combined invoke result for session_before_tree (matches installed pi ExtensionRunner.emit). */
export type HarnessSessionBeforeTreeCombinedResult = {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
	};
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
};

/** Invoke result types for harness events that return values to the caller (combined shapes where pi aggregates). */
export type HarnessEventResultMap = {
	tool_call: ToolCallEventResult;
	before_agent_start: HarnessBeforeAgentStartCombinedResult;
	tool_result: HarnessToolResultCombinedResult;
	session_before_tree: HarnessSessionBeforeTreeCombinedResult;
};


export type MockFn<T extends (...args: never[]) => unknown> = MockedFunction<T>;

export interface PiHarnessOptions {
	/** Tool catalog available before extension registration. */
	initialTools?: ToolInfo[];
	/** Active tool names returned by getActiveTools. */
	activeTools?: string[];
	/** Default value returned by getFlag when a name is not in flagValues. */
	defaultFlagValue?: boolean | string;
	/** Per-flag values returned by getFlag. */
	flagValues?: Record<string, boolean | string | undefined>;
}

export type HarnessEventInvokeResult<E extends HarnessEventName> = E extends keyof HarnessEventResultMap
	? HarnessEventResultMap[E] | undefined
	: void;

export interface EventHarness {
	on: MockFn<HarnessOn>;
	invokeEvent: <E extends HarnessEventName>(
		event: E,
		payload: HarnessEventMap[E],
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<HarnessEventInvokeResult<E>>;
	invokeEventWithContext: <E extends HarnessEventName>(
		event: E,
		payload: HarnessEventMap[E],
		ctx: ExtensionContext,
	) => Promise<HarnessEventInvokeResult<E>>;
	runSessionStart: (
		ctxOverrides?: ExtensionContextOverrides,
		eventOverrides?: Partial<SessionStartEvent>,
	) => Promise<void>;
	runModelSelect: (
		model: NonNullable<ExtensionContext["model"]>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
	runBeforeAgentStart: (
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<HarnessEventInvokeResult<"before_agent_start">>;
	runTurnStart: (ctxOverrides?: ExtensionContextOverrides) => Promise<void>;
	runTurnEnd: (
		eventOverrides?: Partial<TurnEndEvent>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
	runSessionShutdown: (
		eventOverrides?: Partial<HarnessEventMap["session_shutdown"]>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
	runSessionBeforeCompact: (
		eventOverrides?: Partial<SessionBeforeCompactEvent>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
	runSessionCompact: (
		eventOverrides?: Partial<SessionCompactEvent>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
	runSessionTree: (
		eventOverrides?: Partial<HarnessEventMap["session_tree"]>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
	runSessionBeforeTree: (
		eventOverrides?: Partial<HarnessEventMap["session_before_tree"]>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<HarnessEventInvokeResult<"session_before_tree">>;
	runToolCall: (
		event: ToolCallEvent,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<ToolCallEventResult | undefined>;
	runToolCallWithContext: (
		event: ToolCallEvent,
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	runToolResult: (
		event: ToolResultEvent,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<HarnessEventInvokeResult<"tool_result">>;
}

export interface PiHarness extends EventHarness {
	registerProvider: MockFn<ExtensionAPI["registerProvider"]>;
	registerFlag: MockFn<ExtensionAPI["registerFlag"]>;
	registerCommand: MockFn<ExtensionAPI["registerCommand"]>;
	registerTool: MockFn<ExtensionAPI["registerTool"]> & ExtensionAPI["registerTool"];
	getAllTools: MockFn<ExtensionAPI["getAllTools"]>;
	getActiveTools: MockFn<ExtensionAPI["getActiveTools"]>;
	setActiveTools: MockFn<ExtensionAPI["setActiveTools"]>;
	sendMessage: MockFn<ExtensionAPI["sendMessage"]>;
	getFlag: MockFn<ExtensionAPI["getFlag"]>;
	appendEntry: MockFn<ExtensionAPI["appendEntry"]>;
	events: ExtensionAPI["events"];
	_eventsEmitted: Array<{ channel: string; data: unknown }>;
	runCommand: (
		name: string,
		args?: string,
		ctxOverrides?: ExtensionCommandContextOverrides,
	) => Promise<void>;
	_registered: Array<{ name: string; config: ProviderConfig }>;
	_commands: Map<string, RegisteredCommandOptions>;
	_tools: RegisteredTool[];
	_activeToolNames: () => string[];
}

export interface BridgePiHarness extends EventHarness {
	getActiveTools: MockFn<ExtensionAPI["getActiveTools"]>;
	getAllTools: MockFn<ExtensionAPI["getAllTools"]>;
	setActiveTools: MockFn<ExtensionAPI["setActiveTools"]>;
}
