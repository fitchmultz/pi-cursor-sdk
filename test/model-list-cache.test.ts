import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import {
	clearModelListCache,
	fingerprintApiKey,
	getModelCacheTtlMs,
	isModelCacheDisabled,
	loadAnyCachedModelCatalog,
	loadFreshCachedModels,
	saveModelListCache,
	__testUtils,
} from "../src/model-list-cache.js";

const MODELS: ModelListItem[] = [
	{
		id: "composer-2",
		displayName: "Composer 2",
		variants: [{ params: [], displayName: "Composer 2", isDefault: true }],
	},
];

describe("model-list-cache", () => {
	const originalEnv = process.env;
	let tmpAgentDir: string;
	const fp = fingerprintApiKey("test-key");

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env[__testUtils.DISABLE_ENV_VAR];
		delete process.env[__testUtils.TTL_ENV_VAR];
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-model-cache-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
	});

	afterEach(() => {
		rmSync(tmpAgentDir, { recursive: true, force: true });
		process.env = originalEnv;
	});

	it("removes saved and corrupt catalogs and reports absence", () => {
		expect(clearModelListCache()).toBe(false);
		saveModelListCache(fp, MODELS);
		expect(clearModelListCache()).toBe(true);
		expect(loadFreshCachedModels(fp)).toBeUndefined();
		writeFileSync(__testUtils.getCachePath(), "corrupt");
		expect(clearModelListCache()).toBe(true);
	});

	it("round-trips a saved catalog for a matching key", () => {
		saveModelListCache(fp, MODELS);
		expect(loadFreshCachedModels(fp)).toEqual(MODELS);
	});

	it("writes the cache file with 0600 permissions and no API key", () => {
		expect(saveModelListCache(fp, MODELS)).toBe(true);
		const path = __testUtils.getCachePath();
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		const raw = readFileSync(path, "utf-8");
		expect(raw).not.toContain("test-key");
		expect(JSON.parse(raw).keyFingerprint).toBe(fp);
	});

	it("tightens permissions when rewriting an existing loose cache file", () => {
		const path = __testUtils.getCachePath();
		writeFileSync(path, "{}", { mode: 0o644 });

		expect(saveModelListCache(fp, MODELS)).toBe(true);

		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("misses when the key fingerprint differs", () => {
		saveModelListCache(fp, MODELS);
		expect(loadFreshCachedModels(fingerprintApiKey("other-key"))).toBeUndefined();
	});

	it("treats entries older than the TTL as a miss but still returns them as stale", () => {
		saveModelListCache(fp, MODELS);
		const future = Date.now() + __testUtils.DEFAULT_TTL_MS + 1000;
		expect(loadFreshCachedModels(fp, future)).toBeUndefined();
		expect(loadAnyCachedModelCatalog(fp)?.models).toEqual(MODELS);
	});

	it("ignores a corrupt cache file", () => {
		writeFileSync(__testUtils.getCachePath(), "{ not json");
		expect(loadFreshCachedModels(fp)).toBeUndefined();
		expect(loadAnyCachedModelCatalog(fp)).toBeUndefined();
	});

	it.each([
		["non-finite", "1e309"],
		["negative", "-1"],
		["finite Date-invalid", "1e100"],
		["far-future", `${Date.now() + __testUtils.DEFAULT_TTL_MS + 1}`],
	])("ignores cache files with %s timestamps", (_label, fetchedAt) => {
		writeFileSync(
			__testUtils.getCachePath(),
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
			__testUtils.getCachePath(),
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

	it("disables read and write when the disable env flag is set", () => {
		process.env[__testUtils.DISABLE_ENV_VAR] = "1";
		saveModelListCache(fp, MODELS);
		expect(loadFreshCachedModels(fp)).toBeUndefined();
		expect(loadAnyCachedModelCatalog(fp)).toBeUndefined();
	});

	it("honors a custom TTL from the environment", () => {
		process.env[__testUtils.TTL_ENV_VAR] = "1000";
		expect(getModelCacheTtlMs()).toBe(1000);
		saveModelListCache(fp, MODELS);
		expect(loadFreshCachedModels(fp, Date.now() + 2000)).toBeUndefined();
	});

	it("falls back to the default TTL for invalid env values", () => {
		process.env[__testUtils.TTL_ENV_VAR] = "not-a-number";
		expect(getModelCacheTtlMs()).toBe(__testUtils.DEFAULT_TTL_MS);
	});

	it.each(["1", "true", "on", "yes", "enabled"])("reports disabled state from truthy env flag %s", (value) => {
		expect(isModelCacheDisabled()).toBe(false);
		process.env[__testUtils.DISABLE_ENV_VAR] = value;
		expect(isModelCacheDisabled()).toBe(true);
	});
});
