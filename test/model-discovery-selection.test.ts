import { describe, it, expect, beforeEach } from "vitest";
import {
	buildCursorModelSelection,
	getCursorModelMetadata,
	getCursorModelMetadataEntries,
	__testUtils,
} from "../src/model-discovery.js";
import type { ModelListItem } from "@cursor/sdk";
import { FALLBACK_MODEL_ITEMS } from "../src/cursor-fallback-models.generated.js";

function register(items: ModelListItem[]) {
	return __testUtils.registerModelItems(items);
}

describe("buildCursorModelSelection", () => {
	beforeEach(() => {
		register([
			{
				id: "gpt-5.4",
				displayName: "GPT-5.4",
				parameters: [
					{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] },
					{
						id: "reasoning",
						displayName: "Reasoning",
						values: [
							{ value: "none" },
							{ value: "low" },
							{ value: "medium" },
							{ value: "high" },
							{ value: "extra-high" },
						],
					},
					{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
				],
				variants: [
					{
						params: [
							{ id: "context", value: "1m" },
							{ id: "reasoning", value: "medium" },
							{ id: "fast", value: "false" },
						],
						displayName: "GPT-5.4",
						isDefault: true,
					},
				],
			},
			{
				id: "claude-opus-4-7",
				displayName: "Opus 4.7",
				parameters: [
					{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
					{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "300k" }] },
					{
						id: "effort",
						displayName: "Effort",
						values: [
							{ value: "low" },
							{ value: "medium" },
							{ value: "high" },
							{ value: "xhigh" },
						],
					},
				],
				variants: [
					{
						params: [
							{ id: "thinking", value: "true" },
							{ id: "context", value: "1m" },
							{ id: "effort", value: "xhigh" },
						],
						displayName: "Opus 4.7",
						isDefault: true,
					},
				],
			},
		]);
	});

	it("uses selected context, pi thinking, and fast state", () => {
		expect(buildCursorModelSelection("gpt-5.4@272k", "xhigh", true)).toEqual({
			id: "gpt-5.4",
			params: [
				{ id: "context", value: "272k" },
				{ id: "reasoning", value: "extra-high" },
				{ id: "fast", value: "true" },
			],
		});
	});

	it("turns Claude thinking off and omits effort when pi thinking is off", () => {
		expect(buildCursorModelSelection("claude-opus-4-7@300k", "off")).toEqual({
			id: "claude-opus-4-7",
			params: [
				{ id: "thinking", value: "false" },
				{ id: "context", value: "300k" },
			],
		});
	});

	it("turns Claude thinking on and maps effort when pi thinking is enabled", () => {
		expect(buildCursorModelSelection("claude-opus-4-7@1m", "high")).toEqual({
			id: "claude-opus-4-7",
			params: [
				{ id: "thinking", value: "true" },
				{ id: "context", value: "1m" },
				{ id: "effort", value: "high" },
			],
		});
	});

	it("maps generated Gemini reasoning_effort controls without changing catalog defaults", () => {
		const gemini = FALLBACK_MODEL_ITEMS.find(({ id }) => id === "gemini-3.8-flash");
		if (!gemini) throw new Error("gemini-3.8-flash fallback fixture missing");
		const original = structuredClone(gemini);
		const [model] = register([gemini]);

		expect(model).toMatchObject({
			id: gemini.id,
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: null,
				max: null,
			},
		});
		for (const level of ["low", "medium", "high"] as const) {
			expect(buildCursorModelSelection(gemini.id, level)).toEqual({
				id: gemini.id,
				params: [{ id: "reasoning_effort", value: level }],
			});
		}
		for (const level of ["off", "minimal", "xhigh", "max"] as const) {
			expect(buildCursorModelSelection(gemini.id, level)).toEqual({
				id: gemini.id,
				params: [{ id: "reasoning_effort", value: "high" }],
			});
		}
		expect(getCursorModelMetadata(gemini.id)?.defaultParams).toEqual([{ id: "reasoning_effort", value: "high" }]);
		expect(gemini).toEqual(original);
	});

	it("passes unknown model IDs through plainly", () => {
		expect(buildCursorModelSelection("gemini-3.1-pro", "off")).toEqual({ id: "gemini-3.1-pro" });
	});

	it("returns cloned metadata entries", () => {
		const entries = getCursorModelMetadataEntries();
		const metadata = entries.find((entry) => entry.piModelId === "gpt-5.4@1m");
		expect(metadata?.defaultParams).toEqual([
			{ id: "context", value: "1m" },
			{ id: "reasoning", value: "medium" },
			{ id: "fast", value: "false" },
		]);
		metadata!.defaultParams[0].value = "mutated";
		metadata!.thinkingLevelMap!.medium = "mutated";
		expect(getCursorModelMetadata("gpt-5.4@1m")?.defaultParams[0].value).toBe("1m");
		expect(getCursorModelMetadata("gpt-5.4@1m")?.thinkingLevelMap?.medium).toBe("medium");
	});
});
