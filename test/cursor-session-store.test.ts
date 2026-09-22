import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent, createAgentPlatform, type LocalAgentStore } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import { CURSOR_STORE_ROOT_ENV } from "../src/cursor-config.js";
import {
	buildCursorSessionStateRoot,
	ensurePersistentStoreRoot,
	getCursorSessionStoreIdentities,
	hashCursorSessionStoreScope,
	hashWorkspaceCwd,
	openCursorSessionStore,
	openCursorSessionStoreForScope,
	resolveSdkStateRoot,
	__testUtils as storeTestUtils,
} from "../src/cursor-session-store.js";

describe("cursor session store identity", () => {
	it("derives a stable session root below the workspace state root", () => {
		const scopeKey = "/tmp/sessions/example.jsonl";
		expect(hashCursorSessionStoreScope(scopeKey)).toBe("9983782212ce97faa33c17445f21670d");
		expect(buildCursorSessionStateRoot("/sdk/workspace", scopeKey, true)).toBe(
			join("/sdk/workspace", "pi-sessions", "9983782212ce97faa33c17445f21670d"),
		);
	});

	it("separates persisted pi sessions and gives every fileless open a temporary root", () => {
		const first = buildCursorSessionStateRoot("/sdk/workspace", "session-a", true);
		const second = buildCursorSessionStateRoot("/sdk/workspace", "session-b", true);
		const anonymous = buildCursorSessionStateRoot("/sdk/workspace", "__anonymous__", false);

		expect(first).not.toBe(second);
		expect(anonymous).not.toBe(buildCursorSessionStateRoot("/sdk/workspace", "__anonymous__", false));
		expect(anonymous).toContain(join(tmpdir(), "pi-cursor-sdk-"));
		expect(anonymous).toContain("pi-sessions");
	});

	it("never resumes a fileless acquisition from the shared default store", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cursor-fileless-shared-store-"));
		storeTestUtils.setSdkOperations({
			getDefaultStateRoot: () => workspaceRoot,
			openSqliteStore: async () => ({
				dispose: async () => {},
			}) as unknown as LocalAgentStore & { dispose(): Promise<void> },
		});
		try {
			const selection = await openCursorSessionStoreForScope({
				cwd: workspaceRoot,
				scopeKey: "ephemeral",
				persistent: false,
				hasResumeHandle: true,
				resumeIdentity: { version: 1, stateRoot: workspaceRoot },
			});
			expect(selection.resumeAttemptAllowed).toBe(false);
			expect(selection.sessionStore.identity.stateRoot).not.toBe(workspaceRoot);
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
			hasResumeHandle: false,
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
			hasResumeHandle: true,
			resumeIdentity: { version: 1, stateRoot: sharedRoot },
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

	it("removes a temporary root even when SQLite disposal fails", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cursor-store-dispose-failure-"));
		let stateRoot = "";
		storeTestUtils.setSdkOperations({
			getDefaultStateRoot: () => workspaceRoot,
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
				hasResumeHandle: false,
			});
			const removalRoot = dirname(dirname(stateRoot));
			await expect(selection.sessionStore.dispose()).rejects.toThrow("dispose failed");
			expect(existsSync(removalRoot)).toBe(false);
		} finally {
			storeTestUtils.setSdkOperations(undefined);
			rmSync(workspaceRoot, { recursive: true, force: true });
		}
	});

	it("opens isolated SQLite stores that can write concurrently", async () => {
		storeTestUtils.setSdkOperations(undefined);
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-session-stores-"));
		const [first, second] = await Promise.all([
			openCursorSessionStore(root, { version: 1, stateRoot: join(root, "first") }),
			openCursorSessionStore(root, { version: 1, stateRoot: join(root, "second") }),
		]);
		try {
			await Promise.all([
				first.store.agents.create({ agent: {
					agentId: "agent-first",
					cwd: root,
					status: "idle",
					createdAt: 1,
					updatedAt: 1,
				} }),
				second.store.agents.create({ agent: {
					agentId: "agent-second",
					cwd: root,
					status: "idle",
					createdAt: 1,
					updatedAt: 1,
				} }),
			]);
			expect(await first.store.agents.get({ agentId: "agent-first" })).toMatchObject({ agentId: "agent-first" });
			expect(await first.store.agents.get({ agentId: "agent-second" })).toBeNull();
			expect(await Agent.messages.list("agent-first", { runtime: "local", cwd: root, store: first.store })).toEqual([]);
			const platform = await createAgentPlatform({
				localStore: second.store,
				workspaceRef: root,
				scopedWorkspaceRef: root,
			});
			expect(await platform.getAgent("agent-second")).toMatchObject({ agentId: "agent-second" });
			await Agent.delete("agent-first", { cwd: root, store: first.store });
			expect(await first.store.agents.get({ agentId: "agent-first" })).toBeNull();
			expect(await second.store.agents.get({ agentId: "agent-second" })).toMatchObject({ agentId: "agent-second" });
		} finally {
			await Promise.all([first.dispose(), second.dispose()]);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("places persistent session stores under the resolved storeRoot, not the SDK home default", async () => {
		const storeRoot = mkdtempSync(join(tmpdir(), "pi-cursor-store-root-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-cursor-cwd-"));
		storeTestUtils.setSdkOperations(undefined);
		const previous = process.env[CURSOR_STORE_ROOT_ENV];
		process.env[CURSOR_STORE_ROOT_ENV] = storeRoot;
		try {
			const scopeKey = "/tmp/sessions/example.jsonl";
			const identities = await getCursorSessionStoreIdentities(cwd, scopeKey, true);
			expect(identities.defaultStore.stateRoot).toBe(join(storeRoot, hashWorkspaceCwd(cwd)));
			expect(identities.sessionStore.stateRoot).toBe(
				join(storeRoot, hashWorkspaceCwd(cwd), "pi-sessions", hashCursorSessionStoreScope(scopeKey)),
			);
			if (process.platform !== "win32") {
				expect(statSync(storeRoot).mode & 0o777).toBe(0o700);
			}
			const fileless = await getCursorSessionStoreIdentities(cwd, "__anonymous__", false);
			expect(fileless.sessionStore.stateRoot).toContain(join(tmpdir(), "pi-cursor-sdk-"));
			expect(fileless.sessionStore.stateRoot).toContain("pi-sessions");
		} finally {
			if (previous === undefined) delete process.env[CURSOR_STORE_ROOT_ENV];
			else process.env[CURSOR_STORE_ROOT_ENV] = previous;
			rmSync(storeRoot, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("resumes a recorded store identity when it matches the configured custom storeRoot", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cursor-custom-resume-match-"));
		const customStoreRoot = mkdtempSync(join(tmpdir(), "pi-cursor-custom-store-root-match-"));
		storeTestUtils.setSdkOperations(undefined);
		const previous = process.env[CURSOR_STORE_ROOT_ENV];
		process.env[CURSOR_STORE_ROOT_ENV] = customStoreRoot;
		try {
			const scopeKey = "persisted-session";
			const identities = await getCursorSessionStoreIdentities(workspaceRoot, scopeKey, true);
			const selection = await openCursorSessionStoreForScope({
				cwd: workspaceRoot,
				scopeKey,
				persistent: true,
				hasResumeHandle: true,
				resumeIdentity: identities.sessionStore,
			});
			expect(selection.resumeAttemptAllowed).toBe(true);
			expect(selection.resumeFallback).toBe(false);
			expect(selection.sessionStore.identity).toEqual(identities.sessionStore);
			await selection.sessionStore.dispose();
		} finally {
			if (previous === undefined) delete process.env[CURSOR_STORE_ROOT_ENV];
			else process.env[CURSOR_STORE_ROOT_ENV] = previous;
			storeTestUtils.setSdkOperations(undefined);
			rmSync(workspaceRoot, { recursive: true, force: true });
			rmSync(customStoreRoot, { recursive: true, force: true });
		}
	});

	it("does not resume a recorded store identity against a configured custom storeRoot", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cursor-custom-resume-"));
		const customStoreRoot = mkdtempSync(join(tmpdir(), "pi-cursor-custom-store-root-"));
		storeTestUtils.setSdkOperations(undefined);
		const previous = process.env[CURSOR_STORE_ROOT_ENV];
		process.env[CURSOR_STORE_ROOT_ENV] = customStoreRoot;
		try {
			const selection = await openCursorSessionStoreForScope({
				cwd: workspaceRoot,
				scopeKey: "persisted-session",
				persistent: true,
				hasResumeHandle: true,
				resumeIdentity: {
					version: 1,
					stateRoot: "/home/user/.cursor/projects/example/sdk-agent-store/pi-sessions/deadbeef",
				},
			});
			expect(selection.resumeAttemptAllowed).toBe(false);
			expect(selection.resumeFallback).toBe(true);
			expect(selection.sessionStore.identity.stateRoot).toContain("pi-sessions");
			expect(selection.sessionStore.identity.stateRoot).not.toContain(".cursor/projects");
			expect(selection.sessionStore.identity.stateRoot).toContain(hashWorkspaceCwd(workspaceRoot));
			await selection.sessionStore.dispose();
		} finally {
			if (previous === undefined) delete process.env[CURSOR_STORE_ROOT_ENV];
			else process.env[CURSOR_STORE_ROOT_ENV] = previous;
			storeTestUtils.setSdkOperations(undefined);
			rmSync(workspaceRoot, { recursive: true, force: true });
			rmSync(customStoreRoot, { recursive: true, force: true });
		}
	});

	it("uses the SDK default state root when storeRoot is not configured", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-default-root-"));
		const isolatedDefaultStateRoot = async (workspaceCwd: string) =>
			resolveSdkStateRoot(workspaceCwd, { env: {}, user: {} });
		storeTestUtils.setSdkOperations({
			getDefaultStateRoot: isolatedDefaultStateRoot,
			openSqliteStore: async () =>
				({ dispose: async () => {} }) as unknown as LocalAgentStore & { dispose(): Promise<void> },
		});
		const previous = process.env[CURSOR_STORE_ROOT_ENV];
		delete process.env[CURSOR_STORE_ROOT_ENV];
		try {
			const identities = await getCursorSessionStoreIdentities(cwd, "session-a", true);
			expect(identities.defaultStore.stateRoot).toBe(await isolatedDefaultStateRoot(cwd));
			expect(identities.defaultStore.stateRoot).toContain(".cursor/projects");
		} finally {
			storeTestUtils.setSdkOperations(undefined);
			if (previous === undefined) delete process.env[CURSOR_STORE_ROOT_ENV];
			else process.env[CURSOR_STORE_ROOT_ENV] = previous;
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("normalizes cwd before hashing for a configured custom storeRoot", async () => {
		const storeRoot = mkdtempSync(join(tmpdir(), "pi-cursor-store-root-normalize-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-cursor-cwd-normalize-"));
		const previous = process.env[CURSOR_STORE_ROOT_ENV];
		process.env[CURSOR_STORE_ROOT_ENV] = storeRoot;
		try {
			const withSlash = await resolveSdkStateRoot(`${cwd}/`, { env: process.env, user: {} });
			const withoutSlash = await resolveSdkStateRoot(cwd, { env: process.env, user: {} });
			expect(withSlash).toBe(withoutSlash);
			expect(withSlash).toBe(join(storeRoot, hashWorkspaceCwd(cwd)));
		} finally {
			if (previous === undefined) delete process.env[CURSOR_STORE_ROOT_ENV];
			else process.env[CURSOR_STORE_ROOT_ENV] = previous;
			rmSync(storeRoot, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it.skipIf(process.getuid?.() === 0)("fails closed when the resolved storeRoot is not writable", async () => {
		const parent = mkdtempSync(join(tmpdir(), "pi-cursor-ro-"));
		chmodSync(parent, 0o500);
		try {
			expect(() => ensurePersistentStoreRoot(join(parent, "pi-cursor-sdk"))).toThrow(/not writable|cannot be used|refusing/);
			await expect(
				resolveSdkStateRoot("/tmp/project", {
					env: { [CURSOR_STORE_ROOT_ENV]: join(parent, "pi-cursor-sdk") },
					user: {},
				}),
			).rejects.toThrow(/not writable|cannot be used|refusing/);
		} finally {
			chmodSync(parent, 0o700);
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("does not chmod an unowned parent and restricts only the storeRoot leaf", () => {
		const parent = mkdtempSync(join(tmpdir(), "pi-cursor-parent-mode-"));
		chmodSync(parent, 0o755);
		const storeRoot = join(parent, "pi-cursor-sdk");
		try {
			ensurePersistentStoreRoot(storeRoot);
			expect(statSync(parent).mode & 0o777).toBe(0o755);
			if (process.platform !== "win32") {
				expect(statSync(storeRoot).mode & 0o777).toBe(0o700);
			}
		} finally {
			chmodSync(parent, 0o700);
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"does not create a persistent storeRoot for fileless acquisitions",
		async () => {
			const parent = mkdtempSync(join(tmpdir(), "pi-cursor-fileless-ro-"));
			chmodSync(parent, 0o500);
			storeTestUtils.setSdkOperations(undefined);
			const previous = process.env[CURSOR_STORE_ROOT_ENV];
			process.env[CURSOR_STORE_ROOT_ENV] = join(parent, "pi-cursor-sdk");
			try {
				const identities = await getCursorSessionStoreIdentities("/tmp/project", "__anonymous__", false);
				expect(identities.sessionStore.stateRoot).toContain(join(tmpdir(), "pi-cursor-sdk-"));
				expect(existsSync(join(parent, "pi-cursor-sdk"))).toBe(false);
			} finally {
				if (previous === undefined) delete process.env[CURSOR_STORE_ROOT_ENV];
				else process.env[CURSOR_STORE_ROOT_ENV] = previous;
				chmodSync(parent, 0o700);
				rmSync(parent, { recursive: true, force: true });
			}
		},
	);

	it("rejects filesystem-root and parent-directory storeRoot paths", () => {
		expect(() => ensurePersistentStoreRoot("relative-store")).toThrow(/absolute|usable|refusing/);
		expect(() => ensurePersistentStoreRoot("/")).toThrow(/usable|refusing|root/);
		expect(() => ensurePersistentStoreRoot("/var/tmp/foo/../bar")).toThrow(/usable|refusing|\.\./);
	});

	it.skipIf(process.platform === "win32")("rejects a storeRoot that is a symlink", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cursor-symlink-store-"));
		const target = join(dir, "target");
		const link = join(dir, "link");
		mkdirSync(target);
		symlinkSync(target, link);
		try {
			expect(() => ensurePersistentStoreRoot(link)).toThrow(/symlink|refusing/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("rejects a symlink under a world-writable parent", () => {
		const parent = mkdtempSync(join(tmpdir(), "pi-cursor-ww-parent-"));
		const target = join(parent, "target");
		const link = join(parent, "link");
		mkdirSync(target);
		symlinkSync(target, link);
		chmodSync(parent, 0o1777);
		try {
			expect(() => ensurePersistentStoreRoot(join(link, "pi-cursor-sdk"))).toThrow(/symlink|refusing/);
		} finally {
			chmodSync(parent, 0o700);
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("rejects a middle-path symlink component", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cursor-mid-symlink-"));
		const base = join(dir, "base");
		const target = join(dir, "target");
		const link = join(base, "link");
		mkdirSync(target);
		mkdirSync(base);
		symlinkSync(target, link);
		try {
			expect(() => ensurePersistentStoreRoot(join(link, "pi-cursor-sdk"))).toThrow(/symlink|refusing/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
