import { createHash, randomUUID } from "node:crypto";
import {
	accessSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	type Stats,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, toNamespacedPath } from "node:path";
import type { LocalAgentStore } from "@cursor/sdk";
import {
	loadCursorSdkUserConfig,
	resolveCursorSdkConfig,
	type ResolveCursorSdkConfigOptions,
} from "./cursor-config.js";
import { noFollowFlag } from "./cursor-durable-fs.js";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";
import { validateStoreRootPath } from "./cursor-store-root-path.js";

export interface CursorSessionStoreIdentity {
	readonly version: 1;
	readonly stateRoot: string;
}

export interface OpenCursorSessionStore {
	identity: CursorSessionStoreIdentity;
	store: LocalAgentStore;
	dispose(): Promise<void>;
}

export interface CursorSessionStoreSelection {
	sessionStore: OpenCursorSessionStore;
	identities: {
		defaultStore: CursorSessionStoreIdentity;
		sessionStore: CursorSessionStoreIdentity;
	};
	resumeAttemptAllowed: boolean;
	resumeFallback: boolean;
}

interface CursorSessionStoreSdkOperations {
	getDefaultStateRoot(cwd: string): string | Promise<string>;
	openSqliteStore(options: { workspaceRef: string; stateRoot: string }): Promise<LocalAgentStore & { dispose(): Promise<void> }>;
}

let sdkOperationsForTests: CursorSessionStoreSdkOperations | undefined;

export function hashCursorSessionStoreScope(scopeKey: string): string {
	return createHash("sha256")
		.update("pi-cursor-sdk-session-store\0")
		.update(scopeKey)
		.digest("hex")
		.slice(0, 32);
}

export function hashWorkspaceCwd(cwd: string): string {
	return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 32);
}

function isWorldWritable(mode: number): boolean {
	return (mode & 0o002) !== 0;
}

function isSticky(mode: number): boolean {
	return (mode & 0o1000) !== 0;
}

function failStoreRoot(storeRoot: string, error: unknown): never {
	if (error instanceof Error && error.message.includes("refusing to fall back")) throw error;
	const detail = error instanceof Error ? error.message : String(error);
	throw new Error(
		`Cursor SDK storeRoot "${storeRoot}" cannot be used; refusing to fall back to ~/.cursor (${detail})`,
	);
}

function assertDirectory(stats: Stats, path: string): void {
	if (!stats.isDirectory()) throw new Error(`storeRoot path component "${path}" is not a directory`);
}

function canCreateChildIn(parentStats: Stats, uid: number | undefined, seenWorldWritable: boolean): void {
	assertDirectory(parentStats, "parent");
	if (typeof uid === "number" && parentStats.uid === uid) {
		if (isWorldWritable(parentStats.mode) && !isSticky(parentStats.mode)) {
			throw new Error("refusing to create a storeRoot component in a world-writable non-sticky directory");
		}
		return;
	}
	if (isWorldWritable(parentStats.mode)) {
		if (!isSticky(parentStats.mode)) {
			throw new Error("refusing to create a storeRoot component in a world-writable non-sticky directory");
		}
		return;
	}
	if (seenWorldWritable) {
		throw new Error("refusing to create a storeRoot component under an unowned path after a world-writable directory");
	}
}

function restrictOwnedDirectory(path: string, uid: number): void {
	const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
	const fd = openSync(path, constants.O_RDONLY | noFollowFlag() | directoryFlag);
	try {
		const opened = fstatSync(fd);
		assertDirectory(opened, path);
		if (opened.uid !== uid) throw new Error(`storeRoot "${path}" is not owned by the current user`);
		fchmodSync(fd, 0o700);
		const after = fstatSync(fd);
		if (!after.isDirectory() || after.uid !== uid || (after.mode & 0o777) !== 0o700) {
			throw new Error(`storeRoot "${path}" could not be restricted to mode 0700`);
		}
	} finally {
		closeSync(fd);
	}
}

export function ensurePersistentStoreRoot(storeRoot: string): void {
	try {
		const pathIssue = validateStoreRootPath(storeRoot);
		if (pathIssue === "relative") {
			throw new Error(`storeRoot "${storeRoot}" is not an absolute directory`);
		}
		if (pathIssue !== undefined) {
			throw new Error(`storeRoot "${storeRoot}" is not a usable directory`);
		}
		if (process.platform === "win32") {
			// Create the leaf if needed; require a writable non-symlink directory. POSIX uid/0700 checks do not apply.
			mkdirSync(storeRoot, { recursive: true });
			const stats = lstatSync(storeRoot);
			if (stats.isSymbolicLink() || !stats.isDirectory()) {
				throw new Error(`storeRoot "${storeRoot}" is not a directory`);
			}
			accessSync(storeRoot, constants.W_OK);
			return;
		}

		const uid = process.getuid?.();
		if (typeof uid !== "number") {
			throw new Error("Cannot determine the current user id for storeRoot checks");
		}

		const parts = storeRoot.split("/").filter(Boolean);
		let current = "/";
		let seenWorldWritable = false;

		for (let index = 0; index < parts.length; index++) {
			const parent = current;
			current = current === "/" ? `/${parts[index]}` : `${current}/${parts[index]}`;
			const isLast = index === parts.length - 1;
			const wasWorldWritable = seenWorldWritable;
			let stats: Stats;

			try {
				stats = lstatSync(current);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				canCreateChildIn(lstatSync(parent), uid, wasWorldWritable);
				mkdirSync(current, { mode: 0o700 });
				stats = lstatSync(current);
				if (stats.isSymbolicLink() || !stats.isDirectory()) {
					throw new Error(`storeRoot path component "${current}" is not a directory`);
				}
				if (stats.uid !== uid) {
					throw new Error(`storeRoot path component "${current}" is not owned by the current user`);
				}
			}

			if (stats.isSymbolicLink()) {
				throw new Error(`storeRoot path component "${current}" is a symlink`);
			}

			assertDirectory(stats, current);
			if (isWorldWritable(stats.mode)) seenWorldWritable = true;

			if (isLast) {
				if (stats.uid !== uid) throw new Error(`storeRoot "${current}" is not owned by the current user`);
				restrictOwnedDirectory(current, uid);
				accessSync(current, constants.W_OK);
			} else if (wasWorldWritable && stats.uid !== uid) {
				throw new Error(`storeRoot path component "${current}" is not owned by the current user`);
			}
		}
	} catch (error) {
		failStoreRoot(storeRoot, error);
	}
}

/** Resolves the per-cwd SDK state root. Uses `@cursor/sdk` `getDefaultSdkStateRoot()` unless `local.storeRoot` is set. */
export async function resolveSdkStateRoot(cwd: string, options: ResolveCursorSdkConfigOptions = {}): Promise<string> {
	const resolved = resolveCursorSdkConfig({
		...options,
		env: options.env ?? process.env,
		user: options.user ?? loadCursorSdkUserConfig(),
	});
	const configuredStoreRoot = resolved.local.storeRoot.value;
	if (configuredStoreRoot === undefined) {
		const { getDefaultSdkStateRoot } = await loadCursorSdk();
		return getDefaultSdkStateRoot(cwd);
	}
	ensurePersistentStoreRoot(configuredStoreRoot);
	return join(configuredStoreRoot, hashWorkspaceCwd(cwd));
}

export function buildCursorSessionStateRoot(defaultStateRoot: string, scopeKey: string, persistent: boolean): string {
	const baseRoot = persistent ? defaultStateRoot : join(tmpdir(), `pi-cursor-sdk-${randomUUID()}`);
	return join(baseRoot, "pi-sessions", hashCursorSessionStoreScope(scopeKey));
}

async function getSdkOperations(): Promise<CursorSessionStoreSdkOperations> {
	if (sdkOperationsForTests) return sdkOperationsForTests;
	return {
		getDefaultStateRoot: (cwd) => resolveSdkStateRoot(cwd),
		openSqliteStore: async (options) => {
			await loadCursorSdk();
			const { SqliteLocalAgentStore } = await import("@cursor/sdk/sqlite");
			return SqliteLocalAgentStore.open(options);
		},
	};
}

export async function getCursorSessionStoreIdentities(
	cwd: string,
	scopeKey: string,
	persistent: boolean,
): Promise<{ defaultStore: CursorSessionStoreIdentity; sessionStore: CursorSessionStoreIdentity }> {
	if (!persistent) {
		const sessionRoot = buildCursorSessionStateRoot("", scopeKey, false);
		return {
			defaultStore: { version: 1, stateRoot: sessionRoot },
			sessionStore: { version: 1, stateRoot: sessionRoot },
		};
	}
	const defaultStateRoot = await (await getSdkOperations()).getDefaultStateRoot(cwd);
	return {
		defaultStore: { version: 1, stateRoot: defaultStateRoot },
		sessionStore: {
			version: 1,
			stateRoot: buildCursorSessionStateRoot(defaultStateRoot, scopeKey, true),
		},
	};
}

export function cursorSessionStoreIdentitiesEqual(
	left: CursorSessionStoreIdentity,
	right: CursorSessionStoreIdentity,
): boolean {
	return left.version === right.version && left.stateRoot === right.stateRoot;
}

async function openOwnedCursorSessionStore(
	cwd: string,
	identity: CursorSessionStoreIdentity,
	removalRoot?: string,
): Promise<OpenCursorSessionStore> {
	const openedIdentity = Object.freeze({ ...identity });
	let store: LocalAgentStore & { dispose(): Promise<void> };
	try {
		store = await (await getSdkOperations()).openSqliteStore({
			workspaceRef: cwd,
			stateRoot: toNamespacedPath(openedIdentity.stateRoot),
		});
	} catch (error) {
		if (removalRoot) await rm(removalRoot, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	return {
		identity: openedIdentity,
		store,
		dispose: async () => {
			try {
				await store.dispose();
			} finally {
				if (removalRoot) await rm(removalRoot, { recursive: true, force: true });
			}
		},
	};
}

export function openCursorSessionStore(
	cwd: string,
	identity: CursorSessionStoreIdentity,
): Promise<OpenCursorSessionStore> {
	return openOwnedCursorSessionStore(cwd, identity);
}

export async function openCursorSessionStoreForScope(options: {
	cwd: string;
	scopeKey: string;
	persistent: boolean;
	hasResumeHandle: boolean;
	resumeIdentity?: CursorSessionStoreIdentity;
}): Promise<CursorSessionStoreSelection> {
	const identities = await getCursorSessionStoreIdentities(options.cwd, options.scopeKey, options.persistent);
	const requestedResumeIdentity = options.hasResumeHandle
		? options.resumeIdentity ?? (options.persistent ? identities.defaultStore : undefined)
		: undefined;
	const resumableIdentities = options.persistent
		? [identities.defaultStore, identities.sessionStore]
		: [identities.sessionStore];
	const resumeIdentity = requestedResumeIdentity && resumableIdentities
		.find((identity) => cursorSessionStoreIdentitiesEqual(identity, requestedResumeIdentity));
	let resumeAttemptAllowed = options.hasResumeHandle && resumeIdentity !== undefined;
	let resumeFallback = options.persistent && options.hasResumeHandle && !resumeIdentity;
	const selectedIdentity = resumeIdentity ?? identities.sessionStore;
	const removalRoot = options.persistent ? undefined : dirname(dirname(identities.sessionStore.stateRoot));
	let sessionStore: OpenCursorSessionStore;
	try {
		sessionStore = await openOwnedCursorSessionStore(options.cwd, selectedIdentity, removalRoot);
	} catch (error) {
		if (!resumeIdentity || cursorSessionStoreIdentitiesEqual(resumeIdentity, identities.sessionStore)) throw error;
		resumeAttemptAllowed = false;
		resumeFallback = true;
		sessionStore = await openOwnedCursorSessionStore(options.cwd, identities.sessionStore);
	}
	return { sessionStore, identities, resumeAttemptAllowed, resumeFallback };
}

export const __testUtils = {
	setSdkOperations(operations: CursorSessionStoreSdkOperations | undefined): void {
		sdkOperationsForTests = operations;
	},
};
