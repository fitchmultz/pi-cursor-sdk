import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { InteractionUpdate, SDKAgent } from "@cursor/sdk";
import { CursorSdkTurnCoordinator } from "../src/cursor-provider-turn-coordinator.js";
import { createCursorLiveRunAccountingState } from "../src/cursor-live-run-accounting.js";
import type { CursorLiveRun } from "../src/cursor-live-run-coordinator.js";
import { DISCARDED_INCOMPLETE_TOOL_CALL_REASON } from "../src/cursor-sdk-event-debug.js";
import { buildIncompleteCursorToolRunOutcome } from "../src/cursor-incomplete-tool-visibility.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display-state.js";
import { makeAssistantMessage } from "./helpers/pi-harness.js";

function createIncompleteShellCoordinator(): {
	coordinator: CursorSdkTurnCoordinator;
	liveRun: CursorLiveRun;
} {
	const liveRun: CursorLiveRun = {
		id: "run-incomplete-shell",
		agent: { agentId: "agent-1" } as SDKAgent,
		sessionAgentScopeKey: "scope-1",
		accounting: createCursorLiveRunAccountingState(0),
		pendingEvents: [],
		textDeltas: [],
		emittedText: "",
		recordedToolDisplayIds: [],
		done: false,
		cancelled: false,
		disposed: false,
		chainUserInputAfterCompletion: false,
	};
	const coordinator = new CursorSdkTurnCoordinator({
		stream: createAssistantMessageEventStream(),
		partial: makeAssistantMessage(""),
		cwd: process.cwd(),
		useNativeToolReplay: true,
		nativeReplayId: "replay-incomplete-shell",
		textDeltas: [],
		liveRun,
	});
	return { coordinator, liveRun };
}

function startIncompleteShell(coordinator: CursorSdkTurnCoordinator): void {
	coordinator.handleDelta({
		type: "tool-call-started",
		toolCall: { name: "shell", args: { command: "echo cursor-stuck-probe-ok" } },
		callId: "shell-stale-1",
	} as unknown as InteractionUpdate);
}

function queuedIncompleteShellCards(liveRun: CursorLiveRun): Array<{
	activityTitle?: unknown;
	activitySummary?: unknown;
	isError?: boolean;
}> {
	return liveRun.pendingEvents.flatMap((event) => {
		if (event.type !== "tool") return [];
		return [
			{
				activityTitle: event.tool.args.activityTitle,
				activitySummary: event.tool.args.activitySummary,
				isError: event.tool.isError,
			},
		];
	});
}

function queuedIncompleteShellTraces(liveRun: CursorLiveRun): string {
	return liveRun.pendingEvents
		.filter((event): event is Extract<typeof event, { type: "thinking-delta" }> => event.type === "thinking-delta")
		.map((event) => event.text)
		.join("");
}

describe("CursorSdkTurnCoordinator incomplete shell emission", () => {
	beforeEach(() => {
		nativeToolDisplayTestUtils.reset();
		nativeToolDisplayTestUtils.registerNativeToolNameForTests("cursor");
	});

	afterEach(() => {
		nativeToolDisplayTestUtils.reset();
	});

	it("does not emit a user-visible incomplete shell card after a successful text-producing turn", () => {
		const { coordinator, liveRun } = createIncompleteShellCoordinator();
		startIncompleteShell(coordinator);
		coordinator.discardIncompleteStartedToolCalls(
			buildIncompleteCursorToolRunOutcome({
				reason: DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
				assistantTextProduced: true,
			}),
		);
		expect(queuedIncompleteShellCards(liveRun)).toEqual([]);
		expect(queuedIncompleteShellTraces(liveRun)).not.toContain("Cursor shell did not complete");
		expect(queuedIncompleteShellTraces(liveRun)).not.toContain("missing completion");
	});

	it("emits a user-visible incomplete shell card when no assistant text was produced", () => {
		const { coordinator, liveRun } = createIncompleteShellCoordinator();
		startIncompleteShell(coordinator);
		coordinator.discardIncompleteStartedToolCalls(
			buildIncompleteCursorToolRunOutcome({
				reason: DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
				assistantTextProduced: false,
			}),
		);
		expect(queuedIncompleteShellCards(liveRun)).toEqual([
			{
				activityTitle: "Cursor shell",
				activitySummary: "missing completion",
				isError: true,
			},
		]);
	});

	it("emits a user-visible incomplete shell abort after a text-producing turn", () => {
		const { coordinator, liveRun } = createIncompleteShellCoordinator();
		startIncompleteShell(coordinator);
		coordinator.discardIncompleteStartedToolCalls(
			buildIncompleteCursorToolRunOutcome({
				reason: "abort",
				assistantTextProduced: true,
			}),
		);
		expect(queuedIncompleteShellCards(liveRun)).toEqual([]);
		expect(queuedIncompleteShellTraces(liveRun)).toContain("Cursor shell did not complete");
		expect(queuedIncompleteShellTraces(liveRun)).toContain("aborted");
	});

	it("emits a user-visible incomplete shell card after an SDK failure", () => {
		const { coordinator, liveRun } = createIncompleteShellCoordinator();
		startIncompleteShell(coordinator);
		coordinator.discardIncompleteStartedToolCalls(
			buildIncompleteCursorToolRunOutcome({
				reason: "sdk-failure",
				assistantTextProduced: true,
			}),
		);
		expect(queuedIncompleteShellCards(liveRun)).toEqual([
			{
				activityTitle: "Cursor shell",
				activitySummary: "SDK run failed",
				isError: true,
			},
		]);
	});
});
