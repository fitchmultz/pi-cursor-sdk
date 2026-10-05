import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { CURSOR_STORE_ROOT_ENV, loadCursorSdkProjectConfig, loadCursorSdkUserConfig, parseCursorSdkConfig, resolveCursorSdkConfig } from "../src/cursor-config.js";
import { buildCursorCustomWorkspaceRoot, buildCursorSessionStateRoot, isCanonicalConfiguredSessionStoreIdentity, isCanonicalDefaultSessionStoreIdentity, openCursorSessionStoreForScope, resolveCursorStoreRootBase, withCursorSessionStoreIdentities, __testUtils as storeTests } from "../src/cursor-session-store.js";
import { __testUtils as sessionAgents } from "../src/cursor-session-agent.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";

describe("configured local store root", () => {
	let base: string;
	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "cursor-custom-root-"));
	});
	afterEach(() => {
		storeTests.setSdkOperations(undefined);
		vi.unstubAllEnvs();
		rmSync(base, { recursive: true, force: true });
	});

	it("resolves explicit environment, trusted project and user paths in precedence order", () => {
		const config = { user: { local: { storeRoot: "user" } }, project: { local: { storeRoot: "project" } } };
		expect(resolveCursorSdkConfig({ ...config, env: { [CURSOR_STORE_ROOT_ENV]: "env" } }).local.storeRoot).toMatchObject({ value: "env", source: "environment" });
		expect(resolveCursorSdkConfig({ ...config, env: {} }).local.storeRoot).toMatchObject({ value: "project", source: "project" });
		expect(resolveCursorSdkConfig({ user: config.user, env: {} }).local.storeRoot.value).toBe("user");
		expect(resolveCursorSdkConfig({ env: {} }).local.storeRoot.value).toBeUndefined();
		expect(resolveCursorStoreRootBase(base, "relative")).toBe(resolve(base, "relative"));
		expect(resolveCursorStoreRootBase(base, "~/stores")).toBe(join(homedir(), "stores"));
	});

	it("keeps the default pool identity and canonicalizes configured bases", () => {
		const params = { apiKey: "key", agentMode: "agent" as const, cwd: base, modelSelection: { id: "model" } };
		const original = sessionAgents.buildSessionAgentPoolKey("scope", params);
		expect(sessionAgents.buildSessionAgentPoolKey("scope", { ...params, storeRootBase: undefined })).toBe(original);
		const relative = sessionAgents.buildSessionAgentPoolKey("scope", { ...params, storeRootBase: "state" });
		expect(relative).toBe(sessionAgents.buildSessionAgentPoolKey("scope", { ...params, storeRootBase: join(base, "state") }));
		expect(relative).not.toBe(original);
		expect(relative).not.toBe(sessionAgents.buildSessionAgentPoolKey("scope", { ...params, storeRootBase: "other" }));
	});

	it("retains both configured store and subagent ownership in the pool identity", () => {
		const params = {
			apiKey: "key",
			agentMode: "agent" as const,
			cwd: base,
			modelSelection: { id: "model" },
			storeRootBase: "state",
			customSubagents: { reviewer: { description: "Reviews", prompt: "Review carefully" } },
		};
		const combined = sessionAgents.buildSessionAgentPoolKey("scope", params);
		expect(sessionAgents.buildSessionAgentPoolKey("scope", { ...params, storeRootBase: "other" })).not.toBe(combined);
		expect(sessionAgents.buildSessionAgentPoolKey("scope", {
			...params,
			customSubagents: { reviewer: { description: "Reviews", prompt: "Review changed behavior" } },
		})).not.toBe(combined);
		expect(sessionAgents.buildSessionAgentPoolKey("scope", { ...params, customSubagents: undefined })).not.toBe(combined);
	});

	it("recognizes configured identities only for their exact cwd and session", () => {
		const cwd = join(base, "workspace");
		const stateRoot = buildCursorSessionStateRoot(buildCursorCustomWorkspaceRoot(base, cwd), "scope");
		const identity = { version: 1 as const, stateRoot };
		expect(isCanonicalConfiguredSessionStoreIdentity(cwd, "scope", identity)).toBe(true);
		expect(isCanonicalConfiguredSessionStoreIdentity(join(base, "other"), "scope", identity)).toBe(false);
		expect(isCanonicalConfiguredSessionStoreIdentity(cwd, "other", identity)).toBe(false);
		expect(isCanonicalConfiguredSessionStoreIdentity(cwd, "scope", { ...identity, stateRoot: stateRoot + "/" })).toBe(false);
		expect(isCanonicalConfiguredSessionStoreIdentity(cwd, "scope", { ...identity, stateRoot: stateRoot.replace("pi-sessions", "pi-sessions/..//pi-sessions") })).toBe(false);
		expect(isCanonicalConfiguredSessionStoreIdentity(cwd, "scope", { ...identity, stateRoot: "relative" })).toBe(false);
	});

	it("classifies only exact default layouts for retry without touching storage", () => {
		const cwd = join(base, "workspace");
		const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
		for (const algorithm of ["sha256", "md5"]) {
			const root = join(homedir(), ".cursor", "projects", slug, "sdk-agent-store", createHash(algorithm).update(cwd).digest("hex"));
			const identity = { version: 1 as const, stateRoot: buildCursorSessionStateRoot(root, "scope") };
			expect(isCanonicalDefaultSessionStoreIdentity(cwd, "scope", identity)).toBe(true);
			expect(isCanonicalDefaultSessionStoreIdentity(cwd, "scope", { ...identity, stateRoot: root })).toBe(true);
			expect(isCanonicalDefaultSessionStoreIdentity(cwd, "other", identity)).toBe(false);
			expect(isCanonicalDefaultSessionStoreIdentity(join(base, "other"), "scope", identity)).toBe(false);
			expect(isCanonicalDefaultSessionStoreIdentity(cwd, "scope", { ...identity, stateRoot: identity.stateRoot + "/" })).toBe(false);
			expect(isCanonicalDefaultSessionStoreIdentity(cwd, "scope", { ...identity, stateRoot: identity.stateRoot.replace("pi-sessions", "pi-sessions/../pi-sessions") })).toBe(false);
		}
		expect(isCanonicalDefaultSessionStoreIdentity(cwd, "scope", undefined)).toBe(false);
		expect(isCanonicalDefaultSessionStoreIdentity(cwd, "scope", { version: 1, stateRoot: "/tmp/untrusted-store" })).toBe(false);
	});

	it("does not read an untrusted project's malformed store path", () => {
		const configDir = join(base, ".pi");
		mkdirSync(configDir);
		writeFileSync(join(configDir, "cursor-sdk.json"), JSON.stringify({ local: { storeRoot: 42 } }));
		expect(loadCursorSdkProjectConfig(base, false)).toBeUndefined();
		expect(() => loadCursorSdkProjectConfig(base, true)).toThrow("storeRoot");
	});

	it.each(["", "   ", "bad\0path", "bad\npath", 42, null])("rejects explicit malformed paths without falling back: %j", (path) => {
		expect(() => parseCursorSdkConfig({ local: { storeRoot: path } })).toThrow("storeRoot");
		const configFile = join(base, "cursor-sdk.json");
		writeFileSync(configFile, JSON.stringify({ local: { storeRoot: path } }));
		expect(() => loadCursorSdkUserConfig(configFile)).toThrow("storeRoot");
		if (typeof path === "string") expect(() => resolveCursorSdkConfig({ env: { [CURSOR_STORE_ROOT_ENV]: path } })).toThrow("storeRoot");
	});

	it("bypasses the migration-capable default getter and separates cwd/session identities", async () => {
		const getter = vi.fn(() => { throw new Error("default getter must not run"); });
		const mock = installCursorSessionStoreMock(getter);
		const cwd = join(base, "workspace");
		const selections = await Promise.all([
			openCursorSessionStoreForScope({ cwd, scopeKey: "a", persistent: true, storeRootBase: base }),
			openCursorSessionStoreForScope({ cwd, scopeKey: "b", persistent: true, storeRootBase: base }),
			openCursorSessionStoreForScope({ cwd: join(base, "other"), scopeKey: "a", persistent: true, storeRootBase: base }),
		]);
		try {
			expect(getter).not.toHaveBeenCalled();
			expect(new Set(selections.map(s => s.sessionStore.identity.stateRoot)).size).toBe(3);
			expect(selections[0]!.sessionStore.identity.stateRoot).toBe(buildCursorSessionStateRoot(buildCursorCustomWorkspaceRoot(base, cwd), "a"));
			expect(mock.openedOptions).toHaveLength(3);
		} finally {
			await Promise.all(selections.map((selection) => selection.sessionStore.dispose()));
		}
	});

	it("retains independent same-cwd leases when the selected base changes", async () => {
		installCursorSessionStoreMock(() => { throw new Error("default getter must not run"); });
		const cwd = join(base, "workspace");
		const old = await openCursorSessionStoreForScope({ cwd, scopeKey: "a", persistent: true, storeRootBase: join(base, "old") });
		const current = await openCursorSessionStoreForScope({ cwd, scopeKey: "a", persistent: true, storeRootBase: join(base, "new") });
		try {
			expect(old.sessionStore.identity.stateRoot).not.toBe(current.sessionStore.identity.stateRoot);
			await withCursorSessionStoreIdentities(cwd, "b", async identities => {
				expect(identities.defaultStore.stateRoot).toBe(buildCursorCustomWorkspaceRoot(join(base, "old"), cwd));
			}, join(base, "old"));
		} finally {
			await old.sessionStore.dispose();
			await current.sessionStore.dispose();
		}
	});

	it.each(["prefix", "cwd", "session-parent", "session"] as const)("rejects owned %s links before opening SQLite", async (part) => {
		const cwd = join(base, "workspace");
		const root = buildCursorCustomWorkspaceRoot(base, cwd);
		const session = buildCursorSessionStateRoot(root, "a");
		const linked = { prefix: dirname(root), cwd: root, "session-parent": dirname(session), session }[part];
		const outside = join(base, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "keep.txt"), "preserved");
		mkdirSync(dirname(linked), { recursive: true });
		symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
		const mock = installCursorSessionStoreMock();
		await expect(openCursorSessionStoreForScope({ cwd, scopeKey: "a", persistent: true, storeRootBase: base })).rejects.toThrow("link or non-directory");
		expect(mock.openSqliteStore).not.toHaveBeenCalled();
		expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("preserved");
	});

	it("supports a user-managed ancestor link and leaves its permissions unchanged", async () => {
		const target = join(base, "target");
		mkdirSync(target, { mode: 0o751 });
		const before = statSync(target).mode;
		const alias = join(base, "alias");
		symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
		installCursorSessionStoreMock();
		const selected = await openCursorSessionStoreForScope({ cwd: base, scopeKey: "a", persistent: true, storeRootBase: alias });
		try {
			expect(statSync(target).mode).toBe(before);
			if (process.platform !== "win32") expect(statSync(join(target, "pi-cursor-sdk")).mode & 0o777).toBe(0o700);
		} finally {
			await selected.sessionStore.dispose();
		}
	});

	it("keeps temporary summary/fileless stores outside the configured base", async () => {
		installCursorSessionStoreMock();
		const selected = await openCursorSessionStoreForScope({ cwd: base, scopeKey: "summary", persistent: false, storeRootBase: base });
		try {
			expect(selected.sessionStore.identity.stateRoot.startsWith(join(base, "pi-cursor-sdk"))).toBe(false);
		}
		finally {
			await selected.sessionStore.dispose();
		}
	});

	it("retains real SQLite history only in its exact configured cwd and session", async () => {
		const cwd = join(base, "workspace");
		const first = await openCursorSessionStoreForScope({ cwd, scopeKey: "a", persistent: true, storeRootBase: base });
		const second = await openCursorSessionStoreForScope({ cwd, scopeKey: "b", persistent: true, storeRootBase: base });
		const agent = { agentId: "custom-history", cwd, status: "idle" as const, createdAt: 1, updatedAt: 1 };
		try {
			await first.sessionStore.store.agents.create({ agent });
			expect(await second.sessionStore.store.agents.get({ agentId: agent.agentId })).toBeNull();
		} finally {
			await first.sessionStore.dispose();
			await second.sessionStore.dispose();
		}
		const reopened = await openCursorSessionStoreForScope({ cwd, scopeKey: "a", persistent: true, storeRootBase: base, resume: { identity: first.sessionStore.identity, agentId: agent.agentId } });
		try {
			expect(reopened.resumeAttemptAllowed).toBe(true);
			expect(await reopened.sessionStore.store.agents.get({ agentId: agent.agentId })).toMatchObject(agent);
			const direct = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: reopened.sessionStore.identity.stateRoot });
			try {
				expect(await direct.agents.get({ agentId: agent.agentId })).toMatchObject(agent);
			} finally {
				await direct.dispose();
			}
		} finally {
			await reopened.sessionStore.dispose();
		}
	});
});
