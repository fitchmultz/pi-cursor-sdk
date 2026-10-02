import { readFileSync } from "node:fs";
import type { SendOptions } from "@cursor/sdk";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamCursor, __testUtils } from "../src/cursor-provider.js";
import { getFinalAssistantText } from "../src/cursor-run-final-text.js";
import {
	asMockCursorRun, collectEvents, collectTextDeltas, getDoneEvent, getErrorEvent,
	makeContext, makeModel, mockCreatedAgent, registerNativeToolDisplayForTest,
	resetCursorProviderTestState, createExtensionTestContext, type RegisteredTool,
} from "./helpers/cursor-provider-harness.js";
import { readInstalledPackageVersion } from "./helpers/installed-package.js";

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

describe("Cursor completed assistant-message boundaries", () => {
	beforeEach(resetCursorProviderTestState);
	afterEach(async () => {
		await __testUtils.releaseAllPendingCursorLiveRunsForTests();
		await __testUtils.resetSessionCursorAgents();
	});

	it("the captured onStep messages complete whole groups of token deltas", () => {
		let pending = "";
		for (const callback of fixture.callbacks) {
			if (callback.channel === "onDelta" && callback.args.update.type === "text-delta") pending += callback.args.update.text;
			if (callback.channel === "onStep" && callback.args.step.type === "assistantMessage") {
				expect(callback.args.step.message.text).toBe(pending);
				pending = "";
			}
		}
		expect(pending).toBe("");
	});

	it.each(["cloud", "local", "local-live"])("preserves captured progress and exact final text in %s output", async (runtime) => {
		expect(readInstalledPackageVersion("@cursor/sdk")).toBe(fixture.sdkVersion);
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
		installSend([text("Working"), complete("Working"),
			{ channel: "onDelta", args: { update: { type: "thinking-delta", text: "Considering" } } },
			{ channel: "onDelta", args: { update: { type: "thinking-completed", thinkingDurationMs: 1 } } },
			text("NO_MARKER"), complete("NO_MARKER"),
		], "NO_MARKER");
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(collectTextDeltas(events)).toBe("Working\n\nNO_MARKER");
		const message = getDoneEvent(events).message;
		expect(message.content.some((block) => block.type === "thinking" && block.thinking.includes("Considering"))).toBe(true);
		expect(getFinalAssistantText(message)).toBe("NO_MARKER");
	});

	it("ignores empty deltas and repeated completion callbacks without adding extra boundaries", async () => {
		installSend([complete(""), text("Working"), complete("Working"), complete("Working"), text(""), text("NO"), text("_MARKER"), complete("NO_MARKER")], "NO_MARKER");
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(collectTextDeltas(events)).toBe("Working\n\nNO_MARKER");
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

	it("does not duplicate an exact final suffix after unpunctuated progress", async () => {
		installSend([text("Working"), complete("Working"), text("NO_MARKER"), complete("NO_MARKER")], "NO_MARKER");
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(collectTextDeltas(events)).toBe("Working\n\nNO_MARKER");
		expect(getFinalAssistantText(getDoneEvent(events).message)).toBe("NO_MARKER");
	});

	it.each([false, true])("keeps completed progress on cancellation without a dangling separator (live=%s)", async (live) => {
		if (live) {
			process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
			await registerNativeToolDisplayForTest([]);
		}
		installSend([text("Working"), complete("Working")], "NO_MARKER", "cancelled");
		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(getErrorEvent(events).reason).toBe("aborted");
		expect(collectTextDeltas(events)).toBe("Working");
		expect(getFinalAssistantText(getErrorEvent(events).error)).toBe("Working");
	});
});
