import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE,
	readCursorSessionAgentCleanupPlan,
	runCursorSessionAgentCleanupCommand,
	__testUtils as cleanupTestUtils,
	type CursorSessionAgentCleanupEntryData,
} from "../src/cursor-session-agent-cleanup.js";
import {
	CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
	__testUtils as resumeTestUtils,
	type CursorSessionAgentResumeEntryData,
} from "../src/cursor-session-agent-resume.js";
import { makeAssistantMessage } from "./helpers/pi-harness.js";
import { __testUtils as scopeTestUtils } from "../src/cursor-session-scope.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";
import { buildCursorSessionStateRoot } from "../src/cursor-session-store.js";

function resumeData(agentId: string, extra: Partial<CursorSessionAgentResumeEntryData> = {}): CursorSessionAgentResumeEntryData {
	return {
		version: 1,
		runtime: "local",
		agentId,
		scopeKey: "/tmp/session.jsonl",
		sessionFile: "/tmp/session.jsonl",
		sessionId: "session-1",
		cwd: "/tmp/project",
		poolKey: "pool-1",
		branchPathHash: "hash",
		compactionGeneration: 0,
		sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
		createdAt: "2026-07-08T00:00:00.000Z",
		...extra,
	};
}

const cleanupScope = {
	scopeKey: "/tmp/session.jsonl",
	sessionFile: "/tmp/session.jsonl",
	sessionId: "session-1",
	cwd: "/tmp/project",
};

function resumeEntry(id: string, data: CursorSessionAgentResumeEntryData): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: data.createdAt,
		customType: CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
		data,
	};
}

function messageEntry(id: string, parentId: string | null, role: "user" | "assistant"): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-08T00:00:00.000Z",
		message: role === "assistant"
			? makeAssistantMessage("")
			: { role: "user", content: "hello", timestamp: 1 },
	};
}

function parseCleanupPhase(value: unknown): string | undefined {
	return cleanupTestUtils.parseCleanupEntryData(value)?.phase;
}

function cleanupEntry(id: string, data: CursorSessionAgentCleanupEntryData, parentId: string | null = null): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: data.timestamp,
		customType: CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE,
		data,
	};
}

function linearEntries(entries: SessionEntry[]): SessionEntry[] {
	return entries.map((entry, index) => ({ ...entry, parentId: index === 0 ? null : entries[index - 1].id }));
}

function makeContext(entries: SessionEntry[], branch: SessionEntry[] = entries) {
	return {
		cwd: "/tmp/project",
		sessionManager: {
			getEntries: vi.fn(() => entries),
			getBranch: vi.fn(() => branch),
			getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
			getSessionId: vi.fn(() => "session-1"),
		},
		ui: { notify: vi.fn() },
	};
}

describe("cursor-session-agent-cleanup", () => {
	beforeEach(() => {
		installCursorSessionStoreMock();
		cleanupTestUtils.reset();
		cleanupTestUtils.setAppendDurability(() => true);
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "session-1");
		vi.clearAllMocks();
	});

	it("plans only recorded cleanup candidates and protects the active branch agent", () => {
		const oldEntry = resumeEntry("r1", resumeData("agent-old"));
		const activeEntry = resumeEntry("r2", resumeData("agent-active", {
			cleanupCandidateAgentIds: ["agent-old", "agent-old", "agent-*", "bc-cloud"],
		}));

		const entries = linearEntries([oldEntry, activeEntry]);
		expect(readCursorSessionAgentCleanupPlan(entries, entries, cleanupScope)).toEqual({
			candidateAgentIds: ["agent-old"],
			protectedAgentIds: ["agent-active"],
		});
	});

	it("protects an original agent still resumable from a sibling session-tree branch", async () => {
		const rootUser = messageEntry("u1", null, "user");
		const rootAssistant = messageEntry("a1", "u1", "assistant");
		const rootHash = resumeTestUtils.hashBranchStep(
			resumeTestUtils.hashBranchStep(resumeTestUtils.EMPTY_BRANCH_HASH, rootUser),
			rootAssistant,
		);
		const original = resumeEntry("r-old", resumeData("agent-old", { branchPathHash: rootHash }));
		original.parentId = "a1";
		const siblingUser = messageEntry("u-sibling", "r-old", "user");
		const forkUser = messageEntry("u-fork", "r-old", "user");
		const forkAssistant = messageEntry("a-fork", "u-fork", "assistant");
		const forkHash = resumeTestUtils.hashBranchStep(
			resumeTestUtils.hashBranchStep(rootHash, forkUser),
			forkAssistant,
		);
		const replacement = resumeEntry("r-new", resumeData("agent-new", {
			poolKey: "pool-2",
			branchPathHash: forkHash,
			cleanupCandidateAgentIds: ["agent-old"],
		}));
		replacement.parentId = "a-fork";
		const entries = [rootUser, rootAssistant, original, siblingUser, forkUser, forkAssistant, replacement];
		const activeBranch = [rootUser, rootAssistant, original, forkUser, forkAssistant, replacement];
		const plan = readCursorSessionAgentCleanupPlan(entries, activeBranch, cleanupScope);
		expect(plan).toEqual({
			candidateAgentIds: [],
			protectedAgentIds: ["agent-new", "agent-old"],
		});

		const appendEntry = vi.fn();
		const deleteAgent = vi.fn();
		cleanupTestUtils.setSdkOperations({ delete: deleteAgent });
		await runCursorSessionAgentCleanupCommand({ appendEntry }, "--yes", makeContext(entries, activeBranch));
		expect(deleteAgent).not.toHaveBeenCalled();
		expect(appendEntry).toHaveBeenCalledWith(CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE, expect.objectContaining({
			candidateAgentIds: [],
			protectedAgentIds: ["agent-new", "agent-old"],
		}));
	});

	it("fails closed without deleting when a corrupted session has multiple roots", async () => {
		const oldEntry = resumeEntry("root-old", resumeData("agent-old"));
		const replacement = resumeEntry("root-new", resumeData("agent-new", {
			cleanupCandidateAgentIds: ["agent-old"],
		}));
		const entries = [oldEntry, replacement];
		expect(readCursorSessionAgentCleanupPlan(entries, [replacement], cleanupScope)).toEqual({
			candidateAgentIds: [],
			protectedAgentIds: ["agent-new", "agent-old"],
		});

		const appendEntry = vi.fn();
		const deleteAgent = vi.fn();
		cleanupTestUtils.setSdkOperations({ delete: deleteAgent });
		await runCursorSessionAgentCleanupCommand({ appendEntry }, "--yes", makeContext(entries, [replacement]));
		expect(deleteAgent).not.toHaveBeenCalled();
	});

	it("rejects cloud and malformed resume records before cleanup planning", () => {
		const cloudEntry = resumeEntry("r1", resumeData("bc-cloud-agent", { cleanupCandidateAgentIds: ["agent-old"] }));
		const malformedEntry = resumeEntry("r2", resumeData("agent-*", { cleanupCandidateAgentIds: ["agent-other"] }));

		expect(readCursorSessionAgentCleanupPlan([cloudEntry, malformedEntry], [cloudEntry], cleanupScope)).toEqual({
			candidateAgentIds: [],
			protectedAgentIds: [],
		});
		expect(cleanupTestUtils.parseCleanupEntryData({
			action: "delete",
			phase: "unknown",
			runtime: "local",
			timestamp: "2026-07-08T00:00:00.000Z",
			candidateAgentIds: ["agent-old"],
		})).toBeUndefined();
		expect(cleanupTestUtils.parseCleanupEntryData({
			action: "dry-run",
			phase: "intent",
			runtime: "local",
			timestamp: "2026-07-08T00:00:00.000Z",
			candidateAgentIds: ["agent-old"],
		})).toBeUndefined();
	});

	it("reconciles durable intents, successful results, failed results, and legacy delete entries", () => {
		const oldEntry = resumeEntry("r1", resumeData("agent-old"));
		const activeEntry = resumeEntry("r2", resumeData("agent-active", {
			cleanupCandidateAgentIds: ["agent-old", "agent-pending", "agent-deleted", "agent-failed", "agent-invalid"],
		}));
		const legacyDeleted = cleanupEntry("c1", {
			action: "delete",
			runtime: "local",
			timestamp: "2026-07-08T00:01:00.000Z",
			candidateAgentIds: ["agent-old"],
			deletedAgentIds: ["agent-old"],
		});
		const intent = cleanupEntry("c2", {
			action: "delete",
			phase: "intent",
			runtime: "local",
			timestamp: "2026-07-08T00:02:00.000Z",
			candidateAgentIds: ["agent-pending", "agent-deleted", "agent-failed", "agent-invalid"],
		});
		const result = cleanupEntry("c3", {
			action: "delete",
			phase: "result",
			runtime: "local",
			timestamp: "2026-07-08T00:03:00.000Z",
			candidateAgentIds: ["agent-deleted", "agent-failed", "agent-invalid"],
			deletedAgentIds: ["agent-deleted"],
			failedAgentIds: [
				{ agentId: "agent-failed", error: "failed" },
				{ agentId: "agent-invalid", error: "invalid store", retryable: false },
			],
		});

		const entries = linearEntries([oldEntry, activeEntry, legacyDeleted, intent, result]);
		expect(readCursorSessionAgentCleanupPlan(
			entries,
			entries.slice(0, 2),
			cleanupScope,
		)).toEqual({
			candidateAgentIds: ["agent-failed"],
			protectedAgentIds: ["agent-active"],
		});
	});

	it("ignores cleanup candidates copied from another session scope", () => {
		const copiedEntry = resumeEntry("r1", resumeData("agent-copied", {
			scopeKey: "/tmp/other-session.jsonl",
			sessionFile: "/tmp/other-session.jsonl",
			sessionId: "other-session",
			cleanupCandidateAgentIds: ["agent-foreign"],
		}));
		const activeEntry = resumeEntry("r2", resumeData("agent-active", { cleanupCandidateAgentIds: ["agent-old"] }));

		expect(readCursorSessionAgentCleanupPlan([copiedEntry, activeEntry], [activeEntry], cleanupScope)).toEqual({
			candidateAgentIds: ["agent-old"],
			protectedAgentIds: ["agent-active"],
		});
		expect(readCursorSessionAgentCleanupPlan([copiedEntry], [copiedEntry], cleanupScope)).toEqual({
			candidateAgentIds: [],
			protectedAgentIds: [],
		});
	});

	it("dry-runs without deleting and records exact candidates", async () => {
		const entries = linearEntries([resumeEntry("r1", resumeData("agent-old")), resumeEntry("r2", resumeData("agent-active", { cleanupCandidateAgentIds: ["agent-old"] }))]);
		const appendEntry = vi.fn();
		const deleteAgent = vi.fn();
		cleanupTestUtils.setSdkOperations({ delete: deleteAgent });

		await runCursorSessionAgentCleanupCommand({ appendEntry }, "--dry-run", makeContext(entries));

		expect(deleteAgent).not.toHaveBeenCalled();
		expect(appendEntry).toHaveBeenCalledWith(CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE, expect.objectContaining({
			action: "dry-run",
			candidateAgentIds: ["agent-old"],
			protectedAgentIds: ["agent-active"],
		}));
	});

	it("records exact intent before deleting and records the result afterward", async () => {
		const entries = linearEntries([resumeEntry("r1", resumeData("agent-old")), resumeEntry("r2", resumeData("agent-active", { cleanupCandidateAgentIds: ["agent-old"] }))]);
		const callOrder: string[] = [];
		const appendEntry = vi.fn((_type: string, value?: unknown) => {
			const data = value as CursorSessionAgentCleanupEntryData;
			callOrder.push(`append:${data.phase}`);
		});
		const deleteAgent = vi.fn(async () => { callOrder.push("delete:agent-old"); });
		cleanupTestUtils.setSdkOperations({ delete: deleteAgent });

		await runCursorSessionAgentCleanupCommand({ appendEntry }, "--yes", makeContext(entries));

		expect(callOrder).toEqual(["append:intent", "delete:agent-old", "append:result"]);
		expect(deleteAgent).toHaveBeenCalledWith("agent-old", {
			cwd: "/tmp/project",
			store: expect.any(Object),
		});
		expect(appendEntry).toHaveBeenNthCalledWith(1, CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE, expect.objectContaining({
			action: "delete",
			phase: "intent",
			candidateAgentIds: ["agent-old"],
		}));
		expect(appendEntry).toHaveBeenNthCalledWith(2, CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE, expect.objectContaining({
			action: "delete",
			phase: "result",
			candidateAgentIds: ["agent-old"],
			deletedAgentIds: ["agent-old"],
		}));
	});

	it("deletes a versioned cleanup candidate from its recorded per-session store", async () => {
		const storeMock = installCursorSessionStoreMock();
		const stateRoot = buildCursorSessionStateRoot("/tmp/cursor-sdk-state", cleanupScope.scopeKey, true);
		const storeIdentity = { version: 1 as const, stateRoot };
		const entries = linearEntries([
			resumeEntry("r1", resumeData("agent-old", { version: 2, storeIdentity })),
			resumeEntry("r2", resumeData("agent-active", {
				version: 2,
				storeIdentity,
				cleanupCandidates: [{ agentId: "agent-old", storeIdentity }],
			})),
		]);
		const deleteAgent = vi.fn().mockResolvedValue(undefined);
		cleanupTestUtils.setSdkOperations({ delete: deleteAgent });

		await runCursorSessionAgentCleanupCommand({ appendEntry: vi.fn() }, "--yes", makeContext(entries));

		expect(storeMock.openSqliteStore).toHaveBeenCalledWith({ workspaceRef: "/tmp/project", stateRoot: toNamespacedPath(stateRoot) });
		expect(deleteAgent).toHaveBeenCalledWith("agent-old", {
			cwd: "/tmp/project",
			store: storeMock.stores[0],
		});
		expect(storeMock.stores[0].dispose).toHaveBeenCalledTimes(1);
	});

	it("rejects a recorded store root outside the current session identities before SDK delete", async () => {
		const entries = linearEntries([
			resumeEntry("r1", resumeData("agent-old")),
			resumeEntry("r2", resumeData("agent-active", {
				version: 2,
				storeIdentity: { version: 1, stateRoot: buildCursorSessionStateRoot("/tmp/cursor-sdk-state", cleanupScope.scopeKey, true) },
				cleanupCandidates: [{
					agentId: "agent-old",
					storeIdentity: { version: 1, stateRoot: "/tmp/untrusted-store" },
				}],
			})),
		]);
		const deleteAgent = vi.fn();
		const appendEntry = vi.fn();
		const ctx = makeContext(entries);
		cleanupTestUtils.setSdkOperations({ delete: deleteAgent });

		await runCursorSessionAgentCleanupCommand({ appendEntry }, "--yes", ctx);

		expect(deleteAgent).not.toHaveBeenCalled();
		expect(appendEntry).toHaveBeenLastCalledWith(CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE, expect.objectContaining({
			failedAgentIds: [expect.objectContaining({ agentId: "agent-old", retryable: false })],
		}));
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("1 failed"), "error");
	});

	it("persists and fsyncs real SessionManager intent before delete and result afterward", async () => {
		cleanupTestUtils.setAppendDurability(undefined);
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-local-cleanup-durable-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir, { id: "cleanup-durable" });
			manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			manager.appendMessage(makeAssistantMessage("root"));
			const sessionFile = manager.getSessionFile()!;
			scopeTestUtils.set(tempDir, sessionFile, manager.getSessionId());
			const scoped = { scopeKey: sessionFile, sessionFile, sessionId: manager.getSessionId(), cwd: tempDir };
			manager.appendCustomEntry(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, resumeData("agent-old", scoped));
			manager.appendCustomEntry(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, resumeData("agent-active", {
				...scoped,
				cleanupCandidateAgentIds: ["agent-old"],
			}));
			const order: string[] = [];
			const deleteAgent = vi.fn(async () => {
				const latest = manager.getBranch().at(-1);
				expect(latest?.type).toBe("custom");
				expect(latest?.type === "custom" ? parseCleanupPhase(latest.data) : undefined).toBe("intent");
				order.push("delete");
			});
			cleanupTestUtils.setSdkOperations({ delete: deleteAgent });
			const pi = { appendEntry: (customType: string, data: unknown) => {
				manager.appendCustomEntry(customType, data);
				order.push(`append:${parseCleanupPhase(data)}`);
			} };
			const ctx = { cwd: tempDir, sessionManager: manager, ui: { notify: vi.fn() } };

			await runCursorSessionAgentCleanupCommand(pi, "--yes", ctx);

			expect(order).toEqual(["append:intent", "delete", "append:result"]);
			const result = manager.getBranch().at(-1);
			expect(result?.type === "custom" ? parseCleanupPhase(result.data) : undefined).toBe("result");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("performs zero deletes when real SessionManager intent fsync fails", async () => {
		cleanupTestUtils.setAppendDurability(undefined);
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-local-cleanup-fsync-fail-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir, { id: "cleanup-fsync-fail" });
			manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			manager.appendMessage(makeAssistantMessage("root"));
			const sessionFile = manager.getSessionFile()!;
			scopeTestUtils.set(tempDir, sessionFile, manager.getSessionId());
			const scoped = { scopeKey: sessionFile, sessionFile, sessionId: manager.getSessionId(), cwd: tempDir };
			manager.appendCustomEntry(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, resumeData("agent-old", scoped));
			manager.appendCustomEntry(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, resumeData("agent-active", {
				...scoped,
				cleanupCandidateAgentIds: ["agent-old"],
			}));
			const deleteAgent = vi.fn();
			cleanupTestUtils.setSdkOperations({ delete: deleteAgent });
			const pi = { appendEntry: (customType: string, data: unknown) => {
				manager.appendCustomEntry(customType, data);
				if (parseCleanupPhase(data) === "intent") unlinkSync(sessionFile);
			} };
			const ctx = { cwd: tempDir, sessionManager: manager, ui: { notify: vi.fn() } };

			await runCursorSessionAgentCleanupCommand(pi, "--yes", ctx);

			expect(deleteAgent).not.toHaveBeenCalled();
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No agents were deleted"), "error");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("fails closed before SDK delete when the session file is a symlink, leaving its target untouched", async () => {
		cleanupTestUtils.setAppendDurability(undefined);
		const outsideDir = mkdtempSync(join(tmpdir(), "cursor-local-cleanup-target-"));
		const linkDir = mkdtempSync(join(tmpdir(), "cursor-local-cleanup-symlink-"));
		try {
			const target = join(outsideDir, "target.jsonl");
			writeFileSync(target, "original");
			const targetMode = statSync(target).mode & 0o777;
			const sessionFile = join(linkDir, "session.jsonl");
			symlinkSync(target, sessionFile);
			scopeTestUtils.set(linkDir, sessionFile, "session-1");

			const entries = linearEntries([
				resumeEntry("r1", resumeData("agent-old", { scopeKey: sessionFile, sessionFile, sessionId: "session-1", cwd: linkDir })),
				resumeEntry("r2", resumeData("agent-active", {
					scopeKey: sessionFile, sessionFile, sessionId: "session-1", cwd: linkDir,
					cleanupCandidateAgentIds: ["agent-old"],
				})),
			]);
			const appendEntry = vi.fn((_type: string, value?: unknown) => {
				entries.push(cleanupEntry(`c${entries.length}`, value as CursorSessionAgentCleanupEntryData, entries.at(-1)?.id ?? null));
			});
			const deleteAgent = vi.fn();
			cleanupTestUtils.setSdkOperations({ delete: deleteAgent });
			const ctx = {
				cwd: linkDir,
				sessionManager: {
					getEntries: vi.fn(() => entries),
					getBranch: vi.fn(() => entries),
					getSessionFile: vi.fn(() => sessionFile),
					getSessionId: vi.fn(() => "session-1"),
				},
				ui: { notify: vi.fn() },
			};

			await runCursorSessionAgentCleanupCommand({ appendEntry }, "--yes", ctx);

			expect(deleteAgent).not.toHaveBeenCalled();
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No agents were deleted"), "error");
			expect(readFileSync(target, "utf8")).toBe("original");
			expect(statSync(target).mode & 0o777).toBe(targetMode);
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
			rmSync(linkDir, { recursive: true, force: true });
		}
	});

	it("performs zero deletes when durable intent append fails", async () => {
		const entries = linearEntries([resumeEntry("r1", resumeData("agent-old")), resumeEntry("r2", resumeData("agent-active", { cleanupCandidateAgentIds: ["agent-old"] }))]);
		const appendEntry = vi.fn(() => { throw new Error("disk full"); });
		const deleteAgent = vi.fn();
		const ctx = makeContext(entries);
		cleanupTestUtils.setSdkOperations({ delete: deleteAgent });

		await runCursorSessionAgentCleanupCommand({ appendEntry }, "--yes", ctx);

		expect(deleteAgent).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No agents were deleted"), "error");
	});

	it("keeps a durable intent when result append fails after a delete", async () => {
		const entries = linearEntries([resumeEntry("r1", resumeData("agent-old")), resumeEntry("r2", resumeData("agent-active", { cleanupCandidateAgentIds: ["agent-old"] }))]);
		const appendEntry = vi.fn((_type: string, value?: unknown) => {
			const data = value as CursorSessionAgentCleanupEntryData;
			if (data.phase === "result") throw new Error("disk full");
			entries.push(cleanupEntry("c-intent", data, entries.at(-1)?.id ?? null));
		});
		const deleteAgent = vi.fn().mockResolvedValue(undefined);
		const ctx = makeContext(entries);
		cleanupTestUtils.setSdkOperations({ delete: deleteAgent });

		await runCursorSessionAgentCleanupCommand({ appendEntry }, "--yes", ctx);

		expect(deleteAgent).toHaveBeenCalledWith("agent-old", {
			cwd: "/tmp/project",
			store: expect.any(Object),
		});
		expect(readCursorSessionAgentCleanupPlan(entries, entries.slice(0, 2), cleanupScope).candidateAgentIds).toEqual([]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("durable intent blocks automatic retries"), "error");
	});

	it("keeps failed IDs unresolved when result append succeeds but result fsync fails", async () => {
		const entries = linearEntries([
			resumeEntry("r1", resumeData("agent-old")),
			resumeEntry("r2", resumeData("agent-active", { cleanupCandidateAgentIds: ["agent-old"] })),
		]);
		let appendId = 0;
		const appendEntry = vi.fn((_type: string, value?: unknown) => {
			entries.push(cleanupEntry(`c${++appendId}`, value as CursorSessionAgentCleanupEntryData, entries.at(-1)?.id ?? null));
		});
		cleanupTestUtils.setAppendDurability((data) => data.phase === "intent");
		cleanupTestUtils.setSdkOperations({ delete: vi.fn().mockRejectedValue(new Error("still busy")) });
		const ctx = makeContext(entries);

		await runCursorSessionAgentCleanupCommand({ appendEntry }, "--yes", ctx);

		expect(entries.some((entry) => entry.type === "custom" && parseCleanupPhase(entry.data) === "result")).toBe(true);
		expect(readCursorSessionAgentCleanupPlan(entries, entries.slice(0, 2), cleanupScope).candidateAgentIds).toEqual([]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("durable intent blocks automatic retries"), "error");
	});

	it("records partial success so only failed IDs remain retryable", async () => {
		const entries = linearEntries([resumeEntry("r1", resumeData("agent-old-1")), resumeEntry("r2", resumeData("agent-active", {
			cleanupCandidateAgentIds: ["agent-old-1", "agent-old-2"],
		}))]);
		let appendId = 0;
		const appendEntry = vi.fn((_type: string, value?: unknown) => {
			entries.push(cleanupEntry(`c${++appendId}`, value as CursorSessionAgentCleanupEntryData, entries.at(-1)?.id ?? null));
		});
		const deleteAgent = vi.fn(async (agentId: string) => {
			if (agentId === "agent-old-2") throw new Error("still busy");
		});
		cleanupTestUtils.setSdkOperations({ delete: deleteAgent });

		await runCursorSessionAgentCleanupCommand({ appendEntry }, "--yes", makeContext(entries));

		expect(readCursorSessionAgentCleanupPlan(entries, entries.slice(0, 2), cleanupScope)).toEqual({
			candidateAgentIds: ["agent-old-2"],
			protectedAgentIds: ["agent-active"],
		});
		expect(appendEntry).toHaveBeenLastCalledWith(CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE, expect.objectContaining({
			phase: "result",
			deletedAgentIds: ["agent-old-1"],
			failedAgentIds: [{ agentId: "agent-old-2", error: "still busy" }],
		}));
	});

	it("does not call delete when no exact recorded candidates exist", async () => {
		const entries = [resumeEntry("r1", resumeData("agent-active"))];
		const appendEntry = vi.fn();
		const deleteAgent = vi.fn();
		cleanupTestUtils.setSdkOperations({ delete: deleteAgent });

		await runCursorSessionAgentCleanupCommand({ appendEntry }, "--yes", makeContext(entries));

		expect(deleteAgent).not.toHaveBeenCalled();
		expect(appendEntry).toHaveBeenCalledWith(CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE, expect.objectContaining({
			action: "delete",
			phase: "result",
			candidateAgentIds: [],
			deletedAgentIds: [],
		}));
	});
});
