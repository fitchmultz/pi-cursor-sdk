import { vi } from "vitest";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionContext,
	ExtensionHandler,
	SessionBeforeTreeEvent,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { createDefaultSystemPromptOptions, createExtensionTestContext, makeAssistantMessage } from "./context-fixtures.js";
import type {
	EventHarness,
	ExtensionContextOverrides,
	HarnessBeforeAgentStartCombinedResult,
	HarnessEventInvokeResult,
	HarnessEventMap,
	HarnessEventName,
	HarnessOn,
	HarnessSessionBeforeTreeCombinedResult,
	HarnessToolResultCombinedResult,
	MockFn,
} from "./pi-harness-types.js";

type HarnessStoredHandler =
	| ExtensionHandler<ToolCallEvent, ToolCallEventResult>
	| ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>
	| ExtensionHandler<ToolResultEvent, HarnessToolResultCombinedResult>
	| ExtensionHandler<SessionBeforeTreeEvent, HarnessSessionBeforeTreeCombinedResult>
	| ExtensionHandler<HarnessEventMap[Exclude<HarnessEventName, "tool_call" | "before_agent_start" | "tool_result" | "session_before_tree">]>;

function createBeforeAgentStartContext(
	baseCtx: ExtensionContext,
	getSystemPrompt: () => string,
): ExtensionContext {
	return {
		...baseCtx,
		getSystemPrompt,
	};
}

async function invokeBeforeAgentStartHandlers(
	payload: BeforeAgentStartEvent,
	ctx: ExtensionContext,
	handlers: readonly HarnessStoredHandler[],
): Promise<HarnessBeforeAgentStartCombinedResult | undefined> {
	let currentSystemPrompt = payload.systemPrompt;
	const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
	let systemPromptModified = false;
	for (const handler of handlers) {
		const event: BeforeAgentStartEvent = {
			...payload,
			systemPrompt: currentSystemPrompt,
		};
		const chainedCtx = createBeforeAgentStartContext(ctx, () => currentSystemPrompt);
		const result = await (handler as ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>)(
			event,
			chainedCtx,
		);
		if (!result) continue;
		if (result.message) {
			messages.push(result.message);
		}
		if (result.systemPrompt !== undefined) {
			currentSystemPrompt = result.systemPrompt;
			systemPromptModified = true;
		}
	}
	if (messages.length === 0 && !systemPromptModified) {
		return undefined;
	}
	return {
		messages: messages.length > 0 ? messages : undefined,
		systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
	};
}

async function invokeToolResultHandlers(
	payload: ToolResultEvent,
	ctx: ExtensionContext,
	handlers: readonly HarnessStoredHandler[],
): Promise<HarnessToolResultCombinedResult | undefined> {
	const currentEvent: ToolResultEvent = { ...payload };
	let modified = false;
	for (const handler of handlers) {
		const result = await (handler as ExtensionHandler<ToolResultEvent, HarnessToolResultCombinedResult>)(
			currentEvent,
			ctx,
		);
		if (!result) continue;
		if (result.content !== undefined) {
			currentEvent.content = result.content;
			modified = true;
		}
		if (result.details !== undefined) {
			currentEvent.details = result.details;
			modified = true;
		}
		if (result.isError !== undefined) {
			currentEvent.isError = result.isError;
			modified = true;
		}
	}
	if (!modified) {
		return undefined;
	}
	return {
		content: currentEvent.content,
		details: currentEvent.details,
		isError: currentEvent.isError,
	};
}

async function invokeSessionBeforeTreeHandlers(
	payload: SessionBeforeTreeEvent,
	ctx: ExtensionContext,
	handlers: readonly HarnessStoredHandler[],
): Promise<HarnessSessionBeforeTreeCombinedResult | undefined> {
	let result: HarnessSessionBeforeTreeCombinedResult | undefined;
	for (const handler of handlers) {
		const handlerResult = await (
			handler as ExtensionHandler<SessionBeforeTreeEvent, HarnessSessionBeforeTreeCombinedResult>
		)(payload, ctx);
		if (handlerResult) {
			result = handlerResult;
			if (result.cancel) {
				return result;
			}
		}
	}
	return result;
}

function createHarnessEventApi(): EventHarness {
	const handlers = new Map<HarnessEventName, HarnessStoredHandler[]>();

	const on = vi.fn(((event: HarnessEventName, handler: HarnessStoredHandler) => {
		const existing = handlers.get(event) ?? [];
		handlers.set(event, [...existing, handler]);
	}) as HarnessOn);

	const invokeEventWithContext = async <E extends HarnessEventName>(
		event: E,
		payload: HarnessEventMap[E],
		ctx: ExtensionContext,
	): Promise<HarnessEventInvokeResult<E>> => {
		const eventHandlers = handlers.get(event) ?? [];
		if (event === "before_agent_start") {
			return (await invokeBeforeAgentStartHandlers(
				payload as BeforeAgentStartEvent,
				ctx,
				eventHandlers,
			)) as HarnessEventInvokeResult<E>;
		}
		if (event === "tool_result") {
			return (await invokeToolResultHandlers(
				payload as ToolResultEvent,
				ctx,
				eventHandlers,
			)) as HarnessEventInvokeResult<E>;
		}
		if (event === "session_before_tree") {
			return (await invokeSessionBeforeTreeHandlers(
				payload as SessionBeforeTreeEvent,
				ctx,
				eventHandlers,
			)) as HarnessEventInvokeResult<E>;
		}
		if (event === "tool_call") {
			const toolCallPayload = payload as ToolCallEvent;
			let toolCallResult: ToolCallEventResult | undefined;
			for (const handler of eventHandlers) {
				const result = await (handler as ExtensionHandler<ToolCallEvent, ToolCallEventResult>)(
					toolCallPayload,
					ctx,
				);
				if (result) {
					toolCallResult = result;
					if (result.block) {
						return toolCallResult as HarnessEventInvokeResult<E>;
					}
				}
			}
			return toolCallResult as HarnessEventInvokeResult<E>;
		}
		for (const handler of eventHandlers) {
			await (handler as ExtensionHandler<HarnessEventMap[E]>)(payload, ctx);
		}
		return undefined as HarnessEventInvokeResult<E>;
	};

	const invokeEvent = async <E extends HarnessEventName>(
		event: E,
		payload: HarnessEventMap[E],
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<HarnessEventInvokeResult<E>> => {
		return invokeEventWithContext(event, payload, createExtensionTestContext(ctxOverrides));
	};

	const runSessionStart = async (
		ctxOverrides: ExtensionContextOverrides = {},
		eventOverrides: Partial<HarnessEventMap["session_start"]> = {},
	): Promise<void> => {
		await invokeEvent(
			"session_start",
			{ type: "session_start", reason: "startup", ...eventOverrides },
			ctxOverrides,
		);
	};

	const runModelSelect = async (
		model: NonNullable<ExtensionContext["model"]>,
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<void> => {
		await invokeEvent(
			"model_select",
			{ type: "model_select", model, previousModel: undefined, source: "set" },
			{ ...ctxOverrides, model },
		);
	};

	const runBeforeAgentStart = async (
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<HarnessEventInvokeResult<"before_agent_start">> => {
		const ctx = createExtensionTestContext(ctxOverrides);
		return invokeEventWithContext(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "start",
				systemPrompt: "",
				systemPromptOptions: createDefaultSystemPromptOptions(ctx.cwd),
			} satisfies BeforeAgentStartEvent,
			ctx,
		);
	};

	const runTurnStart = async (ctxOverrides: ExtensionContextOverrides = {}): Promise<void> => {
		await invokeEvent("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctxOverrides);
	};

	const runTurnEnd = async (
		eventOverrides: Partial<TurnEndEvent> = {},
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<void> => {
		await invokeEvent(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 1,
				message: makeAssistantMessage("") as TurnEndEvent["message"],
				toolResults: [],
				...{
					messageEntryId: "assistant-1",
					toolResultEntryIds: [],
					entries: [],
					continue: false,
					context: {
						contextEntries: [],
						contextMessages: [],
						llmMessages: [],
						pendingMessages: [],
						canContinue: true,
					},
					outcome: "completed" as const,
				},
				...eventOverrides,
			},
			ctxOverrides,
		);
	};

	const runSessionShutdown = async (
		eventOverrides: Partial<HarnessEventMap["session_shutdown"]> = {},
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<void> => {
		await invokeEvent(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit", ...eventOverrides },
			ctxOverrides,
		);
	};

	const runSessionBeforeCompact = async (
		eventOverrides: Partial<SessionBeforeCompactEvent> = {},
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<void> => {
		await invokeEvent(
			"session_before_compact",
			{
				type: "session_before_compact",
				reason: "manual",
				willRetry: false,
				preparation: {
					firstKeptEntryId: "entry-1",
					messagesToSummarize: [],
					turnPrefixMessages: [],
					isSplitTurn: false,
					tokensBefore: 0,
					previousSummary: undefined,
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
					settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
				},
				branchEntries: [],
				signal: new AbortController().signal,
				...eventOverrides,
			},
			ctxOverrides,
		);
	};

	const runSessionCompact = async (
		eventOverrides: Partial<SessionCompactEvent> = {},
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<void> => {
		await invokeEvent(
			"session_compact",
			{
				type: "session_compact",
				reason: "manual",
				willRetry: false,
				compactionEntry: {
					type: "compaction",
					id: "compaction-1",
					parentId: null,
					timestamp: new Date().toISOString(),
					summary: "summary",
					firstKeptEntryId: "entry-1",
					tokensBefore: 0,
				},
				fromExtension: false,
				...eventOverrides,
			},
			ctxOverrides,
		);
	};

	const runToolCallWithContext = async (
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> => {
		return invokeEventWithContext("tool_call", event, ctx);
	};

	const runToolCall = async (
		event: ToolCallEvent,
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<ToolCallEventResult | undefined> => {
		return runToolCallWithContext(event, createExtensionTestContext(ctxOverrides));
	};

	const runToolResult = async (
		event: ToolResultEvent,
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<HarnessEventInvokeResult<"tool_result">> => {
		return invokeEvent("tool_result", event, ctxOverrides);
	};

	const runSessionTree = async (
		eventOverrides: Partial<HarnessEventMap["session_tree"]> = {},
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<void> => {
		await invokeEvent(
			"session_tree",
			{ type: "session_tree", newLeafId: null, oldLeafId: null, ...eventOverrides },
			ctxOverrides,
		);
	};

	const runSessionBeforeTree = async (
		eventOverrides: Partial<HarnessEventMap["session_before_tree"]> = {},
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<HarnessEventInvokeResult<"session_before_tree">> => {
		return invokeEvent(
			"session_before_tree",
			{
				type: "session_before_tree",
				preparation: {
					targetId: "entry-1",
					oldLeafId: null,
					commonAncestorId: null,
					entriesToSummarize: [],
					userWantsSummary: false,
				},
				signal: AbortSignal.timeout(60_000),
				...eventOverrides,
			},
			ctxOverrides,
		);
	};

	return {
		on: on as MockFn<HarnessOn>,
		invokeEvent,
		invokeEventWithContext,
		runSessionStart,
		runModelSelect,
		runBeforeAgentStart,
		runTurnStart,
		runTurnEnd,
		runSessionShutdown,
		runSessionBeforeCompact,
		runSessionCompact,
		runSessionTree,
		runSessionBeforeTree,
		runToolCall,
		runToolCallWithContext,
		runToolResult,
	};
}

/** Event-hook-only fake pi surface (session cwd, scoped listeners, etc.). */
export function createEventHarness(): EventHarness {
	return createHarnessEventApi();
}

export { createHarnessEventApi };
