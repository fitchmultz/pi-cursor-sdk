import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep, toNamespacedPath } from "node:path";
import { Agent, getDefaultSdkStateRoot } from "@cursor/sdk";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCursorSessionStateRoot, openCursorSessionStoreForScope, __testUtils as storeTests } from "../src/cursor-session-store.js";
import { runCursorSessionAgentCleanupCommand, __testUtils as cleanupTests } from "../src/cursor-session-agent-cleanup.js";
import { CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, __testUtils as resumeTests } from "../src/cursor-session-agent-resume.js";
import { cursorSessionScopeKeyForManager } from "../src/cursor-session-scope.js";
import { installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";

let home: string;
let cwd: string;
let currentRoot: string;
let legacyRoot: string;
const agentId = "agent-before-upgrade";

// Legacy fixture identity is the verified 1.0.32 public getter's MD5(cwd),
// under the prefix obtained from the current public getter, not a guessed HOME layout.
function identity(root: string) { return { version: 1 as const, stateRoot: root }; }
async function seed(root: string, id = agentId, workspace = cwd) {
	const opened = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: toNamespacedPath(root) });
	try {
		// Inspected installed public create path: omitting model skips catalog
		// validation. Seed SDK-owned metadata, not an invented agent record.
		const agent = await Agent.create({ agentId: id, local: { cwd: workspace, store: opened, settingSources: [] }, tools: [] });
		await agent[Symbol.asyncDispose]();
		// create() reserves a queued first run. Complete the offline fixture via
		// the public datastore; deletion must not bypass the SDK's active-run guard.
		for (const run of (await opened.runs.list({ filter: { agentIds: [id] } })).items) {
			await opened.runs.update({ run: { ...run, status: "finished" } });
		}
		await opened.runs.create({ run: {
			agentId: id, runId: `run-${id}`, turnNumber: 2, status: "finished",
			result: "retained answer", createdAt: 1, updatedAt: 2,
		} });
		await opened.runEvents.append({ runId: `run-${id}`, eventType: "proof", payload: { retained: true } });
		await opened.checkpoints.create({ agentId: id, blobId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", data: new Uint8Array([1, 2, 3]) });
	} finally { await opened.dispose(); }
}
async function select(root: string, scopeKey = "session-a", id = agentId) {
	return openCursorSessionStoreForScope({
		cwd, scopeKey, persistent: true,
		resume: { identity: identity(root), agentId: id },
	});
}
async function assertHistory(root: string, id = agentId) {
	const opened = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: toNamespacedPath(root) });
	try {
		expect(await opened.runs.get({ agentId: id, runId: `run-${id}` })).toMatchObject({ result: "retained answer" });
		expect((await opened.runEvents.list({ runId: `run-${id}` })).items).toHaveLength(1);
		expect(await opened.checkpoints.get({ agentId: id, blobId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" })).toEqual(new Uint8Array([1, 2, 3]));
		// No model/API key: inspected public resume path skips remote catalog validation.
		const resumed = await Agent.resume(id, { local: { cwd, store: opened, settingSources: [] } });
		expect(resumed.agentId).toBe(id);
		await resumed[Symbol.asyncDispose]();
	} finally { await opened.dispose(); }
}

function recordCleanupCandidate(manager: SessionManager, root: string) {
	const scopeKey = cursorSessionScopeKeyForManager(manager);
	const branchHash = resumeTests.hashBranchStep(resumeTests.EMPTY_BRANCH_HASH, manager.getBranch()[0]!);
	manager.appendCustomEntry(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, {
		version: 2, runtime: "local", agentId: "agent-active",
		scopeKey, sessionFile: manager.getSessionFile()!, sessionId: manager.getSessionId(), cwd,
		poolKey: "unchanged-pool", branchPathHash: branchHash, compactionGeneration: 0,
		sendState: { bootstrapped: true, contextFingerprint: "saved", incrementalSendCount: 2 },
		createdAt: new Date().toISOString(), storeIdentity: identity(root),
		cleanupCandidates: [{ agentId, storeIdentity: identity(root) }, { agentId: "agent-active", storeIdentity: identity(root) }],
	});
}

function fileHashes(root: string): Record<string, string> {
	const hashes: Record<string, string> = {};
	function visit(path: string) {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const file = join(path, entry.name);
			if (entry.isDirectory()) visit(file);
			else hashes[file.slice(root.length)] = createHash("sha256").update(readFileSync(file)).digest("hex");
		}
	}
	visit(root);
	return hashes;
}

function malformedIdentity(root: string, kind: "double-slash" | "alternate-separators") {
	return kind === "double-slash" ? root.replace(dirname(legacyRoot), `${dirname(legacyRoot)}${sep}`) :
		(process.platform === "win32" ? root.replaceAll("\\", "/") : root.replaceAll("/", "\\"));
}

// A sync path-walk regression must fail in a bounded child, not hang Vitest's
// event loop. Import the current TypeScript owners, never stale built output.
function runIdentityChild(body: string) {
	const hook = `data:text/javascript,${encodeURIComponent(`
		import { existsSync } from "node:fs";
		import { registerHooks } from "node:module";
		import { fileURLToPath } from "node:url";
		registerHooks({ resolve(specifier, context, next) {
			if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
				const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
				if (existsSync(fileURLToPath(source))) return next(source.href, context);
			}
			return next(specifier, context);
		} });
	`)}`;
	const source = `
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		const prefix = ${JSON.stringify(dirname(currentRoot))};
		const checks = [];
		const lstat = fs.lstatSync;
		fs.lstatSync = (path, ...args) => {
			if (String(path).startsWith(${JSON.stringify(join(home, ".cursor"))})) checks.push(String(path));
			return lstat(path, ...args);
		};
		syncBuiltinESMExports();
		const deny = () => { throw new Error("Network forbidden in identity proof"); };
		for (const [name, methods] of [["node:http", ["request", "get"]], ["node:https", ["request", "get"]], ["node:http2", ["connect"]], ["node:net", ["connect", "createConnection"]], ["node:tls", ["connect"]]]) {
			const module = (await import(name)).default;
			for (const method of methods) module[method] = deny;
		}
		syncBuiltinESMExports();
		globalThis.fetch = deny;
		${body}
		assert(checks.length > 0);
		assert(checks.every(path => path === prefix || path.startsWith(prefix + ${JSON.stringify(sep)})));
		console.log(JSON.stringify({ completed: true, inspectedOnlyOwnedPaths: true }));
	`;
	const child = spawnSync(process.execPath, ["--import", hook, "--input-type=module", "-e", source], {
		cwd: process.cwd(), encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
		env: {
			HOME: home, USERPROFILE: home, CURSOR_CONFIG_DIR: join(home, "config"), PATH: dirname(process.execPath),
			...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		},
	});
	expect(child.error?.message).toBeUndefined();
	expect(child.status, child.stderr).toBe(0);
	expect(JSON.parse(child.stdout.trim().split("\n").at(-1)!)).toEqual({ completed: true, inspectedOnlyOwnedPaths: true });
}

beforeEach(() => {
	home = mkdtempSync(join(realpathSync(tmpdir()), "cursor-sdk-migration-"));
	cwd = join(home, "workspace");
	mkdirSync(cwd);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("CURSOR_API_KEY", "");
	vi.stubEnv("CURSOR_CONFIG_DIR", join(home, "config"));
	// Offline proof must fail rather than silently reaching any network transport.
	const deny = () => { throw new Error("Network forbidden in store migration contract"); };
	vi.stubGlobal("fetch", vi.fn(deny));
	for (const [module, key] of [
		[http, "request"], [http, "get"], [https, "request"], [https, "get"],
		[http2, "connect"], [net, "connect"], [net, "createConnection"], [tls, "connect"],
	] as const) (vi.spyOn as any)(module, key).mockImplementation(deny);
	syncBuiltinESMExports();
	currentRoot = getDefaultSdkStateRoot(cwd);
	legacyRoot = join(dirname(currentRoot), createHash("md5").update(cwd).digest("hex"));
	expect(currentRoot).toBe(join(dirname(currentRoot), createHash("sha256").update(cwd).digest("hex")));
});
afterEach(() => {
	storeTests.setSdkOperations(undefined);
	cleanupTests.reset();
	resumeTests.reset();
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("installed SDK root migration with real SQLite", () => {
	it("opens unique temporary stores without inspecting, migrating or leasing linked workspace history", async () => {
		const outside = join(home, "outside");
		const externalLegacy = join(outside, createHash("md5").update(cwd).digest("hex"));
		const history = buildCursorSessionStateRoot(externalLegacy, "fileless-history");
		await seed(history);
		const before = fileHashes(outside);
		const prefix = dirname(currentRoot);
		mkdirSync(dirname(prefix), { recursive: true });
		symlinkSync(outside, prefix, process.platform === "win32" ? "junction" : "dir");
		const getter = vi.fn(getDefaultSdkStateRoot);
		storeTests.setSdkOperations({
			getDefaultStateRoot: getter,
			openSqliteStore: (options) => SqliteLocalAgentStore.open(options),
		});
		const inspect = vi.spyOn(fs, "lstatSync");
		const rename = vi.spyOn(fs, "renameSync");
		syncBuiltinESMExports();
		let first: Awaited<ReturnType<typeof openCursorSessionStoreForScope>> | undefined =
			await openCursorSessionStoreForScope({ cwd, scopeKey: "fileless", persistent: false });
		let second: Awaited<ReturnType<typeof openCursorSessionStoreForScope>> | undefined;
		try {
			second = await openCursorSessionStoreForScope({ cwd, scopeKey: "fileless", persistent: false });
			const firstRoot = dirname(dirname(first.sessionStore.identity.stateRoot));
			const secondRoot = dirname(dirname(second.sessionStore.identity.stateRoot));
			expect(firstRoot).not.toBe(secondRoot);
			expect(first.resumeAttemptAllowed).toBe(false);
			expect(second.resumeAttemptAllowed).toBe(false);
			expect(inspect.mock.calls.some(([path]) => String(path).startsWith(prefix))).toBe(false);
			expect(getter).not.toHaveBeenCalled();
			expect(rename).not.toHaveBeenCalled();
			// A temporary open must not retain a pending workspace derivation.
			rmSync(prefix);
			const persistent = await openCursorSessionStoreForScope({ cwd, scopeKey: "persistent", persistent: true });
			await persistent.sessionStore.dispose();
			expect(getter).toHaveBeenCalledOnce();
			await first.sessionStore.dispose();
			first = undefined;
			expect(existsSync(firstRoot)).toBe(false);
			expect(existsSync(secondRoot)).toBe(true);
			await second.sessionStore.dispose();
			second = undefined;
			expect(existsSync(secondRoot)).toBe(false);
			expect(fileHashes(outside)).toEqual(before);
			expect(readdirSync(outside)).toEqual([createHash("md5").update(cwd).digest("hex")]);
			await assertHistory(history);
		} finally {
			await first?.sessionStore.dispose();
			await second?.sessionStore.dispose();
		}
	});
	it.each(["C:\\Work +π\\Repo", "//SERVER/Foo...__-- bar/", "/"])(
		"contract-verifies preflight against the installed layout factory/public getter for %s", async (workspace) => {
		const modules = await installedCursorModules();
		const root = getDefaultSdkStateRoot(workspace);
		const prefix = dirname(root);
		const candidates = Object.values(modules("../utils/dist/workspace-paths.js"))
			.filter((value) => typeof value === "function")
			.map((value) => (value as (home: string, cwd: string) => string)(home, workspace))
			.filter((value) => join(value, "sdk-agent-store") === prefix);
		expect(candidates).toHaveLength(1);
		const outside = join(home, "outside");
		const oldHash = createHash("md5").update(workspace).digest("hex");
		mkdirSync(join(outside, oldHash), { recursive: true });
		writeFileSync(join(outside, oldHash, "keep"), "unchanged");
		const before = fileHashes(outside);
		mkdirSync(dirname(prefix), { recursive: true });
		symlinkSync(outside, prefix, process.platform === "win32" ? "junction" : "dir");
		await expect(openCursorSessionStoreForScope({
			cwd: workspace, scopeKey: "layout-contract", persistent: true,
		})).rejects.toThrow("link or non-directory");
		expect(fileHashes(outside)).toEqual(before);
	});
	it.each(["acquisition", "cleanup"] as const)("rejects an owned prefix BEFORE %s can rename matching external SQLite history", async (operation) => {
		const manager = SessionManager.create(cwd, join(home, "pi-sessions"));
		manager.appendMessage({ role: "user", content: "saved branch", timestamp: 1 });
		const scopeKey = cursorSessionScopeKeyForManager(manager);
		const outside = join(home, "outside");
		const externalLegacy = join(outside, createHash("md5").update(cwd).digest("hex"));
		const history = buildCursorSessionStateRoot(externalLegacy, scopeKey);
		await seed(history);
		const before = fileHashes(outside);
		const old = buildCursorSessionStateRoot(legacyRoot, scopeKey);
		recordCleanupCandidate(manager, old);
		const prefix = dirname(currentRoot);
		mkdirSync(dirname(prefix), { recursive: true });
		symlinkSync(outside, prefix, process.platform === "win32" ? "junction" : "dir");
		const rename = vi.spyOn(fs, "renameSync");
		const getter = vi.fn(getDefaultSdkStateRoot);
		const open = vi.spyOn(SqliteLocalAgentStore, "open");
		const remove = vi.spyOn(Agent, "delete");
		storeTests.setSdkOperations({
			getDefaultStateRoot: getter,
			openSqliteStore: (options) => SqliteLocalAgentStore.open(options),
		});
		syncBuiltinESMExports();
		if (operation === "acquisition") {
			await expect(select(old, scopeKey)).rejects.toThrow(`link or non-directory: ${prefix}`);
		} else {
			const reopened = SessionManager.open(manager.getSessionFile()!);
			await runCursorSessionAgentCleanupCommand({
				appendEntry: (type, data) => { reopened.appendCustomEntry(type, data); },
			}, "--yes", { cwd, sessionManager: reopened, ui: { notify: vi.fn() } });
			expect(reopened.getEntries().at(-1)).toMatchObject({ data: { deletedAgentIds: [], failedAgentIds: [{ agentId }] } });
		}
		expect(fileHashes(outside)).toEqual(before);
		expect(readdirSync(outside)).toEqual([createHash("md5").update(cwd).digest("hex")]);
		expect(rename).not.toHaveBeenCalled();
		expect(getter).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		open.mockRestore();
		rmSync(prefix);
		const fresh = await openCursorSessionStoreForScope({ cwd, scopeKey: "after-layout-repair", persistent: true });
		await fresh.sessionStore.dispose();
		expect(getter).toHaveBeenCalledOnce();
		expect(fileHashes(outside)).toEqual(before);
		await assertHistory(history);
	});

	it.each(["legacy-link", "legacy-link-with-current", "current-link", "legacy-file", "current-file", "prefix-file"] as const)(
		"rejects the %s workspace component before invoking the public migration getter", async (kind) => {
		const outside = join(home, "outside");
		await seed(outside);
		const before = fileHashes(outside);
		const blocked = kind.startsWith("legacy") ? legacyRoot : kind.startsWith("current") ? currentRoot : dirname(currentRoot);
		if (kind === "legacy-link-with-current") mkdirSync(currentRoot, { recursive: true });
		mkdirSync(dirname(blocked), { recursive: true });
		if (kind.includes("link")) symlinkSync(outside, blocked, process.platform === "win32" ? "junction" : "dir");
		else writeFileSync(blocked, "not a directory");
		const getter = vi.fn(getDefaultSdkStateRoot);
		const open = vi.fn((options: { workspaceRef: string; stateRoot: string }) => SqliteLocalAgentStore.open(options));
		storeTests.setSdkOperations({ getDefaultStateRoot: getter, openSqliteStore: open });
		await expect(select(legacyRoot)).rejects.toThrow(`link or non-directory: ${blocked}`);
		expect(getter).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
		expect(existsSync(blocked)).toBe(true);
		if (kind.endsWith("file")) expect(readFileSync(blocked, "utf8")).toBe("not a directory");
		expect(fileHashes(outside)).toEqual(before);
		await assertHistory(outside);
	});
	it.each(["workspace", "session"] as const)("resumes %s history after the actual SDK rename and again after restart", async (kind) => {
		const old = kind === "workspace" ? legacyRoot : buildCursorSessionStateRoot(legacyRoot, "session-a");
		const migrated = kind === "workspace" ? currentRoot : buildCursorSessionStateRoot(currentRoot, "session-a");
		await seed(old);
		expect(existsSync(currentRoot)).toBe(false);
		for (let restart = 0; restart < 2; restart++) {
			const selection = await select(old);
			try {
				expect(selection.resumeAttemptAllowed).toBe(true);
				expect(selection.resumeFallback).toBe(false);
				expect(selection.sessionStore.identity.stateRoot).toBe(migrated);
			} finally { await selection.sessionStore.dispose(); }
			await assertHistory(migrated);
		}
		expect(existsSync(legacyRoot)).toBe(false);
	});

	it("retains the recorded legacy owner when both roots and colliding agent IDs exist", async () => {
		const old = buildCursorSessionStateRoot(legacyRoot, "session-a");
		const fresh = buildCursorSessionStateRoot(currentRoot, "session-a");
		await seed(old);
		await seed(fresh);
		const selection = await select(old);
		try {
			expect(selection.resumeAttemptAllowed).toBe(true);
			expect(selection.sessionStore.identity.stateRoot).toBe(old);
			await Agent.delete(agentId, { cwd, store: selection.sessionStore.store });
			expect(await selection.sessionStore.store.agents.get({ agentId })).toBeNull();
		} finally { await selection.sessionStore.dispose(); }
		await assertHistory(fresh);
		expect(existsSync(legacyRoot)).toBe(true);
	});

	it("uses the surviving MD5 owner when the SDK rename fails", async () => {
		const old = buildCursorSessionStateRoot(legacyRoot, "session-a");
		await seed(old);
		vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("rename denied"), { code: "EACCES" }); });
		syncBuiltinESMExports();
		const selection = await select(old);
		try {
			expect(selection.resumeAttemptAllowed).toBe(true);
			expect(selection.sessionStore.identity.stateRoot).toBe(old);
		} finally { await selection.sessionStore.dispose(); }
		expect(existsSync(currentRoot)).toBe(false);
		await assertHistory(old);
	});

	it("shares the first root selection across concurrent scopes after a one-shot SDK rename failure", async () => {
		const old = buildCursorSessionStateRoot(legacyRoot, "session-a");
		await seed(old);
		const realRename = fs.renameSync;
		const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
			throw Object.assign(new Error("rename temporarily denied"), { code: "EACCES" });
		}).mockImplementation(realRename);
		syncBuiltinESMExports();
		const selections = await Promise.all([
			select(old),
			openCursorSessionStoreForScope({ cwd, scopeKey: "session-b", persistent: true }),
		]);
		try {
			expect(rename).toHaveBeenCalledTimes(1);
			expect(selections.map((selection) => {
				assert(selection.persistent);
				return selection.identities.defaultStore.stateRoot;
			})).toEqual([legacyRoot, legacyRoot]);
			expect(selections[0]!.resumeAttemptAllowed).toBe(true);
			expect(await selections[0]!.sessionStore.store.agents.get({ agentId })).toMatchObject({ agentId, cwd });
			await assertHistory(old);
			expect(existsSync(currentRoot)).toBe(false);
		} finally { await Promise.all(selections.map((selection) => selection.sessionStore.dispose())); }
		const restarted = await select(old);
		try {
			expect(restarted.sessionStore.identity.stateRoot).toBe(buildCursorSessionStateRoot(currentRoot, "session-a"));
			await assertHistory(restarted.sessionStore.identity.stateRoot);
		} finally { await restarted.sessionStore.dispose(); }
		expect(existsSync(legacyRoot)).toBe(false);
	});

	it.each([".cursor", "projects"] as const)("resumes real SQLite through a user-managed %s link above the SDK layout", async (kind) => {
		const linked = kind === ".cursor" ? join(home, ".cursor") : join(home, ".cursor", "projects");
		const outside = join(home, "user-managed");
		mkdirSync(outside);
		mkdirSync(dirname(linked), { recursive: true });
		symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
		const old = buildCursorSessionStateRoot(legacyRoot, "session-a");
		await seed(old);
		const selection = await select(old);
		try {
			expect(selection.resumeAttemptAllowed).toBe(true);
			await assertHistory(selection.sessionStore.identity.stateRoot);
		} finally { await selection.sessionStore.dispose(); }
	});

	it("falls back from an unreadable migrated default store without modifying its data", async () => {
		await seed(legacyRoot);
		// Observed installed .35 public SQLite layout: stateRoot/index.db.
		writeFileSync(join(legacyRoot, "index.db"), "unreadable retained SQLite data");
		const selection = await select(legacyRoot);
		try {
			expect(selection.resumeAttemptAllowed).toBe(false);
			expect(selection.resumeFallback).toBe(true);
			expect(selection.sessionStore.identity.stateRoot).toBe(buildCursorSessionStateRoot(currentRoot, "session-a"));
			expect(readFileSync(join(currentRoot, "index.db"), "utf8")).toBe("unreadable retained SQLite data");
		} finally { await selection.sessionStore.dispose(); }
	});

	it("defers SDK rename retries until every owned SQLite store in the workspace is disposed", async () => {
		const old = buildCursorSessionStateRoot(legacyRoot, "session-a");
		await seed(old);
		const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename temporarily denied"); });
		syncBuiltinESMExports();
		const first = await select(old);
		rename.mockRestore();
		syncBuiltinESMExports();
		const sibling = await openCursorSessionStoreForScope({
			cwd, scopeKey: "session-b", persistent: true,
		});
		let firstDisposed = false;
		try {
			assert(sibling.persistent);
			expect(sibling.identities.defaultStore.stateRoot).toBe(legacyRoot);
			expect(existsSync(currentRoot)).toBe(false);
			await first.sessionStore.dispose();
			firstDisposed = true;
			const third = await select(old);
			try {
				expect(third.sessionStore.identity.stateRoot).toBe(old);
				expect(existsSync(currentRoot)).toBe(false);
			} finally { await third.sessionStore.dispose(); }
		} finally {
			if (!firstDisposed) await first.sessionStore.dispose();
			await sibling.sessionStore.dispose();
		}
		const restarted = await select(old);
		try {
			expect(restarted.resumeAttemptAllowed).toBe(true);
			expect(restarted.sessionStore.identity.stateRoot).toBe(buildCursorSessionStateRoot(currentRoot, "session-a"));
		} finally { await restarted.sessionStore.dispose(); }
	});

	it.each(["wrong-scope", "outside", "missing-agent", "wrong-cwd"] as const)("rejects %s instead of treating a missing old path as migration proof", async (kind) => {
		const current = buildCursorSessionStateRoot(currentRoot, "session-a");
		await seed(current, agentId, kind === "wrong-cwd" ? join(home, "other") : cwd);
		const recorded = kind === "outside" ? join(home, "unrelated") :
			buildCursorSessionStateRoot(legacyRoot, kind === "wrong-scope" ? "other-scope" : "session-a");

		const selection = await select(recorded, "session-a", kind === "missing-agent" ? "agent-not-there" : agentId);
		try {
			expect(selection.resumeAttemptAllowed).toBe(false);
			expect(selection.resumeFallback).toBe(true);
		} finally { await selection.sessionStore.dispose(); }
	});

	it.each(["double-slash", "alternate-separators"] as const)("falls back from %s resume identities without walking above the prefix or changing history", async (kind) => {
		const current = buildCursorSessionStateRoot(currentRoot, "session-a");
		await seed(current);
		const recorded = malformedIdentity(buildCursorSessionStateRoot(legacyRoot, "session-a"), kind);
		runIdentityChild(`
			const { openCursorSessionStoreForScope } = await import(${JSON.stringify(new URL("../src/cursor-session-store.ts", import.meta.url).href)});
			const selection = await openCursorSessionStoreForScope(${JSON.stringify({ cwd, scopeKey: "session-a", persistent: true, resume: { identity: identity(recorded), agentId } })});
			assert.equal(selection.resumeAttemptAllowed, false);
			assert.equal(selection.resumeFallback, true);
			await selection.sessionStore.dispose();
		`);
		await assertHistory(current);
	});

	it.each(["double-slash", "alternate-separators"] as const)("durably rejects %s cleanup identities without walking above the prefix or deleting history", async (kind) => {
		const manager = SessionManager.create(cwd, join(home, "pi-sessions"));
		manager.appendMessage({ role: "user", content: "saved branch", timestamp: 1 });
		const scopeKey = cursorSessionScopeKeyForManager(manager);
		const old = buildCursorSessionStateRoot(legacyRoot, scopeKey);
		await seed(old);
		recordCleanupCandidate(manager, malformedIdentity(old, kind));
		runIdentityChild(`
			const { SessionManager } = await import("@earendil-works/pi-coding-agent");
			const { runCursorSessionAgentCleanupCommand } = await import(${JSON.stringify(new URL("../src/cursor-session-agent-cleanup.ts", import.meta.url).href)});
			const manager = SessionManager.open(${JSON.stringify(manager.getSessionFile())});
			await runCursorSessionAgentCleanupCommand({
				appendEntry: (type, data) => manager.appendCustomEntry(type, data),
			}, "--yes", { cwd: ${JSON.stringify(cwd)}, sessionManager: manager, ui: { notify() {} } });
			const result = manager.getEntries().at(-1).data;
			assert.deepEqual(result.deletedAgentIds, []);
			assert.equal(result.failedAgentIds[0].agentId, ${JSON.stringify(agentId)});
			assert.equal(result.failedAgentIds[0].retryable, false);
		`);
		const persisted = SessionManager.open(manager.getSessionFile()!);
		expect(persisted.getEntries().at(-1)).toMatchObject({ data: {
			deletedAgentIds: [], failedAgentIds: [{ agentId, retryable: false }],
		} });
		await assertHistory(buildCursorSessionStateRoot(currentRoot, scopeKey));
	});

	it.each([
		["session", "resume"], ["parent", "resume"],
		["session", "cleanup"], ["parent", "cleanup"],
		["session", "migrated-cleanup"], ["parent", "migrated-cleanup"],
		["session", "dangling-migrated-cleanup"], ["parent", "dangling-migrated-cleanup"],
	] as const)("guards a symlinked %s during %s without changing outside history", async (kind, operation) => {
		const manager = SessionManager.create(cwd, join(home, "pi-sessions"));
		manager.appendMessage({ role: "user", content: "saved branch", timestamp: 1 });
		const scopeKey = cursorSessionScopeKeyForManager(manager);
		const sessionRoot = buildCursorSessionStateRoot(currentRoot, scopeKey);
		await seed(sessionRoot);
		await seed(sessionRoot, "agent-active");
		const outside = join(home, "outside");
		const outsideHistory = kind === "parent" ? join(outside, basename(sessionRoot)) : outside;
		await seed(outsideHistory);
		const before = fileHashes(outside);
		const recorded = operation === "cleanup" ? sessionRoot : buildCursorSessionStateRoot(legacyRoot, scopeKey);
		recordCleanupCandidate(manager, recorded);
		const linked = kind === "parent" ? dirname(sessionRoot) : sessionRoot;
		const held = join(home, "held-owned-history");
		renameSync(linked, held);
		symlinkSync(operation.startsWith("dangling") ? join(home, "missing-target") : outside, linked,
			process.platform === "win32" ? "junction" : "dir");
		const getter = vi.fn(getDefaultSdkStateRoot);
		const open = vi.spyOn(SqliteLocalAgentStore, "open");
		const remove = vi.spyOn(Agent, "delete");
		storeTests.setSdkOperations({ getDefaultStateRoot: getter, openSqliteStore: (options) => SqliteLocalAgentStore.open(options) });
		const reopened = SessionManager.open(manager.getSessionFile()!);
		const pi = { appendEntry: (type: string, data: unknown) => { reopened.appendCustomEntry(type, data); } };
		const ctx = { cwd, sessionManager: reopened, ui: { notify: vi.fn() } };
		if (operation === "resume") {
			await expect(select(sessionRoot, scopeKey)).rejects.toThrow(`link or non-directory: ${linked}`);
		} else {
			await runCursorSessionAgentCleanupCommand(pi, "--yes", ctx);
			const failed = SessionManager.open(manager.getSessionFile()!).getEntries().at(-1);
			const result = failed?.type === "custom" ? cleanupTests.parseCleanupEntryData(failed.data) : undefined;
			expect(failed).toMatchObject({ data: { action: "delete", phase: "result", deletedAgentIds: [] } });
			expect(result?.failedAgentIds).toEqual([{ agentId, error: `Cursor local store path contains a link or non-directory: ${linked}` }]);
		}
		// This is a post-getter boundary, unlike the prefix preflight table.
		expect(getter).toHaveBeenCalledOnce();
		expect(open).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(fileHashes(outside)).toEqual(before);
		rmSync(linked);
		renameSync(held, linked);
		if (operation !== "resume") {
			// Reopen the actual durable ledger; the SAME candidate must remain eligible.
			const repaired = SessionManager.open(manager.getSessionFile()!);
			const retryPi = { appendEntry: (type: string, data: unknown) => { repaired.appendCustomEntry(type, data); } };
			const retryCtx = { cwd, sessionManager: repaired, ui: { notify: vi.fn() } };
			await runCursorSessionAgentCleanupCommand(retryPi, "--dry-run", retryCtx);
			expect(repaired.getEntries().at(-1)).toMatchObject({ data: { candidateAgentIds: [agentId], protectedAgentIds: ["agent-active"] } });
			await runCursorSessionAgentCleanupCommand(retryPi, "--yes", retryCtx);
			expect(remove).toHaveBeenCalledOnce();
			expect(remove).toHaveBeenCalledWith(agentId, expect.objectContaining({ cwd }));
			expect(SessionManager.open(manager.getSessionFile()!).getEntries().at(-1)).toMatchObject({ data: {
				phase: "result", deletedAgentIds: [agentId], protectedAgentIds: ["agent-active"],
			} });
			open.mockRestore();
			const owned = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: toNamespacedPath(sessionRoot) });
			try {
				expect(await owned.agents.get({ agentId })).toBeNull();
				expect(await owned.agents.get({ agentId: "agent-active" })).toMatchObject({ cwd });
			} finally { await owned.dispose(); }
			await assertHistory(sessionRoot, "agent-active");
		}
		expect(fileHashes(outside)).toEqual(before);
		await assertHistory(outsideHistory);
	});

	it.each(["ordinary", "concurrent-first", "delete-failure"] as const)(
		"retains exact persisted cleanup ownership and releases it after %s", async (kind) => {
		const manager = SessionManager.create(cwd, join(home, "pi-sessions"));
		manager.appendMessage({ role: "user", content: "saved branch", timestamp: 1 });
		const scopeKey = cursorSessionScopeKeyForManager(manager);
		const old = buildCursorSessionStateRoot(legacyRoot, scopeKey);
		await seed(old);
		await seed(old, "agent-active");
		recordCleanupCandidate(manager, old);
		// Reopen the real native ledger; the retained old identity must not strand cleanup.
		const reopened = SessionManager.open(manager.getSessionFile()!);
		if (kind !== "ordinary") {
			const realRename = fs.renameSync;
			vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
				throw Object.assign(new Error("rename temporarily denied"), { code: "EACCES" });
			}).mockImplementation(realRename);
			syncBuiltinESMExports();
		}
		if (kind === "delete-failure") cleanupTests.setSdkOperations({
			delete: async () => { throw new Error("delete temporarily denied"); },
		});
		const cleanup = runCursorSessionAgentCleanupCommand({
			appendEntry: (type, data) => { reopened.appendCustomEntry(type, data); },
		}, "--yes", { cwd, sessionManager: reopened, ui: { notify: vi.fn() } });
		if (kind === "concurrent-first") {
			const selection = await select(old, scopeKey, "agent-active");
			try {
				await cleanup;
				assert(selection.persistent);
				expect(selection.identities.defaultStore.stateRoot).toBe(legacyRoot);
				expect(selection.resumeAttemptAllowed).toBe(true);
				expect(await selection.sessionStore.store.agents.get({ agentId: "agent-active" })).toMatchObject({ cwd });
				expect(existsSync(currentRoot)).toBe(false);
			} finally { await selection.sessionStore.dispose(); }
		} else { await cleanup; }
		// Both cleanup success and failure must release derivation/store ownership:
		// this acquisition retries the real rename and can publicly resume history.
		const selection = await select(old, scopeKey, "agent-active");
		await selection.sessionStore.dispose();
		const migrated = buildCursorSessionStateRoot(currentRoot, scopeKey);
		const opened = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: toNamespacedPath(migrated) });
		try {
			if (kind === "delete-failure") {
				expect(await opened.agents.get({ agentId })).toMatchObject({ agentId });
				expect(reopened.getEntries().at(-1)).toMatchObject({ data: {
					deletedAgentIds: [], failedAgentIds: [{ agentId, error: "delete temporarily denied" }],
				} });
			} else {
				expect(await opened.agents.get({ agentId })).toBeNull();
				expect(await opened.checkpoints.get({ agentId, blobId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" })).toBeNull();
				expect((await opened.runEvents.list({ runId: `run-${agentId}` })).items).toEqual([]);
				expect(reopened.getEntries().at(-1)).toMatchObject({ data: { deletedAgentIds: [agentId], protectedAgentIds: ["agent-active"] } });
			}
			expect(await opened.agents.get({ agentId: "agent-active" })).toMatchObject({ agentId: "agent-active" });
		} finally { await opened.dispose(); }
		await assertHistory(migrated, "agent-active");
	});
});
