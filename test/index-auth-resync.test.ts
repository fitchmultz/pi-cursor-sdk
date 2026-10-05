import "./helpers/cursor-provider-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionPi, resetIndexExtensionTestState } from "./helpers/index-extension-test-kit.js";
import { makeProviderModelConfig, makeHarnessModel } from "./helpers/pi-harness.js";
vi.mock("../src/model-discovery.js", () => ({ discoverModels: vi.fn(), getCursorModelMetadata: vi.fn() }));
vi.mock("../src/cursor-api-key.js", async (original) => ({
	...await original<typeof import("../src/cursor-api-key.js")>(),
	resolveCursorRuntimeApiKey: vi.fn(),
}));
import extensionFactory from "../src/index.js";
import { discoverModels } from "../src/model-discovery.js";
import { resolveCursorRuntimeApiKey } from "../src/cursor-api-key.js";
const discovery = vi.mocked(discoverModels);
const resolveKey = vi.mocked(resolveCursorRuntimeApiKey);
const model = makeHarnessModel("cursor", "cursor-sdk", "catalog");
beforeEach(async () => {
	await resetIndexExtensionTestState();
	resolveKey.mockReset().mockResolvedValue(undefined);
	discovery.mockReset().mockImplementation(async options => {
		if (!options?.apiKey) {
			options?.onFallback?.({ reason: "missing-api-key", message: "missing key" });
		}
		return [makeProviderModelConfig("catalog")];
	});
});

describe("extension auth warning ownership", () => {
	it("registers listeners once and clears stale warnings before login session_start", async () => {
		const pi = createExtensionPi();
		await extensionFactory(pi);
		const listenerCount = pi.on.mock.calls.length;
		const notify = vi.fn();
		const ctx = { model, hasUI: true, ui: { notify } };
		await pi.runSessionStart(ctx);
		expect(notify).toHaveBeenCalledOnce();
		resolveKey.mockResolvedValue("new-key");
		notify.mockClear();
		await pi.runSessionStart(ctx);
		expect(notify).not.toHaveBeenCalled();
		for (let i = 0; i < 3; i++) {
			resolveKey.mockResolvedValue(undefined);
			await pi.runSessionStart(ctx);
			resolveKey.mockResolvedValue("new-key");
			await pi.runSessionStart(ctx);
		}
		expect(pi.on.mock.calls.length).toBe(listenerCount);
		expect(notify).toHaveBeenCalledTimes(3);
	});
	it("does not notify or re-register an explicit refresh that completes after shutdown", async () => {
		const pi = createExtensionPi();
		await extensionFactory(pi);
		let finish!: (models: ReturnType<typeof makeProviderModelConfig>[]) => void;
		discovery.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const notify = vi.fn();
		const count = pi._registered.length;
		const refresh = pi.runCommand("cursor-refresh-models", "", { hasUI: true, ui: { notify } });
		await vi.waitFor(() => expect(finish).toBeDefined());
		await pi.runSessionShutdown({ reason: "reload" });
		finish([makeProviderModelConfig("late")]);
		await refresh;
		expect(pi._registered).toHaveLength(count);
		expect(notify).not.toHaveBeenCalled();
	});
});
