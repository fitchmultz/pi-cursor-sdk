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
});
