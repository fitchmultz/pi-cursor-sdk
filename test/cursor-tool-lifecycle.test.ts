import { describe, expect, it } from "vitest";
import {
	formatCursorToolLifecycleProgressText,
	isCursorToolLifecycleEligible,
} from "../src/cursor-tool-lifecycle.js";

describe("cursor tool lifecycle", () => {
	it("marks long-running or externally meaningful tools as lifecycle-eligible", () => {
		expect(isCursorToolLifecycleEligible({ name: "mcp", args: { toolName: "web_search" } })).toBe(true);
		expect(isCursorToolLifecycleEligible({ name: "shell", args: { command: "npm test" } })).toBe(true);
		expect(isCursorToolLifecycleEligible({ name: "task", args: { description: "Explore repo" } })).toBe(true);
		expect(isCursorToolLifecycleEligible({ name: "generateImage", args: { prompt: "icon" } })).toBe(true);
	});

	it("builds scrubbed bounded lifecycle labels", () => {
		const secretKey = "lifecycle-secret-key";
		expect(formatCursorToolLifecycleProgressText(
			{ name: "mcp", args: { toolName: `Bearer ${secretKey}` } }, secretKey,
		)).toBe("Cursor MCP: Bearer [redacted]\n");
		expect(formatCursorToolLifecycleProgressText(
			{ name: "mcp", args: { toolName: "search".repeat(100) } },
		)).toBe(`Cursor MCP: ${"search".repeat(100).slice(0, 239)}…\n`);
		expect(formatCursorToolLifecycleProgressText(
			{ name: "mcp", args: { toolName: "external_search" } },
		)).toBe("Cursor MCP: external_search\n");
		expect(formatCursorToolLifecycleProgressText(
			{ name: "mcp", args: { toolName: "WebSearch", args: { search_term: "pi extension" } } },
		)).toBe("Cursor web search: pi extension\n");
	});

	it("does not leak endpoint URLs or absolute private paths in non-shell lifecycle labels", () => {
		const secretPath = "/Users/test/Projects/secret-project/src/file.ts";
		const secretUrl = "https://api.example.com/v1/secret-endpoint";
		const unsafeDetailCases = [
			{ name: "task", args: { description: "Inspect /root/.ssh/id_rsa" }, title: "Cursor subagent", expected: "task" },
			{ name: "task", args: { description: "Open file:///Users/test/secret" }, title: "Cursor subagent", expected: "task" },
			{ name: "task", args: { description: "path=/root/.ssh/id_rsa" }, title: "Cursor subagent", expected: "task" },
			{ name: "task", args: { description: "--file=/Users/test/secret" }, title: "Cursor subagent", expected: "task" },
			{ name: "task", args: { description: "cwd=C:\\Users\\test\\secret" }, title: "Cursor subagent", expected: "task" },
			{ name: "task", args: { description: "path=~/secret" }, title: "Cursor subagent", expected: "task" },
			{ name: "semSearch", args: { query: "/Volumes/Secrets/file" }, title: "Cursor semantic search", expected: "semantic search" },
			{ name: "createPlan", args: { plan: "ssh://host/path\nnext step" }, title: "Cursor plan", expected: "plan" },
			{ name: "generateImage", args: { path: secretPath }, title: "Cursor image generation", expected: "image generation" },
			{ name: "recordScreen", args: { path: secretPath }, title: "Cursor screen recording", expected: "screen recording" },
			{ name: "task", args: { description: `Inspect ${secretPath}` }, title: "Cursor subagent", expected: "task" },
		] as const;

		expect(formatCursorToolLifecycleProgressText({ name: "shell", args: { command: "npm test" } })).toBe("Cursor shell: npm test\n");
		expect(formatCursorToolLifecycleProgressText({ name: "shell", args: { command: `cd ${secretPath} && npm test` } })).toBe(
			`Cursor shell: cd ${secretPath} && npm test\n`,
		);
		expect(formatCursorToolLifecycleProgressText(
			{ name: "shell", args: { command: "curl -H 'Authorization: Bearer secret-key' https://api.example.test" } },
			"secret-key",
		)).toBe("Cursor shell: curl -H 'Authorization: [redacted] [redacted]' https://api.example.test\n");

		for (const { name, args, title, expected } of unsafeDetailCases) {
			expect(formatCursorToolLifecycleProgressText({ name, args })).toBe(`${title}: ${expected}\n`);
		}
		expect(formatCursorToolLifecycleProgressText({ name: "webFetch", args: { url: secretUrl } })).toBe("Cursor web fetch: web fetch\n");
	});
});
