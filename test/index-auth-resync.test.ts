import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import { createExtensionPi, resetIndexExtensionTestState } from "./helpers/index-extension-test-kit.js";
import { makeProviderModelConfig } from "./helpers/pi-harness.js";
import { fingerprintApiKey, saveModelListCache, __testUtils as cacheTestUtils } from "../src/model-list-cache.js";

vi.mock("../src/model-discovery.js", () => ({
	discoverModels: vi.fn(),
	getCursorModelMetadata: vi.fn(),
}));

vi.mock("../src/cursor-api-key.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/cursor-api-key.js")>();
	return {
		...actual,
		resolveCursorRuntimeApiKey: vi.fn(),
	};
});

import extensionFactory from "../src/index.js";
import { discoverModels } from "../src/model-discovery.js";
import { resolveCursorRuntimeApiKey } from "../src/cursor-api-key.js";

const mockedDiscover = vi.mocked(discoverModels);
const mockedResolveKey = vi.mocked(resolveCursorRuntimeApiKey);

describe("extension auth resync on session_start", () => {
	const originalEnv = process.env;
	let tmpAgentDir: string;

	beforeEach(async () => {
		await resetIndexExtensionTestState();
		process.env = { ...originalEnv };
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-auth-resync-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		mockedDiscover.mockReset();
		mockedResolveKey.mockReset();
	});

	afterEach(() => {
		rmSync(tmpAgentDir, { recursive: true, force: true });
		process.env = originalEnv;
	});

	it("does not rediscover when auth is unchanged between sessions", async () => {
		mockedResolveKey.mockResolvedValue("steady-key");
		mockedDiscover.mockResolvedValue([makeProviderModelConfig("composer-2")]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		expect(mockedDiscover).toHaveBeenCalledTimes(1);

		await pi.runSessionStart();
		await pi.runSessionStart({}, { reason: "reload" });

		expect(mockedDiscover).toHaveBeenCalledTimes(1);
	});

	it("rediscovers and re-registers when the key rotates", async () => {
		mockedResolveKey.mockResolvedValue("key-a");
		const startupModels = [makeProviderModelConfig("composer-2")];
		const rotatedModels = [makeProviderModelConfig("composer-3")];
		mockedDiscover.mockResolvedValueOnce(startupModels).mockResolvedValueOnce(rotatedModels);
		const pi = createExtensionPi();
		await extensionFactory(pi);

		mockedResolveKey.mockResolvedValue("key-b");
		await pi.runSessionStart();

		expect(mockedDiscover).toHaveBeenCalledTimes(2);
		const registrations = (pi._registered as Array<{ name: string; config: { models?: unknown } }>).filter(
			(entry) => entry.name === "cursor",
		);
		expect(registrations.length).toBeGreaterThanOrEqual(2);
		expect(registrations[registrations.length - 1]?.config.models).toEqual(rotatedModels);
	});

	it("clears the stale on-disk catalog and falls back after logout", async () => {
		mockedResolveKey.mockResolvedValue("key-a");
		mockedDiscover.mockResolvedValueOnce([makeProviderModelConfig("composer-2")]);
		const fallbackModels = [makeProviderModelConfig("fallback-1")];
		mockedDiscover.mockResolvedValueOnce(fallbackModels);
		const staleCatalog: ModelListItem[] = [{ id: "composer-2", displayName: "Composer 2" }];
		saveModelListCache(fingerprintApiKey("key-a"), staleCatalog);
		expect(existsSync(cacheTestUtils.getCachePath())).toBe(true);

		const pi = createExtensionPi();
		await extensionFactory(pi);

		mockedResolveKey.mockResolvedValue(undefined);
		await pi.runSessionStart();

		expect(mockedDiscover).toHaveBeenCalledTimes(2);
		expect(existsSync(cacheTestUtils.getCachePath())).toBe(false);
		const registrations = (pi._registered as Array<{ name: string; config: { models?: unknown } }>).filter(
			(entry) => entry.name === "cursor",
		);
		expect(registrations[registrations.length - 1]?.config.models).toEqual(fallbackModels);
	});
});
