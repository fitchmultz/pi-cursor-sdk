import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Run, RunResult, SDKAgent, TokenUsage } from "@cursor/sdk";
import { collectCursorCloudRunReport, fetchCursorCloudRawUsage, formatCursorCloudRunReport } from "../src/cursor-cloud-reporting.js";

const usageContractFixture = JSON.parse(readFileSync(
	new URL("./fixtures/cursor-cloud-agent-usage-doc-2026-07-09.json", import.meta.url),
	"utf8",
)) as {
	source: { url: string; verified: string };
	request: { method: string; path: string; optionalRunId: string };
	response: { totalUsage: TokenUsage; runs: Array<{ id: string; usage: TokenUsage }> };
};

describe("cursor cloud reporting", () => {
	it("matches the captured official raw usage route and response contract", async () => {
		const previousBackendUrl = process.env.CURSOR_BACKEND_URL;
		process.env.CURSOR_BACKEND_URL = "https://evil.example";
		const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(usageContractFixture.response), { status: 200 }));
		try {
			const agentId = usageContractFixture.request.path.split("/")[3];
			const report = await fetchCursorCloudRawUsage({
				agentId,
				runId: usageContractFixture.request.optionalRunId,
				apiKey: "secret-key",
				fetchImpl,
			});

			expect(usageContractFixture.source).toEqual({
				url: "https://cursor.com/docs/cloud-agent/api/endpoints",
				verified: "2026-07-09",
			});
			expect(usageContractFixture.request.method).toBe("GET");
			expect(fetchImpl.mock.calls[0]?.[0].toString()).toBe(
				`https://api.cursor.com${usageContractFixture.request.path}?runId=${usageContractFixture.request.optionalRunId}`,
			);
			expect(report).toEqual({
				totalUsage: usageContractFixture.response.totalUsage,
				runUsage: usageContractFixture.response.runs[0]?.usage,
			});
		} finally {
			if (previousBackendUrl === undefined) delete process.env.CURSOR_BACKEND_URL;
			else process.env.CURSOR_BACKEND_URL = previousBackendUrl;
		}
	});

	it("omits the optional runId query while still parsing total usage", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(usageContractFixture.response), { status: 200 }));
		const agentId = usageContractFixture.request.path.split("/")[3];

		const report = await fetchCursorCloudRawUsage({ agentId, apiKey: "secret-key", fetchImpl });

		expect(fetchImpl.mock.calls[0]?.[0].toString()).toBe(`https://api.cursor.com${usageContractFixture.request.path}`);
		expect(report).toEqual({ totalUsage: usageContractFixture.response.totalUsage });
	});

	it("aborts the raw usage fetch when the timeout fires", async () => {
		let signal: AbortSignal | undefined;
		const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
			signal = init?.signal ?? undefined;
			return new Promise<Response>(() => {});
		}) as typeof fetch;

		const report = await fetchCursorCloudRawUsage({
			agentId: "bc-agent",
			runId: "run-1",
			apiKey: "secret-key",
			fetchImpl,
			timeoutMs: 1,
		});

		expect(report).toBeUndefined();
		expect(signal?.aborted).toBe(true);
	});

	it("aborts raw usage response body parsing when the timeout fires", async () => {
		let signal: AbortSignal | undefined;
		const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
			signal = init?.signal ?? undefined;
			return Promise.resolve({
				ok: true,
				json: () => new Promise(() => {}),
			} as Response);
		}) as typeof fetch;

		const report = await fetchCursorCloudRawUsage({
			agentId: "bc-agent",
			runId: "run-1",
			apiKey: "secret-key",
			fetchImpl,
			timeoutMs: 1,
		});

		expect(report).toBeUndefined();
		expect(signal?.aborted).toBe(true);
	});

	it("omits malformed optional branches, artifacts, and usage", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			totalUsage: { inputTokens: -1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 8 },
			runs: [{ id: "run-1", usage: { inputTokens: 1, outputTokens: Number.POSITIVE_INFINITY, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 8 } }],
		}), { status: 200 }));
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchImpl;
		try {
			const report = await collectCursorCloudRunReport({
				agent: {
					listArtifacts: vi.fn().mockResolvedValue([
						{ path: "valid.txt", sizeBytes: 1, updatedAt: "now" },
						{ path: "missing-size.txt", updatedAt: "now" },
						{ path: "negative.txt", sizeBytes: -1, updatedAt: "now" },
						{ path: "infinite.txt", sizeBytes: Number.POSITIVE_INFINITY, updatedAt: "now" },
						{ path: 7, sizeBytes: 1, updatedAt: "now" },
					]),
				} as unknown as SDKAgent,
				run: { id: "run-1", agentId: "bc-agent" } as Run,
				waitResult: {
					id: "run-1",
					status: "finished",
					git: { branches: [null, { repoUrl: 7, branch: "bad" }, { repoUrl: "repo", branch: 9 }, { repoUrl: "repo", branch: "valid" }] },
				} as unknown as RunResult,
				apiKey: "key",
			});

			expect(report.branches).toEqual([{ repoUrl: "repo", branch: "valid" }]);
			expect(report.artifacts).toEqual([{ path: "valid.txt", sizeBytes: 1, updatedAt: "now" }]);
			expect(report.usage).toBeUndefined();
			expect(formatCursorCloudRunReport({
				agentId: "bc-agent",
				runId: "run-1",
				branches: [],
				usage: {
					runUsage: {
						inputTokens: 1,
						outputTokens: Number.POSITIVE_INFINITY,
						cacheReadTokens: 3,
						cacheWriteTokens: 4,
						totalTokens: 8,
					},
				},
			})).not.toContain("raw usage");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("prefers mapped Agent.getUsage over the REST usage fallback", async () => {
		const fetchImpl = vi.fn();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchImpl;
		try {
			const report = await collectCursorCloudRunReport({
				agent: {
					listArtifacts: vi.fn().mockResolvedValue([]),
					getUsage: vi.fn().mockResolvedValue({
						usage: { inputTokens: 9, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 12 },
						runs: [{
							runId: "run-1",
							usage: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 11 },
						}],
					}),
				} as unknown as SDKAgent,
				run: { id: "run-1", agentId: "bc-agent" } as Run,
				waitResult: { id: "run-1", status: "finished" } as RunResult,
				apiKey: "key",
			});
			expect(report.usage).toEqual({
				totalUsage: { inputTokens: 9, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 12 },
				runUsage: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 11 },
			});
			expect(fetchImpl).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("uses a prefetched AgentUsage without calling getUsage again", async () => {
		const getUsage = vi.fn();
		const report = await collectCursorCloudRunReport({
			agent: {
				listArtifacts: vi.fn().mockResolvedValue([]),
				getUsage,
			} as unknown as SDKAgent,
			run: { id: "run-1", agentId: "bc-agent" } as Run,
			waitResult: { id: "run-1", status: "finished" } as RunResult,
			apiKey: "key",
			agentUsage: {
				usage: { inputTokens: 4, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5 },
				runs: [],
			},
		});
		expect(getUsage).not.toHaveBeenCalled();
		expect(report.usage).toEqual({
			totalUsage: { inputTokens: 4, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5 },
		});
	});

	it("bounds, sanitizes, and scrubs all remote display strings", () => {
		const hostile = `prefix\u0085\u2028'secret-key-${"x".repeat(500)}`;
		const report = formatCursorCloudRunReport({
			agentId: `bc-${hostile}`,
			runId: hostile,
			branches: [{ repoUrl: hostile, branch: hostile, prUrl: hostile }],
			artifacts: [{ path: hostile, sizeBytes: 1, updatedAt: hostile }],
		}, { apiKey: "secret-key" });

		expect(report).not.toContain("secret-key");
		expect(report.split("\n").every((line) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(line))).toBe(true);
		expect(report).toContain("[redacted]");
		expect(report).toContain("prefix '[redacted]");
		for (const line of report.trimEnd().split("\n")) expect(line.length).toBeLessThan(600);
	});

	it("scrubs API keys from formatted cloud report text", () => {
		const report = formatCursorCloudRunReport({
			agentId: "bc-agent",
			runId: "run-1",
			branches: [{ repoUrl: "github.com/acme/secret-key", branch: "cursor/work", prUrl: "https://github.com/acme/repo/pull/1?token=secret-key" }],
			artifacts: [{ path: "artifacts/secret-key.txt", sizeBytes: 1, updatedAt: "2026-07-07T00:00:00Z" }],
		}, { apiKey: "secret-key" });

		expect(report).not.toContain("secret-key");
		expect(report).toContain("[redacted]");
	});
});
