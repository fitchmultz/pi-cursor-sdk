import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelListItem } from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CURSOR_SDK_LOCAL_MODEL_CATALOG_ENV as ENV,
	projectCursorModelsForLocalValidation,
	syncCursorSdkLocalModelCatalog,
} from "../src/cursor-local-model-catalog.js";
import { loadCursorSdk } from "../src/cursor-sdk-runtime.js";
import { openCursorSessionStoreForScope } from "../src/cursor-session-store.js";
import { fingerprintApiKey, saveModelListCache } from "../src/model-list-cache.js";

const API_KEY = "test-credential-not-real-catalog";
const MODELS: ModelListItem[] = [{
	id: "composer-2.5",
	displayName: "Composer 2.5",
	aliases: ["composer"],
	parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
	variants: [
		{ params: [{ id: "fast", value: "true" }], displayName: "Composer 2.5", isDefault: true },
		{ params: [{ id: "fast", value: "false" }], displayName: "Composer 2.5" },
	],
}, {
	id: "max-model",
	displayName: "Max Model",
	variants: [
		{ params: [{ id: "context", value: "1m" }], displayName: "Max Model 1M", isMaxMode: true },
		{ params: [{ id: "context", value: "200k" }], displayName: "Max Model 200K" },
	],
}];

describe("syncCursorSdkLocalModelCatalog", () => {
	const originalEnv = process.env;
	let agentDir: string;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env[ENV];
		delete process.env.PI_CURSOR_SDK_DISABLE_MODEL_CACHE;
		delete process.env.PI_CURSOR_SDK_MODEL_CACHE_TTL_MS;
		agentDir = mkdtempSync(join(tmpdir(), "pi-cursor-local-catalog-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		syncCursorSdkLocalModelCatalog("no-cache-for-this-key", { id: "none" }); // release any owned value
		vi.unstubAllGlobals();
		rmSync(agentDir, { recursive: true, force: true });
		process.env = originalEnv;
	});

	it("serves the fresh cached catalog when it contains the selected id or alias", () => {
		saveModelListCache(fingerprintApiKey(API_KEY), MODELS);
		syncCursorSdkLocalModelCatalog(API_KEY, { id: "composer" });
		expect(JSON.parse(process.env[ENV]!)).toEqual(projectCursorModelsForLocalValidation(MODELS));
	});

	it("projects to lookup fields and keeps variants only for models with a max-mode variant", () => {
		expect(projectCursorModelsForLocalValidation(MODELS)).toEqual([
			{ id: "composer-2.5", aliases: ["composer"] },
			{ id: "max-model", variants: [
				{ params: [{ id: "context", value: "1m" }], isMaxMode: true },
				{ params: [{ id: "context", value: "200k" }] },
			] },
		]);
	});

	it("clears its own value when the cache is missing, disabled, for another key, or lacks the model", () => {
		saveModelListCache(fingerprintApiKey(API_KEY), MODELS);
		syncCursorSdkLocalModelCatalog(API_KEY, { id: "composer-2.5" });
		syncCursorSdkLocalModelCatalog(API_KEY, { id: "new-model" });
		expect(process.env[ENV]).toBeUndefined();

		syncCursorSdkLocalModelCatalog(API_KEY, { id: "composer-2.5" });
		syncCursorSdkLocalModelCatalog("other-key", { id: "composer-2.5" });
		expect(process.env[ENV]).toBeUndefined();

		syncCursorSdkLocalModelCatalog(API_KEY, { id: "composer-2.5" });
		process.env.PI_CURSOR_SDK_DISABLE_MODEL_CACHE = "1";
		syncCursorSdkLocalModelCatalog(API_KEY, { id: "composer-2.5" });
		expect(process.env[ENV]).toBeUndefined();
	});

	it("never overwrites or clears a value it did not set", () => {
		saveModelListCache(fingerprintApiKey(API_KEY), MODELS);
		process.env[ENV] = "[{\"id\":\"user-model\"}]";
		syncCursorSdkLocalModelCatalog(API_KEY, { id: "composer-2.5" });
		expect(process.env[ENV]).toBe("[{\"id\":\"user-model\"}]");
		syncCursorSdkLocalModelCatalog(API_KEY, { id: "new-model" });
		expect(process.env[ENV]).toBe("[{\"id\":\"user-model\"}]");
	});

	// Installed SDK contract: LOCAL Agent.create validates through GET /v1/models unless the env catalog is
	// present, and the projected catalog resolves every selection exactly like the full live catalog.
	it.each([
		{ label: "alias", selection: { id: "composer" } },
		{ label: "params", selection: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] } },
		{ label: "max-mode variant", selection: { id: "max-model", params: [{ id: "context", value: "1m" }] } },
		{ label: "non-max variant", selection: { id: "max-model", params: [{ id: "context", value: "200k" }] } },
	])("installed SDK resolves the $label selection identically from the env catalog without GET /v1/models", async ({ selection }) => {
		const requests: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (request: string | URL | Request) => {
			const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
			requests.push(path);
			if (path === "/v1/models") {
				return new Response(JSON.stringify({ items: MODELS }), { status: 200, headers: { "content-type": "application/json" } });
			}
			return new Response("", { status: 401 });
		}));
		const { Agent } = await loadCursorSdk();
		const resolve = async (apiKey: string) => {
			const { sessionStore } = await openCursorSessionStoreForScope({ cwd: agentDir, scopeKey: apiKey, persistent: false });
			try {
				const agent = await Agent.create({
					apiKey,
					model: selection,
					tools: [],
					local: { cwd: agentDir, store: sessionStore.store, settingSources: [] },
				});
				await agent[Symbol.asyncDispose]();
				return agent.model;
			} finally {
				await sessionStore.dispose();
			}
		};
		// Unique keys defeat the SDK's per-process validation cache.
		const live = await resolve(`${API_KEY}-live-${selection.id}-${requests.length}`);
		expect(requests.filter((path) => path === "/v1/models")).toHaveLength(1);
		saveModelListCache(fingerprintApiKey(API_KEY), MODELS);
		syncCursorSdkLocalModelCatalog(API_KEY, selection);
		const cached = await resolve(`${API_KEY}-cached-${selection.id}-${requests.length}`);
		expect(requests.filter((path) => path === "/v1/models")).toHaveLength(1);
		expect(cached).toEqual(live);
		if (selection.params?.[0]?.value === "1m") expect(live).toMatchObject({ maxMode: true });
	}, 30_000);
});
