import { describe, expect, it } from "vitest";
import {
	classifyCursorRunEmission,
	isCursorRunFinishedSuccessfully,
	resolveCursorRunOutcome,
} from "../src/cursor-provider-run-outcome.js";

function makeWaitResult(status: "finished" | "cancelled" | "error", result?: string) {
	return {
		id: "run-1",
		agentId: "agent-1",
		status,
		result,
		durationMs: 1,
		model: { id: "composer-2.5" },
	};
}

describe("cursor-provider-run-outcome", () => {
	it("uses the runtime target for terminal auth guidance", () => {
		const cloud = resolveCursorRunOutcome({
			waitResult: makeWaitResult("error", "Invalid API key"),
			textDeltas: [],
			emittedText: "",
			runtimeTarget: "cloud",
		});
		const local = resolveCursorRunOutcome({
			waitResult: makeWaitResult("error", "Invalid API key"),
			textDeltas: [],
			emittedText: "",
			runtimeTarget: "local",
		});

		expect(cloud.kind === "error" && cloud.errorMessage).toContain("Cloud API authentication");
		expect(local.kind === "error" && local.errorMessage).toContain("Cursor SDK API key may be invalid or unauthorized");
	});

	it("marks successful finished runs and selects final text", () => {
		const outcome = resolveCursorRunOutcome({
			waitResult: makeWaitResult("finished", "final answer"),
			runtimeTarget: "local",
			textDeltas: ["final"],
			emittedText: "",
		});
		expect(isCursorRunFinishedSuccessfully(outcome)).toBe(true);
		expect(classifyCursorRunEmission(outcome)).toBe("finished");
		expect(outcome.kind).toBe("finished");
		if (outcome.kind === "finished") {
			expect(outcome.finalText).toBe("final answer");
			expect(outcome.assistantTextProduced).toBe(true);
		}
	});
});
