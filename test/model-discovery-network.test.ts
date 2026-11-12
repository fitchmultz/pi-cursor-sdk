import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { discoverModels, type CursorModelCatalogProvenance } from "../src/model-discovery.js";
import { fingerprintApiKey, saveModelListCache } from "../src/model-list-cache.js";

it.each([false, true])("does not promise an automatic discovery retry (cached=%s)", async (cached) => {
	const root = mkdtempSync(join(tmpdir(), "cursor-discovery-network-"));
	const apiKey = "synthetic-offline-key";
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	vi.stubEnv("PI_CURSOR_SDK_DISABLE_MODEL_CACHE", undefined);
	vi.stubEnv("CURSOR_API_KEY", undefined);
	const urls: string[] = [];
	// Keep the real SDK error conversion; only fail its network transport.
	vi.stubGlobal("fetch", (url: unknown) => {
		urls.push(String(url));
		return Promise.reject(new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
		}));
	});
	try {
		if (cached) {
			expect(saveModelListCache(fingerprintApiKey(apiKey), [{ id: "cached-model", displayName: "Cached model" }])).toBe(true);
		}
		const catalogs: CursorModelCatalogProvenance[] = [];
		const models = await discoverModels({ apiKey, forceRefresh: true, onCatalog: (catalog) => catalogs.push(catalog) });
		expect(models.length).toBeGreaterThan(0);
		expect(urls.filter((url) => url.endsWith("/v1/models"))).toHaveLength(1);
		expect(catalogs).toEqual([{ source: cached ? "cache" : "bundled", issue: expect.objectContaining({ reason: cached ? "cached-after-error" : "discovery-failed" }) }]);
		const issue = catalogs[0].issue;
		expect(issue?.errorMessage).toContain("Network error");
		expect(issue?.message).not.toMatch(/automatically|auto-retry/i);
		if (cached) expect(models.map((model) => model.id)).toEqual(["cached-model"]);
		else expect(issue?.message).toContain("/cursor-refresh-models");
	} finally {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});
