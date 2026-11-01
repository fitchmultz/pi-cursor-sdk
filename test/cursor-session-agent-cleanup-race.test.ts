import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, createExtensionRuntime, DefaultResourceLoader, ExtensionRunner, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE,
	readCursorSessionAgentCleanupPlan,
	runCursorSessionAgentCleanupCommand,
	__testUtils as cleanupTestUtils,
} from "../src/cursor-session-agent-cleanup.js";
import {
	CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
	__testUtils as resumeTestUtils,
} from "../src/cursor-session-agent-resume.js";
import { cursorSessionScopeKeyForManager } from "../src/cursor-session-scope.js";
import { buildCursorSessionStateRoot, __testUtils as storeTestUtils } from "../src/cursor-session-store.js";
import { makeAssistantMessage } from "./helpers/pi-harness.js";
import { installCursorSessionStoreMock, sessionStoreBackedBy } from "./helpers/cursor-session-store.js";

const { loadSdk } = vi.hoisted(() => ({ loadSdk: vi.fn() }));
vi.mock("../src/cursor-sdk-runtime.js", () => ({ loadCursorSdk: loadSdk }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function cleanupFixture(tempDir: string, candidates = ["agent-old"], workspaceRoot?: string) {
	const manager = SessionManager.create(tempDir, tempDir, { id: "cleanup-race" });
	manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
	manager.appendMessage(makeAssistantMessage("root"));
	const sessionFile = manager.getSessionFile()!;
	const scope = { scopeKey: sessionFile, sessionFile, sessionId: manager.getSessionId(), cwd: tempDir };
	const storeIdentity = workspaceRoot ? { version: 1 as const, stateRoot: buildCursorSessionStateRoot(workspaceRoot, sessionFile) } : undefined;
	let branchHash = manager.getBranch().reduce(resumeTestUtils.hashBranchStep, resumeTestUtils.EMPTY_BRANCH_HASH);
	const data = (agentId: string, hash: string) => ({
		version: storeIdentity ? 2 as const : 1 as const, runtime: "local" as const, agentId, ...scope,
		poolKey: `pool-${agentId}`, branchPathHash: hash, compactionGeneration: 0,
		sendState: { bootstrapped: true, contextFingerprint: "fixture", incrementalSendCount: 0 },
		createdAt: "2026-07-08T00:00:00.000Z", ...(storeIdentity ? { storeIdentity } : {}),
	});
	const oldResume = manager.appendCustomEntry(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, data("agent-old", branchHash));
	manager.appendMessage({ role: "user", content: "continue", timestamp: 2 });
	branchHash = resumeTestUtils.hashBranchStep(branchHash, manager.getBranch().at(-1)!);
	manager.appendMessage(makeAssistantMessage("replacement"));
	branchHash = resumeTestUtils.hashBranchStep(branchHash, manager.getBranch().at(-1)!);
	manager.appendCustomEntry(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, {
		...data("agent-new", branchHash),
		...(storeIdentity ? { cleanupCandidates: candidates.map((agentId) => ({ agentId, storeIdentity })) } : { cleanupCandidateAgentIds: candidates }),
	});
	return { manager, sessionFile, scope, oldResume, storeIdentity };
}

function ledger(sessionFile: string, tempDir: string) {
	return SessionManager.open(sessionFile, tempDir).getEntries().flatMap((entry) =>
		entry.type === "custom" && entry.customType === CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE
			? [cleanupTestUtils.parseCleanupEntryData(entry.data)] : []);
}

type WaitPoint = "preloaded" | "first-import";

async function runNavigatingCleanup(waitPoint: WaitPoint) {
	const tempDir = mkdtempSync(join(tmpdir(), "cursor-cleanup-race-"));
	try {
		const { manager, sessionFile, scope, oldResume } = cleanupFixture(tempDir);
		expect(readCursorSessionAgentCleanupPlan(manager.getEntries(), manager.getBranch(), scope)).toEqual({
			candidateAgentIds: ["agent-old"], protectedAgentIds: ["agent-new"],
		});

		const history = new Set(["agent-old", "agent-new"]);
		const events: string[] = [];
		const remove = vi.fn(async (agentId: string) => {
			const protectedNow = readCursorSessionAgentCleanupPlan(manager.getEntries(), manager.getBranch(), scope).protectedAgentIds.includes(agentId);
			events.push(`delete:${agentId}:${protectedNow ? "protected" : "eligible"}`);
			history.delete(agentId);
		});
		const sdk = { Agent: { delete: remove } };
		const gate = deferred<void>();
		installCursorSessionStoreMock();
		loadSdk.mockImplementation(async () => {
			if (waitPoint === "first-import") {
				events.push("wait:first-import");
				await gate.promise;
			}
			return sdk;
		});
		const ui = { notify: vi.fn() };
		const task = runCursorSessionAgentCleanupCommand({ appendEntry: (type, value) => manager.appendCustomEntry(type, value) },
			"--yes", { cwd: tempDir, sessionManager: manager, ui });
		// Model an independent Pi input callback. In the preloaded control, our
		// synthetic store only yields resolved promises so cleanup wins the turn.
		// The first-import variant holds the await until this callback navigates.
		await new Promise<void>((done) => setImmediate(() => {
			manager.branch(oldResume);
			const protectedNow = readCursorSessionAgentCleanupPlan(manager.getEntries(), manager.getBranch(), scope).protectedAgentIds.includes("agent-old");
			events.push(`navigate:${protectedNow ? "protected" : "unprotected"}`);
			gate.resolve();
			done();
		}));
		await task;
		return { events, history: [...history].sort(), ledger: ledger(sessionFile, tempDir), calls: remove.mock.calls, ui };
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

beforeEach(() => {
	cleanupTestUtils.reset();
	loadSdk.mockReset();
});
afterEach(() => {
	cleanupTestUtils.reset();
	storeTestUtils.setSdkOperations(undefined);
});

describe("cleanup navigation race with native SessionManager and synthetic SDK", () => {
	it("preloaded synthetic control deletes before the independently scheduled navigation", async () => {
		const result = await runNavigatingCleanup("preloaded");
		expect(result.events).toEqual(["delete:agent-old:eligible", "navigate:protected"]);
		expect(result.history).toEqual(["agent-new"]);
		expect(result.ledger.map((entry) => entry?.phase)).toEqual(["intent", "result"]);
	});

	it("does not delete after navigation during the new first-import wait", async () => {
		const result = await runNavigatingCleanup("first-import");
		expect(result.events).toEqual(["wait:first-import", "navigate:protected"]);
		expect(result.history).toEqual(["agent-new", "agent-old"]);
		expect(result.calls).toHaveLength(0);
		// Nothing destructive began, so no intent or result is written to the new branch.
		expect(result.ledger).toEqual([]);
		expect(result.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No agents were deleted"), "error");
	});

	it("Pi can navigate its tree while an extension command is awaiting the synthetic import", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cleanup-native-pi-"));
		let session: AgentSession | undefined;
		const gate = deferred<void>(), entered = deferred<void>();
		try {
			const { manager, sessionFile, scope, oldResume } = cleanupFixture(tempDir);
			installCursorSessionStoreMock();
			const remove = vi.fn(async () => {});
			loadSdk.mockImplementation(async () => { entered.resolve(); await gate.promise; return { Agent: { delete: remove } }; });
			const agentDir = join(tempDir, "agent"); mkdirSync(agentDir);
			const settingsManager = SettingsManager.inMemory({ defaultTools: [], compaction: { enabled: false }, retry: { enabled: false } });
			const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
				modelsStorePath: join(tempDir, "models.json"), allowModelNetwork: false });
			const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager, noExtensions: true,
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [(pi) => pi.registerCommand("cleanup-probe", {
					description: "Offline cleanup race fixture",
					handler: (args, ctx) => runCursorSessionAgentCleanupCommand(pi, args, ctx),
				})],
			});
			await loader.reload();
			({ session } = await createAgentSession({ cwd: tempDir, agentDir, modelRuntime, resourceLoader: loader, settingsManager, sessionManager: manager, tools: [] }));
			const errors: unknown[] = [];
			await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
			const task = session.prompt("/cleanup-probe --yes", { source: "rpc" });
			await entered.promise;
			expect(session.isStreaming).toBe(false);
			expect(await session.navigateTree(oldResume, { summarize: false })).toMatchObject({ cancelled: false });
			expect(readCursorSessionAgentCleanupPlan(manager.getEntries(), manager.getBranch(), scope).protectedAgentIds).toContain("agent-old");
			gate.resolve();
			await task;
			expect(remove).not.toHaveBeenCalled();
			expect(ledger(sessionFile, tempDir)).toEqual([]);
			expect(errors).toEqual([]);
		} finally {
			gate.resolve();
			if (session) { await session.abort(); session.dispose(); }
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("handles actual Pi ExtensionRunner stale ctx accessors and a closed old UI", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cleanup-native-stale-"));
		const gate = deferred<void>(), entered = deferred<void>();
		let notify: ReturnType<typeof vi.spyOn> | undefined;
		try {
			const { manager, sessionFile } = cleanupFixture(tempDir);
			const stores = installCursorSessionStoreMock();
			const remove = vi.fn(async () => {});
			loadSdk.mockImplementation(async () => { entered.resolve(); await gate.promise; return { Agent: { delete: remove } }; });
			const runner = new ExtensionRunner([], createExtensionRuntime(), tempDir, manager, undefined as never);
			notify = vi.spyOn(runner.getUIContext(), "notify").mockImplementation(() => { throw new Error("old UI closed"); });
			const ctx = runner.createCommandContext();
			const task = runCursorSessionAgentCleanupCommand({ appendEntry: (type, value) => manager.appendCustomEntry(type, value) }, "--yes", ctx);
			await entered.promise;
			runner.invalidate("native stale-context fixture");
			expect(() => ctx.sessionManager).toThrow("native stale-context fixture");
			expect(() => ctx.ui).toThrow("native stale-context fixture");
			gate.resolve();
			await expect(task).resolves.toBeUndefined();
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("No agents were deleted"), "error");
			expect(remove).not.toHaveBeenCalled();
			expect(stores.openSqliteStore).not.toHaveBeenCalled();
			expect(ledger(sessionFile, tempDir)).toEqual([]);
		} finally {
			gate.resolve();
			notify?.mockRestore();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it.each(["replacement", "stale"] as const)("does not write into a %s session after the import wait", async (kind) => {
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cleanup-switch-"));
		try {
			const { manager, sessionFile, scope } = cleanupFixture(tempDir);
			const other = SessionManager.create(tempDir, tempDir, { id: "other-session" });
			other.appendMessage({ role: "user", content: "other session", timestamp: 3 });
			const stores = installCursorSessionStoreMock();
			const gate = deferred<void>(), entered = deferred<void>();
			const remove = vi.fn(async () => {});
			loadSdk.mockImplementation(async () => { entered.resolve(); await gate.promise; return { Agent: { delete: remove } }; });
			let current = manager;
			let stale = false;
			const ui = { notify: vi.fn() };
			const ctx = {
				cwd: tempDir,
				get sessionManager() { if (stale) throw new Error("stale context"); return current; },
				get ui() { if (stale) throw new Error("stale context"); return ui; },
			};
			const pi = { appendEntry: (type: string, value: unknown) => {
				if (stale) throw new Error("stale API");
				current.appendCustomEntry(type, value);
			} };
			const task = runCursorSessionAgentCleanupCommand(pi, "--yes", ctx);
			await entered.promise;
			if (kind === "replacement") current = other;
			else stale = true;
			gate.resolve();
			await task;
			expect(remove).not.toHaveBeenCalled();
			expect(stores.openSqliteStore).not.toHaveBeenCalled();
			expect(ledger(sessionFile, tempDir)).toEqual([]);
			expect(ledger(other.getSessionFile()!, tempDir)).toEqual([]);
			expect(readCursorSessionAgentCleanupPlan(manager.getEntries(), manager.getBranch(), scope).candidateAgentIds).toEqual(["agent-old"]);
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("No agents were deleted"), "error");
		} finally { rmSync(tempDir, { recursive: true, force: true }); }
	});

	it("detects a newly protected sibling even if the original branch is reselected during import", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cleanup-sibling-"));
		try {
			const { manager, sessionFile, scope, oldResume } = cleanupFixture(tempDir);
			const originalLeaf = manager.getBranch().at(-1)!.id;
			installCursorSessionStoreMock();
			const gate = deferred<void>(), entered = deferred<void>();
			const remove = vi.fn(async () => {});
			loadSdk.mockImplementation(async () => { entered.resolve(); await gate.promise; return { Agent: { delete: remove } }; });
			const ui = { notify: vi.fn() };
			const task = runCursorSessionAgentCleanupCommand({ appendEntry: (type, value) => manager.appendCustomEntry(type, value) },
				"--yes", { cwd: tempDir, sessionManager: manager, ui });
			await entered.promise;
			manager.branch(oldResume);
			manager.appendMessage({ role: "user", content: "sibling continuation", timestamp: 3 });
			manager.branch(originalLeaf);
			expect(manager.getBranch().at(-1)?.id).toBe(originalLeaf);
			expect(readCursorSessionAgentCleanupPlan(manager.getEntries(), manager.getBranch(), scope).protectedAgentIds).toContain("agent-old");
			gate.resolve();
			await task;
			expect(remove).not.toHaveBeenCalled();
			expect(ledger(sessionFile, tempDir)).toEqual([]);
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("plan changed"), "error");
		} finally { rmSync(tempDir, { recursive: true, force: true }); }
	});

	it.each(["identity", "new-candidate"] as const)("fails closed on %s changes without changing entry IDs", async (change) => {
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cleanup-identity-race-"));
		try {
			const workspaceRoot = join(tempDir, "sdk-workspace");
			const { manager, sessionFile } = cleanupFixture(tempDir, ["agent-old"], workspaceRoot);
			const stores = installCursorSessionStoreMock(() => workspaceRoot);
			const gate = deferred<void>(), entered = deferred<void>();
			const remove = vi.fn(async () => {});
			loadSdk.mockImplementation(async () => { entered.resolve(); await gate.promise; return { Agent: { delete: remove } }; });
			const ui = { notify: vi.fn() };
			const task = runCursorSessionAgentCleanupCommand({ appendEntry: (type, value) => manager.appendCustomEntry(type, value) },
				"--yes", { cwd: tempDir, sessionManager: manager, ui });
			await entered.promise;
			const entry = manager.getEntries().findLast((item) => item.type === "custom" && item.customType === CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE);
			if (entry?.type !== "custom") throw new Error("missing fixture resume entry");
			const record = entry.data as { cleanupCandidates: Array<{ agentId: string; storeIdentity: { version: 1; stateRoot: string } }> };
			if (change === "identity") record.cleanupCandidates[0].storeIdentity.stateRoot = join(tempDir, "different-store");
			else record.cleanupCandidates.push({ agentId: "agent-newly-listed", storeIdentity: { ...record.cleanupCandidates[0].storeIdentity } });
			gate.resolve();
			await task;
			expect(remove).not.toHaveBeenCalled();
			expect(stores.openSqliteStore).not.toHaveBeenCalled();
			expect(ledger(sessionFile, tempDir)).toEqual([]);
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("plan changed"), "error");
		} finally { rmSync(tempDir, { recursive: true, force: true }); }
	});

	it("leaves competing intents unresolved instead of writing a result after the tree changes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cleanup-competing-"));
		try {
			const { manager, sessionFile, scope } = cleanupFixture(tempDir);
			installCursorSessionStoreMock();
			const gate = deferred<void>(), entered = deferred<void>();
			const remove = vi.fn(async () => {});
			loadSdk.mockImplementation(async () => { entered.resolve(); await gate.promise; return { Agent: { delete: remove } }; });
			const ui = { notify: vi.fn() };
			const task = runCursorSessionAgentCleanupCommand({ appendEntry: (type, value) => manager.appendCustomEntry(type, value) },
				"--yes", { cwd: tempDir, sessionManager: manager, ui });
			await entered.promise;
			manager.appendCustomEntry(CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE, {
				action: "delete", phase: "intent", runtime: "local", timestamp: new Date().toISOString(), candidateAgentIds: ["agent-old"],
			});
			gate.resolve();
			await task;
			expect(remove).not.toHaveBeenCalled();
			expect(ledger(sessionFile, tempDir).map((entry) => entry?.phase)).toEqual(["intent"]);
			expect(readCursorSessionAgentCleanupPlan(manager.getEntries(), manager.getBranch(), scope).candidateAgentIds).toEqual([]);
		} finally { rmSync(tempDir, { recursive: true, force: true }); }
	});

	it("replans after a delayed import without letting its own intent hide multiple locked candidates", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cleanup-multiple-"));
		try {
			const workspaceRoot = join(tempDir, "sdk-workspace");
			const { manager, sessionFile, storeIdentity } = cleanupFixture(tempDir, ["agent-old", "agent-second"], workspaceRoot);
			const stores = installCursorSessionStoreMock(() => workspaceRoot);
			const gate = deferred<void>(), entered = deferred<void>();
			const remove = vi.fn(async (_agentId: string, _options: unknown) => {
				expect(ledger(sessionFile, tempDir).map((entry) => entry?.phase)).toEqual(["intent"]);
			});
			loadSdk.mockImplementation(async () => { entered.resolve(); await gate.promise; return { Agent: { delete: remove } }; });
			const ui = { notify: vi.fn() };
			const task = runCursorSessionAgentCleanupCommand({ appendEntry: (type, value) => manager.appendCustomEntry(type, value) },
				"--yes", { cwd: tempDir, sessionManager: manager, ui });
			await entered.promise;
			expect(ledger(sessionFile, tempDir)).toEqual([]);
			expect(stores.openSqliteStore).not.toHaveBeenCalled();
			gate.resolve();
			await task;
			expect(remove.mock.calls.map(([id]) => id)).toEqual(["agent-old", "agent-second"]);
			expect(stores.openedOptions).toEqual([{ workspaceRef: tempDir, stateRoot: toNamespacedPath(storeIdentity!.stateRoot) }]);
			for (const [, options] of remove.mock.calls) {
				expect(options).toMatchObject({ cwd: tempDir, store: sessionStoreBackedBy(stores.stores[0]) });
			}
			expect(ledger(sessionFile, tempDir)).toMatchObject([
				{ phase: "intent", candidateAgentIds: ["agent-old", "agent-second"] },
				{ phase: "result", deletedAgentIds: ["agent-old", "agent-second"] },
			]);
		} finally { rmSync(tempDir, { recursive: true, force: true }); }
	});

	it("keeps its durable intent rather than appending a result to a branch changed during an SDK failure", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cleanup-result-branch-"));
		const gate = deferred<void>(), entered = deferred<void>();
		try {
			const { manager, sessionFile, scope, oldResume } = cleanupFixture(tempDir);
			installCursorSessionStoreMock();
			const remove = vi.fn(async () => { entered.resolve(); await gate.promise; throw new Error("synthetic delete failed without mutation"); });
			loadSdk.mockResolvedValue({ Agent: { delete: remove } });
			const ui = { notify: vi.fn() };
			const task = runCursorSessionAgentCleanupCommand({ appendEntry: (type, value) => manager.appendCustomEntry(type, value) },
				"--yes", { cwd: tempDir, sessionManager: manager, ui });
			await entered.promise;
			expect(ledger(sessionFile, tempDir).map((entry) => entry?.phase)).toEqual(["intent"]);
			manager.branch(oldResume);
			gate.resolve();
			await task;
			expect(ledger(sessionFile, tempDir).map((entry) => entry?.phase)).toEqual(["intent"]);
			expect(readCursorSessionAgentCleanupPlan(manager.getEntries(), manager.getBranch(), scope).candidateAgentIds).toEqual([]);
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("durable intent blocks automatic retries"), "error");
		} finally { gate.resolve(); rmSync(tempDir, { recursive: true, force: true }); }
	});

	it("durably records SDK import failure without opening a store or deleting candidates", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cleanup-import-fail-"));
		try {
			const { manager, sessionFile, scope } = cleanupFixture(tempDir, ["agent-old", "agent-second"]);
			const stores = installCursorSessionStoreMock();
			loadSdk.mockImplementation(async () => {
				expect(ledger(sessionFile, tempDir)).toEqual([]);
				throw new Error("synthetic import failure");
			});
			const ui = { notify: vi.fn() };
			await runCursorSessionAgentCleanupCommand({ appendEntry: (type, value) => manager.appendCustomEntry(type, value) },
				"--yes", { cwd: tempDir, sessionManager: manager, ui });
			expect(stores.openSqliteStore).not.toHaveBeenCalled();
			expect(ledger(sessionFile, tempDir)).toMatchObject([
				{ phase: "intent", candidateAgentIds: ["agent-old", "agent-second"] },
				{ phase: "result", failedAgentIds: [
					{ agentId: "agent-old", error: "synthetic import failure" },
					{ agentId: "agent-second", error: "synthetic import failure" },
				] },
			]);
			const last = SessionManager.open(sessionFile, tempDir).getEntries().at(-1);
			expect(last?.type === "custom" ? last.data : undefined).toMatchObject({ deletedAgentIds: [] });
			expect(readCursorSessionAgentCleanupPlan(manager.getEntries(), manager.getBranch(), scope).candidateAgentIds).toEqual(["agent-old", "agent-second"]);
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("2 failed"), "error");
		} finally { rmSync(tempDir, { recursive: true, force: true }); }
	});

	it("does not load the SDK for invalid, dry-run, or fileless cleanup", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cleanup-no-load-"));
		try {
			const { manager, sessionFile } = cleanupFixture(tempDir);
			const ui = { notify: vi.fn() };
			const pi = { appendEntry: (type: string, value: unknown) => manager.appendCustomEntry(type, value) };
			await runCursorSessionAgentCleanupCommand(pi, "--yes --dry-run", { cwd: tempDir, sessionManager: manager, ui });
			await runCursorSessionAgentCleanupCommand(pi, "--dry-run", { cwd: tempDir, sessionManager: manager, ui });
			expect(loadSdk).not.toHaveBeenCalled();
			expect(ledger(sessionFile, tempDir)).toMatchObject([{ action: "dry-run", candidateAgentIds: ["agent-old"] }]);

			const fileless = SessionManager.inMemory(tempDir);
			fileless.appendMessage({ role: "user", content: "fileless", timestamp: 1 });
			fileless.appendCustomEntry(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, {
				version: 1, runtime: "local", agentId: "agent-new", scopeKey: cursorSessionScopeKeyForManager(fileless),
				sessionId: fileless.getSessionId(), cwd: tempDir, poolKey: "pool", branchPathHash: "hash", compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: "fixture", incrementalSendCount: 0 },
				createdAt: "2026-07-08T00:00:00.000Z", cleanupCandidateAgentIds: ["agent-old"],
			});
			const filelessUi = { notify: vi.fn() };
			await runCursorSessionAgentCleanupCommand({ appendEntry: (type, value) => fileless.appendCustomEntry(type, value) },
				"--yes", { cwd: tempDir, sessionManager: fileless, ui: filelessUi });
			expect(loadSdk).not.toHaveBeenCalled();
			expect(filelessUi.notify).toHaveBeenCalledWith(expect.stringContaining("No agents were deleted"), "error");
		} finally { rmSync(tempDir, { recursive: true, force: true }); }
	});

	it.each(["--dry-run", "--yes"] as const)("does not load the SDK for %s with no candidates", async (args) => {
		const tempDir = mkdtempSync(join(tmpdir(), "cursor-cleanup-noop-"));
		try {
			const { manager, sessionFile } = cleanupFixture(tempDir, []);
			const stores = installCursorSessionStoreMock();
			await runCursorSessionAgentCleanupCommand({ appendEntry: (type, value) => manager.appendCustomEntry(type, value) },
				args, { cwd: tempDir, sessionManager: manager, ui: { notify: vi.fn() } });
			expect(loadSdk).not.toHaveBeenCalled();
			expect(stores.openSqliteStore).not.toHaveBeenCalled();
			expect(ledger(sessionFile, tempDir)).toMatchObject([args === "--yes" ? { action: "delete", phase: "result", candidateAgentIds: [] } : { action: "dry-run", candidateAgentIds: [] }]);
		} finally { rmSync(tempDir, { recursive: true, force: true }); }
	});
});
