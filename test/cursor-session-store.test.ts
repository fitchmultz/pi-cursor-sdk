import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Agent, createAgentPlatform, type LocalAgentStore } from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCursorSessionStateRoot,
	hashCursorSessionStoreScope,
	openCursorSessionStore,
	openCursorSessionStoreForScope,
	__testUtils as storeTestUtils,
} from "../src/cursor-session-store.js";

describe("cursor session store identity", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pi-cursor-session-store-home-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
	});

	afterEach(() => {
		storeTestUtils.setSdkOperations(undefined);
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	it("derives a stable session root below the SDK workspace state root", () => {
		const scopeKey = "/tmp/sessions/example.jsonl";
		expect(hashCursorSessionStoreScope(scopeKey)).toBe("9983782212ce97faa33c17445f21670d");
		expect(buildCursorSessionStateRoot("/sdk/workspace", scopeKey)).toBe(
			join("/sdk/workspace", "pi-sessions", "9983782212ce97faa33c17445f21670d"),
		);
	});

	it("separates persisted pi sessions", () => {
		const first = buildCursorSessionStateRoot("/sdk/workspace", "session-a");
		const second = buildCursorSessionStateRoot("/sdk/workspace", "session-b");

		expect(first).not.toBe(second);
	});

	it("never resumes a fileless acquisition from the shared default store", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cursor-fileless-shared-store-"));
		storeTestUtils.setSdkOperations({
			getDefaultStateRoot: () => join(workspaceRoot, "sdk-owned"),
			openSqliteStore: async () => ({
				dispose: async () => {},
			}) as unknown as LocalAgentStore & { dispose(): Promise<void> },
		});
		try {
			const selection = await openCursorSessionStoreForScope({
				cwd: workspaceRoot,
				scopeKey: "ephemeral",
				persistent: false,
				resume: { identity: { version: 1, stateRoot: join(workspaceRoot, "sdk-owned") }, agentId: "previous-agent" },
			});
			expect(selection.resumeAttemptAllowed).toBe(false);
			expect(selection.sessionStore.identity.stateRoot).not.toBe(join(workspaceRoot, "sdk-owned"));
			await selection.sessionStore.dispose();
		} finally {
			storeTestUtils.setSdkOperations(undefined);
			rmSync(workspaceRoot, { recursive: true, force: true });
		}
	});

	it("removes a factory-owned temporary store after graceful disposal", async () => {
		storeTestUtils.setSdkOperations(undefined);
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-ephemeral-store-"));
		const selection = await openCursorSessionStoreForScope({
			cwd: root,
			scopeKey: "ephemeral",
			persistent: false,
		});
		const removalRoot = dirname(dirname(selection.sessionStore.identity.stateRoot));
		expect(existsSync(selection.sessionStore.identity.stateRoot)).toBe(true);

		await selection.sessionStore.dispose();

		expect(existsSync(removalRoot)).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});

	it("never grants temporary-removal ownership to a caller-supplied store", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cursor-shared-store-"));
		const sharedRoot = join(workspaceRoot, "shared");
		const marker = join(sharedRoot, "keep.txt");
		mkdirSync(sharedRoot, { recursive: true });
		writeFileSync(marker, "keep");
		const selection = await openCursorSessionStoreForScope({
			cwd: workspaceRoot,
			scopeKey: "persisted-session",
			persistent: true,
			resume: { identity: { version: 1, stateRoot: sharedRoot }, agentId: "previous-agent" },
		});
		try {
			expect(selection.resumeAttemptAllowed).toBe(false);
			expect(selection.resumeFallback).toBe(true);
			expect(selection.sessionStore.identity.stateRoot).not.toBe(sharedRoot);
		} finally {
			await selection.sessionStore.dispose();
			expect(existsSync(marker)).toBe(true);
			rmSync(workspaceRoot, { recursive: true, force: true });
		}
	});

	it("refuses temporary removal after an owned component is replaced by a link", async () => {
		storeTestUtils.setSdkOperations({
			getDefaultStateRoot: () => join(home, "workspace"),
			openSqliteStore: async ({ stateRoot }) => {
				mkdirSync(stateRoot, { recursive: true });
				return { dispose: async () => {} } as unknown as LocalAgentStore & { dispose(): Promise<void> };
			},
		});
		const selection = await openCursorSessionStoreForScope({
			cwd: home, scopeKey: "temporary", persistent: false,
		});
		const removalRoot = dirname(dirname(selection.sessionStore.identity.stateRoot));
		const outside = join(home, "user-managed");
		mkdirSync(outside);
		const marker = join(outside, "keep.txt");
		writeFileSync(marker, "keep");
		rmSync(removalRoot, { recursive: true });
		symlinkSync(outside, removalRoot, process.platform === "win32" ? "junction" : "dir");
		try {
			await expect(selection.sessionStore.dispose()).rejects.toThrow("removal path contains a link");
			expect(existsSync(marker)).toBe(true);
		} finally { rmSync(removalRoot); }
	});

	it("removes a temporary root even when SQLite disposal fails", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cursor-store-dispose-failure-"));
		let stateRoot = "";
		storeTestUtils.setSdkOperations({
			getDefaultStateRoot: () => join(workspaceRoot, "sdk-owned"),
			openSqliteStore: async (options) => {
				stateRoot = options.stateRoot;
				mkdirSync(stateRoot, { recursive: true });
				return {
					dispose: async () => { throw new Error("dispose failed"); },
				} as unknown as LocalAgentStore & { dispose(): Promise<void> };
			},
		});
		try {
			const selection = await openCursorSessionStoreForScope({
				cwd: workspaceRoot,
				scopeKey: "ephemeral",
				persistent: false,
			});
			const removalRoot = dirname(dirname(stateRoot));
			await expect(selection.sessionStore.dispose()).rejects.toThrow("dispose failed");
			expect(existsSync(removalRoot)).toBe(false);
		} finally {
			storeTestUtils.setSdkOperations(undefined);
			rmSync(workspaceRoot, { recursive: true, force: true });
		}
	});

	it("opens custom session/cwd-isolated SQLite stores with public persistence and exact deletion", async () => {
		storeTestUtils.setSdkOperations(undefined);
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-session-stores-"));
		const options = { cwd: root, persistent: true, storeRoot: join(root, "custom") };
		const [first, second] = await Promise.all([
			openCursorSessionStoreForScope({ ...options, scopeKey: "first" }),
			openCursorSessionStoreForScope({ ...options, scopeKey: "second" }),
		]);
		try {
			const workspace = join(realpathSync(root), "custom", createHash("sha256").update(resolve(root)).digest("hex").slice(0, 32));
			expect(first.sessionStore.identity.stateRoot).toBe(buildCursorSessionStateRoot(workspace, "first"));
			expect(second.sessionStore.identity.stateRoot).toBe(buildCursorSessionStateRoot(workspace, "second"));
			expect(existsSync(join(first.sessionStore.identity.stateRoot, "index.db"))).toBe(true);
			const otherCwd = await openCursorSessionStoreForScope({ ...options, cwd: join(root, "other"), scopeKey: "first" });
			expect(otherCwd.sessionStore.identity.stateRoot).not.toBe(first.sessionStore.identity.stateRoot);
			await otherCwd.sessionStore.dispose();
			expect(existsSync(join(home, ".cursor"))).toBe(false);
			await Promise.all([first, second].map((selected, index) => selected.sessionStore.store.agents.create({ agent: {
				agentId: index === 0 ? "agent-first" : "agent-second", cwd: root, status: "idle", createdAt: 1, updatedAt: 1,
			} })));
			expect(await first.sessionStore.store.agents.get({ agentId: "agent-second" })).toBeNull();
			expect(await Agent.messages.list("agent-first", { runtime: "local", cwd: root, store: first.sessionStore.store })).toEqual([]);
			const platform = await createAgentPlatform({ localStore: second.sessionStore.store, workspaceRef: root, scopedWorkspaceRef: root });
			expect(await platform.getAgent("agent-second")).toMatchObject({ agentId: "agent-second" });
			await Agent.delete("agent-first", { cwd: root, store: first.sessionStore.store });
			expect(await first.sessionStore.store.agents.get({ agentId: "agent-first" })).toBeNull();
		} finally { await Promise.all([first.sessionStore.dispose(), second.sessionStore.dispose()]); }
		const reopened = await openCursorSessionStoreForScope({ ...options, scopeKey: "second" });
		try {
			expect(await reopened.sessionStore.store.agents.get({ agentId: "agent-second" })).toMatchObject({ agentId: "agent-second" });
		} finally {
			await reopened.sessionStore.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["derive", "open", "dispose"] as const)("releases same-cwd ownership after %s failure", async (failure) => {
		let calls = 0;
		let fail = true;
		const root = join(home, "owned");
		storeTestUtils.setSdkOperations({
			getDefaultStateRoot: async () => {
				calls++;
				if (fail && failure === "derive") throw new Error("derive failed");
				return root;
			},
			openSqliteStore: async () => {
				if (fail && failure === "open") throw new Error("open failed");
				return { dispose: async () => {
					if (fail && failure === "dispose") throw new Error("dispose failed");
				} } as unknown as LocalAgentStore & { dispose(): Promise<void> };
			},
		});
		const options = { cwd: home, scopeKey: "first", persistent: true };
		const first = openCursorSessionStoreForScope(options);
		if (failure === "dispose") {
			await expect((await first).sessionStore.dispose()).rejects.toThrow("dispose failed");
		} else if (failure === "derive") {
			const sibling = openCursorSessionStoreForScope({ ...options, scopeKey: "sibling" });
			await Promise.all([first, sibling].map((selection) => expect(selection).rejects.toThrow("derive failed")));
		} else {
			await expect(first).rejects.toThrow(`${failure} failed`);
		}
		fail = false;
		const next = await openCursorSessionStoreForScope({ ...options, scopeKey: "next" });
		await next.sessionStore.dispose();
		expect(calls).toBe(2);
	});

	it("rejects missing or mismatched workspace ownership instead of adopting it and releases the failed open", async () => {
		const root = join(home, "owned");
		const getter = vi.fn(() => root);
		storeTestUtils.setSdkOperations({
			getDefaultStateRoot: getter,
			openSqliteStore: async () => ({ dispose: async () => {} }) as unknown as LocalAgentStore & { dispose(): Promise<void> },
		});
		const options = { cwd: home, scopeKey: "first", persistent: true };
		await expect(openCursorSessionStore(home, { version: 1, stateRoot: root }, root)).rejects.toThrow("ownership is not active");
		const first = await openCursorSessionStoreForScope(options);
		const wrong = join(home, "wrong");
		await expect(openCursorSessionStore(home, { version: 1, stateRoot: wrong }, wrong)).rejects.toThrow("ownership root mismatch");
		await first.sessionStore.dispose();
		const next = await openCursorSessionStoreForScope(options);
		await next.sessionStore.dispose();
		expect(getter).toHaveBeenCalledTimes(2);
	});
});
