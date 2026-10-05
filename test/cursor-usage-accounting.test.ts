import { describe, expect, it } from "vitest";
import { InteractionUpdateSchema, TurnEndedUpdateSchema } from "@cursor/sdk";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import { applyCursorApproximateUsage, applyCursorUsage, estimateCursorAssistantSessionOutputTokens, isCursorSdkUsageSafeForPiMessage, readCursorSdkTurnUsage, readCursorSdkTurnUsageFromUpdate } from "../src/cursor-usage-accounting.js";
import { makeContext, makeModel } from "./helpers/pi-harness.js";

function assistant(content: AssistantMessage["content"] = [{ type: "text", text: "Hello back." }]): AssistantMessage {
	return { role: "assistant", content, api: "cursor-sdk", provider: "cursor", model: "test-model", stopReason: "stop", timestamp: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function expectCoherent(message: AssistantMessage) {
	const { input, output, cacheRead, cacheWrite, totalTokens } = message.usage;
	expect(input + output + cacheRead + cacheWrite).toBe(totalTokens);
	expect(calculateContextTokens(message.usage)).toBe(totalTokens);
}

describe("native Cursor occupancy", () => {
	it("partitions the captured cached LOCAL turn exactly once", () => {
		// Captured glm-5p3-flash LOCAL turn 2: full prompt 4232 includes cacheRead4096.
		const message = assistant();
		applyCursorUsage(message, makeModel(), makeContext(), 7, { runtime: "local", occupancyFloor: 100000,
			turn: { inputTokens: 4232, outputTokens: 3, cacheReadTokens: 4096, cacheWriteTokens: 0 } });
		expect(message.usage).toMatchObject({ input: 136, output: 3, cacheRead: 4096, cacheWrite: 0, totalTokens: 4235 });
		expectCoherent(message);
	});

	it("maps both cache categories to disjoint native components", () => {
		const message = assistant();
		applyCursorUsage(message, makeModel(), makeContext(), 7, { runtime: "local",
			turn: { inputTokens: 46965, outputTokens: 3, cacheReadTokens: 42036, cacheWriteTokens: 4927 } });
		expect(message.usage).toMatchObject({ input: 2, output: 3, cacheRead: 42036, cacheWrite: 4927, totalTokens: 46968 });
		expectCoherent(message);
	});

	it.each([
		{ inputTokens: 100, outputTokens: 1, cacheReadTokens: 80, cacheWriteTokens: 30 },
		{ inputTokens: -1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
		{ inputTokens: NaN, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
		{ inputTokens: 100, outputTokens: Infinity, cacheReadTokens: 0, cacheWriteTokens: 0 },
		{ inputTokens: 1125429, outputTokens: 7049, cacheReadTokens: 1015493, cacheWriteTokens: 0 },
	])("rejects unsafe raw LOCAL counts and emits a coherent estimate: %j", (turn) => {
		const model = makeModel();
		expect(isCursorSdkUsageSafeForPiMessage(turn, model)).toBe(false);
		const message = assistant();
		applyCursorUsage(message, model, makeContext(), 7, { runtime: "local", turn });
		expect(message.usage.cacheRead).toBe(0);
		expect(message.usage.totalTokens).toBeLessThan(model.contextWindow);
		expectCoherent(message);
	});

	it("keeps response and window limits separate from partition validation", () => {
		const model = makeModel();
		expect(isCursorSdkUsageSafeForPiMessage({ inputTokens: 100, outputTokens: model.maxTokens + 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model)).toBe(false);
		expect(isCursorSdkUsageSafeForPiMessage({ inputTokens: model.contextWindow - 10, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0 }, model)).toBe(false);
	});

	it("reads the installed SDK's public turn-ended schema, not a cumulative usage event", () => {
		const update = { type: "turn-ended", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 } };
		expect(TurnEndedUpdateSchema.safeParse(update).success).toBe(true);
		expect(InteractionUpdateSchema.safeParse(update).success).toBe(true);
		expect(readCursorSdkTurnUsageFromUpdate(update)).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
		expect(readCursorSdkTurnUsageFromUpdate({ ...update, type: "usage" })).toBeUndefined();
		expect(InteractionUpdateSchema.safeParse({ ...update, type: "usage" }).success).toBe(false);
		expect(readCursorSdkTurnUsage({ ...update.usage, outputTokens: Infinity })).toBeUndefined();
		expect(readCursorSdkTurnUsage({ ...update.usage, inputTokens: -1 })).toBeUndefined();
	});

	it("estimates thinking and tool-call output as well as text", () => {
		const text = assistant([{ type: "text", text: "Done." }]);
		const rich = assistant([{ type: "thinking", thinking: "Inspecting the repository." }, { type: "text", text: "Done." }, { type: "toolCall", name: "read", id: "call-1", arguments: { path: "README.md" } }]);
		expect(estimateCursorAssistantSessionOutputTokens(text)).toBeGreaterThan(0);
		expect(estimateCursorAssistantSessionOutputTokens(rich)).toBeGreaterThan(estimateCursorAssistantSessionOutputTokens(text));
	});

	it.each([undefined, 100000])("uses only a supplied trusted floor and never borrows context usage: %s", (occupancyFloor) => {
		const prior = assistant(); prior.usage.totalTokens = 110000;
		const context = makeContext(); context.messages.push(prior);
		const message = assistant();
		applyCursorApproximateUsage(message, makeModel(), context, 7, occupancyFloor);
		if (occupancyFloor) expect(message.usage.totalTokens).toBe(occupancyFloor);
		else expect(message.usage.totalTokens).toBeLessThan(1000);
		expect(message.usage.cacheRead).toBe(0);
		expectCoherent(message);
	});

	it.each([NaN, Infinity, -1, 1000000])("rejects an invalid supplied floor: %s", (occupancyFloor) => {
		const message = assistant(); applyCursorApproximateUsage(message, makeModel(), makeContext(), 7, occupancyFloor);
		expect(message.usage.totalTokens).toBeLessThan(1000); expectCoherent(message);
	});

	it("does not treat Cloud turn usage as a captured LOCAL occupancy contract", () => {
		const message = assistant();
		applyCursorUsage(message, makeModel(), makeContext(), 7, { runtime: "cloud", occupancyFloor: 1234,
			turn: { inputTokens: 10000, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 1000 } });
		expect(message.usage.totalTokens).toBe(1234); expect(message.usage.cacheRead).toBe(0); expectCoherent(message);
	});

	it("prices native components using configured model estimates", () => {
		const model = { ...makeModel(), cost: { input: 0.75, output: 3.5, cacheRead: 0.075, cacheWrite: 0.375 } };
		const message = assistant();
		applyCursorUsage(message, model, makeContext(), 7, { runtime: "local", turn: { inputTokens: 6500, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 500 } });
		expect(message.usage.cost.total).toBeCloseTo(0.0020125, 10); expectCoherent(message);
		applyCursorUsage(message, model, makeContext(), 1000);
		expect(message.usage.cost.input).toBeCloseTo(0.00075, 10);
		expect(message.usage.cost.cacheRead).toBe(0); expectCoherent(message);
	});

	it.each([{ threshold: 10000, cost: 0.0101 }, { threshold: 9999, cost: 0.0071 }])("preserves native cost-tier threshold $threshold", ({ threshold, cost }) => {
		const model = { ...makeModel(), cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, tiers: [{ inputTokensAbove: threshold, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }] } };
		const message = assistant();
		applyCursorUsage(message, model, makeContext(), 7, { runtime: "local", turn: { inputTokens: 10000, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 1000 } });
		expect(message.usage.cost.total).toBeCloseTo(cost, 10);
	});

	it("keeps default zero-cost models honest", () => {
		const message = assistant(); applyCursorUsage(message, makeModel(), makeContext(), 1000);
		expect(message.usage.cost.total).toBe(0); expectCoherent(message);
	});
});
