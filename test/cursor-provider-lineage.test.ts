import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asMockCursorRun,
	asMockSdkAgent,
	collectEvents,
	createPiHarness,
	makeContext,
	makeModel,
	mockedCreate,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import {
	CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE,
	registerCursorSessionAgentLineage,
	__testUtils as lineageTestUtils,
} from "../src/cursor-session-agent-lineage.js";
import { __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { registerCursorSessionScope } from "../src/cursor-session-scope.js";
import { streamCursor } from "../src/cursor-provider.js";

function successfulAgent(agentId: string) {
	return asMockSdkAgent({
		agentId,
		send: vi.fn().mockResolvedValue(asMockCursorRun({
			id: `run-${agentId}`,
			agentId,
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: `run-${agentId}`, status: "finished", result: "done" }),
		})),
	});
}

describe("cursor provider lineage", () => {
	beforeEach(async () => {
		await resetCursorProviderTestState();
		lineageTestUtils.reset();
	});

	it("appends two distinct successfully sent local agent IDs for one native pi session", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentLineage(pi);
		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionId: vi.fn(() => "session-1"),
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getEntries: vi.fn(() => []),
			},
		});
		mockedCreate
			.mockResolvedValueOnce(successfulAgent("agent-1"))
			.mockResolvedValueOnce(successfulAgent("agent-2"));

		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await sessionAgentTestUtils.resetSessionCursorAgent();
		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await pi.runTurnEnd();

		expect(pi.appendEntry.mock.calls).toEqual([
			[
				CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE,
				expect.objectContaining({ agentId: "agent-1", sessionId: "session-1" }),
			],
			[
				CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE,
				expect.objectContaining({ agentId: "agent-2", sessionId: "session-1" }),
			],
		]);
	});

	it("does not record an acquired local agent when abort prevents Agent.send", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentLineage(pi);
		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionId: vi.fn(() => "session-1"),
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getEntries: vi.fn(() => []),
			},
		});
		const controller = new AbortController();
		const send = vi.fn();
		mockedCreate.mockImplementationOnce(async () => {
			controller.abort();
			return asMockSdkAgent({ agentId: "agent-unused", send });
		});

		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal }));
		await pi.runTurnEnd();

		expect(send).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("records a local agent when Agent.send is initiated but rejects", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentLineage(pi);
		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionId: vi.fn(() => "session-1"),
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getEntries: vi.fn(() => []),
			},
		});
		mockedCreate.mockResolvedValueOnce(asMockSdkAgent({
			agentId: "agent-failed",
			send: vi.fn().mockRejectedValue(new Error("send failed")),
		}));

		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await pi.runTurnEnd();

		expect(pi.appendEntry).toHaveBeenCalledOnce();
		expect(pi.appendEntry).toHaveBeenCalledWith(
			CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE,
			expect.objectContaining({ agentId: "agent-failed", sessionId: "session-1" }),
		);
	});
});
