import type { SDKAgent } from "@cursor/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCursorSessionForCompaction } from "../src/cursor-session-compaction-prep.js";
import { cursorLiveRuns } from "../src/cursor-provider-live-run-drain.js";
import { __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { acquireSessionCursorAgent, __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { resetCursorProviderTestState } from "./helpers/cursor-provider-harness.js";

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

});
