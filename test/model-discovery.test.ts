import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	discoverModels,
	buildCursorModelSelection,
	getCursorModelMetadata,
	__testUtils,
	type CursorModelFallbackIssue,
} from "../src/model-discovery.js";
import { saveCachedContextWindow, __testUtils as contextWindowCacheTestUtils } from "../src/context-window-cache.js";
import { FALLBACK_MODEL_ITEMS } from "../src/cursor-fallback-models.generated.js";

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

vi.mock("@cursor/sdk", () => ({
	Cursor: {
		models: {
			list: vi.fn(),
		},
	},
}));

import { Cursor } from "@cursor/sdk";
import type { ModelListItem } from "@cursor/sdk";

const mockedList = vi.mocked(Cursor.models.list);

function register(items: ModelListItem[]) {
	return __testUtils.registerModelItems(items);
}

function writeStoredCursorApiKey(apiKey: string): void {
	writeFileSync(
		join(process.env.PI_CODING_AGENT_DIR!, "auth.json"),
		JSON.stringify({ cursor: { type: "api_key", key: apiKey } }, null, 2),
	);
}

describe("discoverModels", () => {
	const originalEnv = process.env;
	const originalArgv = process.argv;
	let tmpAgentDir: string;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.CURSOR_API_KEY;
		delete process.env.PI_CURSOR_HIDE_MODELS_WHEN_LOGGED_OUT;
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-discovery-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		process.argv = ["node", "vitest"];
	});

	afterEach(() => {
		rmSync(tmpAgentDir, { recursive: true, force: true });
		process.env = originalEnv;
		process.argv = originalArgv;
		vi.clearAllMocks();
	});

	it("returns generated fallback models when no API key", async () => {
		delete process.env.CURSOR_API_KEY;
		const issues: CursorModelFallbackIssue[] = [];
		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY, onFallback: (issue) => issues.push(issue) });
		const modelIds = models.map((model) => model.id);
		expect(modelIds).toEqual(
			expect.arrayContaining([
				"claude-opus-4-7@1m",
				"claude-opus-4-7@300k",
				"claude-opus-4-8@1m",
				"claude-opus-4-8@300k",
				"claude-sonnet-4-6@1m",
				"claude-sonnet-4-6@200k",
				"claude-haiku-5-5@300k",
				"claude-haiku-5-5@1m",
				"composer-2.5",
				"composer-2-5",
				"composer-latest",
				"grok-4.6",
				"grok-4.6:fast",
				"grok-4.6:slow",
				"gpt-5.5@1m",
				"gpt-5.5@272k",
			]),
		);
		expect(modelIds.length).toBeGreaterThan(20);
		expect(issues).toEqual([
			expect.objectContaining({
				reason: "missing-api-key",
				message: expect.stringContaining("CURSOR_API_KEY"),
			}),
		]);
		expect(issues[0].message).toContain("/login");
		expect(issues[0].message).toContain("startup discovery does not parse Pi CLI arguments");
		expect(issues[0].message).toContain("fallback models can run once auth exists");
		expect(issues[0].message).toContain("/cursor-refresh-models");
		expect(issues[0].message).not.toContain("will fail until pi is restarted");
		expect(mockedList).not.toHaveBeenCalled();

		for (const context of ["300k", "1m"]) {
			const modelId = `claude-haiku-5-5@${context}`;
			expect(models.find(({ id }) => id === modelId)).toMatchObject({
				reasoning: true,
				contextWindow: context === "300k" ? 300000 : 1000000,
				thinkingLevelMap: {
					off: "false",
					minimal: null,
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
				},
			});
			const defaultParams = [
				{ id: "thinking", value: "true" },
				{ id: "context", value: context },
				{ id: "reasoning_effort", value: "high" },
			];
			expect(getCursorModelMetadata(modelId)).toMatchObject({ catalogDefaultContext: "1m", defaultParams });
			expect(buildCursorModelSelection(modelId, "minimal", true)).toEqual({
				id: "claude-haiku-5-5",
				params: defaultParams,
			});
			expect(buildCursorModelSelection(modelId, "xhigh")).toEqual({
				id: "claude-haiku-5-5",
				params: [
					{ id: "thinking", value: "true" },
					{ id: "context", value: context },
					{ id: "reasoning_effort", value: "xhigh" },
				],
			});
			expect(buildCursorModelSelection(modelId, "off")).toEqual({
				id: "claude-haiku-5-5",
				params: [
					{ id: "thinking", value: "false" },
					{ id: "context", value: context },
				],
			});
			expect(getCursorModelMetadata(modelId)?.defaultParams).toEqual(defaultParams);
		}
	});

	it("returns fallback models and reports missing key when API key is whitespace", async () => {
		process.env.CURSOR_API_KEY = "   ";
		const issues: CursorModelFallbackIssue[] = [];
		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY, onFallback: (issue) => issues.push(issue) });
		expect(models.some((model) => model.id === "gpt-5.5@1m")).toBe(true);
		expect(issues).toEqual([expect.objectContaining({ reason: "missing-api-key" })]);
		expect(mockedList).not.toHaveBeenCalled();
	});

	it("ignores adversarial Pi argv forms during startup discovery", async () => {
		process.argv = [
			"node", "pi", "--model", "anthropic/first", "--api-key", "first-key",
			"--MODEL", "cursor/case", "--API-KEY", "case-key",
			"--model=cursor/unsupported", "--api-key=equals-key",
			"--models", "cursor/list-like", "--provider", "cursor",
			"--model", "cursor/final", "--api-key", "last-key",
		];

		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

		expect(models.some((model) => model.id === "composer-2.5")).toBe(true);
		expect(mockedList).not.toHaveBeenCalled();
	});

	it("uses an explicitly supplied provider-scoped refresh key", async () => {
		mockedList.mockResolvedValueOnce([
			{ id: "composer-2", displayName: "Composer 2", variants: [{ params: [], displayName: "Composer 2", isDefault: true }] },
		]);

		const models = await discoverModels({ apiKey: " explicit-key " });

		expect(mockedList).toHaveBeenCalledWith({ apiKey: "explicit-key" });
		expect(models.map((model) => model.id)).toEqual(["composer-2"]);
	});

	it("never falls through an explicit missing native key to unrelated default auth or ambient env", async () => {
		writeStoredCursorApiKey("unrelated-default-key");
		process.env.CURSOR_API_KEY = "unrelated-ambient-key";
		const issues: CursorModelFallbackIssue[] = [];
		const models = await discoverModels({ apiKey: undefined, onFallback: (issue) => issues.push(issue) });
		expect(models.some((model) => model.id === "composer-2.5")).toBe(true);
		expect(issues[0].reason).toBe("missing-api-key");
		expect(mockedList).not.toHaveBeenCalled();
	});

	it("calls Cursor.models.list with API key and sorts by base id", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "model-b",
				displayName: "Model B",
				variants: [{ params: [], displayName: "Model B", isDefault: true }],
			},
			{
				id: "model-a",
				displayName: "Model A",
				variants: [{ params: [], displayName: "Model A", isDefault: true }],
			},
		]);
		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });
		expect(mockedList).toHaveBeenCalledWith({ apiKey: "test-key-123" });
		expect(models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
		expect(models[0].name).toBe("Model A");
	});

	it("sorts by base id while preserving Cursor SDK context value order inside each model", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "z-model",
				displayName: "Z Model",
				parameters: [{ id: "context", displayName: "Context", values: [{ value: "long" }, { value: "short" }] }],
				variants: [{ params: [{ id: "context", value: "short" }], displayName: "Z Model", isDefault: true }],
			},
			{
				id: "a-model",
				displayName: "A Model",
				parameters: [{ id: "context", displayName: "Context", values: [{ value: "300k" }, { value: "1m" }] }],
				variants: [{ params: [{ id: "context", value: "1m" }], displayName: "A Model", isDefault: true }],
			},
		]);

		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

		expect(models.map((model) => model.id)).toEqual(["a-model@300k", "a-model@1m", "z-model@long", "z-model@short"]);
		expect(getCursorModelMetadata("a-model@300k")?.defaultParams).toEqual([{ id: "context", value: "300k" }]);
		expect(getCursorModelMetadata("z-model@long")?.defaultParams).toEqual([{ id: "context", value: "long" }]);
	});

	it("registers Cursor model aliases with the same params and context variants", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gpt-5.5",
				displayName: "GPT-5.5",
				aliases: ["gpt-latest", "gpt-latest", ""],
				parameters: [
					{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] },
					{ id: "reasoning", displayName: "Reasoning", values: [{ value: "none" }, { value: "medium" }] },
				],
				variants: [
					{
						params: [
							{ id: "context", value: "1m" },
							{ id: "reasoning", value: "medium" },
						],
						displayName: "GPT-5.5",
						isDefault: true,
					},
				],
			},
		]);

		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

		expect(models.map((model) => model.id)).toEqual(["gpt-5.5@1m", "gpt-5.5@272k", "gpt-latest@1m", "gpt-latest@272k"]);
		expect(models[2].name).toBe("GPT-5.5 (gpt-latest) @ 1m");
		expect(getCursorModelMetadata("gpt-latest@272k")).toMatchObject({
			baseModelId: "gpt-5.5",
			selectionModelId: "gpt-latest",
			context: "272k",
		});
		expect(buildCursorModelSelection("gpt-latest@272k", "medium")).toEqual({
			id: "gpt-latest",
			params: [
				{ id: "context", value: "272k" },
				{ id: "reasoning", value: "medium" },
			],
		});
	});

	it("skips aliases that multiple Cursor base models share", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "model-a",
				displayName: "Model A",
				aliases: ["model-latest", "model-shared"],
				variants: [{ params: [], displayName: "Model A", isDefault: true }],
			},
			{
				id: "model-b",
				displayName: "Model B",
				aliases: ["model-stable", "model-shared"],
				variants: [{ params: [], displayName: "Model B", isDefault: true }],
			},
		]);

		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

		expect(models.map((model) => model.id)).toEqual(["model-a", "model-latest", "model-b", "model-stable"]);
		expect(getCursorModelMetadata("model-shared")).toBeUndefined();
	});

	it("skips aliases that collide with another Cursor base model id", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "model-a",
				displayName: "Model A",
				aliases: ["model-b", "model-a-latest"],
				variants: [{ params: [], displayName: "Model A", isDefault: true }],
			},
			{
				id: "model-b",
				displayName: "Model B",
				variants: [{ params: [], displayName: "Model B", isDefault: true }],
			},
		]);

		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

		expect(models.map((model) => model.id)).toEqual(["model-a", "model-a-latest", "model-b"]);
		expect(getCursorModelMetadata("model-b")?.baseModelId).toBe("model-b");
	});

	it("uses the aliased base model context-window cache for aliases without context params", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gpt-5-mini",
				displayName: "GPT-5 Mini",
				aliases: ["gpt-mini-latest"],
				variants: [{ params: [], displayName: "GPT-5 Mini", isDefault: true }],
			},
		]);

		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

		expect(models.map((model) => [model.id, model.contextWindow])).toEqual([
			["gpt-5-mini", 272000],
			["gpt-mini-latest", 272000],
		]);
	});

	it("registers one pi model per Cursor context value", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gpt-5.4",
				displayName: "GPT-5.4",
				parameters: [
					{ id: "context", displayName: "Context", values: [{ value: "272k" }, { value: "1m" }] },
					{
						id: "reasoning",
						displayName: "Reasoning",
						values: [{ value: "none" }, { value: "medium" }],
					},
					{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
				],
				variants: [
					{
						params: [
							{ id: "context", value: "1m" },
							{ id: "reasoning", value: "medium" },
							{ id: "fast", value: "false" },
						],
						displayName: "GPT-5.4",
						isDefault: true,
					},
				],
			},
		]);
		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });
		expect(models.map((model) => model.id)).toEqual([
			"gpt-5.4@272k",
			"gpt-5.4@272k:fast",
			"gpt-5.4@272k:slow",
			"gpt-5.4@1m",
			"gpt-5.4@1m:fast",
			"gpt-5.4@1m:slow",
		]);
		expect(models[0].contextWindow).toBe(272000);
		expect(models[1].contextWindow).toBe(272000);
		expect(models[3].contextWindow).toBe(1000000);
		expect(models[0].name).toBe("GPT-5.4 @ 272k");
		expect(models[1].name).toBe("GPT-5.4 (fast) @ 272k");
		expect(models[2].name).toBe("GPT-5.4 (slow) @ 272k");

		const metadata = getCursorModelMetadata("gpt-5.4@272k");
		expect(metadata).toMatchObject({
			baseModelId: "gpt-5.4",
			context: "272k",
			supportsFast: true,
			defaultFast: false,
		});
		expect(metadata?.defaultParams).toEqual([
			{ id: "context", value: "272k" },
			{ id: "reasoning", value: "medium" },
			{ id: "fast", value: "false" },
		]);
		expect(getCursorModelMetadata("gpt-5.4@272k:fast")).toMatchObject({
			baseModelId: "gpt-5.4",
			selectionModelId: "gpt-5.4",
			context: "272k",
			fastOverride: true,
			defaultFast: true,
		});
		expect(getCursorModelMetadata("gpt-5.4@272k:slow")).toMatchObject({
			baseModelId: "gpt-5.4",
			selectionModelId: "gpt-5.4",
			context: "272k",
			fastOverride: false,
			defaultFast: false,
		});
		expect(buildCursorModelSelection("gpt-5.4@272k:fast", "medium")).toEqual({
			id: "gpt-5.4",
			params: [
				{ id: "context", value: "272k" },
				{ id: "reasoning", value: "medium" },
				{ id: "fast", value: "true" },
			],
		});
		expect(buildCursorModelSelection("gpt-5.4@272k:slow", "medium")).toEqual({
			id: "gpt-5.4",
			params: [
				{ id: "context", value: "272k" },
				{ id: "reasoning", value: "medium" },
				{ id: "fast", value: "false" },
			],
		});
	});

	it("does not encode reasoning, effort, or thinking into pi model IDs", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gpt-5.3-codex",
				displayName: "GPT-5.3 Codex",
				parameters: [
					{ id: "reasoning", displayName: "Reasoning", values: [{ value: "high" }] },
					{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
				],
				variants: [
					{
						params: [
							{ id: "reasoning", value: "high" },
							{ id: "fast", value: "true" },
						],
						displayName: "GPT-5.3 Codex",
						isDefault: true,
					},
				],
			},
		]);
		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });
		expect(models.map((model) => model.id)).toEqual(["gpt-5.3-codex", "gpt-5.3-codex:fast", "gpt-5.3-codex:slow"]);
		expect(getCursorModelMetadata("gpt-5.3-codex")?.defaultParams).toEqual([
			{ id: "reasoning", value: "high" },
			{ id: "fast", value: "true" },
		]);
	});

	it("uses bundled SDK-derived context windows for models without context params", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-context-window-bundled-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			process.env.CURSOR_API_KEY = "test-key-123";
			mockedList.mockResolvedValueOnce([
				{
					id: "composer-2",
					displayName: "Composer 2",
					parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
					variants: [{ params: [{ id: "fast", value: "true" }], displayName: "Composer 2", isDefault: true }],
				},
				{
					id: "new-sdk-model",
					displayName: "New SDK Model",
					variants: [{ params: [], displayName: "New SDK Model", isDefault: true }],
				},
			]);

			const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

			expect(models.map((model) => [model.id, model.contextWindow])).toEqual([
				["composer-2", 200000],
				["composer-2:fast", 200000],
				["composer-2:slow", 200000],
				["new-sdk-model", 200000],
			]);
		} finally {
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});

	it.each([3, 25])("bounds populated context-window cache reads for a %i-model catalog", async (catalogSize) => {
		const cachePath = join(tmpAgentDir, "cursor-sdk-context-windows.json");
		writeFileSync(cachePath, JSON.stringify({ contextWindows: { default: 321000, "synthetic-model-0": 654000 } }));
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce(
			Array.from({ length: catalogSize }, (_, index) => ({
				id: `synthetic-model-${index}`,
				displayName: `Synthetic Model ${index}`,
				variants: [{ params: [], displayName: `Synthetic Model ${index}`, isDefault: true }],
			})),
		);

		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

		expect(models).toHaveLength(catalogSize);
		expect(models.find(({ id }) => id === "synthetic-model-0")?.contextWindow).toBe(654000);
		expect(models.filter(({ id }) => id !== "synthetic-model-0").map(({ contextWindow }) => contextWindow))
			.toEqual(Array(catalogSize - 1).fill(321000));
		const cacheReads = vi.mocked(readFileSync).mock.calls.filter(([path]) => path === cachePath).length;
		expect(cacheReads).toBeGreaterThan(0);
		expect(cacheReads).toBeLessThanOrEqual(3);
	});

	it("lets user cache override context-qualified model IDs", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-context-window-qualified-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			saveCachedContextWindow("gpt-5.5@1m", 950000);
			process.env.CURSOR_API_KEY = "test-key-123";
			mockedList.mockResolvedValueOnce([
				{
					id: "gpt-5.5",
					displayName: "GPT-5.5",
					parameters: [{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] }],
					variants: [{ params: [{ id: "context", value: "1m" }], displayName: "GPT-5.5", isDefault: true }],
				},
			]);

			const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

			expect(models.map((model) => [model.id, model.contextWindow])).toEqual([
				["gpt-5.5@1m", 950000],
				["gpt-5.5@272k", 272000],
			]);
		} finally {
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});

	it("uses base context evidence for aliases unless an exact alias observation exists", () => {
		const opus = FALLBACK_MODEL_ITEMS.find(({ id }) => id === "claude-opus-4-8");
		if (!opus) throw new Error("claude-opus-4-8 fallback fixture missing");
		saveCachedContextWindow("opus-4-8@1m", 310000);

		const windowsById = Object.fromEntries(register([opus]).map(({ id, contextWindow }) => [id, contextWindow]));

		expect(windowsById["claude-opus-4-8@1m"]).toBe(300000);
		expect(windowsById["opus-4.8@1m"]).toBe(300000);
		expect(windowsById["opus-4-8@1m"]).toBe(310000);
	});

	it("inherits base context and fast evidence for aliases without exact observations", () => {
		saveCachedContextWindow("base-context-model@1m", 300000);
		saveCachedContextWindow("base-context-model@1m:fast", 320000);
		saveCachedContextWindow("observed-alias@1m", 310000);
		const windowsById = Object.fromEntries(register([{
			id: "base-context-model",
			displayName: "Base Context Model",
			aliases: ["observed-alias", "unobserved-alias"],
			parameters: [
				{ id: "context", displayName: "Context", values: [{ value: "1m" }] },
				{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
			],
			variants: [{
				displayName: "Default",
				isDefault: true,
				params: [{ id: "context", value: "1m" }, { id: "fast", value: "false" }],
			}],
		}]).map(({ id, contextWindow }) => [id, contextWindow]));

		expect(windowsById["observed-alias@1m"]).toBe(310000);
		expect(windowsById["unobserved-alias@1m"]).toBe(300000);
		expect(windowsById["unobserved-alias@1m:slow"]).toBe(300000);
		expect(windowsById["unobserved-alias@1m:fast"]).toBe(320000);
	});

	it("lets user cache override bundled context windows", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-context-window-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			saveCachedContextWindow("composer-2", 201000);
			process.env.CURSOR_API_KEY = "test-key-123";
			mockedList.mockResolvedValueOnce([
				{
					id: "composer-2",
					displayName: "Composer 2",
					parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
					variants: [{ params: [{ id: "fast", value: "true" }], displayName: "Composer 2", isDefault: true }],
				},
			]);

			const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

			expect(models.map((model) => [model.id, model.contextWindow])).toEqual([
				["composer-2", 201000],
				["composer-2:fast", 201000],
				["composer-2:slow", 201000],
			]);
		} finally {
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});

	it("ignores malformed context-window cache values", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-context-window-malformed-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			writeFileSync(contextWindowCacheTestUtils.getCachePath(), JSON.stringify({ contextWindows: { "composer-2": "201000" } }));
			process.env.CURSOR_API_KEY = "test-key-123";
			mockedList.mockResolvedValueOnce([
				{
					id: "composer-2",
					displayName: "Composer 2",
					variants: [{ params: [], displayName: "Composer 2", isDefault: true }],
				},
			]);

			const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

			expect(models.find((model) => model.id === "composer-2")?.contextWindow).toBe(200000);
		} finally {
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});

	it("sets reasoning false for models without thinking controls", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gemini-3.1-pro",
				displayName: "Gemini 3.1 Pro",
				variants: [{ params: [], displayName: "Gemini 3.1 Pro", isDefault: true }],
			},
		]);
		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });
		expect(models[0].reasoning).toBe(false);
		expect(models[0].thinkingLevelMap).toBeUndefined();
	});

	it("maps Cursor reasoning values to pi thinking levels", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gpt-5.4",
				displayName: "GPT-5.4",
				parameters: [
					{
						id: "reasoning",
						displayName: "Reasoning",
						values: [
							{ value: "none" },
							{ value: "minimal" },
							{ value: "low" },
							{ value: "medium" },
							{ value: "high" },
							{ value: "extra-high" },
						],
					},
				],
				variants: [
					{
						params: [{ id: "reasoning", value: "medium" }],
						displayName: "GPT-5.4",
						isDefault: true,
					},
				],
			},
		]);
		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });
		expect(models[0].thinkingLevelMap).toEqual({
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "extra-high",
			max: null,
		});
	});

	it("maps boolean Cursor thinking values to off and high with explicit unsupported nulls", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "claude-haiku-4-5",
				displayName: "Haiku 4.5",
				parameters: [
					{
						id: "thinking",
						displayName: "Thinking",
						values: [{ value: "false" }, { value: "true" }],
					},
				],
				variants: [
					{
						params: [{ id: "thinking", value: "true" }],
						displayName: "Haiku 4.5",
						isDefault: true,
					},
				],
			},
		]);
		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });
		expect(models[0].thinkingLevelMap).toEqual({
			off: "false",
			minimal: null,
			low: null,
			medium: null,
			high: "true",
			xhigh: null,
			max: null,
		});
	});

	it("maps Claude effort with distinct xhigh and max values", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "claude-opus-4-7",
				displayName: "Opus 4.7",
				parameters: [
					{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
					{ id: "context", displayName: "Context", values: [{ value: "300k" }, { value: "1m" }] },
					{
						id: "effort",
						displayName: "Effort",
						values: [
							{ value: "low" },
							{ value: "medium" },
							{ value: "high" },
							{ value: "xhigh" },
							{ value: "max" },
							{ value: "extra-high" },
						],
					},
				],
				variants: [
					{
						params: [
							{ id: "thinking", value: "true" },
							{ id: "context", value: "1m" },
							{ id: "effort", value: "xhigh" },
						],
						displayName: "Opus 4.7",
						isDefault: true,
					},
				],
			},
		]);
		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });
		expect(models.map((model) => model.id)).toEqual(["claude-opus-4-7@300k", "claude-opus-4-7@1m"]);
		expect(models[0].contextWindow).toBe(300000);
		expect(models[1].contextWindow).toBe(1000000);
		expect(models[0].thinkingLevelMap).toEqual({
			off: "false",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	it("registers text and image input for Cursor models", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "vision-capable",
				displayName: "Vision Capable",
				variants: [{ params: [], displayName: "Vision Capable", isDefault: true }],
			},
		]);

		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

		expect(models[0].input).toEqual(["text", "image"]);
	});

	it("maps reasoning off to unsupported null when Cursor exposes no none or off value", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "reasoning-only",
				displayName: "Reasoning Only",
				parameters: [
					{
						id: "reasoning",
						displayName: "Reasoning",
						values: [{ value: "low" }, { value: "medium" }, { value: "high" }],
					},
				],
				variants: [{ params: [{ id: "reasoning", value: "medium" }], displayName: "Reasoning Only", isDefault: true }],
			},
		]);

		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

		expect(models[0].thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
		expect(buildCursorModelSelection("reasoning-only", "off")).toEqual({
			id: "reasoning-only",
			params: [{ id: "reasoning", value: "medium" }],
		});
	});

	it.each(["effort", "reasoning_effort"])("maps boolean thinking plus %s to enabled effort levels and off without effort", async (effortId) => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "claude-like",
				displayName: "Claude Like",
				parameters: [
					{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
					{ id: effortId, displayName: "Effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }, { value: "max" }] },
				],
				variants: [
					{
						params: [
							{ id: "thinking", value: "true" },
							{ id: effortId, value: "medium" },
						],
						displayName: "Claude Like",
						isDefault: true,
					},
				],
			},
		]);

		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });

		expect(models[0].thinkingLevelMap).toEqual({
			off: "false",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
		for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
			expect(buildCursorModelSelection("claude-like", level)).toEqual({
				id: "claude-like",
				params: [
					{ id: "thinking", value: "true" },
					{ id: effortId, value: level },
				],
			});
		}
		expect(buildCursorModelSelection("claude-like", "minimal")).toEqual({
			id: "claude-like",
			params: [{ id: "thinking", value: "true" }, { id: effortId, value: "medium" }],
		});
		expect(buildCursorModelSelection("claude-like", "off")).toEqual({
			id: "claude-like",
			params: [{ id: "thinking", value: "false" }],
		});
	});

	it("keeps the fallback snapshot aligned with the current Composer 2.5 catalog shape", async () => {
		delete process.env.CURSOR_API_KEY;

		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });
		const modelIds = models.map((model) => model.id);

		expect(modelIds).toEqual(expect.arrayContaining(["composer-2.5", "composer-2-5", "composer-latest"]));
		expect(getCursorModelMetadata("composer-2.5")).toEqual(
			expect.objectContaining({
				baseModelId: "composer-2.5",
				selectionModelId: "composer-2.5",
				contextWindow: 200000,
				supportsFast: true,
				defaultFast: true,
			}),
		);
		expect(getCursorModelMetadata("composer-2-5")).toEqual(
			expect.objectContaining({
				baseModelId: "composer-2.5",
				selectionModelId: "composer-2-5",
				contextWindow: 200000,
				supportsFast: true,
				defaultFast: true,
			}),
		);
		expect(buildCursorModelSelection("composer-2.5", "off")).toEqual({
			id: "composer-2.5",
			params: [{ id: "fast", value: "true" }],
		});
		expect(buildCursorModelSelection("composer-2.5", "off", false)).toEqual({
			id: "composer-2.5",
			params: [{ id: "fast", value: "false" }],
		});
	});


	it("uses id as name when displayName is missing", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{ id: "raw-id", variants: [{ params: [], displayName: "raw-id", isDefault: true }] } as unknown as ModelListItem,
		]);
		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });
		expect(models[0].name).toBe("raw-id");
	});

	it("uses first variant when no isDefault is marked", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "test-model",
				displayName: "Test Model",
				parameters: [{ id: "reasoning", displayName: "Reasoning", values: [{ value: "low" }, { value: "high" }] }],
				variants: [
					{ params: [{ id: "reasoning", value: "low" }], displayName: "Test Model" },
					{ params: [{ id: "reasoning", value: "high" }], displayName: "Test Model" },
				],
			},
		]);
		const models = await discoverModels({ apiKey: process.env.CURSOR_API_KEY });
		expect(models[0].id).toBe("test-model");
		expect(buildCursorModelSelection("test-model", "off")).toEqual({
			id: "test-model",
			params: [{ id: "reasoning", value: "low" }],
		});
	});

});
