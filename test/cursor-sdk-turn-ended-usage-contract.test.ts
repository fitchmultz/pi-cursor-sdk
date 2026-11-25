import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelCallCompletedUpdateSchema, TurnEndedUpdateSchema } from "@cursor/sdk";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import {
	applyCursorUsage,
	isCursorSdkUsageSafeForPiMessage,
	readCursorSdkModelCallUsageFromUpdate,
	readCursorSdkTurnUsageFromUpdate,
} from "../src/cursor-usage-accounting.js";
import { installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";
import { readInstalledPackageVersion, resolveInstalledPackageRoot } from "./helpers/installed-package.js";
import { makeModel } from "./helpers/pi-harness.js";

const sdkRoot = resolveInstalledPackageRoot("@cursor/sdk");
interface TurnEndedUsageContractFixture {
	provenance: {
		sdkPackage: string;
		sdkVersion: string;
		verified: string;
		issue: string;
		capture: string;
		notes: string[];
	};
	installedSdkPublishedTransform: {
		sdkVersion: string;
		declaration: string;
		implementationModule: string;
		totalTokensFormula: string;
		inputTokensDeclaration: string;
		docsUrl: string;
	};
	observedRawTurnEnded: Array<{
		label: string;
		model: string;
		usage: {
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
		};
	}>;
	expectedPiMappingFromRawTurnEnded: Array<{
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
	}>;
	runtimeDivergenceEvidence: {
		inputTokensDeltaTurn1ToTurn2: number;
		cacheReadDeltaTurn1ToTurn2: number;
		interpretation: string;
	};
}

function makeAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "A" }],
		api: "cursor-sdk",
		provider: "cursor",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/cursor-sdk-turn-ended-usage-1.0.23.json", import.meta.url), "utf8"),
) as TurnEndedUsageContractFixture;

describe("installed Cursor SDK turn-ended usage contract", () => {
	it("locks the published SDK TokenUsage transform alongside observed raw turn-ended semantics", async () => {
		expect(fixture.provenance.sdkPackage).toBe("@cursor/sdk");
		expect(fixture.provenance.sdkVersion).toBe("1.0.23");
		expect(fixture.provenance.issue).toContain("/issues/196");
		expect(fixture.installedSdkPublishedTransform.sdkVersion).toBe(readInstalledPackageVersion("@cursor/sdk"));

		const usageTypes = readFileSync(join(sdkRoot, "dist/esm/usage-types.d.ts"), "utf8");
		expect(usageTypes).toContain("`totalTokens` excludes `reasoningTokens`");
		expect(usageTypes).toContain("Build a `TokenUsage` from a turn-ended payload");
		// SDK 1.4.2 documents the raw semantics this provider already mapped from observation.
		const deltaTypes = readFileSync(join(sdkRoot, "dist/esm/vendor/cursor-sdk-shared/delta-types.d.ts"), "utf8");
		const normalizedDeltaTypes = deltaTypes.replace(/\s*\*\s*/g, " ");
		expect(normalizedDeltaTypes).toContain("`turn-ended` usage: `inputTokens` is the whole prompt, cache reads and writes included");
		expect(normalizedDeltaTypes).toContain(
			"One model call's tokens, sent when the call finishes. Counted like `turn-ended` usage: `inputTokens` is the whole prompt, cache reads and writes included. The turn's `turn-ended` usage is the turn's total. /\nexport declare const ModelCallCompletedUpdateSchema:",
		);

		// Published toTokenUsage/sumTokenUsage: totalTokens = inputTokens + outputTokens. Cache fields are not added again.
		const transformSource = (await installedCursorModules()).factorySource("./src/agent/usage-types.ts");
		const totals = [...transformSource.matchAll(
			/\{inputTokens:([\w$]+),outputTokens:([\w$]+),cacheReadTokens:[\w$]+,cacheWriteTokens:[\w$]+,totalTokens:([^,}]+)[,}]/g,
		)];
		expect(totals).toHaveLength(2);
		for (const [, input, output, total] of totals) expect(total).toBe(`${input}+${output}`);
		expect(fixture.installedSdkPublishedTransform.totalTokensFormula).toBe("inputTokens + outputTokens");

		const [first, second] = fixture.observedRawTurnEnded;
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second!.usage.inputTokens - first!.usage.inputTokens).toBe(
			fixture.runtimeDivergenceEvidence.inputTokensDeltaTurn1ToTurn2,
		);
		expect(second!.usage.cacheReadTokens - first!.usage.cacheReadTokens).toBe(
			fixture.runtimeDivergenceEvidence.cacheReadDeltaTurn1ToTurn2,
		);
		// Partition proof: cache fields fit inside raw inputTokens; input does not collapse when cacheRead appears.
		for (const sample of fixture.observedRawTurnEnded) {
			const { inputTokens, cacheReadTokens, cacheWriteTokens } = sample.usage;
			expect(cacheReadTokens + cacheWriteTokens).toBeLessThanOrEqual(inputTokens);
		}
		expect(second!.usage.inputTokens).toBeGreaterThan(second!.usage.cacheWriteTokens);
	});

	it("maps observed raw turn-ended.usage with full-prompt partition semantics, not an additive four-field totalTokens", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Reply with exactly: A", timestamp: 1 }],
		};

		expect(fixture.observedRawTurnEnded).toHaveLength(fixture.expectedPiMappingFromRawTurnEnded.length);
		for (const [index, sample] of fixture.observedRawTurnEnded.entries()) {
			const update = { type: "turn-ended", usage: sample.usage };
			expect(TurnEndedUpdateSchema.safeParse(update).success).toBe(true);
			const turn = readCursorSdkTurnUsageFromUpdate(update);
			expect(turn).toEqual(sample.usage);
			expect(isCursorSdkUsageSafeForPiMessage(turn!, model)).toBe(true);

			const partial = makeAssistantMessage();
			// The stale trusted occupancy floor must not override fresh LOCAL turn counts.
			applyCursorUsage(partial, model, context, 7, { runtime: "local", turn: turn!, occupancyFloor: 100000 });
			expect(partial.usage).toMatchObject(fixture.expectedPiMappingFromRawTurnEnded[index]!);
			expect(
				partial.usage.input + partial.usage.cacheRead + partial.usage.cacheWrite + partial.usage.output,
			).toBe(partial.usage.totalTokens);
			// Explicitly reject the additive four-field total (published by SDK 1.0.x) for raw local turn-ended samples.
			const additiveFourFieldTotal =
				sample.usage.inputTokens +
				sample.usage.outputTokens +
				sample.usage.cacheReadTokens +
				sample.usage.cacheWriteTokens;
			expect(partial.usage.totalTokens).not.toBe(additiveFourFieldTotal);
			expect(partial.usage.totalTokens).toBe(sample.usage.inputTokens + sample.usage.outputTokens);
			expect(calculateContextTokens(partial.usage)).toBe(partial.usage.totalTokens);

			const modelCallUpdate = { type: "model-call-completed", modelCallId: `call-${index + 1}`, usage: sample.usage };
			expect(ModelCallCompletedUpdateSchema.safeParse(modelCallUpdate).success).toBe(true);
			const modelCallUsage = readCursorSdkModelCallUsageFromUpdate(modelCallUpdate);
			expect(modelCallUsage).toEqual(sample.usage);
			const modelCallPartial = makeAssistantMessage();
			applyCursorUsage(modelCallPartial, model, context, 7, { runtime: "local", turn: modelCallUsage!, occupancyFloor: 100000 });
			expect(modelCallPartial.usage).toMatchObject(fixture.expectedPiMappingFromRawTurnEnded[index]!);
		}
	});
});
