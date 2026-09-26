import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import {
	acquireSessionCursorAgent,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";

describe("cursor-session-agent dead transport", () => {
	beforeEach(async () => {
		installCursorSessionStoreMock();
		cursorSessionScopeTestUtils.reset();
		resumeTestUtils.reset();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		vi.clearAllMocks();
	});

	it("bounds disposal of a dead-transport agent so the next acquire recreates instead of hanging", async () => {
		const hangingDispose = vi.fn().mockReturnValue(new Promise<never>(() => {}));
		const secondDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi
			.fn()
			.mockResolvedValueOnce({ agentId: "agent-1", [Symbol.asyncDispose]: hangingDispose })
			.mockResolvedValueOnce({ agentId: "agent-2", [Symbol.asyncDispose]: secondDispose });
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const first = await acquireSessionCursorAgent(params);
		const previousTimeout = sessionAgentTestUtils.setDeadTransportAgentDisposeTimeoutMs(25);
		try {
			sessionAgentTestUtils.invalidateSessionAgent(first.scopeKey, { deadTransport: true });
			const second = await acquireSessionCursorAgent(params);
			expect(second.created).toBe(true);
			expect(second.agent).not.toBe(first.agent);
			expect(hangingDispose).toHaveBeenCalledTimes(1);
		} finally {
			sessionAgentTestUtils.setDeadTransportAgentDisposeTimeoutMs(previousTimeout);
		}
	});
});
