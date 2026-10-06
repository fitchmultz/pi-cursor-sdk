import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import ts from "@typescript/typescript6";
import { resolveInstalledPackageRoot } from "./helpers/installed-package.js";
import {
	buildCursorModelSelection,
	getCursorModelMetadata,
	__testUtils,
} from "../src/model-discovery.js";
import type { ModelListItem } from "@cursor/sdk";
import { FALLBACK_MODEL_ITEMS } from "../src/cursor-fallback-models.generated.js";

// Keep model-selection fixtures independent of user context-window overrides.
vi.mock("../src/context-window-cache.js", () => ({ loadContextWindowCache: () => new Map() }));

function register(items: ModelListItem[]) {
	return __testUtils.registerModelItems(items);
}

function grok47Fixture(): ModelListItem {
	// Retained SDK catalog capture, not an invented model/default contract.
	const item = FALLBACK_MODEL_ITEMS.find(({ id }) => id === "grok-4.7");
	if (!item) throw new Error("grok-4.7 fallback fixture missing");
	return structuredClone(item);
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

	it("retains the installed SDK catalog and optional selection-params declaration contract", () => {
		const path = join(resolveInstalledPackageRoot("@cursor/sdk"), "dist/esm/options.d.ts");
		const ast = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		const shapes = Object.fromEntries(ast.statements.filter(ts.isInterfaceDeclaration).map((node) => [
			node.name.text,
			node.members.map((member) => member.getText(ast)),
		]));
		expect(shapes.ModelParameterValue).toEqual(["id: string;", "value: string;"]);
		expect(shapes.ModelSelection).toEqual(["id: string;", "params?: ModelParameterValue[];"]);
		expect(shapes.ModelVariant).toEqual(expect.arrayContaining([
			"params: ModelParameterValue[];", "isDefault?: boolean;",
		]));
		expect(shapes.ModelListItem).toEqual(expect.arrayContaining([
			"id: string;", "aliases?: string[];", "parameters?: ModelParameterDefinition[];", "variants?: ModelVariant[];",
		]));
	});

	it.each(["256k", "500k"].flatMap((context) =>
		(["low", "medium", "high", "xhigh"] as const).flatMap((effort) =>
			[false, true].map((fast) => ({ context, effort, fast }))),
	))("keeps effort=$effort and fast=$fast explicit at context=$context", ({ context, effort, fast }) => {
		const item = grok47Fixture();
		const original = structuredClone(item);
		register([item]);
		expect(buildCursorModelSelection(`grok-4.7@${context}`, effort, fast)).toEqual({
			id: "grok-4.7",
			params: [
				...(context === "500k" ? [] : [{ id: "context", value: context }]),
				{ id: "reasoning_effort", value: effort },
				{ id: "fast", value: String(fast) },
			],
		});
		expect(item).toEqual(original);
	});

	it("applies the base rule to SDK aliases and speed variants without mutating metadata", () => {
		const item = { ...grok47Fixture(), aliases: ["grok-latest"] };
		register([item]);
		for (const id of ["grok-4.7", "grok-latest"]) {
			for (const context of ["256k", "500k"]) {
				for (const suffix of ["", ":fast", ":slow"]) {
					const modelId = `${id}@${context}${suffix}`;
					const metadata = getCursorModelMetadata(modelId)!;
					const original = structuredClone(metadata);
					expect(metadata.catalogDefaultContext).toBe("500k");
					expect(metadata.contextWindow).toBe(Number(context.slice(0, -1)) * 1000);
					for (const level of ["off", "minimal", "high", "max"] as const) {
						expect(buildCursorModelSelection(modelId, level)).toEqual({
							id,
							params: [
								...(context === "500k" ? [] : [{ id: "context", value: context }]),
								{ id: "reasoning_effort", value: "high" },
								{ id: "fast", value: suffix === ":slow" ? "false" : "true" },
							],
						});
					}
					const selection = buildCursorModelSelection(modelId, "medium", false);
					selection.params![0]!.value = "mutated result";
					expect(metadata).toEqual(original);
				}
			}
		}
	});

	it("refreshes the catalog baseline independently of selected context and falls back to the first variant", () => {
		const item = grok47Fixture();
		register([item]);
		expect(buildCursorModelSelection("grok-4.7@256k", "medium", true).params).toContainEqual({ id: "context", value: "256k" });
		const refreshed = grok47Fixture();
		const variant = refreshed.variants!.find(({ isDefault }) => isDefault)!;
		variant.params.find(({ id }) => id === "context")!.value = "256k";
		register([refreshed]);
		expect(buildCursorModelSelection("grok-4.7@256k", "medium", true).params).not.toContainEqual({ id: "context", value: "256k" });
		expect(buildCursorModelSelection("grok-4.7@500k", "medium", true).params).toContainEqual({ id: "context", value: "500k" });
		for (const variant of refreshed.variants!) delete variant.isDefault;
		register([refreshed]);
		expect(getCursorModelMetadata("grok-4.7@500k")?.catalogDefaultContext).toBe("256k");
		expect(buildCursorModelSelection("grok-4.7@500k", "high", false).params).toContainEqual({ id: "context", value: "500k" });
	});

	it.each(["missing-context", "missing-variants"])("does not infer a baseline with %s", (missing) => {
		const item = grok47Fixture();
		if (missing === "missing-variants") delete item.variants;
		else for (const variant of item.variants!) variant.params = variant.params.filter(({ id }) => id !== "context");
		register([item]);
		expect(getCursorModelMetadata("grok-4.7@500k")?.catalogDefaultContext).toBeUndefined();
		expect(buildCursorModelSelection("grok-4.7@500k", "high", true).params).toContainEqual({ id: "context", value: "500k" });
	});

	it("keeps matching catalog defaults explicit for other models, even a Grok-named alias", () => {
		const item = { ...grok47Fixture(), id: "another-model", aliases: ["grok-4.7"] };
		register([item]);
		for (const id of ["another-model", "grok-4.7"]) {
			expect(buildCursorModelSelection(`${id}@500k`, "high", true)).toEqual({
				id,
				params: [
					{ id: "context", value: "500k" },
					{ id: "reasoning_effort", value: "high" },
					{ id: "fast", value: "true" },
				],
			});
		}
	});

	it("passes unknown model IDs through plainly", () => {
		expect(buildCursorModelSelection("gemini-3.1-pro", "off")).toEqual({ id: "gemini-3.1-pro" });
	});
});
