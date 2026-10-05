import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUsage } from "@cursor/sdk";
import { loadCursorSdk } from "../src/cursor-sdk-runtime.js";
import { readInstalledPackageDistText } from "./helpers/installed-package.js";

afterEach(() => vi.unstubAllGlobals());
describe("installed Cursor SDK getUsage contract", () => {
	it.each([
		{ label: "per-UUID rows", runs: [{ id: "billing-uuid" }] },
		{ label: "aggregate-only empty rows", runs: [] },
	])("public getter preserves disjoint whole-agent token/cost snapshots with $label", async ({ runs }) => {
		// Recorded LOCAL cache counts (SDK1.0.32, 2026-10-04); public endpoint contract:
		// https://cursor.com/docs/cloud-agent/api/endpoints#usage (four disjoint categories).
		const usage = { inputTokens: 136, outputTokens: 3, cacheReadTokens: 4096, cacheWriteTokens: 0, totalTokens: 4235 };
		const cost = { rawCostCents: 0.1, chargedCents: 0.2 };
		const transport = vi.fn(async (request: string | URL | Request) => {
			const url = request instanceof Request ? request.url : String(request);
			return new Response(JSON.stringify(url.endsWith("/usage") ? { totalUsage: usage, cost, runs: runs.map(row => ({ ...row, usage, cost })) } : {}), { status: 200, headers: { "content-type": "application/json" } });
		});
		vi.stubGlobal("fetch", transport);
		const { Agent } = await loadCursorSdk();
		const result: AgentUsage = await Agent.getUsage("agent-local-contract", { apiKey: "test-credential-not-real" });
		expect(result).toEqual({ usage, cost, runs: runs.map(row => ({ runId: row.id, usage, cost })) });
		expect(transport.mock.calls.filter(([request]) => String(request instanceof Request ? request.url : request).endsWith("/usage"))).toHaveLength(1);
	});
	it("rejects LOCAL client-minted run labels before auth/network instead of joining them to billing UUIDs", async () => {
		const { Agent } = await loadCursorSdk();
		await expect(Agent.getUsage("agent-local-contract", { runId: "run-client-label" })).rejects.toThrow("backend never receives it");
	});
	it("attaches a no-op error listener before local shell snapshot writes", () => {
		expect(readInstalledPackageDistText("@cursor/sdk")).toMatch(
			/function (\w+)\(e\)\{e\?\.on\("error",\(\(\)=>\{\}\)\)\}function \w+\(e,t\)\{e&&\(\1\(e\),e\.write\(t\),e\.end\(\)\)\}/,
		);
	});
});
