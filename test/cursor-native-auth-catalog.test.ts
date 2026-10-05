import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, ModelRegistry, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { createExtensionRegistrationPi } from "./helpers/pi-harness.js";
import extension from "../src/index.js";
import * as sdkRuntime from "../src/cursor-sdk-runtime.js";
import { buildCursorModelSelection, getCursorModelMetadata } from "../src/model-discovery.js";
import { fingerprintApiKey, saveModelListCache, __testUtils as cache } from "../src/model-list-cache.js";

// Only external Cursor catalog data is substituted. Auth, composition,
// publication and the actual extension factory execute their real owners.
vi.mock("@cursor/sdk", () => ({ Cursor: { models: { list: vi.fn() } } }));
import { Cursor } from "@cursor/sdk";
const list = vi.mocked(Cursor.models.list);
const item = (id: string) => ({ id, displayName: id });
const login = (runtime: ModelRuntime, key: string) => runtime.login("cursor", "api_key", { prompt: async () => key, notify() {} });

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cursor-native-auth-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	vi.stubEnv("CURSOR_API_KEY", undefined);
	vi.stubEnv("PI_CURSOR_SDK_DISABLE_MODEL_CACHE", undefined);
	vi.stubEnv("PI_CURSOR_HIDE_MODELS_WHEN_LOGGED_OUT", "1");
	list.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function fixture(configKey?: string) {
	const credentials = new InMemoryCredentialStore();
	const modelsPath = join(root, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers: configKey ? { cursor: { apiKey: configKey } } : {} }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath, refreshOnCreate: false, allowModelNetwork: false });
	const registry = new ModelRegistry(runtime);
	const pi = createExtensionRegistrationPi();
	pi.registerProvider = registry.registerProvider.bind(registry);
	await extension(pi);
	const notify = vi.fn();
	await pi.runSessionStart({ modelRegistry: registry, hasUI: true, ui: { notify } });
	return { runtime, registry, credentials, pi, notify, modelsPath };
}

it("hides only unauthenticated availability, retaining known CLI selection and native login", async () => {
	const { runtime, pi } = await fixture();
	try {
		expect(await runtime.getAvailable("cursor")).toEqual([]);
		expect(resolveCliModel({ cliProvider: "cursor", cliModel: "grok-4.6", modelRuntime: runtime }).model?.id).toBe("grok-4.6");
		expect(runtime.getProvider("cursor")?.auth.apiKey?.login).toBeTypeOf("function");
		await runtime.setRuntimeApiKey("cursor", "synthetic-runtime");
		expect((await runtime.getAvailable("cursor")).length).toBeGreaterThan(0);
	} finally { await pi.runSessionShutdown(); }
});

it("real same-session login/rotation/logout updates cached metadata with zero catalog calls", async () => {
	const { runtime, pi, credentials, registry } = await fixture();
	const load = vi.spyOn(sdkRuntime, "loadCursorSdk");
	saveModelListCache(fingerprintApiKey("synthetic-login"), [{ ...item("native-cached"), aliases: ["native-alias"], variants: [{ displayName: "default", params: [{ id: "opaque", value: "retained" }] }] }]);
	const expired = JSON.parse(readFileSync(cache.getCachePath(), "utf8"));
	expired.fetchedAt = 1;
	writeFileSync(cache.getCachePath(), JSON.stringify(expired));
	try {
		await login(runtime, "synthetic-login");
		await registry.refresh({ providers: ["cursor"], allowNetwork: false, force: true });
		expect(runtime.getModels("cursor").map(m => m.id)).toEqual(["native-cached", "native-alias"]);
		expect(buildCursorModelSelection("native-alias", "off")).toEqual({ id: "native-alias", params: [{ id: "opaque", value: "retained" }] });
		expect(await credentials.read("cursor")).toMatchObject({ type: "api_key", key: "synthetic-login" });
		await login(runtime, "synthetic-rotated");
		expect(runtime.getModels("cursor").some(m => m.id === "grok-4.6")).toBe(true);
		expect(getCursorModelMetadata("native-alias")).toBeUndefined();
		await runtime.logout("cursor");
		expect(await credentials.read("cursor")).toBeUndefined();
		expect(await runtime.getAvailable("cursor")).toEqual([]);
		expect(existsSync(cache.getCachePath())).toBe(false);
		expect(load).not.toHaveBeenCalled();
		expect(list).not.toHaveBeenCalled();
	} finally { await pi.runSessionShutdown(); }
});

it("default no-auth fallback remains available and unresolved stored placeholders do not fake opt-in auth", async () => {
	vi.stubEnv("PI_CURSOR_HIDE_MODELS_WHEN_LOGGED_OUT", undefined);
	const { runtime, pi, credentials, registry } = await fixture();
	try {
		expect((await runtime.getAvailable("cursor")).length).toBeGreaterThan(0);
		vi.stubEnv("PI_CURSOR_HIDE_MODELS_WHEN_LOGGED_OUT", "1");
		await credentials.modify("cursor", async () => ({ type: "api_key", key: "pi-cursor-sdk-cursor-api-key-placeholder" }));
		await registry.refresh({ providers: ["cursor"], allowNetwork: false });
		expect(await runtime.getAvailable("cursor")).toEqual([]);
		expect(await registry.getProviderAuth("cursor")).toBeUndefined();
	} finally { await pi.runSessionShutdown(); }
});

it("keyless provider env resolves native auth, availability and catalog network phase", async () => {
	const { runtime, registry, credentials, pi } = await fixture();
	try {
		await credentials.modify("cursor", async () => ({ type: "api_key", env: { CURSOR_API_KEY: "synthetic-provider-env" } }));
		await registry.refresh({ providers: ["cursor"], allowNetwork: false });
		expect((await registry.getProviderAuth("cursor"))?.auth.apiKey).toBe("synthetic-provider-env");
		expect((await runtime.getAvailable("cursor")).length).toBeGreaterThan(0);
		expect(list).not.toHaveBeenCalled();
		list.mockResolvedValueOnce([item("provider-env-catalog")]);
		await registry.refresh({ providers: ["cursor"], allowNetwork: true });
		expect(list).toHaveBeenCalledWith({ apiKey: "synthetic-provider-env" });
		expect(runtime.getModels("cursor").map(m => m.id)).toEqual(["provider-env-catalog"]);
	} finally { await pi.runSessionShutdown(); }
});

it.each(["ambient", "config", "runtime"] as const)("stored removal preserves surviving effective %s auth and matching cache", async (source) => {
	const key = `synthetic-${source}`;
	if (source === "ambient") vi.stubEnv("CURSOR_API_KEY", key);
	const load = vi.spyOn(sdkRuntime, "loadCursorSdk");
	const { runtime, registry, pi, credentials } = await fixture(source === "config" ? key : undefined);
	try {
		await login(runtime, "synthetic-stored");
		if (source === "runtime") await runtime.setRuntimeApiKey("cursor", key);
		saveModelListCache(fingerprintApiKey(key), [item("surviving-catalog")]);
		const bytes = readFileSync(cache.getCachePath());
		// Native logout also removes runtime overrides. A backing-store removal
		// does not: refresh must respect the still-effective runtime overlay.
		if (source === "runtime") {
			await credentials.delete("cursor");
			await registry.refresh({ providers: ["cursor"], allowNetwork: false });
		} else await runtime.logout("cursor");
		expect((await registry.getProviderAuth("cursor"))?.auth.apiKey).toBe(key);
		expect(runtime.getModels("cursor").map(m => m.id)).toEqual(["surviving-catalog"]);
		expect(readFileSync(cache.getCachePath())).toEqual(bytes);
		expect(load).not.toHaveBeenCalled();
		expect(list).not.toHaveBeenCalled();
	} finally { await pi.runSessionShutdown(); }
});

it("composed config precedes ambient; runtime removal restores stored; same-session config/env changes refresh cache-only", async () => {
	vi.stubEnv("CURSOR_API_KEY", "synthetic-ambient");
	const { runtime, registry, pi, modelsPath } = await fixture("synthetic-config");
	try {
		expect((await registry.getProviderAuth("cursor"))?.auth.apiKey).toBe("synthetic-config");
		await login(runtime, "synthetic-stored");
		await runtime.setRuntimeApiKey("cursor", "synthetic-runtime");
		expect((await registry.getProviderAuth("cursor"))?.auth.apiKey).toBe("synthetic-runtime");
		await runtime.removeRuntimeApiKey("cursor");
		expect((await registry.getProviderAuth("cursor"))?.auth.apiKey).toBe("synthetic-stored");
		await runtime.setRuntimeApiKey("cursor", "synthetic-runtime-logout");
		await runtime.logout("cursor");
		expect((await registry.getProviderAuth("cursor"))?.auth.apiKey).toBe("synthetic-config");
		writeFileSync(modelsPath, JSON.stringify({ providers: { cursor: { apiKey: "synthetic-new-config" } } }));
		saveModelListCache(fingerprintApiKey("synthetic-new-config"), [item("new-config")]);
		await registry.refresh({ providers: ["cursor"], allowNetwork: false });
		expect(runtime.getModels("cursor").map(m => m.id)).toEqual(["new-config"]);
		writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
		vi.stubEnv("CURSOR_API_KEY", "synthetic-new-env");
		saveModelListCache(fingerprintApiKey("synthetic-new-env"), [item("new-env")]);
		await registry.refresh({ providers: ["cursor"], allowNetwork: false });
		expect(runtime.getModels("cursor").map(m => m.id)).toEqual(["new-env"]);
		expect(list).not.toHaveBeenCalled();
	} finally { await pi.runSessionShutdown(); }
});

it.each(["cancel", "rotation", "shutdown"] as const)("%s prevents cancellation-ignorant late catalog from mutating models/metadata/cache/warning", async (cause) => {
	const { runtime, registry, pi, notify } = await fixture();
	try {
		await login(runtime, "synthetic-current");
		list.mockResolvedValueOnce([item("current")]);
		await registry.refresh({ providers: ["cursor"], allowNetwork: true, force: true });
		let release!: () => void;
		let enter!: () => void;
		const entered = new Promise<void>(resolve => { enter = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		list.mockImplementationOnce(async () => { enter(); await gate; return [item("deliberately-late")]; });
		const controller = new AbortController();
		const pending = registry.refresh({ providers: ["cursor"], allowNetwork: true, force: true, signal: controller.signal });
		await entered;
		if (cause === "rotation") await login(runtime, "synthetic-replacement");
		else if (cause === "shutdown") await pi.runSessionShutdown();
		else controller.abort();
		const ids = runtime.getModels("cursor").map(m => m.id);
		const bytes = readFileSync(cache.getCachePath());
		notify.mockClear();
		release();
		const result = await pending;
		if (cause === "cancel") expect(result.aborted).toBe(true);
		await new Promise(resolve => setImmediate(resolve));
		expect(runtime.getModels("cursor").map(m => m.id)).toEqual(ids);
		expect(getCursorModelMetadata("deliberately-late")).toBeUndefined();
		expect(readFileSync(cache.getCachePath())).toEqual(bytes);
		if (cause !== "shutdown") await pi.runTurnStart({ modelRegistry: registry, hasUI: true, ui: { notify } });
		if (cause !== "rotation") expect(notify).not.toHaveBeenCalled();
	} finally { await pi.runSessionShutdown(); }
});

it("accepted recovery replaces warning state and logout cleanup leaves user-managed links intact", async () => {
	const { runtime, registry, pi, notify } = await fixture();
	try {
		await login(runtime, "synthetic-recovery");
		list.mockResolvedValueOnce([item("recovered")]);
		await pi.runCommand("cursor-refresh-models", "", { modelRegistry: registry, hasUI: true, ui: { notify } });
		expect(notify).toHaveBeenCalledWith("Cursor model catalog refreshed with 1 model.", "info");
		notify.mockClear();
		await pi.runTurnStart({ modelRegistry: registry, hasUI: true, ui: { notify } });
		expect(notify).not.toHaveBeenCalled();
		const owned = cache.getCachePath();
		const userFile = join(root, "user-catalog.json");
		writeFileSync(userFile, readFileSync(owned));
		rmSync(owned);
		symlinkSync(userFile, owned);
		await runtime.logout("cursor");
		expect(existsSync(userFile)).toBe(true);
		expect(existsSync(owned)).toBe(true);
	} finally { await pi.runSessionShutdown(); }
});
