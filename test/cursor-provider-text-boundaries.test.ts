// Install the external SDK transport mock before the static provider dependency graph evaluates.
import "./helpers/cursor-provider-harness.js";
import { readFileSync } from "node:fs";
import type { SendOptions } from "@cursor/sdk";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { __testUtils } from "../src/cursor-provider.js";
import { getFinalAssistantText } from "../src/cursor-run-final-text.js";
import {
	asMockCursorRun, collectEvents, collectTextDeltas, getDoneEvent, getErrorEvent,
	makeContext, makeModel, mockCreatedAgent, registerNativeToolDisplayForTest,
	resetCursorProviderTestState, createExtensionTestContext, type RegisteredTool,
} from "./helpers/cursor-provider-harness.js";
import { installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";
import { installCursorProviderVirtualTime } from "./helpers/cursor-provider-virtual-time.js";

type TextCallback =
	| { channel: "onDelta"; args: Parameters<NonNullable<SendOptions["onDelta"]>>[0] }
	| { channel: "onStep"; args: Parameters<NonNullable<SendOptions["onStep"]>>[0] };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/cursor-text-boundaries-1.0.32.json", import.meta.url), "utf8")) as {
	sdkVersion: string;
	callbacks: TextCallback[];
	result: string;
};
const messages = fixture.callbacks.flatMap((callback) =>
	callback.channel === "onStep" && callback.args.step.type === "assistantMessage" ? [callback.args.step.message.text] : [],
);

async function emitCallbacks(options: SendOptions, callbacks: TextCallback[]): Promise<void> {
	for (const callback of callbacks) {
		if (callback.channel === "onDelta") await options.onDelta?.(callback.args);
		else await options.onStep?.(callback.args);
	}
}

function installSend(callbacks: TextCallback[], result: string, status: "finished" | "cancelled" = "finished") {
	const send = vi.fn(async (_message: unknown, options: SendOptions = {}) => {
		await emitCallbacks(options, callbacks);
		return asMockCursorRun({
			id: "run-1", agentId: "bc-11111111-1111-4111-8111-111111111111", status,
			wait: vi.fn().mockResolvedValue({ id: "run-1", status, result }),
		});
	});
	mockCreatedAgent({ agentId: "bc-11111111-1111-4111-8111-111111111111", send, listArtifacts: vi.fn().mockResolvedValue([]) });
	return send;
}

const text = (value: string): TextCallback => ({ channel: "onDelta", args: { update: { type: "text-delta", text: value } } });
const complete = (value: string): TextCallback => ({ channel: "onStep", args: { step: { type: "assistantMessage", message: { text: value } } } });
const thinking = (value: string): TextCallback => ({ channel: "onDelta", args: { update: { type: "thinking-delta", text: value } } });
const thinkingCompleted: TextCallback = { channel: "onDelta", args: { update: { type: "thinking-completed", thinkingDurationMs: 1 } } };

// Keep block-pairing fields for sequence assertions; final content is checked separately.
type BlockEvent = [type: string, contentIndex: number] | [type: string, contentIndex: number, payload: string];
function blockEvents(events: readonly AssistantMessageEvent[]): BlockEvent[] {
	return events.flatMap((event): BlockEvent[] => {
		switch (event.type) {
			case "text_start":
			case "thinking_start":
				return [[event.type, event.contentIndex]];
			case "text_delta":
			case "thinking_delta":
				return [[event.type, event.contentIndex, event.delta]];
			case "text_end":
			case "thinking_end":
				return [[event.type, event.contentIndex, event.content]];
			default:
				return [];
		}
	});
}

describe("Cursor completed assistant-message boundaries", () => {
	beforeEach(resetCursorProviderTestState);
	installCursorProviderVirtualTime();
	afterEach(async () => {
		await __testUtils.releaseAllPendingCursorLiveRunsForTests();
		await __testUtils.resetSessionCursorAgents();
	});

	it("the installed SDK completes token groups into the historical capture's assistant-message shape", async () => {
		const modules = await installedCursorModules();
		const Accumulator = Object.values(modules("./src/agent/run-interaction-accumulator.ts")).find(
			(value: any) => typeof value === "function" && typeof value.prototype?.apply === "function",
		) as any;
		expect(Accumulator).toBeTypeOf("function");
		const completed: string[] = [];
		const accumulator = new Accumulator({ onStep: ({ step }: any) => {
			if (step.type === "assistantMessage") completed.push(step.message.text);
		} });
		// Keep the original .32 capture/provenance. Only exercise the installed
		// accumulator contract here; this is not a new live SDK capture.
		for (const callback of fixture.callbacks) {
			if (callback.channel === "onDelta") await accumulator.apply(callback.args.update);
			if (callback.channel === "onStep" && callback.args.step.type === "assistantMessage") {
				await accumulator.apply({ type: "tool-call-completed", toolCall: { type: "read" } });
			}
		}
		expect(completed).toEqual(messages);
		expect(accumulator.finalAssistantText()).toBe(fixture.result);
	});

	it.each(["cloud", "local", "local-live"])("preserves captured progress and exact final text in %s output", async (runtime) => {
		expect(messages.at(-1)).toBe(fixture.result);
		if (runtime === "cloud") {
			process.env.PI_CURSOR_RUNTIME = "cloud";
			process.env.PI_CURSOR_CLOUD_ACK = "1";
			process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		} else if (runtime === "local-live") {
			process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
			await registerNativeToolDisplayForTest([]);
		}
		installSend(fixture.callbacks, fixture.result);
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const done = getDoneEvent(events);
		expect(done.reason).toBe("stop");
		expect(collectTextDeltas(events)).toBe(messages.join("\n\n"));
		expect(done.message.content.filter((block) => block.type === "text").map((block) => block.text)).toEqual(
			messages.map((message, index) => index < messages.length - 1 ? `${message}\n\n` : message),
		);
		expect(getFinalAssistantText(done.message)).toBe(fixture.result);
		// The smoke uses this actual host RPC accessor, which concatenates text blocks.
		const rpcText = AgentSession.prototype.getLastAssistantText.call({ messages: [done.message] } as AgentSession);
		expect(rpcText).toBe(messages.join("\n\n"));
		expect(rpcText?.split(/\r?\n/).filter((line) => line.trim()).at(-1)).toBe("NO_MARKER");
		expect(events.filter((event) => event.type === "text_start")).toHaveLength(messages.length);
		expect(events.filter((event) => event.type === "text_end")).toHaveLength(messages.length);
	});

	it("does not separate token chunks or append whitespace after the only message", async () => {
		installSend([text("NO"), text("_MARKER"), complete("NO_MARKER")], "NO_MARKER");
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(collectTextDeltas(events)).toBe("NO_MARKER");
		expect(getFinalAssistantText(getDoneEvent(events).message)).toBe("NO_MARKER");
		expect(events.filter((event) => event.type === "text_start")).toHaveLength(1);
	});

	it.each([false, true])("separates a wait-only final result after completed progress (live=%s)", async (live) => {
		if (live) {
			process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
			await registerNativeToolDisplayForTest([]);
		}
		installSend([text("Working"), complete("Working")], "NO_MARKER");
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(collectTextDeltas(events)).toBe("Working\n\nNO_MARKER");
		expect(getFinalAssistantText(getDoneEvent(events).message)).toBe("NO_MARKER");
	});

	it.each([false, true])("retains progress/thinking separation before the final message (live=%s)", async (live) => {
		if (live) {
			process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
			await registerNativeToolDisplayForTest([]);
		}
		installSend([text("Working"), complete("Working"), thinking("Considering"), thinkingCompleted, text("NO_MARKER"), complete("NO_MARKER")], "NO_MARKER");
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(collectTextDeltas(events)).toBe("Working\n\nNO_MARKER");
		const message = getDoneEvent(events).message;
		expect(message.content.some((block) => block.type === "thinking" && block.thinking.includes("Considering"))).toBe(true);
		expect(getFinalAssistantText(message)).toBe("NO_MARKER");
	});

	it.each([
		{
			// Direct turns keep thinking and text open together; each delta grows its own block.
			live: false,
			blocks: [
				["thinking_start", 0], ["thinking_delta", 0, "Planning"],
				["text_start", 1], ["text_delta", 1, "Working"],
				["thinking_delta", 0, " still"], ["thinking_end", 0, "Planning still"],
				["text_delta", 1, "\n\n"], ["text_end", 1, "Working\n\n"],
				["text_start", 2], ["text_delta", 2, "NO_MARKER"], ["text_end", 2, "NO_MARKER"],
			],
			content: [
				{ type: "thinking", thinking: "Planning still" },
				{ type: "text", text: "Working\n\n" },
				{ type: "text", text: "NO_MARKER" },
			],
		},
		{
			// Live drain closes one channel before opening the other.
			live: true,
			blocks: [
				["thinking_start", 0], ["thinking_delta", 0, "Planning"], ["thinking_end", 0, "Planning"],
				["text_start", 1], ["text_delta", 1, "Working"], ["text_end", 1, "Working"],
				["thinking_start", 2], ["thinking_delta", 2, " still"], ["thinking_end", 2, " still"],
				["text_start", 3], ["text_delta", 3, "\n\n"], ["text_end", 3, "\n\n"],
				["text_start", 4], ["text_delta", 4, "NO_MARKER"], ["text_end", 4, "NO_MARKER"],
			],
			content: [
				{ type: "thinking", thinking: "Planning" },
				{ type: "text", text: "Working" },
				{ type: "thinking", thinking: " still" },
				{ type: "text", text: "\n\n" },
				{ type: "text", text: "NO_MARKER" },
			],
		},
	])("pairs interleaved thinking and text block events by content index (live=$live)", async ({ live, blocks, content }) => {
		if (live) {
			process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
			await registerNativeToolDisplayForTest([]);
		}
		installSend([thinking("Planning"), text("Working"), thinking(" still"), thinkingCompleted, complete("Working"), text("NO_MARKER"), complete("NO_MARKER")], "NO_MARKER");
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(blockEvents(events)).toEqual(blocks);
		const done = getDoneEvent(events);
		expect(done.message.content).toEqual(content);
		expect(getFinalAssistantText(done.message)).toBe("NO_MARKER");
	});

	it("truncates the direct activity trace once at its budget and keeps text", async () => {
		const trace = "x".repeat(49_995);
		const marker = "\n[Cursor activity trace truncated]\n";
		installSend([thinking(trace), thinking("abcdefghij"), thinking("ignored"), thinkingCompleted, thinking("ignored again"), text("answer"), complete("answer")], "answer");
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(blockEvents(events)).toEqual([
			["thinking_start", 0], ["thinking_delta", 0, trace], ["thinking_delta", 0, `abcde${marker}`],
			["thinking_end", 0, `${trace}abcde${marker}`],
			["text_start", 1], ["text_delta", 1, "answer"], ["text_end", 1, "answer"],
		]);
	});

	it("ignores empty deltas and repeated completion callbacks without adding extra boundaries", async () => {
		installSend([complete(""), text("Working"), complete("Working"), complete("Working"), text(""), text("NO"), text("_MARKER"), complete("NO_MARKER")], "NO_MARKER");
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(collectTextDeltas(events)).toBe("Working\n\nNO_MARKER");
		expect(getFinalAssistantText(getDoneEvent(events).message)).toBe("NO_MARKER");
	});

	it("preserves a message boundary across native tool-use and pending-run drain", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const tools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(tools);
		let options: SendOptions = {};
		let finish!: (value: { id: string; status: "finished"; result: string }) => void;
		const completion = new Promise<{ id: string; status: "finished"; result: string }>((resolve) => { finish = resolve; });
		const send = vi.fn(async (_message: unknown, sendOptions: SendOptions = {}) => {
			options = sendOptions;
			await emitCallbacks(options, [text("Working"), complete("Working")]);
			await options.onDelta?.({ update: { type: "tool-call-started", callId: "c1", modelCallId: "model-call-1", toolCall: { type: "read", args: { path: "fixture.txt" } } } });
			await options.onDelta?.({ update: { type: "tool-call-completed", callId: "c1", modelCallId: "model-call-1", toolCall: { type: "read", args: { path: "fixture.txt" }, result: { status: "success", value: { content: "RECORDED", fileSize: 8, totalLines: 1 } } } } });
			return asMockCursorRun({ id: "run-1", agentId: "agent-1", status: "running", wait: vi.fn(() => completion), cancel: vi.fn().mockResolvedValue(undefined) });
		});
		mockCreatedAgent({ send });
		const context = makeContext();
		const firstEvents = await collectEvents(streamCursor(makeModel(), context, { apiKey: "test-key" }));
		const first = getDoneEvent(firstEvents).message;
		expect(first.stopReason).toBe("toolUse");
		expect(collectTextDeltas(firstEvents)).toBe("Working");
		const call = first.content.find((block) => block.type === "toolCall");
		expect(call).toBeDefined();
		const result = await tools.find((tool) => tool.name === "read")!.execute(call!.id, call!.arguments, undefined, undefined, createExtensionTestContext());
		await emitCallbacks(options, [text("NO"), text("_MARKER"), complete("NO_MARKER")]);
		finish({ id: "run-1", status: "finished", result: "NO_MARKER" });
		const events = await collectEvents(streamCursor(makeModel(), { ...context, messages: [...context.messages, first, {
			role: "toolResult", toolCallId: call!.id, toolName: "read", content: result.content, details: result.details, isError: false, timestamp: 2,
		}] }, { apiKey: "test-key" }));
		expect(collectTextDeltas(events)).toBe("NO_MARKER");
		expect(getFinalAssistantText(getDoneEvent(events).message)).toBe("NO_MARKER");
		expect(send).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])("keeps completed progress and the SDK abort reason on cancellation without a dangling separator (live=%s)", async (live) => {
		if (live) {
			process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
			await registerNativeToolDisplayForTest([]);
		}
		installSend([text("Working"), complete("Working")], "NO_MARKER", "cancelled");
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(getErrorEvent(events).reason).toBe("aborted");
		expect(getErrorEvent(events).error.errorMessage).toBe("Cancelled: Cursor SDK run was cancelled.");
		expect(collectTextDeltas(events)).toBe("Working");
		expect(getFinalAssistantText(getErrorEvent(events).error)).toBe("Working");
	});
});
