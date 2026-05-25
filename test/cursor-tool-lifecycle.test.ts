import { describe, expect, it } from "vitest";
import {
	buildCursorToolLifecycleLabel,
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

	it("does not mark fast local file tools as lifecycle-eligible", () => {
		expect(isCursorToolLifecycleEligible({ name: "read", args: { path: "README.md" } })).toBe(false);
		expect(isCursorToolLifecycleEligible({ name: "grep", args: { pattern: "foo" } })).toBe(false);
		expect(isCursorToolLifecycleEligible({ name: "glob", args: { pattern: "*.ts" } })).toBe(false);
	});

	it("builds scrubbed bounded lifecycle labels", () => {
		const secretKey = "lifecycle-secret-key";
		const label = buildCursorToolLifecycleLabel(
			{ name: "mcp", args: { toolName: "search", description: `Bearer ${secretKey}` } },
			secretKey,
		);
		expect(label).toBe("search");
		expect(label).not.toContain(secretKey);

		const progress = formatCursorToolLifecycleProgressText(
			{ name: "mcp", args: { toolName: "external_search" } },
			"test-key",
		);
		expect(progress).toBe("Cursor MCP: external_search\n");
	});

	it("does not leak endpoint URLs or absolute private paths in lifecycle labels", () => {
		const secretPath = "/Users/test/Projects/secret-project/src/file.ts";
		const secretUrl = "https://api.example.com/v1/secret-endpoint";
		const unsafeDetailCases = [
			{ name: "task", args: { description: "Inspect /root/.ssh/id_rsa" }, expected: "task" },
			{ name: "task", args: { description: "Open file:///Users/test/secret" }, expected: "task" },
			{ name: "task", args: { description: "path=/root/.ssh/id_rsa" }, expected: "task" },
			{ name: "task", args: { description: "--file=/Users/test/secret" }, expected: "task" },
			{ name: "task", args: { description: "cwd=C:\\Users\\test\\secret" }, expected: "task" },
			{ name: "task", args: { description: "path=~/secret" }, expected: "task" },
			{ name: "semSearch", args: { query: "/Volumes/Secrets/file" }, expected: "semantic search" },
			{ name: "createPlan", args: { plan: "ssh://host/path\nnext step" }, expected: "plan" },
		] as const;

		expect(buildCursorToolLifecycleLabel({ name: "shell", args: { command: `cd ${secretPath} && npm test` } })).toBe("shell");
		expect(buildCursorToolLifecycleLabel({ name: "webFetch", args: { url: secretUrl } })).toBe("web fetch");
		expect(buildCursorToolLifecycleLabel({ name: "generateImage", args: { path: secretPath } })).toBe("image generation");
		expect(buildCursorToolLifecycleLabel({ name: "recordScreen", args: { path: secretPath } })).toBe("screen recording");
		expect(buildCursorToolLifecycleLabel({ name: "task", args: { description: `Inspect ${secretPath}` } })).toBe("task");

		for (const { name, args, expected } of unsafeDetailCases) {
			expect(buildCursorToolLifecycleLabel({ name, args })).toBe(expected);
			const progress = formatCursorToolLifecycleProgressText({ name, args });
			expect(progress).not.toMatch(/\/root\/|file:\/\/|\/Volumes\/|ssh:\/\/|\/Users\/|~\/secret/);
		}

		const progress = formatCursorToolLifecycleProgressText({ name: "webFetch", args: { url: secretUrl } });
		expect(progress).toBe("Cursor web fetch: web fetch\n");
		expect(progress).not.toContain(secretUrl);
		expect(progress).not.toContain(secretPath);
	});
});
