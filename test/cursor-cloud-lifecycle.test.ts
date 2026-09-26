import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	CLOUD_LIFECYCLE_ENTRY_TYPE,
	__testUtils as cloudLifecycleTestUtils,
	formatCursorCloudLifecycleList,
	recordCursorCloudLifecycleRun,
	registerCursorCloudLifecycleLedger,
	runCursorCloudLifecycleCommand,
} from "../src/cursor-cloud-lifecycle.js";
import { MAX_CLOUD_REPORT_BRANCHES } from "../src/cursor-cloud-reporting.js";
import { createPiHarness, makeAssistantMessage, type PiHarness } from "./helpers/pi-harness.js";

function lifecycleEntry(id: string, data: Record<string, unknown>): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-07-07T00:00:00.000Z",
		customType: CLOUD_LIFECYCLE_ENTRY_TYPE,
		data,
	};
}

function cloudAgentId(index = 1): string {
	return `bc-00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
}

function recordEntry(agentId = cloudAgentId()): SessionEntry {
	return lifecycleEntry(`record-${agentId}`, {
		action: "record",
		runtime: "cloud",
		agentId,
		runId: "run-1",
		timestamp: "2026-07-07T00:00:00.000Z",
		branches: [{ repoUrl: "github.com/acme/repo", branch: "cursor/work", prUrl: "https://github.com/acme/repo/pull/7" }],
	});
}

function hostPersistsCustomEntriesBeforeFirstResponse(): boolean {
	const tempDir = mkdtempSync(join(tmpdir(), "cursor-cloud-pi-persistence-probe-"));
	try {
		const manager = SessionManager.create(tempDir, tempDir, { id: "cloud-lifecycle-persistence-probe" });
		manager.appendCustomEntry(CLOUD_LIFECYCLE_ENTRY_TYPE, { probe: true });
		return existsSync(manager.getSessionFile()!);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

// Official Pi defers the session file until the first assistant message; the fitchmultz/pi fork writes custom entries eagerly.
const eagerCustomEntryHost = hostPersistsCustomEntriesBeforeFirstResponse();

function resetCloudLifecycleTestState(): void {
	cloudLifecycleTestUtils.reset();
	cloudLifecycleTestUtils.setRuntimeApiKeyResolver(async () => "test-key");
}

function registerCloudLifecycle(pi: PiHarness): void {
	registerCursorCloudLifecycleLedger(pi);
	pi.registerCommand("cursor-cloud", {
		description: "test",
		handler: (args, ctx) => runCursorCloudLifecycleCommand(pi, args, ctx),
	});
}

describe("Cursor cloud lifecycle ledger", () => {
	beforeEach(() => {
		resetCloudLifecycleTestState();
		cloudLifecycleTestUtils.setDurableWriter(() => true);
	});

	afterEach(() => {
		cloudLifecycleTestUtils.reset();
		vi.clearAllMocks();
	});

	it("records successful cloud run lifecycle metadata in session custom entries", () => {
		const pi = createPiHarness();
		registerCloudLifecycle(pi);

		expect(recordCursorCloudLifecycleRun({
			agentId: cloudAgentId(),
			runId: "run-1",
			branches: [{ repoUrl: "github.com/acme/repo", branch: "cursor/work", prUrl: "https://github.com/acme/repo/pull/7" }],
			artifacts: [{ path: "artifacts/report.txt", sizeBytes: 12, updatedAt: "2026-07-07T00:00:00Z" }],
		})).toBe(true);

		expect(pi.appendEntry).toHaveBeenCalledWith(CLOUD_LIFECYCLE_ENTRY_TYPE, expect.objectContaining({
			action: "record",
			runtime: "cloud",
			agentId: cloudAgentId(),
			runId: "run-1",
			branches: [expect.objectContaining({ branch: "cursor/work", prUrl: "https://github.com/acme/repo/pull/7" })],
		}));
		expect(pi.appendEntry.mock.calls[0]?.[1]).not.toHaveProperty("artifacts");
		expect(pi.appendEntry.mock.calls[0]?.[1]).not.toHaveProperty("cwd");
		expect(pi.appendEntry.mock.calls[0]?.[1]).not.toHaveProperty("sessionFile");
		expect(pi.appendEntry.mock.calls[0]?.[1]).not.toHaveProperty("sessionName");
	});

	it("fsyncs a Pi anchor before the durable journal and fails closed when fsync fails", () => {
		const order: string[] = [];
		const pi = createPiHarness();
		pi.appendEntry.mockImplementation(() => { order.push("pi-entry"); });
		cloudLifecycleTestUtils.setSessionFsync(() => { order.push("session-fsync"); return true; });
		cloudLifecycleTestUtils.setDurableWriter(() => { order.push("journal-fsync"); return true; });
		registerCloudLifecycle(pi);

		expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(), branches: [] })).toBe(true);
		expect(order).toEqual(["pi-entry", "session-fsync", "journal-fsync"]);

		order.length = 0;
		cloudLifecycleTestUtils.setSessionFsync(() => { order.push("session-fsync"); return false; });
		expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(2), branches: [] })).toBe(false);
		expect(order).toEqual(["pi-entry", "session-fsync"]);
	});

	it("tracks Pi's installed custom-entry persistence boundary", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cloud-pi-session-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir, { id: "cloud-lifecycle-contract" });
			const entryId = manager.appendCustomEntry(CLOUD_LIFECYCLE_ENTRY_TYPE, { contract: true });
			if (!eagerCustomEntryHost) {
				expect(existsSync(manager.getSessionFile()!)).toBe(false);
				manager.appendMessage(makeAssistantMessage("persist session"));
			}
			expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain(`"id":"${entryId}"`);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects lifecycle recording without a durable session", () => {
		resetCloudLifecycleTestState();
		const pi = createPiHarness();
		registerCloudLifecycle(pi);

		expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(), branches: [] })).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")("rejects a symlinked lifecycle journal without reading or modifying its target", async () => {
		resetCloudLifecycleTestState();
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cloud-journal-nofollow-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "cursor-cloud-journal-target-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir, { id: "journal-nofollow" });
			manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			manager.appendMessage(makeAssistantMessage("persist session"));
			const recordedAgent = cloudAgentId(1);
			const forgedAgent = cloudAgentId(2);
			manager.appendCustomEntry(CLOUD_LIFECYCLE_ENTRY_TYPE, {
				action: "record", runtime: "cloud", agentId: recordedAgent,
				timestamp: "2026-07-07T00:00:00.000Z", branches: [],
			});
			const sessionManager = {
				getBranch: () => manager.getBranch(),
				getSessionFile: () => manager.getSessionFile(),
				getSessionId: () => manager.getSessionId(),
			};
			const target = join(outsideDir, "forged.journal");
			const forged = `${JSON.stringify({
				version: 1, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), anchorEntryId: manager.getLeafId(),
				action: "record", runtime: "cloud", agentId: forgedAgent, timestamp: "2026-07-07T00:00:01.000Z", branches: [],
			})}\n`;
			writeFileSync(target, forged);
			chmodSync(target, 0o640);
			const journal = cloudLifecycleTestUtils.durableLedgerPath(manager.getSessionFile()!, manager.getSessionId());
			symlinkSync(target, journal);
			const targetMode = statSync(target).mode & 0o777;
			const archive = vi.fn().mockResolvedValue(undefined);
			cloudLifecycleTestUtils.setSdkOperations({ archive, delete: vi.fn() });
			const pi = createPiHarness();
			pi.appendEntry.mockImplementation((customType, data) => manager.appendCustomEntry(customType, data));
			registerCloudLifecycle(pi);
			await pi.runSessionStart({ cwd: tempDir, sessionManager });

			const notify = vi.fn();
			await pi.runCommand("cursor-cloud", "list", { cwd: tempDir, sessionManager, ui: { notify } });
			expect(notify.mock.calls.at(-1)?.[0]).not.toContain(forgedAgent);
			expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(3), branches: [] })).toBe(false);
			await pi.runCommand("cursor-cloud", `archive ${recordedAgent}`, { cwd: tempDir, sessionManager });

			expect(archive).not.toHaveBeenCalled();
			expect(readFileSync(target, "utf8")).toBe(forged);
			expect(statSync(target).mode & 0o777).toBe(targetMode);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it.skipIf(eagerCustomEntryHost)("recovers a framed first-turn ledger across real timestamped SessionManager paths", async () => {
		resetCloudLifecycleTestState();
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cloud-lifecycle-"));
		const sessionId = "first-turn-cloud-recovery";
		try {
			const firstManager = SessionManager.create(tempDir, tempDir, { id: sessionId });
			firstManager.appendMessage({ role: "user", content: "start cloud work", timestamp: 1 });
			const firstSessionFile = firstManager.getSessionFile()!;
			const firstSessionManager = {
				getBranch: () => firstManager.getBranch(),
				getSessionFile: () => firstSessionFile,
				getSessionId: () => firstManager.getSessionId(),
			};
			const pi = createPiHarness();
			pi.appendEntry.mockImplementation((customType, data) => firstManager.appendCustomEntry(customType, data));
			registerCloudLifecycle(pi);
			await pi.runSessionStart({ sessionManager: firstSessionManager });
			const ledgerPath = cloudLifecycleTestUtils.durableLedgerPath(firstSessionFile, sessionId);
			writeFileSync(ledgerPath, '{"partial":');

			expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(), branches: [] })).toBe(true);
			const ledgerLines = readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/);
			expect(existsSync(firstSessionFile)).toBe(false);
			if (process.platform !== "win32") expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
			expect(ledgerLines[0]).toBe('{"partial":');
			expect(JSON.parse(ledgerLines[1]!)).toMatchObject({
				version: 1,
				sessionId,
				anchorEntryId: null,
				action: "record",
				agentId: cloudAgentId(),
			});

			await new Promise((resolve) => setTimeout(resolve, 2));
			const recoveryManager = SessionManager.create(tempDir, tempDir, { id: sessionId });
			const recoverySessionFile = recoveryManager.getSessionFile()!;
			const recoverySessionManager = {
				getBranch: () => recoveryManager.getBranch(),
				getSessionFile: () => recoverySessionFile,
				getSessionId: () => recoveryManager.getSessionId(),
			};
			expect(recoverySessionFile).not.toBe(firstSessionFile);
			expect(cloudLifecycleTestUtils.durableLedgerPath(recoverySessionFile, sessionId)).toBe(ledgerPath);
			recoveryManager.appendMessage({ role: "user", content: "recover cloud work", timestamp: 2 });
			recoveryManager.appendMessage(makeAssistantMessage("recovery session persisted"));
			expect(existsSync(recoverySessionFile)).toBe(true);

			resetCloudLifecycleTestState();
			const archive = vi.fn().mockResolvedValue(undefined);
			cloudLifecycleTestUtils.setSdkOperations({ archive, delete: vi.fn() });
			const recoveryPi = createPiHarness();
			recoveryPi.appendEntry.mockImplementation((customType, data) => recoveryManager.appendCustomEntry(customType, data));
			registerCloudLifecycle(recoveryPi);
			await recoveryPi.runSessionStart({ sessionManager: recoverySessionManager });
			await recoveryPi.runCommand("cursor-cloud", `archive ${cloudAgentId()}`, { sessionManager: recoverySessionManager });

			expect(archive).toHaveBeenCalledTimes(1);
			expect(archive.mock.calls[0]?.[0]).toBe(cloudAgentId());
			expect(readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/)).toHaveLength(5);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it.runIf(eagerCustomEntryHost)("anchors a framed first-turn ledger to the eagerly persisted Pi entry and claims it after resume", async () => {
		resetCloudLifecycleTestState();
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cloud-eager-lifecycle-"));
		const sessionId = "first-turn-cloud-eager";
		try {
			const manager = SessionManager.create(tempDir, tempDir, { id: sessionId });
			manager.appendMessage({ role: "user", content: "start cloud work", timestamp: 1 });
			const sessionFile = manager.getSessionFile()!;
			const sessionManager = {
				getBranch: () => manager.getBranch(),
				getSessionFile: () => sessionFile,
				getSessionId: () => manager.getSessionId(),
			};
			const pi = createPiHarness();
			pi.appendEntry.mockImplementation((customType, data) => manager.appendCustomEntry(customType, data));
			registerCloudLifecycle(pi);
			await pi.runSessionStart({ sessionManager });
			const ledgerPath = cloudLifecycleTestUtils.durableLedgerPath(sessionFile, sessionId);
			writeFileSync(ledgerPath, '{"partial":');

			expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(), branches: [] })).toBe(true);
			const ledgerLines = readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/);
			if (process.platform !== "win32") expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
			expect(ledgerLines[0]).toBe('{"partial":');
			expect(JSON.parse(ledgerLines[1]!)).toMatchObject({
				version: 1,
				sessionId,
				anchorEntryId: manager.getLeafId(),
				action: "record",
				agentId: cloudAgentId(),
			});

			resetCloudLifecycleTestState();
			const resumed = SessionManager.open(sessionFile, tempDir);
			const resumedSessionManager = {
				getBranch: () => resumed.getBranch(),
				getSessionFile: () => sessionFile,
				getSessionId: () => resumed.getSessionId(),
			};
			const archive = vi.fn().mockResolvedValue(undefined);
			cloudLifecycleTestUtils.setSdkOperations({ archive, delete: vi.fn() });
			const resumedPi = createPiHarness();
			resumedPi.appendEntry.mockImplementation((customType, data) => resumed.appendCustomEntry(customType, data));
			registerCloudLifecycle(resumedPi);
			await resumedPi.runSessionStart({ sessionManager: resumedSessionManager });
			await resumedPi.runCommand("cursor-cloud", `archive ${cloudAgentId()}`, { sessionManager: resumedSessionManager });

			expect(archive).toHaveBeenCalledTimes(1);
			expect(archive.mock.calls[0]?.[0]).toBe(cloudAgentId());
			expect(readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/)).toHaveLength(4);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("claims a fileless first-turn record on its original branch but not a sibling", async () => {
		resetCloudLifecycleTestState();
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cloud-first-turn-branch-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir, { id: "first-turn-branch" });
			const rootUserId = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			const sessionManager = {
				getBranch: () => manager.getBranch(),
				getSessionFile: () => manager.getSessionFile(),
				getSessionId: () => manager.getSessionId(),
			};
			const pi = createPiHarness();
			pi.appendEntry.mockImplementation((customType, data) => manager.appendCustomEntry(customType, data));
			registerCloudLifecycle(pi);
			await pi.runSessionStart({ cwd: tempDir, sessionManager });
			expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(), branches: [] })).toBe(true);
			expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(), runId: "run-first-turn", branches: [] })).toBe(true);
			expect(recordCursorCloudLifecycleRun({
				agentId: cloudAgentId(),
				runId: "run-first-turn",
				branches: [{ repoUrl: "github.com/acme/repo", branch: "cursor/final", prUrl: "https://github.com/acme/repo/pull/1" }],
			})).toBe(true);
			const originalRecordId = manager.getLeafId()!;
			manager.appendMessage(makeAssistantMessage("original branch"));

			manager.branch(rootUserId);
			manager.appendMessage(makeAssistantMessage("sibling branch"));
			const archive = vi.fn().mockResolvedValue(undefined);
			cloudLifecycleTestUtils.setSdkOperations({ archive, delete: vi.fn() });
			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId()}`, { cwd: tempDir, sessionManager });
			expect(archive).not.toHaveBeenCalled();

			manager.branch(originalRecordId);
			const notify = vi.fn();
			await pi.runCommand("cursor-cloud", "list", { cwd: tempDir, sessionManager, ui: { notify } });
			expect(notify.mock.calls.at(-1)?.[0]).toContain("run-first-turn");
			expect(notify.mock.calls.at(-1)?.[0]).toContain("cursor/final");
			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId()}`, { cwd: tempDir, sessionManager });
			expect(archive).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects wrong-session and non-null reused-session journal records while fileless", async () => {
		resetCloudLifecycleTestState();
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cloud-reused-session-"));
		const sessionId = "reused-session";
		try {
			const manager = SessionManager.create(tempDir, tempDir, { id: sessionId });
			const sessionFile = manager.getSessionFile()!;
			const journalPath = cloudLifecycleTestUtils.durableLedgerPath(sessionFile, sessionId);
			const base = {
				version: 1,
				action: "record",
				runtime: "cloud",
				timestamp: "2026-07-07T00:00:00.000Z",
				branches: [],
			};
			writeFileSync(journalPath, [
				JSON.stringify({ ...base, sessionId: "wrong-session", sessionFile: "/old/wrong.jsonl", anchorEntryId: null, agentId: cloudAgentId(1) }),
				JSON.stringify({ ...base, sessionId, sessionFile: "/old/reused.jsonl", anchorEntryId: "old-entry", agentId: cloudAgentId(2) }),
			].join("\n") + "\n");
			const sessionManager = {
				getBranch: () => manager.getBranch(),
				getSessionFile: () => sessionFile,
				getSessionId: () => sessionId,
			};
			const archive = vi.fn().mockResolvedValue(undefined);
			cloudLifecycleTestUtils.setSdkOperations({ archive, delete: vi.fn() });
			const pi = createPiHarness();
			pi.appendEntry.mockImplementation((customType, data) => manager.appendCustomEntry(customType, data));
			registerCloudLifecycle(pi);
			await pi.runSessionStart({ cwd: tempDir, sessionManager });

			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId(1)}`, { cwd: tempDir, sessionManager });
			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId(2)}`, { cwd: tempDir, sessionManager });
			expect(archive).not.toHaveBeenCalled();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not expose a sibling branch agent that shares the same parent", async () => {
		resetCloudLifecycleTestState();
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cloud-sibling-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir, { id: "cloud-sibling-session" });
			manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			const sharedParentId = manager.appendMessage(makeAssistantMessage("root"));
			manager.appendMessage({ role: "user", content: "branch A", timestamp: 3 });
			const sessionManager = {
				getBranch: () => manager.getBranch(),
				getSessionFile: () => manager.getSessionFile(),
				getSessionId: () => manager.getSessionId(),
			};
			const pi = createPiHarness();
			pi.appendEntry.mockImplementation((customType, data) => manager.appendCustomEntry(customType, data));
			registerCloudLifecycle(pi);
			await pi.runSessionStart({ cwd: tempDir, sessionManager });

			expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(), branches: [] })).toBe(true);
			const branchARecordId = manager.getLeafId()!;
			manager.branch(sharedParentId);
			manager.appendMessage({ role: "user", content: "branch B", timestamp: 4 });
			const archive = vi.fn().mockResolvedValue(undefined);
			cloudLifecycleTestUtils.setSdkOperations({ archive, delete: vi.fn() });

			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId()}`, { cwd: tempDir, sessionManager });
			expect(archive).not.toHaveBeenCalled();

			manager.branch(branchARecordId);
			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId()}`, { cwd: tempDir, sessionManager });
			expect(archive).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps mutation intent pending when durable sidecar result writes fail", async () => {
		resetCloudLifecycleTestState();
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cloud-delete-reconcile-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir, { id: "cloud-delete-reconcile" });
			manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			manager.appendMessage(makeAssistantMessage("root"));
			const sessionManager = {
				getBranch: () => manager.getBranch(),
				getSessionFile: () => manager.getSessionFile(),
				getSessionId: () => manager.getSessionId(),
			};
			const pi = createPiHarness();
			pi.appendEntry.mockImplementation((customType, data) => manager.appendCustomEntry(customType, data));
			registerCloudLifecycle(pi);
			await pi.runSessionStart({ cwd: tempDir, sessionManager });
			expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(1), branches: [] })).toBe(true);
			expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(2), branches: [] })).toBe(true);

			const archive = vi.fn().mockResolvedValue(undefined);
			const deleteAgent = vi.fn().mockResolvedValue(undefined);
			cloudLifecycleTestUtils.setSdkOperations({ archive, delete: deleteAgent });
			cloudLifecycleTestUtils.setDurableWriter(() => false);
			expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(3), branches: [] })).toBe(false);
			cloudLifecycleTestUtils.setDurableWriter(undefined);
			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId(3)}`, { cwd: tempDir, sessionManager });
			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId(3)}`, { cwd: tempDir, sessionManager });

			cloudLifecycleTestUtils.setDurableWriter((data) => data.action === "archive_intent" || data.action === "delete_intent");
			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId(1)}`, { cwd: tempDir, sessionManager });
			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId(1)}`, { cwd: tempDir, sessionManager });
			await pi.runCommand("cursor-cloud", `delete ${cloudAgentId(2)} --yes`, { cwd: tempDir, sessionManager });
			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId(2)}`, { cwd: tempDir, sessionManager });

			expect(archive).toHaveBeenCalledTimes(2);
			expect(deleteAgent).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("records durable mutation intent and result when Pi mirror appends fail", async () => {
		resetCloudLifecycleTestState();
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cloud-mutation-protocol-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir, { id: "cloud-mutation-protocol" });
			manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			manager.appendMessage(makeAssistantMessage("root"));
			const sessionManager = {
				getBranch: () => manager.getBranch(),
				getSessionFile: () => manager.getSessionFile(),
				getSessionId: () => manager.getSessionId(),
			};
			const pi = createPiHarness();
			pi.appendEntry.mockImplementation((customType, data) => manager.appendCustomEntry(customType, data));
			registerCloudLifecycle(pi);
			await pi.runSessionStart({ cwd: tempDir, sessionManager });
			expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(), branches: [] })).toBe(true);
			pi.appendEntry.mockImplementation(() => { throw new Error("Pi mirror unavailable"); });
			const archive = vi.fn().mockResolvedValue(undefined);
			cloudLifecycleTestUtils.setSdkOperations({ archive, delete: vi.fn() });

			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId()}`, { cwd: tempDir, sessionManager });
			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId()}`, { cwd: tempDir, sessionManager });

			expect(archive).toHaveBeenCalledTimes(1);
			const journal = readFileSync(
				cloudLifecycleTestUtils.durableLedgerPath(manager.getSessionFile()!, manager.getSessionId()),
				"utf8",
			);
			expect(journal).toContain('"action":"archive_intent"');
			expect(journal).toContain('"action":"archive"');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a newer terminal mutation result ahead of a stale mirrored intent", () => {
		const report = formatCursorCloudLifecycleList([
			recordEntry(),
			lifecycleEntry("archive-result", {
				action: "archive",
				runtime: "cloud",
				agentId: cloudAgentId(),
				timestamp: "2026-07-07T00:03:00.000Z",
			}),
			lifecycleEntry("stale-intent", {
				action: "archive_intent",
				runtime: "cloud",
				agentId: cloudAgentId(),
				timestamp: "2026-07-07T00:02:00.000Z",
			}),
		]);

		expect(report).toContain("(archived)");
		expect(report).not.toContain("pending");
	});

	it("bounds recorded cloud lifecycle branches and ignores artifacts", () => {
		const pi = createPiHarness();
		registerCloudLifecycle(pi);
		const branches = Array.from({ length: MAX_CLOUD_REPORT_BRANCHES + 2 }, (_, index) => ({
			repoUrl: "github.com/acme/repo",
			branch: `cursor/work-${index}`,
		}));
		const artifacts = Array.from({ length: 12 }, (_, index) => ({
			path: `artifacts/report-${index}.txt`,
			sizeBytes: index,
			updatedAt: "2026-07-07T00:00:00Z",
		}));

		recordCursorCloudLifecycleRun({ agentId: cloudAgentId(), runId: "run-1", branches, artifacts });

		expect(pi.appendEntry).toHaveBeenCalledWith(CLOUD_LIFECYCLE_ENTRY_TYPE, expect.objectContaining({
			branches: branches.slice(0, MAX_CLOUD_REPORT_BRANCHES).map((branch) => ({ branch: branch.branch })),
		}));
		expect(pi.appendEntry.mock.calls[0]?.[1]).not.toHaveProperty("artifacts");
	});

	it("sanitizes and caps remote run, branch, and PR strings in ledger and list output", () => {
		const pi = createPiHarness();
		registerCloudLifecycle(pi);
		const apiKey = "secret-cursor-key";
		const hugeRun = `run\u0085\u2028Bearer abc123 ${apiKey} ${"r".repeat(1000)}`;
		const hugeBranch = `cursor\0\u0085/${apiKey}/${"b".repeat(1000)}`;
		const hugePrUrl = `https://github.com/acme/repo/pull/${apiKey}/\u2029${"7".repeat(1000)}`;

		recordCursorCloudLifecycleRun({
			agentId: cloudAgentId(),
			runId: hugeRun,
			branches: [{ repoUrl: "github.com/acme/repo", branch: hugeBranch, prUrl: hugePrUrl }],
		}, { apiKey });

		const data = pi.appendEntry.mock.calls[0]?.[1] as { runId?: string; branches?: Array<{ branch?: string; prUrl?: string }> };
		expect(JSON.stringify(data).length).toBeLessThan(900);
		expect(JSON.stringify(data)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
		expect(data.runId).toContain("…");
		expect(data.runId).not.toContain("abc123");
		expect(JSON.stringify(data)).not.toContain(apiKey);
		expect(data.branches?.[0]?.branch).not.toBe(hugeBranch);
		expect(data.branches?.[0]?.prUrl).not.toBe(hugePrUrl);
		expect(data.branches?.[0]?.branch).toContain("…");
		expect(data.branches?.[0]?.prUrl).toContain("…");

		const report = formatCursorCloudLifecycleList([lifecycleEntry("oversized", data as unknown as Record<string, unknown>)]);
		expect(report).not.toContain(hugeBranch);
		expect(report).not.toContain(hugePrUrl);
		expect(report.split("\n").every((line) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(line))).toBe(true);
		expect(report.length).toBeLessThan(1100);
	});

	it("rejects non-exact hostile agent IDs from lifecycle persistence and mutation", async () => {
		const archive = vi.fn().mockResolvedValue(undefined);
		cloudLifecycleTestUtils.setSdkOperations({ archive, delete: vi.fn() });
		const pi = createPiHarness();
		registerCloudLifecycle(pi);
		const hostileAgentId = "bc-00000000-0000-0000-0000-000000000001\u0085";
		const malformedIds = [
			hostileAgentId,
			"bc-000000000000-0000-0000-0000-000000000001",
			"bc-00000000-0000-0000-0000-00000000000g",
			"bc-00000000-0000-0000-0000-000000000001-extra",
			"bc-agent-1",
		];

		for (const agentId of malformedIds) {
			expect(recordCursorCloudLifecycleRun({ agentId, runId: "run-1", branches: [] }), agentId).toBe(false);
		}
		await pi.runCommand("cursor-cloud", `archive ${hostileAgentId}`, {
			sessionManager: { getBranch: vi.fn(() => [recordEntry(hostileAgentId), recordEntry()]) },
		});

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(archive).not.toHaveBeenCalled();
	});

	it("does not reconcile a fileless orphan or call the SDK when Cloud auth is missing", async () => {
		resetCloudLifecycleTestState();
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cloud-missing-auth-"));
		try {
			const original = SessionManager.create(tempDir, tempDir, { id: "missing-auth-orphan" });
			original.appendMessage({ role: "user", content: "first turn", timestamp: 1 });
			const originalSessionManager = {
				getBranch: () => original.getBranch(),
				getSessionFile: () => original.getSessionFile(),
				getSessionId: () => original.getSessionId(),
			};
			const pi = createPiHarness();
			pi.appendEntry.mockImplementation((customType, data) => original.appendCustomEntry(customType, data));
			registerCloudLifecycle(pi);
			await pi.runSessionStart({ cwd: tempDir, sessionManager: originalSessionManager });
			expect(recordCursorCloudLifecycleRun({ agentId: cloudAgentId(), branches: [] })).toBe(true);
			const journalPath = cloudLifecycleTestUtils.durableLedgerPath(original.getSessionFile()!, original.getSessionId());
			const journalBefore = readFileSync(journalPath, "utf8");

			const restarted = SessionManager.create(tempDir, tempDir, { id: original.getSessionId() });
			pi.appendEntry.mockImplementation((customType, data) => restarted.appendCustomEntry(customType, data));
			pi.appendEntry.mockClear();
			await pi.runSessionStart({ cwd: tempDir, sessionManager: restarted });
			const archive = vi.fn().mockResolvedValue(undefined);
			cloudLifecycleTestUtils.setSdkOperations({ archive, delete: vi.fn() });
			cloudLifecycleTestUtils.setRuntimeApiKeyResolver(async () => undefined);

			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId()}`, { cwd: tempDir, sessionManager: restarted });

			expect(archive).not.toHaveBeenCalled();
			expect(pi.appendEntry).not.toHaveBeenCalled();
			expect(readFileSync(journalPath, "utf8")).toBe(journalBefore);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("caps list output for many recorded agents", () => {
		const entries = Array.from({ length: 30 }, (_, index) => recordEntry(cloudAgentId(index)));
		const report = formatCursorCloudLifecycleList(entries);

		expect(report).toContain(cloudAgentId(0));
		expect(report).toContain("+5 more recorded agents");
		expect(report).not.toContain(cloudAgentId(29));
		expect(report.length).toBeLessThan(3000);
	});

	it("lists recorded non-deleted agents, ignores malformed entries, and hides deleted tombstones", () => {
		const report = formatCursorCloudLifecycleList([
			lifecycleEntry("malformed", {
				action: "record",
				runtime: "cloud",
				agentId: "bc-bad",
				runId: 7,
				timestamp: "2026-07-07T00:00:00.000Z",
				branches: [null],
			}),
			lifecycleEntry("mixed-arrays", {
				action: "record",
				runtime: "cloud",
				agentId: cloudAgentId(3),
				runId: "run-3",
				timestamp: "2026-07-07T00:00:00.000Z",
				branches: [null, { repoUrl: 7 }, { repoUrl: "github.com/acme/repo", branch: "cursor/valid" }, "bad"],
				artifacts: [null, { path: 7 }, { path: "artifacts/valid.txt", updatedAt: "2026-07-07T00:00:00Z" }],
			}),
			recordEntry(cloudAgentId(1)),
			lifecycleEntry("archive-1", {
				action: "archive",
				runtime: "cloud",
				agentId: cloudAgentId(1),
				timestamp: "2026-07-07T00:01:00.000Z",
			}),
			recordEntry(cloudAgentId(2)),
			lifecycleEntry("delete-2", {
				action: "delete",
				runtime: "cloud",
				agentId: cloudAgentId(2),
				timestamp: "2026-07-07T00:02:00.000Z",
			}),
		]);

		expect(report).toContain(`${cloudAgentId(1)} (archived)`);
		expect(report).toContain("run run-1");
		expect(report).toContain("branch cursor/work");
		expect(report).toContain(cloudAgentId(3));
		expect(report).toContain("branch cursor/valid");
		expect(report).not.toContain(cloudAgentId(2));
		expect(report).not.toContain("bc-bad");
	});

	it("resolves mutation auth through the command ModelRegistry and normalizes placeholders", async () => {
		const originalKey = process.env.CURSOR_API_KEY;
		process.env.CURSOR_API_KEY = "env-key";
		cloudLifecycleTestUtils.setRuntimeApiKeyResolver(undefined);
		const archive = vi.fn().mockResolvedValue(undefined);
		cloudLifecycleTestUtils.setSdkOperations({ archive, delete: vi.fn() });
		const getApiKeyForProvider = vi.fn().mockResolvedValue("$CURSOR_API_KEY");
		const pi = createPiHarness();
		registerCloudLifecycle(pi);
		try {
			await pi.runCommand("cursor-cloud", `archive ${cloudAgentId()}`, {
				modelRegistry: { getApiKeyForProvider } as never,
				sessionManager: { getBranch: vi.fn(() => [recordEntry()]) },
			});
			expect(getApiKeyForProvider).toHaveBeenCalledWith("cursor");
			expect(archive).toHaveBeenCalledWith(cloudAgentId(), { apiKey: "env-key" });
		} finally {
			if (originalKey === undefined) delete process.env.CURSOR_API_KEY;
			else process.env.CURSOR_API_KEY = originalKey;
		}
	});

	it("archives exactly one recorded bc- cloud agent and appends a tombstone", async () => {
		const archive = vi.fn().mockResolvedValue(undefined);
		const deleteAgent = vi.fn().mockResolvedValue(undefined);
		cloudLifecycleTestUtils.setSdkOperations({ archive, delete: deleteAgent });
		const pi = createPiHarness();
		registerCloudLifecycle(pi);

		await pi.runCommand("cursor-cloud", `archive ${cloudAgentId()}`, { sessionManager: { getBranch: vi.fn(() => [recordEntry()]) } });

		expect(archive).toHaveBeenCalledTimes(1);
		expect(archive.mock.calls[0]?.[0]).toBe(cloudAgentId());
		expect(deleteAgent).not.toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledWith(CLOUD_LIFECYCLE_ENTRY_TYPE, expect.objectContaining({
			action: "archive",
			runtime: "cloud",
			agentId: cloudAgentId(),
		}));
	});

	it("deletes exactly one recorded bc- cloud agent only with --yes", async () => {
		const archive = vi.fn().mockResolvedValue(undefined);
		const deleteAgent = vi.fn().mockResolvedValue(undefined);
		cloudLifecycleTestUtils.setSdkOperations({ archive, delete: deleteAgent });
		const pi = createPiHarness();
		registerCloudLifecycle(pi);
		const branch = [recordEntry()];

		await pi.runCommand("cursor-cloud", `delete ${cloudAgentId()}`, { sessionManager: { getBranch: vi.fn(() => branch) } });
		await pi.runCommand("cursor-cloud", `delete ${cloudAgentId()} --yes`, { sessionManager: { getBranch: vi.fn(() => branch) } });

		expect(deleteAgent).toHaveBeenCalledTimes(1);
		expect(deleteAgent.mock.calls[0]?.[0]).toBe(cloudAgentId());
		expect(pi.appendEntry).toHaveBeenCalledWith(CLOUD_LIFECYCLE_ENTRY_TYPE, expect.objectContaining({
			action: "delete",
			runtime: "cloud",
			agentId: cloudAgentId(),
		}));
	});

	it("rejects empty, non-cloud, wildcard, unrecorded, and bulk IDs before SDK calls", async () => {
		const archive = vi.fn().mockResolvedValue(undefined);
		const deleteAgent = vi.fn().mockResolvedValue(undefined);
		cloudLifecycleTestUtils.setSdkOperations({ archive, delete: deleteAgent });
		const pi = createPiHarness();
		registerCloudLifecycle(pi);
		const ctx = { sessionManager: { getBranch: vi.fn(() => [recordEntry()]) } };

		await pi.runCommand("cursor-cloud", "archive", ctx);
		await pi.runCommand("cursor-cloud", "archive local-agent-1", ctx);
		await pi.runCommand("cursor-cloud", "delete bc-* --yes", ctx);
		await pi.runCommand("cursor-cloud", `delete ${cloudAgentId(2)} --yes`, ctx);
		await pi.runCommand("cursor-cloud", `delete ${cloudAgentId()} ${cloudAgentId(2)} --yes`, ctx);

		expect(archive).not.toHaveBeenCalled();
		expect(deleteAgent).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
});
