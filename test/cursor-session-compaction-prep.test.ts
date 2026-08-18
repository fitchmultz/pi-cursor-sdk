import type { SDKAgent } from "@cursor/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCursorSessionForCompaction } from "../src/cursor-session-compaction-prep.js";
import { cursorLiveRuns } from "../src/cursor-provider-live-run-drain.js";
import { __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { acquireSessionCursorAgent, __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import {
	persistCursorSessionAgentResumeHandle,
	registerCursorSessionAgentResume,
	__testUtils as resumeTestUtils,
} from "../src/cursor-session-agent-resume.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { resetCursorProviderTestState } from "./helpers/cursor-provider-harness.js";
import { createPiHarness } from "./helpers/pi-harness.js";

describe("prepareCursorSessionForCompaction", () => {
	beforeEach(resetCursorProviderTestState);

	it("disposes the scoped pooled session agent", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: mockDispose,
		});

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const scopeKey = "/tmp/sessions/test.jsonl";
		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});

		expect(sessionAgentTestUtils.sessionAgentsByScope.has(scopeKey)).toBe(true);
		await prepareCursorSessionForCompaction(scopeKey);
		expect(sessionAgentTestUtils.sessionAgentsByScope.has(scopeKey)).toBe(false);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("releases scoped live runs before disposing the pooled agent", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const agent = {
			agentId: "agent-1",
			send: vi.fn(),
			[Symbol.asyncDispose]: mockDispose,
		} as unknown as SDKAgent;
		const createAgent = vi.fn().mockResolvedValue(agent);

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const scopeKey = "/tmp/sessions/test.jsonl";
		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});

		const liveRun = cursorLiveRuns.start({
			id: "cursor-replay-test",
			agent,
			sessionAgentScopeKey: scopeKey,
			promptInputTokens: 0,
		});
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);

		await prepareCursorSessionForCompaction(scopeKey);

		expect(liveRun.disposed).toBe(true);
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		expect(sessionAgentTestUtils.sessionAgentsByScope.has(scopeKey)).toBe(false);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("drops a pending resume handle and suppresses persist for the summarizer send", async () => {
		const scopeKey = "/tmp/sessions/test.jsonl";
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		persistCursorSessionAgentResumeHandle({
			runtime: "local",
			agentId: "agent-summarizer",
			poolKey: "pool-1",
			sendState: { bootstrapped: true, contextFingerprint: "one-message", incrementalSendCount: 0 },
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
		});
		expect(resumeTestUtils.state.pendingHandle?.agentId).toBe("agent-summarizer");

		await prepareCursorSessionForCompaction(scopeKey);

		expect(resumeTestUtils.state.pendingHandle).toBeUndefined();
		expect(resumeTestUtils.isResumeHandlePersistSuppressed()).toBe(true);
		persistCursorSessionAgentResumeHandle({
			runtime: "local",
			agentId: "agent-summarizer-2",
			poolKey: "pool-1",
			sendState: { bootstrapped: true, contextFingerprint: "one-message", incrementalSendCount: 0 },
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
		});
		expect(resumeTestUtils.state.pendingHandle).toBeUndefined();
	});

	it("keeps persist suppressed across turn_end during compaction", async () => {
		const scopeKey = "/tmp/sessions/test.jsonl";
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		await prepareCursorSessionForCompaction(scopeKey);
		const pi = createPiHarness();
		registerCursorSessionAgentResume(pi);
		persistCursorSessionAgentResumeHandle({
			runtime: "local",
			agentId: "agent-summarizer",
			poolKey: "pool-1",
			sendState: { bootstrapped: true, contextFingerprint: "one-message", incrementalSendCount: 0 },
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
		});
		await pi.runTurnEnd({}, {
			sessionManager: {
				getSessionFile: vi.fn(() => scopeKey),
				getSessionId: vi.fn(() => "session-1"),
				getBranch: vi.fn(() => []),
			},
		});
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(resumeTestUtils.isResumeHandlePersistSuppressed()).toBe(true);
		persistCursorSessionAgentResumeHandle({
			runtime: "local",
			agentId: "agent-summarizer-2",
			poolKey: "pool-1",
			sendState: { bootstrapped: true, contextFingerprint: "one-message", incrementalSendCount: 0 },
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
		});
		expect(resumeTestUtils.state.pendingHandle).toBeUndefined();
	});
});
