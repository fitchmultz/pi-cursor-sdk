import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerCursorSessionScope, __testUtils as scopeTestUtils } from "../src/cursor-session-scope.js";
import {
	CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
	getMatchingCursorSessionAgentResumeHandle,
	parseCursorSessionAgentResumeEntryData,
	persistCursorSessionAgentResumeHandle,
	registerCursorSessionAgentResume,
	__testUtils as resumeTestUtils,
	type CursorSessionAgentResumeEntryData,
} from "../src/cursor-session-agent-resume.js";
import { createPiHarness, makeAssistantMessage } from "./helpers/pi-harness.js";

function messageEntry(id: string, parentId: string | null, role: "user" | "assistant" = "user"): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-07T00:00:00.000Z",
		message: role === "assistant"
			? makeAssistantMessage("")
			: { role: "user", content: "hello", timestamp: 1 },
	};
}

function resumeEntry(id: string, parentId: string | null, data: CursorSessionAgentResumeEntryData): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "2026-07-07T00:00:00.000Z",
		customType: CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
		data,
	};
}

describe("cursor-session-agent-resume", () => {
	beforeEach(() => {
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		vi.clearAllMocks();
	});

	it("rejects non-local and malformed agent IDs in persisted resume records", () => {
		const valid = {
			version: 1,
			runtime: "local",
			agentId: "agent-local-1",
			scopeKey: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			poolKey: "pool-1",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
			createdAt: "2026-07-07T00:00:00.000Z",
		};

		expect(parseCursorSessionAgentResumeEntryData(valid)?.agentId).toBe("agent-local-1");
		const current = {
			...valid,
			version: 2,
			storeIdentity: { version: 1, stateRoot: "/tmp/session-store" },
		};
		expect(parseCursorSessionAgentResumeEntryData(current)).toMatchObject({
			version: 2,
			storeIdentity: { version: 1, stateRoot: "/tmp/session-store" },
		});
		expect(parseCursorSessionAgentResumeEntryData({ ...current, storeIdentity: undefined })).toBeUndefined();
		expect(parseCursorSessionAgentResumeEntryData({ ...valid, agentId: `agent-${"a".repeat(250)}` })?.agentId).toHaveLength(256);
		for (const agentId of [
			"bc-cloud-1",
			"not-local",
			"agent-",
			"agent-with space",
			"agent-path/value",
			"agent-dot.value",
			"agent-control\nvalue",
			"agent-*",
			"agent-?",
			`agent-${"a".repeat(251)}`,
		]) {
			expect(parseCursorSessionAgentResumeEntryData({ ...valid, agentId }), agentId).toBeUndefined();
		}
		expect(parseCursorSessionAgentResumeEntryData({
			...valid,
			cleanupCandidateAgentIds: ["agent-old", "bc-cloud-1", "agent-*", "agent-with_under"],
		})?.cleanupCandidateAgentIds).toEqual(["agent-old", "agent-with_under"]);
	});

	it("restores only resume handles recorded on the active pi branch prefix", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentResume(pi);
		const first = messageEntry("u1", null);
		const branchHash = resumeTestUtils.hashBranchStep(resumeTestUtils.EMPTY_BRANCH_HASH, first);
		const handle: CursorSessionAgentResumeEntryData = {
			version: 1,
			runtime: "local",
			agentId: "agent-1",
			scopeKey: "/tmp/session.jsonl",
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-1",
			cwd: "/tmp/project",
			poolKey: "pool-1",
			branchPathHash: branchHash,
			compactionGeneration: 0,
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 2 },
			createdAt: "2026-07-07T00:00:00.000Z",
		};

		const persistedBranch = [first, resumeEntry("r1", "u1", handle)];
		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getSessionId: vi.fn(() => "session-1"),
				getBranch: vi.fn(() => persistedBranch),
			},
		});
		await pi.runBeforeAgentStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getSessionId: vi.fn(() => "session-1"),
				getBranch: vi.fn(() => [...persistedBranch, messageEntry("u2", "r1")]),
			},
		});

		expect(getMatchingCursorSessionAgentResumeHandle("pool-1")).toMatchObject({
			agentId: "agent-1",
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 2 },
		});
	});

	it("rejects a startup-persisted trailing user after a hard crash", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentResume(pi);
		const first = messageEntry("u1", null);
		const branchHash = resumeTestUtils.hashBranchStep(resumeTestUtils.EMPTY_BRANCH_HASH, first);
		const handle: CursorSessionAgentResumeEntryData = {
			version: 1,
			runtime: "local",
			agentId: "agent-1",
			scopeKey: "/tmp/session.jsonl",
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-1",
			cwd: "/tmp/project",
			poolKey: "pool-1",
			branchPathHash: branchHash,
			compactionGeneration: 0,
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 2 },
			createdAt: "2026-07-07T00:00:00.000Z",
		};
		const crashedBranch = [first, resumeEntry("r1", "u1", handle), messageEntry("u2", "r1")];
		const sessionManager = {
			getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
			getSessionId: vi.fn(() => "session-1"),
			getBranch: vi.fn(() => crashedBranch),
		};

		await pi.runSessionStart({ cwd: "/tmp/project", sessionManager });
		await pi.runBeforeAgentStart({ cwd: "/tmp/project", sessionManager });

		expect(getMatchingCursorSessionAgentResumeHandle("pool-1")).toBeUndefined();
	});

	it("rejects a prompt that Pi persisted before a hard-killed provider process exited", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-resume-hard-kill-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir, { id: "hard-kill-session" });
			manager.appendMessage({ role: "user", content: "completed prompt", timestamp: 1 });
			manager.appendMessage(makeAssistantMessage("completed answer"));
			const branch = manager.getBranch();
			const branchPathHash = branch.reduce(resumeTestUtils.hashBranchStep, resumeTestUtils.EMPTY_BRANCH_HASH);
			manager.appendCustomEntry(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, {
				version: 1,
				runtime: "local",
				agentId: "agent-before-crash",
				scopeKey: manager.getSessionFile()!,
				sessionFile: manager.getSessionFile()!,
				sessionId: manager.getSessionId(),
				cwd: tempDir,
				poolKey: "pool-1",
				branchPathHash,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 1 },
				createdAt: "2026-07-07T00:00:00.000Z",
			} satisfies CursorSessionAgentResumeEntryData);
			const child = spawnSync(process.execPath, [
				"--input-type=module",
				"-e",
				`import { SessionManager } from "@earendil-works/pi-coding-agent"; const manager = SessionManager.open(${JSON.stringify(manager.getSessionFile()!)}); manager.appendMessage({ role: "user", content: "submitted before crash", timestamp: 2 }); process.kill(process.pid, "SIGKILL");`,
			], { cwd: process.cwd(), encoding: "utf8" });
			expect(child.status).not.toBe(0);

			const reopened = SessionManager.open(manager.getSessionFile()!, tempDir, tempDir);
			const pi = createPiHarness();
			registerCursorSessionScope(pi);
			registerCursorSessionAgentResume(pi);
			await pi.runSessionStart({ cwd: tempDir, sessionManager: reopened });
			await pi.runBeforeAgentStart({ cwd: tempDir, sessionManager: reopened });

			expect(reopened.getBranch().at(-1)).toMatchObject({ type: "message", message: { role: "user" } });
			expect(getMatchingCursorSessionAgentResumeHandle("pool-1")).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}, process.platform === "win32" ? 20_000 : 5_000);

	it("defers resume handle persistence until turn end so it records the completed assistant path", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentResume(pi);
		const first = messageEntry("u1", null);
		const second = messageEntry("u2", "u1");
		const assistant = messageEntry("a1", "u2", "assistant");
		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getSessionId: vi.fn(() => "session-1"),
				getBranch: vi.fn(() => [first]),
			},
		});
		await pi.runBeforeAgentStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getSessionId: vi.fn(() => "session-1"),
				getBranch: vi.fn(() => [first, second]),
			},
		});

		pi.appendEntry.mockClear();
		persistCursorSessionAgentResumeHandle({
			runtime: "local",
			agentId: "agent-1",
			poolKey: "pool-1",
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
		});

		expect(pi.appendEntry).not.toHaveBeenCalled();
		await pi.runTurnEnd({}, {
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getSessionId: vi.fn(() => "session-1"),
				getBranch: vi.fn(() => [first, second, assistant]),
			},
		});

		const expectedHash = resumeTestUtils.hashBranchStep(
			resumeTestUtils.hashBranchStep(
				resumeTestUtils.hashBranchStep(resumeTestUtils.EMPTY_BRANCH_HASH, first),
				second,
			),
			assistant,
		);
		expect(pi.appendEntry).toHaveBeenCalledWith(
			CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
			expect.objectContaining({ branchPathHash: expectedHash }),
		);
	});

	it("rejects restored handles when a later assistant exists without a newer resume entry", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentResume(pi);
		const first = messageEntry("u1", null);
		const branchHash = resumeTestUtils.hashBranchStep(resumeTestUtils.EMPTY_BRANCH_HASH, first);
		const handle: CursorSessionAgentResumeEntryData = {
			version: 1,
			runtime: "local",
			agentId: "agent-1",
			scopeKey: "/tmp/session.jsonl",
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-1",
			cwd: "/tmp/project",
			poolKey: "pool-1",
			branchPathHash: branchHash,
			compactionGeneration: 0,
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 2 },
			createdAt: "2026-07-07T00:00:00.000Z",
		};

		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getSessionId: vi.fn(() => "session-1"),
				getBranch: vi.fn(() => [first, resumeEntry("r1", "u1", handle), messageEntry("a1", "r1", "assistant")]),
			},
		});

		expect(getMatchingCursorSessionAgentResumeHandle("pool-1")).toBeUndefined();
	});

	it("uses append order to supersede a legacy handle with its versioned successor", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentResume(pi);
		const first = messageEntry("u1", null);
		const assistant = messageEntry("a1", "u1", "assistant");
		const baseHash = resumeTestUtils.hashBranchStep(
			resumeTestUtils.hashBranchStep(resumeTestUtils.EMPTY_BRANCH_HASH, first),
			assistant,
		);
		const oldHandle: CursorSessionAgentResumeEntryData = {
			version: 1,
			runtime: "local",
			agentId: "agent-1",
			scopeKey: "/tmp/session.jsonl",
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-1",
			cwd: "/tmp/project",
			poolKey: "pool-1",
			branchPathHash: baseHash,
			compactionGeneration: 0,
			sendState: { bootstrapped: true, contextFingerprint: "fp-old", incrementalSendCount: 0 },
			createdAt: "2026-07-07T00:01:00.000Z",
		};
		const oldResume = resumeEntry("r1", "a1", oldHandle);
		const futureUser = messageEntry("u2", "r1");
		const futureAssistant = messageEntry("a2", "u2", "assistant");
		const futureHash = resumeTestUtils.hashBranchStep(resumeTestUtils.hashBranchStep(baseHash, futureUser), futureAssistant);
		const newerHandle: CursorSessionAgentResumeEntryData = {
			...oldHandle,
			version: 2,
			branchPathHash: futureHash,
			sendState: { bootstrapped: true, contextFingerprint: "fp-new", incrementalSendCount: 1 },
			createdAt: "2026-07-07T00:00:00.000Z",
			storeIdentity: { version: 1, stateRoot: "/tmp/cursor-sdk-state" },
		};
		const newerResume = resumeEntry("r2", "a2", newerHandle);
		const treeUser = messageEntry("u3", "r1");
		const allEntries = [first, assistant, oldResume, futureUser, futureAssistant, newerResume, treeUser];

		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getSessionId: vi.fn(() => "session-1"),
				getBranch: vi.fn(() => [first, assistant, oldResume, treeUser]),
				getEntries: vi.fn(() => allEntries),
			},
		});

		expect(getMatchingCursorSessionAgentResumeHandle("pool-1")).toBeUndefined();

		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getSessionId: vi.fn(() => "session-1"),
				getBranch: vi.fn(() => [first, assistant, oldResume, futureUser, futureAssistant, newerResume]),
				getEntries: vi.fn(() => allEntries),
			},
		});

		expect(getMatchingCursorSessionAgentResumeHandle("pool-1")).toMatchObject({
			agentId: "agent-1",
			sendState: { contextFingerprint: "fp-new", incrementalSendCount: 1 },
		});
	});

	it("restores a long resume history without positional array rescans", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentResume(pi);
		const entries = Array.from({ length: 2_000 }, (_, index) => resumeEntry(
			`r${index}`,
			index === 0 ? null : `r${index - 1}`,
			{
				version: 1,
				runtime: "local",
				agentId: "agent-1",
				scopeKey: "/tmp/session.jsonl",
				sessionFile: "/tmp/session.jsonl",
				sessionId: "session-1",
				cwd: "/tmp/project",
				poolKey: "pool-1",
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: `fp-${index}`, incrementalSendCount: index },
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		));
		entries.indexOf = vi.fn(() => { throw new Error("indexOf rescan"); });
		entries.findIndex = vi.fn(() => { throw new Error("findIndex rescan"); });

		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getSessionId: vi.fn(() => "session-1"),
				getBranch: vi.fn(() => entries),
				getEntries: vi.fn(() => entries),
			},
		});

		expect(entries.indexOf).not.toHaveBeenCalled();
		expect(entries.findIndex).not.toHaveBeenCalled();
		expect(getMatchingCursorSessionAgentResumeHandle("pool-1")).toMatchObject({
			sendState: { contextFingerprint: "fp-1999", incrementalSendCount: 1999 },
		});
	});

	it("records the previous local agent as a cleanup candidate when a new agent replaces it", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentResume(pi);
		const first = messageEntry("u1", null);
		const branchHash = resumeTestUtils.hashBranchStep(resumeTestUtils.EMPTY_BRANCH_HASH, first);
		const oldHandle: CursorSessionAgentResumeEntryData = {
			version: 1,
			runtime: "local",
			agentId: "agent-old",
			scopeKey: "/tmp/session.jsonl",
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-1",
			cwd: "/tmp/project",
			poolKey: "pool-old",
			branchPathHash: branchHash,
			compactionGeneration: 0,
			sendState: { bootstrapped: true, contextFingerprint: "fp-old", incrementalSendCount: 1 },
			createdAt: "2026-07-07T00:00:00.000Z",
		};
		const oldResume = resumeEntry("r1", "u1", oldHandle);
		const branch = [first, oldResume, messageEntry("u2", "r1")];

		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
				getSessionId: vi.fn(() => "session-1"),
				getBranch: vi.fn(() => branch),
				getEntries: vi.fn(() => branch),
			},
		});
		persistCursorSessionAgentResumeHandle({
			runtime: "local",
			agentId: "agent-new",
			poolKey: "pool-new",
			sendState: { bootstrapped: true, contextFingerprint: "fp-new", incrementalSendCount: 0 },
			storeIdentity: { version: 1, stateRoot: "/tmp/store-new" },
		});

		await pi.runTurnEnd({}, { sessionManager: { getBranch: vi.fn(() => branch) } });

		expect(pi.appendEntry).toHaveBeenCalledWith(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, expect.objectContaining({
			version: 2,
			agentId: "agent-new",
			storeIdentity: { version: 1, stateRoot: "/tmp/store-new" },
			cleanupCandidates: [{ agentId: "agent-old" }],
		}));
	});

	it("rejects copied resume entries from another session identity", async () => {
		const pi = createPiHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentResume(pi);
		const first = messageEntry("u1", null);
		const branchHash = resumeTestUtils.hashBranchStep(resumeTestUtils.EMPTY_BRANCH_HASH, first);
		const copied: CursorSessionAgentResumeEntryData = {
			version: 1,
			runtime: "local",
			agentId: "agent-1",
			scopeKey: "/tmp/original.jsonl",
			sessionFile: "/tmp/original.jsonl",
			sessionId: "original-session",
			cwd: "/tmp/project",
			poolKey: "pool-1",
			branchPathHash: branchHash,
			compactionGeneration: 0,
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
			createdAt: "2026-07-07T00:00:00.000Z",
		};

		await pi.runSessionStart({
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: vi.fn(() => "/tmp/clone.jsonl"),
				getSessionId: vi.fn(() => "clone-session"),
				getBranch: vi.fn(() => [first, resumeEntry("r1", "u1", copied)]),
			},
		});

		expect(getMatchingCursorSessionAgentResumeHandle("pool-1")).toBeUndefined();
	});

	it("clears restored handles on tree navigation and compaction", async () => {
		resumeTestUtils.set({
			scopeKey: "/tmp/session.jsonl",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 1,
				runtime: "local",
				agentId: "agent-1",
				scopeKey: "/tmp/session.jsonl",
				sessionFile: "/tmp/session.jsonl",
				cwd: "/tmp/project",
				poolKey: "pool-1",
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});
		const pi = createPiHarness();
		registerCursorSessionAgentResume(pi);

		await pi.runSessionTree();
		expect(getMatchingCursorSessionAgentResumeHandle("pool-1")).toBeUndefined();

		resumeTestUtils.set({
			activeHandle: {
				version: 1,
				runtime: "local",
				agentId: "agent-1",
				scopeKey: "/tmp/session.jsonl",
				sessionFile: "/tmp/session.jsonl",
				cwd: "/tmp/project",
				poolKey: "pool-1",
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});
		await pi.runSessionCompact();
		expect(getMatchingCursorSessionAgentResumeHandle("pool-1")).toBeUndefined();
	});
});
