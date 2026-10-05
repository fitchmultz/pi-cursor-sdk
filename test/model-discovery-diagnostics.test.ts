import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverModels, type CursorModelFallbackIssue } from "../src/model-discovery.js";

vi.mock("@cursor/sdk", () => ({ Cursor: { models: { list: vi.fn() } } }));
import { Cursor } from "@cursor/sdk";
const mockedList = vi.mocked(Cursor.models.list);

describe("model discovery fallback diagnostics", () => {
	let tmpAgentDir: string;
	beforeEach(() => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-discovery-diagnostics-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", tmpAgentDir);
		vi.stubEnv("CURSOR_API_KEY", "test-key-123");
		mockedList.mockReset();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tmpAgentDir, { recursive: true, force: true });
	});

	it("falls back and reports discovery failure when Cursor.models.list throws", async () => {
		const issues: CursorModelFallbackIssue[] = [];
		mockedList.mockRejectedValueOnce(new Error("network error"));
		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY, onFallback: (issue) => issues.push(issue) });
		expect(models.some((model) => model.id === "composer-2.5")).toBe(true);
		expect(issues).toEqual([
			expect.objectContaining({
				reason: "discovery-failed",
				message: expect.stringContaining("Cursor model discovery failed"),
			}),
		]);
		expect(issues[0].message).toContain("network error");
		expect(issues[0].errorMessage).toBe("network error");
		expect(issues[0].message).not.toContain("/login");
		expect(issues[0].message).not.toContain("test-key-123");
	});

	it("preserves structured loader errors in startup fallback diagnostics", async () => {
		const issues: CursorModelFallbackIssue[] = [];
		mockedList.mockRejectedValueOnce({ name: "ResolveMessage", code: "ERR_MODULE_NOT_FOUND", message: "Cannot find module '@cursor/sdk' Bearer test-key-123" });
		await discoverModels({ apiKey: process.env.CURSOR_API_KEY, onFallback: (issue) => issues.push(issue) });
		expect(issues[0].errorMessage).toContain("ERR_MODULE_NOT_FOUND");
		expect(issues[0].message).toContain("Cannot find module '@cursor/sdk'");
		expect(issues[0].message).not.toMatch(/test-key-123|API key|\/login/);
	});

	it("redacts sensitive values from fallback failure details", async () => {
		const issues: CursorModelFallbackIssue[] = [];
		mockedList.mockRejectedValueOnce(
			new Error(
				'Unauthorized Bearer test-key-123 {"apiKey":"test-key-123","token":"token-value","session_id":"session-value"} https://repo-user:repo-p@ss@example.com/org/repo.git cookie: foo=bar; baz=qux',
			),
		);

		await discoverModels({ apiKey: process.env.CURSOR_API_KEY, onFallback: (issue) => issues.push(issue) });

		expect(issues[0].reason).toBe("discovery-failed");
		expect(issues[0].message).toContain("Bearer [redacted]");
		expect(issues[0].message).toContain('"apiKey":"[redacted]"');
		expect(issues[0].message).toContain('"token":"[redacted]"');
		expect(issues[0].message).toContain('"session_id":"[redacted]"');
		expect(issues[0].message).toContain("cookie: [redacted]");
		expect(issues[0].errorMessage).toContain("Bearer [redacted]");
		expect(issues[0].message).not.toContain("test-key-123");
		expect(issues[0].message).not.toContain("token-value");
		expect(issues[0].message).not.toContain("session-value");
		expect(issues[0].message).not.toContain("repo-user");
		expect(issues[0].message).not.toContain("repo-p");
		expect(issues[0].message).not.toContain("@ss@");
		expect(issues[0].message).not.toContain("foo=bar");
		expect(issues[0].message).not.toContain("baz=qux");
	});

	it("falls back and reports empty model list when Cursor.models.list returns empty", async () => {
		const issues: CursorModelFallbackIssue[] = [];
		mockedList.mockResolvedValueOnce([]);
		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY, onFallback: (issue) => issues.push(issue) });
		expect(models.some((model) => model.id === "claude-opus-4-8@1m")).toBe(true);
		expect(issues).toEqual([
			expect.objectContaining({
				reason: "empty-model-list",
				message: expect.stringContaining("Cursor model discovery returned no models"),
			}),
		]);
		expect(issues[0].message).toContain("/login");
		expect(issues[0].message).toContain("/cursor-refresh-models");
	});
});
