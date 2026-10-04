import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUsage, SDKAgent, TokenUsage } from "@cursor/sdk";
import { fetchCursorSdkAgentUsage, readCursorBilledSnapshot } from "../src/cursor-sdk-billed-usage.js";
const cached: TokenUsage = { inputTokens: 136, outputTokens: 3, cacheReadTokens: 4096, cacheWriteTokens: 0, totalTokens: 4235 };
afterEach(() => vi.useRealTimers());
describe("public SDK billed observations", () => {
	it("preserves documented disjoint cache, aggregate-only totals, large outputs and optional revised cost", async () => {
		const snapshot: AgentUsage = { usage: { ...cached, outputTokens: 500003, totalTokens: 504235 }, runs: [{ runId: "billing-uuid", usage: cached, cost: { rawCostCents: 0.1, chargedCents: 0.2 } }] };
		expect(readCursorBilledSnapshot(snapshot)).toEqual(snapshot);
		expect(await fetchCursorSdkAgentUsage({ getUsage: async () => snapshot })).toEqual({ status: "observed-pending-settlement", snapshot });
		for (const usage of [{ ...cached, inputTokens: -1 }, { ...cached, outputTokens: Infinity }, { ...cached, totalTokens: 8331 }]) expect(readCursorBilledSnapshot({ usage, runs: [] })).toBeUndefined();
	});
	it("keeps unsupported, failed, invalid and timed-out requests distinct from a recognized bill", async () => {
		expect(await fetchCursorSdkAgentUsage({} as SDKAgent)).toEqual({ status: "unavailable", reason: "unsupported" });
		expect(await fetchCursorSdkAgentUsage({ getUsage: async () => { throw new Error("secret must not escape"); } })).toEqual({ status: "unavailable", reason: "request-failed" });
		expect(await fetchCursorSdkAgentUsage({ getUsage: async () => ({}) as AgentUsage })).toEqual({ status: "unavailable", reason: "invalid-response" });
		vi.useFakeTimers(); const result = fetchCursorSdkAgentUsage({ getUsage: () => new Promise(() => {}) }); await vi.advanceTimersByTimeAsync(5000);
		expect(await result).toEqual({ status: "unavailable", reason: "timeout" });
	});
});
