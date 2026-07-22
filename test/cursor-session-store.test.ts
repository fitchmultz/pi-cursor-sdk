import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, createAgentPlatform, type LocalAgentStore } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";
import {
	buildCursorSessionStateRoot,
	claimCursorTemporarySessionStore,
	hashCursorSessionStoreScope,
	openCursorSessionStore,
	__testUtils as storeTestUtils,
} from "../src/cursor-session-store.js";

describe("cursor session store identity", () => {
	it("derives a stable session root below the SDK workspace state root", () => {
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

	it("removes an extension-owned temporary store after graceful disposal", async () => {
		storeTestUtils.setSdkOperations(undefined);
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-ephemeral-store-"));
		const stateRoot = buildCursorSessionStateRoot(root, "ephemeral", false);
		claimCursorTemporarySessionStore({ version: 1, stateRoot });
		const store = await openCursorSessionStore(root, { version: 1, stateRoot }, true);
		expect(existsSync(stateRoot)).toBe(true);

		await store.dispose();

		expect(existsSync(stateRoot)).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});

	it("refuses to remove a shared store even when its path resembles a session root", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cursor-shared-store-"));
		const stateRoot = join(workspaceRoot, "pi-sessions", "a".repeat(32));
		const marker = join(stateRoot, "keep.txt");
		mkdirSync(stateRoot, { recursive: true });
		writeFileSync(marker, "keep");

		await expect(openCursorSessionStore(workspaceRoot, { version: 1, stateRoot }, true)).rejects.toThrow("Refusing to remove");
		expect(existsSync(marker)).toBe(true);
		rmSync(workspaceRoot, { recursive: true, force: true });
	});

	it("binds temporary removal to the authorized identity before SQLite opens", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cursor-store-mutation-"));
		const stateRoot = buildCursorSessionStateRoot(workspaceRoot, "ephemeral", false);
		const identity = { version: 1 as const, stateRoot };
		const fakeStore = { dispose: vi.fn(async () => {}) } as unknown as LocalAgentStore & { dispose(): Promise<void> };
		let resolveOpen: () => void = () => {};
		const openSqliteStore = vi.fn(() => new Promise<typeof fakeStore>((resolve) => {
			resolveOpen = () => resolve(fakeStore);
		}));
		storeTestUtils.setSdkOperations({ getDefaultStateRoot: () => workspaceRoot, openSqliteStore });
		mkdirSync(stateRoot, { recursive: true });
		claimCursorTemporarySessionStore(identity);
		const opening = openCursorSessionStore(workspaceRoot, identity, true);
		const sharedRoot = join(workspaceRoot, "shared");
		const marker = join(sharedRoot, "keep.txt");
		mkdirSync(sharedRoot, { recursive: true });
		writeFileSync(marker, "keep");
		identity.stateRoot = sharedRoot;
		await vi.waitFor(() => expect(openSqliteStore).toHaveBeenCalledTimes(1));
		resolveOpen();

		try {
			const store = await opening;
			await store.dispose();
			expect(store.identity.stateRoot).toBe(stateRoot);
			expect(existsSync(stateRoot)).toBe(false);
			expect(existsSync(marker)).toBe(true);
		} finally {
			storeTestUtils.setSdkOperations(undefined);
			rmSync(workspaceRoot, { recursive: true, force: true });
		}
	});

	it("removes a temporary root even when SQLite disposal fails", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cursor-store-dispose-failure-"));
		const stateRoot = buildCursorSessionStateRoot(workspaceRoot, "ephemeral", false);
		mkdirSync(stateRoot, { recursive: true });
		claimCursorTemporarySessionStore({ version: 1, stateRoot });
		storeTestUtils.setSdkOperations({
			getDefaultStateRoot: () => workspaceRoot,
			openSqliteStore: async () => ({
				dispose: async () => { throw new Error("dispose failed"); },
			}) as unknown as LocalAgentStore & { dispose(): Promise<void> },
		});
		try {
			const store = await openCursorSessionStore(workspaceRoot, { version: 1, stateRoot }, true);
			await expect(store.dispose()).rejects.toThrow("dispose failed");
			expect(existsSync(stateRoot)).toBe(false);
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
});
