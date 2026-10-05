import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeProviderModelConfig } from "./helpers/model-fixtures.js";
vi.mock("../src/model-discovery.js", () => ({ discoverModels: vi.fn() }));
vi.mock("../src/cursor-api-key.js", async (original) => ({
	...await original<typeof import("../src/cursor-api-key.js")>(),
	resolveCursorRuntimeApiKey: vi.fn(),
}));
vi.mock("../src/model-list-cache.js", async (original) => ({
	...await original<typeof import("../src/model-list-cache.js")>(),
	clearModelListCache: vi.fn(() => true),
}));
import { createCursorModelAuthResync } from "../src/cursor-model-auth-resync.js";
import { discoverModels } from "../src/model-discovery.js";
import { resolveCursorRuntimeApiKey } from "../src/cursor-api-key.js";
import { clearModelListCache } from "../src/model-list-cache.js";
const discovery = vi.mocked(discoverModels);
const resolveKey = vi.mocked(resolveCursorRuntimeApiKey);
const models = [makeProviderModelConfig("catalog")];
beforeEach(() => {
	discovery.mockReset().mockResolvedValue(models);
	resolveKey.mockReset().mockResolvedValue("key-a");
	vi.mocked(clearModelListCache).mockClear();
});

describe("owned auth catalog", () => {
	it("skips unchanged auth and applies rotation, logout and login with the exact captured key", async () => {
		const apply = vi.fn();
		const catalog = createCursorModelAuthResync(apply);
		await catalog.refresh();
		await catalog.refresh();
		expect(discovery).toHaveBeenCalledOnce();
		for (const key of ["key-b", undefined, "key-c"]) {
			resolveKey.mockResolvedValue(key);
			await catalog.refresh();
			expect(discovery.mock.lastCall?.[0]?.apiKey).toBe(key ?? null);
		}
		expect(apply).toHaveBeenCalledTimes(4);
		expect(clearModelListCache).toHaveBeenCalledTimes(3);
	});
	it.each(["discovery-failed", "empty-model-list", "cached-after-error"] as const)("retries an unchanged key after %s", async (reason) => {
		discovery.mockImplementationOnce(async options => {
			options?.onFallback?.({ reason, message: "failed" });
			return models;
		});
		const catalog = createCursorModelAuthResync(vi.fn());
		await catalog.refresh();
		await catalog.refresh();
		await catalog.refresh();
		expect(discovery).toHaveBeenCalledTimes(2);
	});
	it("does not commit the fingerprint when provider registration fails", async () => {
		const apply = vi.fn().mockImplementationOnce(() => { throw new Error("registration failed"); });
		const catalog = createCursorModelAuthResync(apply);
		await expect(catalog.refresh()).rejects.toThrow("registration failed");
		await catalog.refresh();
		expect(discovery).toHaveBeenCalledTimes(2);
		expect(apply).toHaveBeenCalledTimes(2);
	});
	it("discards superseded results, serializes the replacement, and baselines its captured key", async () => {
		let finish!: (value: typeof models) => void;
		discovery.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const apply = vi.fn();
		const catalog = createCursorModelAuthResync(apply);
		const first = catalog.refresh();
		await vi.waitFor(() => expect(discovery).toHaveBeenCalledOnce());
		const guard = discovery.mock.lastCall?.[0]?.isCurrent!;
		resolveKey.mockResolvedValue("key-b");
		const second = catalog.refresh({ force: true });
		expect(guard()).toBe(false);
		expect(discovery).toHaveBeenCalledOnce();
		finish(models);
		expect(await first).toBeUndefined();
		await second;
		await catalog.refresh();
		expect(apply).toHaveBeenCalledOnce();
		expect(discovery).toHaveBeenCalledTimes(2);
		expect(discovery.mock.lastCall?.[0]?.apiKey).toBe("key-b");
	});
	it("closes pending and queued work without publishing into a sibling", async () => {
		let finish!: (value: typeof models) => void;
		discovery.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const apply = vi.fn();
		const owner = createCursorModelAuthResync(apply);
		const siblingApply = vi.fn();
		const first = owner.refresh();
		await vi.waitFor(() => expect(discovery).toHaveBeenCalledOnce());
		const queued = owner.refresh({ force: true });
		owner.close();
		finish(models);
		await Promise.all([first, queued]);
		await owner.refresh();
		expect(apply).not.toHaveBeenCalled();
		await createCursorModelAuthResync(siblingApply).refresh();
		expect(siblingApply).toHaveBeenCalledOnce();
	});
	it("refreshes with registry auth but baselines runtime auth, including registry fallback", async () => {
		const catalog = createCursorModelAuthResync(vi.fn());
		await catalog.refresh({ force: true, resolveCommandKey: async () => "command-key" });
		expect(discovery.mock.lastCall?.[0]?.apiKey).toBe("command-key");
		await catalog.refresh();
		expect(discovery).toHaveBeenCalledOnce();
		await catalog.refresh({ force: true, resolveCommandKey: async () => undefined });
		expect(discovery.mock.lastCall?.[0]?.apiKey).toBe("key-a");
	});
});
