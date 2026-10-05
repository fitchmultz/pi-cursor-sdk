import { join, toNamespacedPath } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeRawTestEvidence } from "./helpers/raw-test-evidence.mjs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeCursorContextFingerprint } from "../src/context.js";
import { __testUtils as cursorSessionScopeTestUtils, registerCursorSessionScope } from "../src/cursor-session-scope.js";
import { __testUtils as resumeTestUtils, registerCursorSessionAgentResume, CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE } from "../src/cursor-session-agent-resume.js";
import {
	acquireSessionCursorAgent,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { createPiHarness, makeAssistantMessage, makeContext } from "./helpers/pi-harness.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";
import { buildCursorSessionStateRoot } from "../src/cursor-session-store.js";

// Independent historical persisted bytes, not the current production key builder.
const historicalPoolKey = (scopeKey: string) => [scopeKey, "/tmp/project", '{"id":"composer-2.5"}', "",
	'{"autoReview":false,"sandboxEnabled":false}', "http1:default", "62af8704764faf8e", "bridge:absent"].join("\0");

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
		const stateRoot = buildCursorSessionStateRoot("/tmp/cursor-sdk-state/workspace", scopeKey);
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
		// Independent pre-feature bytes: admitting this handle must not depend on the new key builder.
		const poolKey = historicalPoolKey(scopeKey);
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
		expect(resumeAgent.mock.calls[0][1]).not.toHaveProperty("agents");
	});

	it("persists digest-only definitions and resumes same content, rejecting changed content from reopened JSONL", async () => {
		const root = mkdtempSync(join(tmpdir(), "cursor-custom-resume-"));
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-new-${createAgent.mock.calls.length}`, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		}));
		const resumeAgent = vi.fn().mockResolvedValue({ agentId: "agent-new-1", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const agents = { reviewer: { description: "private description", prompt: "private definition prompt", model: "inherit" as const } };
		const params = { apiKey: "test-key", cwd: root, agentMode: "agent" as const, modelSelection: { id: "fixture" },
			localResume: true, createAgent, resumeAgent, agents };
		try {
			const manager = SessionManager.create(root, join(root, "sessions"));
			const sessionManager = (manager: SessionManager) => ({
				getSessionFile: () => manager.getSessionFile(), getSessionId: () => manager.getSessionId(),
				getBranch: () => manager.getBranch(), getEntries: () => manager.getEntries(),
			});
			const pi = createPiHarness();
			pi.appendEntry.mockImplementation((type, data) => { manager.appendCustomEntry(type, data); });
			registerCursorSessionScope(pi);
			registerCursorSessionAgentResume(pi);
			await pi.runSessionStart({ cwd: root, sessionManager: sessionManager(manager) });
			manager.appendMessage({ role: "user", content: "ordinary request", timestamp: 1 });
			await pi.runBeforeAgentStart({ cwd: root, sessionManager: sessionManager(manager) });
			const lease = await acquireSessionCursorAgent(params);
			lease.commitSend(makeContext(), true);
			manager.appendMessage(makeAssistantMessage("ordinary answer"));
			await pi.runTurnEnd({}, { cwd: root, sessionManager: sessionManager(manager) });
			const file = manager.getSessionFile()!;
			const persisted = readFileSync(file, "utf8");
			expect(persisted).toContain("subagents:");
			expect(persisted).not.toContain("private definition prompt");
			expect(persisted).not.toContain("private description");
			const record = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE);
			expect(record).toMatchObject({ data: { poolKey: lease.poolKey, agentId: lease.agent.agentId } });

			await sessionAgentTestUtils.disposeAllSessionCursorAgents();
			resumeTestUtils.reset();
			const reopened = SessionManager.open(file, join(root, "sessions"), root);
			await pi.runSessionStart({ cwd: root, sessionManager: sessionManager(reopened) });
			const resumed = await acquireSessionCursorAgent(params);
			expect(resumed.resumed).toBe(true);
			expect(resumeAgent.mock.calls[0][1].agents).toEqual(agents);
			expect(resumed.sendState.bootstrapped).toBe(true);

			await sessionAgentTestUtils.disposeAllSessionCursorAgents();
			resumeTestUtils.reset();
			await pi.runSessionStart({ cwd: root, sessionManager: sessionManager(SessionManager.open(file, join(root, "sessions"), root)) });
			const changed = await acquireSessionCursorAgent({ ...params, agents: {
				reviewer: { ...agents.reviewer, prompt: "changed private prompt" },
			} });
			expect(changed.resumed).toBe(false);
			expect(changed.sendState.bootstrapped).toBe(false);
			expect(resumeAgent).toHaveBeenCalledTimes(1);
			expect(createAgent.mock.calls.at(-1)![0].agents.reviewer.prompt).toBe("changed private prompt");
			if (process.env.PI_CURSOR_TEST_EVIDENCE_DIR) {
				writeRawTestEvidence(process.env.PI_CURSOR_TEST_EVIDENCE_DIR, "custom-agent-resume.jsonl", persisted);
				writeRawTestEvidence(process.env.PI_CURSOR_TEST_EVIDENCE_DIR, "custom-agent-resume.json", JSON.stringify({
					poolKey: lease.poolKey, agentId: lease.agent.agentId, resumed: resumed.resumed,
					changedResumed: changed.resumed, changedBootstrapped: changed.sendState.bootstrapped,
					resumeCalls: resumeAgent.mock.calls.length, createCalls: createAgent.mock.calls.length,
				}, null, 2));
			}
		} finally {
			await sessionAgentTestUtils.disposeAllSessionCursorAgents();
			rmSync(root, { recursive: true, force: true });
		}
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
				poolKey: historicalPoolKey(scopeKey),
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: "old", incrementalSendCount: 5 },
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});

		const legacyLease = await acquireSessionCursorAgent(params);
		expect(legacyLease.resumed).toBe(true);
		expect(legacyLease.storeIdentity).toEqual({ version: 1, stateRoot: "/tmp/cursor-sdk-state/workspace" });
		expect(resumeAgent.mock.calls[0][1]?.local?.store).toBe(storeMock.stores[0]);

		sessionAgentTestUtils.invalidateSessionAgent(scopeKey);
		const lease = await acquireSessionCursorAgent({ ...params, forceCreate: true });
		lease.commitSend(context, true);

		expect(createAgent).toHaveBeenCalledTimes(1);
		expect(createAgent.mock.calls[0][0].local?.store).toBe(storeMock.stores[1]);
		expect(storeMock.openedOptions).toEqual([
			{ workspaceRef: "/tmp/project", stateRoot: toNamespacedPath("/tmp/cursor-sdk-state/workspace") },
			{
				workspaceRef: "/tmp/project",
				stateRoot: toNamespacedPath(buildCursorSessionStateRoot("/tmp/cursor-sdk-state/workspace", scopeKey)),
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
				poolKey: historicalPoolKey(scopeKey),
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
			const agents = { reviewer: { description: "D", prompt: "P", model: "inherit" as const } };
			const params = {
				apiKey: "test-key",
				agentMode: "agent" as const,
				cwd: "/tmp/project",
				modelSelection: { id: "composer-2.5" },
				localResume: true,
				createAgent,
				resumeAgent,
				agents,
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
					poolKey: `${historicalPoolKey(scopeKey)}\0subagents:77ec30f9ad60c1b60d34bf999c9d4e68d5d89b86ee31c3d139084d1c2a2f37c0`,
					branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
					compactionGeneration: 0,
					sendState: { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint(makeContext()), incrementalSendCount: 0 },
					createdAt: "2026-07-07T00:00:00.000Z",
				},
			});

			const lease = await acquireSessionCursorAgent(params);

			expect(storeMock.openSqliteStore).toHaveBeenNthCalledWith(1, {
				workspaceRef: "/tmp/project",
				stateRoot: toNamespacedPath("/tmp/cursor-sdk-state/workspace"),
			});
			expect(storeMock.openSqliteStore).toHaveBeenNthCalledWith(2, {
				workspaceRef: "/tmp/project",
				stateRoot: toNamespacedPath(buildCursorSessionStateRoot("/tmp/cursor-sdk-state/workspace", scopeKey)),
			});
			if (failure === "Agent.resume") {
				expect(resumeAgent.mock.calls[0][1]?.local?.store).toBe(storeMock.stores[0]);
				expect(resumeAgent.mock.calls[0][1]?.agents).toEqual(agents);
			} else {
				expect(resumeAgent).not.toHaveBeenCalled();
			}
			const createdStore = storeMock.stores[failure === "Agent.resume" ? 1 : 0];
			expect(createAgent.mock.calls[0][0].local?.store).toBe(createdStore);
			expect(createAgent.mock.calls[0][0].agents).toEqual(agents);
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
				poolKey: historicalPoolKey(scopeKey),
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: "old", incrementalSendCount: 1 },
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});

		const lease = await acquireSessionCursorAgent(params);

		expect(storeMock.openSqliteStore).toHaveBeenCalledTimes(1);
		expect(storeMock.openedOptions[0].stateRoot).toContain("pi-sessions");
		expect(storeMock.openedOptions[0].stateRoot).not.toBe(toNamespacedPath("/tmp/cursor-sdk-state/workspace"));
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
				poolKey: historicalPoolKey(scopeKey),
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
