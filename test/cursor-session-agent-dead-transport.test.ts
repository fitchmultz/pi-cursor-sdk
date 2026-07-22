import { beforeEach, describe, expect, it, vi } from "vitest";
import { installCursorSdkProcessErrorGuard } from "../src/cursor-sdk-process-error-guard.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import {
	acquireSessionCursorAgent,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { makeNodeClosedPipeWriteError } from "./helpers/cursor-sdk-process-error-fixtures.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";

describe("cursor-session-agent dead transport", () => {
	beforeEach(async () => {
		installCursorSessionStoreMock();
		cursorSessionScopeTestUtils.reset();
		resumeTestUtils.reset();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		vi.clearAllMocks();
	});

	it("contains the observed EPIPE only during a contained local turn and recreates just that scope", async () => {
		const firstDispose = vi.fn().mockResolvedValue(undefined);
		const secondDispose = vi.fn().mockResolvedValue(undefined);
		const otherDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi
			.fn()
			.mockResolvedValueOnce({ agentId: "agent-1", [Symbol.asyncDispose]: firstDispose })
			.mockResolvedValueOnce({ agentId: "agent-2", [Symbol.asyncDispose]: secondDispose });
		const createOtherAgent = vi
			.fn()
			.mockResolvedValue({ agentId: "agent-other", [Symbol.asyncDispose]: otherDispose });
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		// Pool an agent in an unrelated scope first; it must stay untouched throughout.
		cursorSessionScopeTestUtils.set("/tmp/other-project", "/tmp/sessions/other.jsonl");
		const other = await acquireSessionCursorAgent({ ...params, cwd: "/tmp/other-project", createAgent: createOtherAgent });

		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const first = await acquireSessionCursorAgent(params);
		const epipe = makeNodeClosedPipeWriteError();

		// Idle pooled agents alone must not broaden suppression: with no active
		// contained local turn, the observed EPIPE stays fatal.
		let idleListenerCalled = false;
		const idleListener = () => {
			idleListenerCalled = true;
		};
		process.once("uncaughtException", idleListener);
		try {
			process.emit("uncaughtException", epipe, "uncaughtException");
			expect(idleListenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", idleListener);
		}
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(first.scopeKey).status).toBe("ready");

		// During an active local turn (as wired by the provider turn runner), the exact
		// EPIPE is contained and marks this scope's transport dead.
		const turnGuard = installCursorSdkProcessErrorGuard();
		turnGuard.containLocalTransportClosedPipe(() =>
			sessionAgentTestUtils.invalidateSessionAgent(first.scopeKey, { deadTransport: true }),
		);
		let containedListenerCalled = false;
		const containedListener = () => {
			containedListenerCalled = true;
		};
		process.once("uncaughtException", containedListener);
		try {
			const emitted = process.emit("uncaughtException", epipe, "uncaughtException");
			expect(emitted).toBe(true);
			expect(containedListenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", containedListener);
			turnGuard.dispose();
		}

		const second = await acquireSessionCursorAgent(params);
		expect(second.created).toBe(true);
		expect(second.agent).not.toBe(first.agent);
		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(secondDispose).not.toHaveBeenCalled();

		// The unrelated scope was not invalidated: same agent, never disposed.
		cursorSessionScopeTestUtils.set("/tmp/other-project", "/tmp/sessions/other.jsonl");
		const otherAgain = await acquireSessionCursorAgent({ ...params, cwd: "/tmp/other-project", createAgent: createOtherAgent });
		expect(otherAgain.created).toBe(false);
		expect(otherAgain.agent).toBe(other.agent);
		expect(otherDispose).not.toHaveBeenCalled();
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
