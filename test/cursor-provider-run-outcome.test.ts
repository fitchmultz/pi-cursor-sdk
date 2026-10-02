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
	it("normalizes signal-aborted finished waits to cancelled outcomes", () => {
		const outcome = resolveCursorRunOutcome({
			waitResult: makeWaitResult("finished", "hello"),
			runtimeTarget: "local",
			signalAborted: true,
			textDeltas: ["hello"],
			emittedText: "",
		});
		expect(outcome.kind).toBe("cancelled");
		expect(isCursorRunFinishedSuccessfully(outcome)).toBe(false);
		expect(classifyCursorRunEmission(outcome)).toBe("cancelled");
	});

	it("normalizes signal-aborted error waits to cancelled outcomes", () => {
		const outcome = resolveCursorRunOutcome({
			waitResult: makeWaitResult("error", "boom"),
			runtimeTarget: "local",
			signalAborted: true,
			textDeltas: [],
			emittedText: "",
		});
		expect(outcome.kind).toBe("cancelled");
		expect(classifyCursorRunEmission(outcome)).toBe("cancelled");
	});

	it("never produces finished outcomes with signalAborted", () => {
		const outcome = resolveCursorRunOutcome({
			waitResult: makeWaitResult("finished", "hello"),
			runtimeTarget: "local",
			signalAborted: true,
			textDeltas: [],
			emittedText: "",
		});
		if (outcome.kind === "finished") {
			expect.fail("finished outcome must not carry caller abort");
		}
	});

	it("classifies SDK cancelled and error statuses for both emission strategies", () => {
		const cancelled = resolveCursorRunOutcome({
			waitResult: makeWaitResult("cancelled"),
			runtimeTarget: "local",
			textDeltas: [],
			emittedText: "",
		});
		expect(classifyCursorRunEmission(cancelled)).toBe("cancelled");

		const failed = resolveCursorRunOutcome({
			waitResult: makeWaitResult("error", "boom"),
			runtimeTarget: "local",
			textDeltas: [],
			emittedText: "",
		});
		expect(classifyCursorRunEmission(failed)).toBe("failed");
	});

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
