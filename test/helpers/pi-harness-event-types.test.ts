import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createEventHarness,
	createDefaultSystemPromptOptions,
	type HarnessEventInvokeResult,
	type HarnessEventMap,
} from "./pi-harness.js";

describe("pi-harness before_agent_start results", () => {
	it("chains systemPrompt edits across multiple handlers", async () => {
		const pi = createEventHarness();
		pi.on("before_agent_start", (event, ctx) => {
			expect(ctx.getSystemPrompt()).toBe("base");
			return { systemPrompt: `${event.systemPrompt}-first` };
		});
		pi.on("before_agent_start", (event, ctx) => {
			expect(event.systemPrompt).toBe("base-first");
			expect(ctx.getSystemPrompt()).toBe("base-first");
			return { systemPrompt: `${event.systemPrompt}-second` };
		});

		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: "base",
			systemPromptOptions: createDefaultSystemPromptOptions("/repo"),
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event);

		expect(result?.systemPrompt).toBe("base-first-second");
	});

	it("returns undefined when no handler modifies the prompt", async () => {
		const pi = createEventHarness();
		pi.on("before_agent_start", () => undefined);

		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: "base",
			systemPromptOptions: createDefaultSystemPromptOptions("/repo"),
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event);

		expect(result).toBeUndefined();
	});

	it("aggregates handler messages into plural messages on invoke", async () => {
		const pi = createEventHarness();
		const firstMessage = {
			customType: "notice",
			content: [{ type: "text" as const, text: "first" }],
			display: false,
		};
		const secondMessage = {
			customType: "notice",
			content: [{ type: "text" as const, text: "second" }],
			display: false,
		};
		pi.on("before_agent_start", () => ({ message: firstMessage }));
		pi.on("before_agent_start", () => ({ message: secondMessage }));

		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: "base",
			systemPromptOptions: createDefaultSystemPromptOptions("/repo"),
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const result = await pi.invokeEvent("before_agent_start", event);

		expect(result?.messages).toEqual([firstMessage, secondMessage]);
		expect(result?.systemPrompt).toBeUndefined();
	});
});

describe("pi-harness tool_call results", () => {
	it("short-circuits later handlers when a handler returns block", async () => {
		const pi = createEventHarness();
		const secondHandler = vi.fn(() => ({ block: true, reason: "blocked" }));
		pi.on("tool_call", () => ({ block: true, reason: "blocked" }));
		pi.on("tool_call", secondHandler);

		const result = await pi.invokeEvent(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "call-1",
				toolName: "bash",
				input: { command: "echo hi" },
			},
			{},
		);

		expect(result).toEqual({ block: true, reason: "blocked" });
		expect(secondHandler).not.toHaveBeenCalled();
	});
});

// Negative compile tests: invalid harness payloads must not type-check.
// @ts-expect-error session_start requires type and reason
const _invalidSessionStart = {} satisfies HarnessEventMap["session_start"];

const _invalidModelSelect = {
	type: "model_select",
	// @ts-expect-error model_select requires a concrete model
	model: undefined,
	previousModel: undefined,
	source: "set",
} satisfies HarnessEventMap["model_select"];

const _validBeforeAgentStartInvoke: HarnessEventInvokeResult<"before_agent_start"> = {
	messages: [
		{
			customType: "notice",
			content: [{ type: "text", text: "hello" }],
			display: false,
		},
	],
	systemPrompt: "updated",
};

const _invalidBeforeAgentStartInvoke = {
	// @ts-expect-error invoke combines handler message into messages[], not message
	message: {
		customType: "notice",
		content: [{ type: "text", text: "hello" }],
		display: false,
	},
} satisfies HarnessEventInvokeResult<"before_agent_start">;

void _validBeforeAgentStartInvoke;
void _invalidBeforeAgentStartInvoke;

export {};
