import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { CURSOR_API_KEY_CONFIG_VALUE } from "../src/cursor-api-key.js";
import { makeProviderModelConfig } from "./helpers/model-fixtures.js";

it("native Pi retains login with an empty extension catalog and applies extension catalog precedence over models.json", async () => {
	const root = await mkdtemp(join(tmpdir(), "cursor-auth-native-"));
	try {
		const credentials = new InMemoryCredentialStore();
		const modelsPath = join(root, "models.json");
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath,
			modelsStorePath: join(root, "model-store.json"),
			allowModelNetwork: false,
		});
		runtime.registerProvider("cursor", {
			api: "cursor-sdk",
			apiKey: CURSOR_API_KEY_CONFIG_VALUE,
			baseUrl: "http://127.0.0.1",
			models: [],
		});
		expect(runtime.getModels("cursor")).toHaveLength(0);
		expect(runtime.getProvider("cursor")).toBeDefined();
		const prompt = async () => "offline-test-key";
		await runtime.login("cursor", "api_key", { prompt, notify: () => {} }, {});
		expect(await runtime.getAuth("cursor")).toMatchObject({ auth: { apiKey: "offline-test-key" } });
		await runtime.logout("cursor");
		expect(runtime.getModels("cursor")).toHaveLength(0);
		expect(runtime.getProvider("cursor")).toBeDefined();

		await writeFile(modelsPath, JSON.stringify({ providers: { cursor: {
			baseUrl: "http://127.0.0.1",
			api: "cursor-sdk",
			models: [makeProviderModelConfig("configured-model")],
		} } }));
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModels("cursor").map(model => model.id)).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
