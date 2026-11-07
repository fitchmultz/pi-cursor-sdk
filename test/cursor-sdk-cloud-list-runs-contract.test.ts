import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCursorSdk } from "../src/cursor-sdk-runtime.js";

afterEach(() => vi.unstubAllGlobals());

describe("installed Cursor SDK cloud listRuns contract", () => {
	it("returns callable Run objects with exact IDs and pagination for cancel-lane recovery", async () => {
		const agentId = "bc-00000000-0000-0000-0000-000000000001";
		const runId = "run-00000000-0000-0000-0000-000000000001";
		// Wire fields and routes verified against SDK 1.0.37 cloud-agent/cloud-api-client.
		const requests: Array<{ method: string; path: string; query: Record<string, string> }> = [];
		vi.stubGlobal("fetch", async (request: string | URL | Request, init?: RequestInit) => {
			const url = new URL(request instanceof Request ? request.url : String(request));
			if (url.pathname === "/auth/exchange_user_api_key") return new Response("", { status: 401 });
			requests.push({ method: init?.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams) });
			if (url.pathname === `/v1/agents/${agentId}/runs`) {
				return Response.json({
					items: [{ id: runId, agentId, status: "RUNNING", createdAt: "2026-07-07T00:00:00Z" }],
					nextCursor: "next-page",
				});
			}
			if (url.pathname === `/v1/agents/${agentId}/runs/${runId}/cancel`) return new Response("", { status: 200 });
			throw new Error(`Unexpected offline SDK request: ${url.pathname}`);
		});

		const { Agent } = await loadCursorSdk();
		const result = await Agent.listRuns(agentId, {
			runtime: "cloud", apiKey: "test-credential-not-real-list-runs", limit: 2, cursor: "current-page",
		});
		expect(result.nextCursor).toBe("next-page");
		expect(result.items).toHaveLength(1);
		const run = result.items[0]!;
		expect(run).toMatchObject({ id: runId, agentId, status: "running" });
		await run.cancel();
		expect(run.status).toBe("cancelled");
		expect(requests).toEqual([
			{ method: "GET", path: `/v1/agents/${agentId}/runs`, query: { limit: "2", cursor: "current-page" } },
			{ method: "POST", path: `/v1/agents/${agentId}/runs/${runId}/cancel`, query: {} },
		]);
	});
});
