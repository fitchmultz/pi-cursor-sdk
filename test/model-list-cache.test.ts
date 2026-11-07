import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import {
	clearModelListCache,
	fingerprintApiKey,
	loadAnyCachedModelCatalog,
	loadFreshCachedModels,
	saveModelListCache,
} from "../src/model-list-cache.js";

const MODELS: ModelListItem[] = [
	{
		id: "composer-2",
		displayName: "Composer 2",
		variants: [{ params: [], displayName: "Composer 2", isDefault: true }],
	},
];
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

describe("model-list-cache", () => {
	const originalEnv = process.env;
	let tmpAgentDir: string;
	let cachePath: string;
	const fp = fingerprintApiKey("test-key");

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.PI_CURSOR_SDK_DISABLE_MODEL_CACHE;
		delete process.env.PI_CURSOR_SDK_MODEL_CACHE_TTL_MS;
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-model-cache-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		cachePath = join(tmpAgentDir, "cursor-sdk-model-list.json");
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(tmpAgentDir, { recursive: true, force: true });
		process.env = originalEnv;
	});

	it("removes only a valid owned catalog and leaves invalid files untouched", () => {
		clearModelListCache();
		saveModelListCache(fp, MODELS);
		clearModelListCache();
		expect(loadFreshCachedModels(fp)).toBeUndefined();
		writeFileSync(cachePath, "corrupt");
		clearModelListCache();
		expect(readFileSync(cachePath, "utf8")).toBe("corrupt");
	});

	it("writes a matching catalog with 0600 permissions and no API key", () => {
		expect(saveModelListCache(fp, MODELS)).toBe(true);
		expect(loadFreshCachedModels(fp)).toEqual(MODELS);
		if (process.platform !== "win32") expect(statSync(cachePath).mode & 0o777).toBe(0o600);
		const raw = readFileSync(cachePath, "utf-8");
		expect(raw).not.toContain("test-key");
		expect(JSON.parse(raw).keyFingerprint).toBe(fp);
	});

	it("tightens permissions when rewriting an existing loose cache file", () => {
		writeFileSync(cachePath, "{}", { mode: 0o644 });

		expect(saveModelListCache(fp, MODELS)).toBe(true);

		if (process.platform !== "win32") expect(statSync(cachePath).mode & 0o777).toBe(0o600);
	});

	it("misses when the key fingerprint differs", () => {
		saveModelListCache(fp, MODELS);
		expect(loadFreshCachedModels(fingerprintApiKey("other-key"))).toBeUndefined();
	});

	it("ignores a corrupt cache file", () => {
		writeFileSync(cachePath, "{ not json");
		expect(loadFreshCachedModels(fp)).toBeUndefined();
		expect(loadAnyCachedModelCatalog(fp)).toBeUndefined();
	});

	it.each([
		["non-finite", "1e309"],
		["negative", "-1"],
		["finite Date-invalid", "1e100"],
		["far-future", `${Date.now() + DEFAULT_TTL_MS + 1}`],
	])("ignores cache files with %s timestamps", (_label, fetchedAt) => {
		writeFileSync(
			cachePath,
			`{"version":1,"fetchedAt":${fetchedAt},"keyFingerprint":${JSON.stringify(fp)},"models":${JSON.stringify(MODELS)}}`,
		);

		expect(loadFreshCachedModels(fp)).toBeUndefined();
		expect(loadAnyCachedModelCatalog(fp)).toBeUndefined();
	});

	it.each([
		["missing displayName", { id: "missing-display-name" }],
		["parameter without values", { id: "raw-id", displayName: "Raw", parameters: [{ id: "context" }] }],
		[
			"parameter value without string value",
			{ id: "raw-id", displayName: "Raw", parameters: [{ id: "context", values: [{ displayName: "1M" }] }] },
		],
		[
			"variant param without string id/value",
			{ id: "raw-id", displayName: "Raw", variants: [{ params: [{ id: "context" }], displayName: "Raw", isDefault: true }] },
		],
	])("ignores cache files with invalid model shapes: %s", (_label, model) => {
		writeFileSync(
			cachePath,
			JSON.stringify({
				version: 1,
				fetchedAt: Date.now(),
				keyFingerprint: fp,
				models: [model],
			}),
		);

		expect(loadFreshCachedModels(fp)).toBeUndefined();
		expect(loadAnyCachedModelCatalog(fp)).toBeUndefined();
	});

	it.each(["1", "true", "on", "yes", "enabled"])("disables persisted reads and writes with env flag %s", (value) => {
		process.env.PI_CURSOR_SDK_DISABLE_MODEL_CACHE = value;
		expect(saveModelListCache(fp, MODELS)).toBe(false);
		expect(existsSync(cachePath)).toBe(false);
		delete process.env.PI_CURSOR_SDK_DISABLE_MODEL_CACHE;
		expect(saveModelListCache(fp, MODELS)).toBe(true);
		const bytes = readFileSync(cachePath);
		process.env.PI_CURSOR_SDK_DISABLE_MODEL_CACHE = value;
		expect(loadFreshCachedModels(fp)).toBeUndefined();
		expect(loadAnyCachedModelCatalog(fp)).toBeUndefined();
		expect(saveModelListCache(fp, [])).toBe(false);
		expect(readFileSync(cachePath)).toEqual(bytes);
	});

	it("honors a custom TTL from the environment", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		process.env.PI_CURSOR_SDK_MODEL_CACHE_TTL_MS = "1000";
		saveModelListCache(fp, MODELS);
		const savedAt = Date.now();
		vi.setSystemTime(savedAt + 1000);
		expect(loadFreshCachedModels(fp)).toEqual(MODELS);
		vi.setSystemTime(savedAt + 1001);
		expect(loadFreshCachedModels(fp)).toBeUndefined();
		expect(loadAnyCachedModelCatalog(fp)?.models).toEqual(MODELS);
	});

	it.each([undefined, "not-a-number", "-1"])("uses the default TTL when env is unset or invalid: %s", (value) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		if (value !== undefined) process.env.PI_CURSOR_SDK_MODEL_CACHE_TTL_MS = value;
		saveModelListCache(fp, MODELS);
		const savedAt = Date.now();
		vi.setSystemTime(savedAt + DEFAULT_TTL_MS);
		expect(loadFreshCachedModels(fp)).toEqual(MODELS);
		vi.setSystemTime(savedAt + DEFAULT_TTL_MS + 1);
		expect(loadFreshCachedModels(fp)).toBeUndefined();
		expect(loadAnyCachedModelCatalog(fp)?.models).toEqual(MODELS);
	});
});
