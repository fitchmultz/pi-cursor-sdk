import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import {
	buildCursorModelSelection,
	discoverModels,
	getCursorModelMetadata,
	type CursorModelFallbackIssue,
} from "../src/model-discovery.js";

vi.mock("@cursor/sdk", () => ({
	Cursor: { models: { list: vi.fn() } },
}));

import { Cursor } from "@cursor/sdk";

const mockedList = vi.mocked(Cursor.models.list);

function writeStoredCursorApiKey(apiKey: string): void {
	writeFileSync(
		join(process.env.PI_CODING_AGENT_DIR!, "auth.json"),
		JSON.stringify({ cursor: { type: "api_key", key: apiKey } }, null, 2),
	);
}

describe("discoverModels model-list cache", () => {
	const originalEnv = process.env;
	const originalArgv = process.argv;
	let tmpAgentDir: string;

	const MODEL: ModelListItem = {
		id: "composer-2",
		displayName: "Composer 2",
		variants: [{ params: [], displayName: "Composer 2", isDefault: true }],
	};

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.CURSOR_API_KEY;
		delete process.env.PI_CURSOR_SDK_DISABLE_MODEL_CACHE;
		delete process.env.PI_CURSOR_SDK_MODEL_CACHE_TTL_MS;
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-discovery-cache-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		process.argv = ["node", "vitest"];
	});

	afterEach(() => {
		rmSync(tmpAgentDir, { recursive: true, force: true });
		process.env = originalEnv;
		process.argv = originalArgv;
		vi.clearAllMocks();
	});

	it("preserves variant-only default params without exposing them as known controls", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "claude-opus-4-8",
				displayName: "Opus 4.8",
				parameters: [
					{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
					{ id: "effort", displayName: "Effort", values: [{ value: "low" }, { value: "high" }] },
				],
				variants: [
					{
						params: [
							{ id: "cyber", value: "false" },
							{ id: "thinking", value: "true" },
							{ id: "effort", value: "high" },
						],
						displayName: "Opus 4.8",
						isDefault: true,
					},
				],
			},
		]);
		await discoverModels();
		expect(getCursorModelMetadata("claude-opus-4-8")?.parameterIds).toEqual({
			context: false,
			reasoning: false,
			effort: true,
			thinking: true,
			reasoning_effort: false,
			fast: false,
		});
		expect(buildCursorModelSelection("claude-opus-4-8", "low")).toEqual({
			id: "claude-opus-4-8",
			params: [
				{ id: "cyber", value: "false" },
				{ id: "thinking", value: "true" },
				{ id: "effort", value: "low" },
			],
		});
	});

	it("serves a warm catalog from cache without a second network call", async () => {
		writeStoredCursorApiKey("cache-key");
		mockedList.mockResolvedValueOnce([MODEL]);

		const first = await discoverModels();
		const second = await discoverModels();

		expect(mockedList).toHaveBeenCalledTimes(1);
		expect(second.map((model) => model.id)).toEqual(first.map((model) => model.id));
	});

	it("bypasses the cache when forceRefresh is set", async () => {
		writeStoredCursorApiKey("cache-key");
		mockedList.mockResolvedValue([MODEL]);

		await discoverModels();
		await discoverModels({ forceRefresh: true });

		expect(mockedList).toHaveBeenCalledTimes(2);
	});

	it("does not read the cache when disabled via env", async () => {
		process.env.PI_CURSOR_SDK_DISABLE_MODEL_CACHE = "1";
		writeStoredCursorApiKey("cache-key");
		mockedList.mockResolvedValue([MODEL]);

		await discoverModels();
		await discoverModels();

		expect(mockedList).toHaveBeenCalledTimes(2);
	});

	it("keeps successful live discovery when cache persistence fails", async () => {
		const badAgentDir = join(tmpAgentDir, "not-a-directory");
		writeFileSync(badAgentDir, "file");
		process.env.PI_CODING_AGENT_DIR = badAgentDir;
		process.env.CURSOR_API_KEY = "cache-key";
		mockedList.mockResolvedValueOnce([MODEL]);
		const issues: CursorModelFallbackIssue[] = [];

		const models = await discoverModels({ onFallback: (issue) => issues.push(issue) });

		expect(models.map((model) => model.id)).toEqual(["composer-2"]);
		expect(issues).toEqual([]);
	});

	it("falls back to the cached catalog with a warning when a forced refresh fails", async () => {
		writeStoredCursorApiKey("cache-key");
		mockedList.mockResolvedValueOnce([MODEL]);
		await discoverModels();

		mockedList.mockRejectedValueOnce(new Error("network down"));
		const issues: CursorModelFallbackIssue[] = [];
		const refreshed = await discoverModels({ forceRefresh: true, onFallback: (issue) => issues.push(issue) });

		expect(refreshed.map((model) => model.id)).toEqual(["composer-2"]);
		expect(issues).toHaveLength(1);
		expect(issues[0].reason).toBe("cached-after-error");
		expect(issues[0].message).toContain("using cached Cursor model catalog");
		expect(issues[0].errorMessage).toContain("network down");
	});

	it("reports absent cached-catalog error details without blaming credentials", async () => {
		writeStoredCursorApiKey("cache-key");
		mockedList.mockResolvedValueOnce([MODEL]);
		await discoverModels();

		mockedList.mockRejectedValueOnce({});
		const issues: CursorModelFallbackIssue[] = [];
		await discoverModels({ forceRefresh: true, onFallback: (issue) => issues.push(issue) });

		expect(issues).toHaveLength(1);
		expect(issues[0].reason).toBe("cached-after-error");
		expect(issues[0].errorMessage).toBe("Cursor SDK request failed without further error details.");
		expect(issues[0].message).not.toMatch(/API key|\/login/);
		expect(issues[0].message).not.toContain("undefined");
	});
});
