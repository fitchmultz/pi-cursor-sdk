import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LocalAgentStore } from "@cursor/sdk";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCursorSessionStateRoot, openCursorSessionStoreForScope, __testUtils as storeTests } from "../src/cursor-session-store.js";

describe("custom persistent store native filesystem boundary", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pi-cursor-custom-path-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
	});
	afterEach(() => {
		storeTests.setSdkOperations(undefined);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	it.each(process.platform === "win32"
		? ["relative", "C:relative", "\\root-relative", "\\\\?\\C:\\device", "\\\\server\\share\\", "C:\\x\\..\\y", "C:\\x\\.\\y"]
		: ["relative", "/", "~/root", "/tmp/../root", "/tmp/./root", "/tmp/null\0root"])(
		"fails closed for invalid persistent root %s but ignores it for fileless storage", async (storeRoot) => {
			const open = vi.fn(async () => ({ dispose: async () => {} }) as unknown as LocalAgentStore & { dispose(): Promise<void> });
			const getter = vi.fn(() => join(home, "default"));
			storeTests.setSdkOperations({ getDefaultStateRoot: getter, openSqliteStore: open });
			await expect(openCursorSessionStoreForScope({ cwd: home, scopeKey: "bad", persistent: true, storeRoot })).rejects.toThrow("storeRoot");
			expect(open).not.toHaveBeenCalled();
			expect(getter).not.toHaveBeenCalled();
			const temporary = await openCursorSessionStoreForScope({ cwd: home, scopeKey: "temporary", persistent: false, storeRoot });
			await temporary.sessionStore.dispose();
			expect(getter).not.toHaveBeenCalled();
		},
	);

	it.each(["ancestor", "root", "workspace", "pi-sessions", "session", "dangling-session", "index.db", "index.db-wal", "index.db-shm", "index.db-journal"])(
		"rejects custom %s links before SQLite open without changing their target", async (component) => {
			const custom = join(realpathSync(home), "parent", "custom");
			const workspace = join(custom, createHash("sha256").update(resolve(home)).digest("hex").slice(0, 32));
			const session = buildCursorSessionStateRoot(workspace, "safe");
			mkdirSync(session, { recursive: true, mode: 0o700 });
			const outside = join(home, "outside");
			mkdirSync(outside, { mode: 0o700 });
			const marker = join(outside, "keep");
			writeFileSync(marker, "untouched");
			const blocked = component === "ancestor" ? dirname(custom) : component === "root" ? custom :
				component === "workspace" ? workspace : component === "pi-sessions" ? dirname(session) :
				component.includes("session") ? session : join(session, component);
			rmSync(blocked, { recursive: true, force: true });
			const isFile = component.startsWith("index");
			symlinkSync(component.startsWith("dangling") ? join(home, "absent") : isFile ? marker : outside,
				blocked, isFile ? "file" : process.platform === "win32" ? "junction" : "dir");
			const open = vi.spyOn(SqliteLocalAgentStore, "open");
			await expect(openCursorSessionStoreForScope({ cwd: home, scopeKey: "safe", persistent: true, storeRoot: custom })).rejects.toThrow(/link|nonregular/);
			expect(open).not.toHaveBeenCalled();
			expect(readFileSync(marker, "utf8")).toBe("untouched");
		},
	);

	it.skipIf(process.platform === "win32")("restricts only owned destinations and rejects shared or nonwritable custom ancestors", async () => {
		const parent = join(home, "unchanged-parent");
		mkdirSync(parent, { mode: 0o755 });
		const custom = join(parent, "custom");
		mkdirSync(custom, { mode: 0o755 });
		const selection = await openCursorSessionStoreForScope({ cwd: home, scopeKey: "private", persistent: true, storeRoot: custom });
		await selection.sessionStore.dispose();
		expect(statSync(parent).mode & 0o777).toBe(0o755);
		expect(statSync(custom).mode & 0o777).toBe(0o700);
		expect(statSync(selection.sessionStore.identity.stateRoot).mode & 0o777).toBe(0o700);
		chmodSync(parent, 0o770);
		await expect(openCursorSessionStoreForScope({ cwd: home, scopeKey: "private", persistent: true, storeRoot: custom })).rejects.toThrow("group or other writable");
		chmodSync(parent, 0o755);
		chmodSync(custom, 0o500);
		await expect(openCursorSessionStoreForScope({ cwd: home, scopeKey: "private", persistent: true, storeRoot: custom })).rejects.toThrow("not owner writable");
		chmodSync(custom, 0o700);
	});

	it("disposes a late public store when its guarded directory identity changed during open, then releases its lease", async () => {
		const custom = join(realpathSync(home), "custom");
		let swap = true;
		const disposed = vi.fn(async () => {});
		storeTests.setSdkOperations({
			getDefaultStateRoot: () => { throw new Error("custom must not derive default"); },
			openSqliteStore: async ({ stateRoot }) => {
				if (swap) {
					renameSync(stateRoot, `${stateRoot}-held`);
					mkdirSync(stateRoot, { mode: 0o700 });
				}
				return { dispose: disposed } as unknown as LocalAgentStore & { dispose(): Promise<void> };
			},
		});
		await expect(openCursorSessionStoreForScope({ cwd: home, scopeKey: "late", persistent: true, storeRoot: custom })).rejects.toThrow("changed directory identity");
		expect(disposed).toHaveBeenCalledOnce();
		swap = false;
		const next = await openCursorSessionStoreForScope({ cwd: home, scopeKey: "late", persistent: true, storeRoot: custom });
		await next.sessionStore.dispose();
		expect(disposed).toHaveBeenCalledTimes(2);
	});

	it("rejects disappearance of a captured index.db during real public open and disposes the returned SQLite store", async () => {
		const options = { cwd: home, scopeKey: "sqlite-race", persistent: true, storeRoot: join(home, "custom") };
		const seeded = await openCursorSessionStoreForScope(options);
		await seeded.sessionStore.dispose();
		const dispose = vi.spyOn(SqliteLocalAgentStore.prototype, "dispose");
		storeTests.setSdkOperations({
			getDefaultStateRoot: () => { throw new Error("custom must not derive default"); },
			openSqliteStore: async (sdkOptions) => {
				const opened = await SqliteLocalAgentStore.open(sdkOptions);
				rmSync(join(sdkOptions.stateRoot, "index.db"));
				return opened;
			},
		});
		const pending = openCursorSessionStoreForScope(options);
		try {
			await expect(pending).rejects.toThrow("disappeared SQLite file");
			expect(dispose).toHaveBeenCalledOnce();
		} finally { await (await pending.catch(() => undefined))?.sessionStore.dispose(); }
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("rejects a root-owned destination without chmod or SQLite side effects", async () => {
		const before = statSync("/usr");
		const open = vi.spyOn(SqliteLocalAgentStore, "open");
		await expect(openCursorSessionStoreForScope({ cwd: home, scopeKey: "unowned", persistent: true, storeRoot: "/usr" })).rejects.toThrow("not owned by the current user");
		expect(open).not.toHaveBeenCalled();
		expect(statSync("/usr").mode).toBe(before.mode);
	});

	it("uses native separators for fully qualified roots rather than treating POSIX backslashes as Windows paths", async () => {
		const named = join(home, process.platform === "win32" ? "native-slashes" : "native\\literal");
		const input = process.platform === "win32" ? named.replaceAll("\\", "/") : named;
		const selected = await openCursorSessionStoreForScope({ cwd: home, scopeKey: "native", persistent: true, storeRoot: input });
		try { expect(selected.sessionStore.identity.stateRoot.startsWith(realpathSync(named))).toBe(true); }
		finally { await selected.sessionStore.dispose(); }
	});

	it.skipIf(process.platform !== "darwin")("admits actual root-owned /var aliases without moving default history", async () => {
		const alias = mkdtempSync("/var/tmp/pi-cursor-custom-alias-");
		const canonical = realpathSync(alias);
		let selected: Awaited<ReturnType<typeof openCursorSessionStoreForScope>> | undefined;
		try {
			expect(alias.startsWith("/var/")).toBe(true);
			expect(canonical.startsWith("/private/var/")).toBe(true);
			selected = await openCursorSessionStoreForScope({ cwd: home, scopeKey: "alias", persistent: true, storeRoot: join(alias, "custom") });
			expect(selected.sessionStore.identity.stateRoot.startsWith(join(canonical, "custom"))).toBe(true);
			expect(existsSync(join(home, ".cursor"))).toBe(false);
		} finally {
			await selected?.sessionStore.dispose();
			rmSync(alias, { recursive: true, force: true });
		}
	});
});
