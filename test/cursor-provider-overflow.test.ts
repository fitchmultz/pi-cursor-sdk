import { describe, expect, it } from "vitest";
import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionHandler, MessageEndEvent, MessageEndEventResult } from "@earendil-works/pi-coding-agent";
import { registerCursorOverflowNormalization } from "../src/cursor-provider-overflow.js";
import { createExtensionTestContext, makeAssistantMessage, makeModel } from "./helpers/pi-harness.js";

function assistantError(errorMessage?: string): AssistantMessage {
	return { ...makeAssistantMessage(""), provider: "cursor", stopReason: "error", errorMessage };
}

function boundary() {
	let handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult> | undefined;
	registerCursorOverflowNormalization({
		on: (event: string, callback: unknown) => {
			if (event === "message_end") handler = callback as typeof handler;
			return () => {};
		},
	});
	expect(handler).toBeDefined();
	return (message: MessageEndEvent["message"], model = makeModel()) =>
		handler!({ type: "message_end", message }, createExtensionTestContext({ model }));
}

describe("registered Cursor overflow recovery", () => {
	it("rewrites Cursor overflow errors for Pi recovery and is idempotent", async () => {
		const deliver = boundary();
		for (const detail of [
			"Your input exceeds the context window of this model",
			"prompt is too long: 300000 tokens > 200000 maximum",
			"Input length exceeds the maximum context length",
			"prompt is too long for the model context window",
		]) {
			const original = assistantError(detail);
			const replacement = (await deliver(original))?.message as AssistantMessage;
			expect(replacement).toEqual({ ...original, errorMessage: `context_length_exceeded: ${detail}` });
			expect(original.errorMessage).toBe(detail);
			expect(isContextOverflow(replacement)).toBe(true);
			expect(await deliver(replacement)).toBeUndefined();
		}
	});

	it("leaves throttling, auth, network and empty errors unchanged", async () => {
		const deliver = boundary();
		for (const detail of [
			"Too many requests, retry after 30s", "rate limited by upstream", "throttlingException: slow down",
			"Too many requests, retry after 10s", "rate limited: context window exceeded",
			"Cursor SDK request failed because the API key may be invalid", "Network error: Cursor SDK request failed",
			"Cursor SDK run failed.", undefined, "   ", "context_length_exceeded: prompt is too long",
		]) expect(await deliver(assistantError(detail))).toBeUndefined();
	});

	it("scopes replacement to Cursor assistant errors, including the current-model fallback", async () => {
		const deliver = boundary();
		const message = assistantError("exceeds the context window");
		const otherModel = { ...makeModel(), provider: "anthropic" };
		expect(await deliver({ ...message, provider: "anthropic" }, otherModel)).toBeUndefined();
		expect(await deliver({ ...message, stopReason: "stop" })).toBeUndefined();
		expect(await deliver({ role: "user", content: "exceeds the context window", timestamp: 1 })).toBeUndefined();
		expect((await deliver({ ...message, provider: "anthropic" }))?.message).toMatchObject({
			errorMessage: "context_length_exceeded: exceeds the context window",
		});
	});
});
