import { describe, expect, it, vi } from "vitest";
import {
	createEventHarness,
	createDefaultSystemPromptOptions,
	type HarnessEventInvokeResult,
	type HarnessEventMap,
} from "./pi-harness.js";

describe("pi-harness event map types", () => {
	it("keeps compile-time negative fixtures for invalid harness payloads", () => {
		expect(true).toBe(true);
	});
});

describe("pi-harness before_agent_start results", () => {
	it("chains systemPrompt edits across multiple handlers", async () => {
		const pi = createEventHarness();
		pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}-first` }));
		pi.on("before_agent_start", (event, ctx) => {
			expect(event.systemPrompt).toContain("-first");
			expect(ctx.getSystemPrompt()).toContain("-first");
			return { systemPrompt: `${event.systemPrompt}-second` };
		});

		const result = await pi.invokeEvent("before_agent_start", {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "base",
			systemPromptOptions: createDefaultSystemPromptOptions("/repo"),
		});

		expect(result?.systemPrompt).toBe("base-first-second");
	});

	it("rebinds ctx.getSystemPrompt() while chaining handlers", async () => {
		const pi = createEventHarness();
		const seenPrompts: string[] = [];
		pi.on("before_agent_start", (_event, ctx) => {
			seenPrompts.push(ctx.getSystemPrompt());
			return { systemPrompt: "after-first" };
		});
		pi.on("before_agent_start", (_event, ctx) => {
			seenPrompts.push(ctx.getSystemPrompt());
			return { systemPrompt: "after-second" };
		});

		const result = await pi.invokeEvent("before_agent_start", {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "base",
			systemPromptOptions: createDefaultSystemPromptOptions("/repo"),
		});

		expect(seenPrompts).toEqual(["base", "after-first"]);
		expect(result?.systemPrompt).toBe("after-second");
	});

	it("returns undefined when no handler modifies the prompt", async () => {
		const pi = createEventHarness();
		pi.on("before_agent_start", () => undefined);

		const result = await pi.invokeEvent("before_agent_start", {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "base",
			systemPromptOptions: createDefaultSystemPromptOptions("/repo"),
		});

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

		const result = await pi.invokeEvent("before_agent_start", {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "base",
			systemPromptOptions: createDefaultSystemPromptOptions("/repo"),
		});

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
