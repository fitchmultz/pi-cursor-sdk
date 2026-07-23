import { toNamespacedPath } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeCursorContextFingerprint } from "../src/context.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import {
	acquireSessionCursorAgent,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { makeContext } from "./helpers/pi-harness.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";
import { buildCursorSessionStateRoot } from "../src/cursor-session-store.js";

describe("cursor-session-agent local resume", () => {
	beforeEach(async () => {
		installCursorSessionStoreMock();
		cursorSessionScopeTestUtils.reset();
		resumeTestUtils.reset();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		vi.clearAllMocks();
	});

	it("resumes a recorded local SDK agent from its versioned session store", async () => {
		const storeMock = installCursorSessionStoreMock();
		const scopeKey = "/tmp/sessions/test.jsonl";
		const stateRoot = buildCursorSessionStateRoot("/tmp/cursor-sdk-state", scopeKey, true);
		const sendState = {
			bootstrapped: true,
			contextFingerprint: computeCursorContextFingerprint(makeContext()),
			incrementalSendCount: 3,
		};
		const resumedAgent = { agentId: "agent-recorded", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const resumeAgent = vi.fn().mockResolvedValue(resumedAgent);
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
			resumeAgent,
		};
		const poolKey = sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params);
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			repoRoot: undefined,
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 2,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState,
				createdAt: "2026-07-07T00:00:00.000Z",
				storeIdentity: { version: 1, stateRoot },
			},
		});

		const lease = await acquireSessionCursorAgent(params);

		expect(lease.created).toBe(true);
		expect(lease.resumed).toBe(true);
		expect(lease.agent).toBe(resumedAgent);
		expect(lease.sendState).toEqual(sendState);
		expect(storeMock.openSqliteStore).toHaveBeenCalledWith({ workspaceRef: "/tmp/project", stateRoot: toNamespacedPath(stateRoot) });
		expect(resumeAgent).toHaveBeenCalledWith(
			"agent-recorded",
			expect.objectContaining({
				apiKey: "test-key",
				model: { id: "composer-2.5" },
				mode: "agent",
				local: expect.objectContaining({ cwd: "/tmp/project", store: storeMock.stores[0] }),
			}),
		);
		expect(createAgent).not.toHaveBeenCalled();
	});

	it("resumes a legacy default-store agent before force-creating its session-store replacement", async () => {
		const storeMock = installCursorSessionStoreMock();
		const scopeKey = "/tmp/sessions/test.jsonl";
		const context = makeContext([{ role: "user", content: "Replacement", timestamp: 1 }]);
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const resumeAgent = vi.fn().mockResolvedValue({ agentId: "agent-recorded", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
			resumeAgent,
		};
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 1,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				poolKey: sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params),
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: "old", incrementalSendCount: 5 },
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});

		const legacyLease = await acquireSessionCursorAgent(params);
		expect(legacyLease.resumed).toBe(true);
		expect(legacyLease.storeIdentity).toEqual({ version: 1, stateRoot: "/tmp/cursor-sdk-state" });
		expect(resumeAgent.mock.calls[0][1]?.local?.store).toBe(storeMock.stores[0]);

		sessionAgentTestUtils.invalidateSessionAgent(scopeKey);
		const lease = await acquireSessionCursorAgent({ ...params, forceCreate: true });
		lease.commitSend(context, true);

		expect(createAgent).toHaveBeenCalledTimes(1);
		expect(createAgent.mock.calls[0][0].local?.store).toBe(storeMock.stores[1]);
		expect(storeMock.openedOptions).toEqual([
			{ workspaceRef: "/tmp/project", stateRoot: toNamespacedPath("/tmp/cursor-sdk-state") },
			{
				workspaceRef: "/tmp/project",
				stateRoot: toNamespacedPath(buildCursorSessionStateRoot("/tmp/cursor-sdk-state", scopeKey, true)),
			},
		]);
		expect(lease.resumed).toBe(false);
		expect(lease.sendState).toMatchObject({ bootstrapped: true, incrementalSendCount: 0 });
		expect(resumeTestUtils.state.pendingHandle).toMatchObject({
			agentId: "agent-new",
			poolKey: lease.poolKey,
		});
	});

	it("does not resume recorded agents unless local resume is enabled", async () => {
		const scopeKey = "/tmp/sessions/test.jsonl";
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const resumeAgent = vi.fn().mockResolvedValue({ agentId: "agent-recorded", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
			resumeAgent,
		};
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 1,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				poolKey: sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params),
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint(makeContext()), incrementalSendCount: 0 },
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});

		const lease = await acquireSessionCursorAgent(params);

		expect(lease.resumed).toBe(false);
		expect(lease.agent.agentId).toBe("agent-new");
		expect(resumeAgent).not.toHaveBeenCalled();
		expect(createAgent).toHaveBeenCalledTimes(1);
	});

	it.each(["store open", "Agent.resume"] as const)(
		"falls back from a legacy default store to the per-session store when %s fails",
		async (failure) => {
			const storeMock = installCursorSessionStoreMock();
			if (failure === "store open") storeMock.openSqliteStore.mockRejectedValueOnce(new Error("legacy index.db is locked"));
			const scopeKey = "/tmp/sessions/test.jsonl";
			const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
			const resumeAgent = vi.fn().mockRejectedValue(new Error("Agent agent-recorded not found"));
			cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
			const params = {
				apiKey: "test-key",
				agentMode: "agent" as const,
				cwd: "/tmp/project",
				modelSelection: { id: "composer-2.5" },
				localResume: true,
				createAgent,
				resumeAgent,
			};
			resumeTestUtils.set({
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				activeHandle: {
					version: 1,
					runtime: "local",
					agentId: "agent-recorded",
					scopeKey,
					sessionFile: scopeKey,
					cwd: "/tmp/project",
					poolKey: sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params),
					branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
					compactionGeneration: 0,
					sendState: { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint(makeContext()), incrementalSendCount: 0 },
					createdAt: "2026-07-07T00:00:00.000Z",
				},
			});

			const lease = await acquireSessionCursorAgent(params);

			expect(storeMock.openSqliteStore).toHaveBeenNthCalledWith(1, {
				workspaceRef: "/tmp/project",
				stateRoot: toNamespacedPath("/tmp/cursor-sdk-state"),
			});
			expect(storeMock.openSqliteStore).toHaveBeenNthCalledWith(2, {
				workspaceRef: "/tmp/project",
				stateRoot: toNamespacedPath(buildCursorSessionStateRoot("/tmp/cursor-sdk-state", scopeKey, true)),
			});
			if (failure === "Agent.resume") {
				expect(resumeAgent.mock.calls[0][1]?.local?.store).toBe(storeMock.stores[0]);
			} else {
				expect(resumeAgent).not.toHaveBeenCalled();
			}
			const createdStore = storeMock.stores[failure === "Agent.resume" ? 1 : 0];
			expect(createAgent.mock.calls[0][0].local?.store).toBe(createdStore);
			expect(lease.store).toBe(createdStore);
			expect(lease.resumed).toBe(false);
			expect(lease.resumeNotice).toContain("Could not resume prior Cursor agent");
			expect(lease.sendState.bootstrapped).toBe(false);
		},
	);

	it("never opens a legacy shared store with fileless removal ownership", async () => {
		const storeMock = installCursorSessionStoreMock();
		const sessionId = "ephemeral";
		const scopeKey = `${cursorSessionScopeTestUtils.EPHEMERAL_SESSION_SCOPE_PREFIX}${sessionId}`;
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const resumeAgent = vi.fn();
		cursorSessionScopeTestUtils.set("/tmp/project", undefined, sessionId);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
			resumeAgent,
		};
		resumeTestUtils.set({
			scopeKey,
			sessionId,
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 1,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey,
				sessionId,
				cwd: "/tmp/project",
				poolKey: sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params),
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: "old", incrementalSendCount: 1 },
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});

		const lease = await acquireSessionCursorAgent(params);

		expect(storeMock.openSqliteStore).toHaveBeenCalledTimes(1);
		expect(storeMock.openedOptions[0].stateRoot).toContain("pi-sessions");
		expect(storeMock.openedOptions[0].stateRoot).not.toBe(toNamespacedPath("/tmp/cursor-sdk-state"));
		expect(resumeAgent).not.toHaveBeenCalled();
		expect(createAgent.mock.calls[0][0].local?.store).toBe(storeMock.stores[0]);
		expect(lease.resumeNotice).toBeUndefined();
	});

	it("creates in the current session store and reports continuity when a recorded store identity is stale", async () => {
		const scopeKey = "/tmp/sessions/test.jsonl";
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const resumeAgent = vi.fn().mockResolvedValue({ agentId: "agent-recorded", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
			resumeAgent,
		};
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 2,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				poolKey: sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params),
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint(makeContext()), incrementalSendCount: 0 },
				createdAt: "2026-07-07T00:00:00.000Z",
				storeIdentity: { version: 1, stateRoot: "/tmp/stale-sdk-root" },
			},
		});

		const lease = await acquireSessionCursorAgent(params);

		expect(lease.resumed).toBe(false);
		expect(lease.resumeNotice).toContain("Could not resume prior Cursor agent");
		expect(resumeAgent).not.toHaveBeenCalled();
		expect(createAgent).toHaveBeenCalledTimes(1);
	});

	it("refreshes resume persistence on a pooled agent across false, true, and false leases", async () => {
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-1", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const scopeKey = "/tmp/sessions/test.jsonl";
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
		});
		const context = makeContext([{ role: "user", content: "Hello", timestamp: 1 }]);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const disabled = await acquireSessionCursorAgent({ ...params, localResume: false });
		disabled.commitSend(context, true);
		expect(resumeTestUtils.state.pendingHandle).toBeUndefined();

		const enabled = await acquireSessionCursorAgent({ ...params, localResume: true });
		enabled.commitSend(context, false);
		expect(resumeTestUtils.state.pendingHandle).toMatchObject({ agentId: "agent-1" });
		resumeTestUtils.state.pendingHandle = undefined;
		enabled.trackRunCompletion(Promise.resolve());

		const disabledAgain = await acquireSessionCursorAgent({ ...params, localResume: false });
		disabledAgain.commitSend(context, false);
		expect(resumeTestUtils.state.pendingHandle).toBeUndefined();
		expect(disabled.agent).toBe(enabled.agent);
		expect(enabled.agent).toBe(disabledAgain.agent);
		expect(createAgent).toHaveBeenCalledTimes(1);
	});

	it("schedules a local resume handle only after a successful send commit", async () => {
		const appendEntry = vi.fn();
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-1", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const scopeKey = "/tmp/sessions/test.jsonl";
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		resumeTestUtils.set({
			appendEntry,
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
		});
		const context = makeContext([{ role: "user", content: "Hello", timestamp: 1 }]);

		const lease = await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
		});
		lease.commitSend(context, true);

		expect(appendEntry).not.toHaveBeenCalled();
		expect(resumeTestUtils.state.pendingHandle).toMatchObject({
			runtime: "local",
			agentId: "agent-1",
			poolKey: lease.poolKey,
			sendState: expect.objectContaining({
				bootstrapped: true,
				contextFingerprint: computeCursorContextFingerprint(context),
				incrementalSendCount: 0,
			}),
		});
	});

});
