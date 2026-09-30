import type { Api, Model } from "@earendil-works/pi-ai";
import type { ProviderModelConfig as PiProviderModelConfig } from "@earendil-works/pi-coding-agent";

type ProviderModelConfig = Extract<PiProviderModelConfig, { reasoning: boolean }>;

export function makeModel(id = "test-model"): Model<"cursor-sdk"> {
	return {
		id,
		name: "Test Model",
		api: "cursor-sdk" as const,
		provider: "cursor",
		baseUrl: "",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

export function makeHarnessModel<TApi extends Api>(
	provider: string,
	api: TApi,
	id: string,
	overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	};
}

export function makeProviderModelConfig(
	id: string,
	overrides: Partial<ProviderModelConfig> = {},
): ProviderModelConfig {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	};
}
