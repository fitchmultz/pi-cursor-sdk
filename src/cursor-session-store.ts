import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from "node:path";
import type { LocalAgentStore } from "@cursor/sdk";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";

export interface CursorSessionStoreIdentity {
	readonly version: 1;
	readonly stateRoot: string;
}

export interface OpenCursorSessionStore {
	identity: CursorSessionStoreIdentity;
	store: LocalAgentStore;
	dispose(): Promise<void>;
}

interface CursorPersistentStoreIdentities {
	defaultStore: CursorSessionStoreIdentity;
	sessionStore: CursorSessionStoreIdentity;
}

export type CursorSessionStoreSelection = {
	sessionStore: OpenCursorSessionStore;
} & ({
	persistent: true;
	identities: CursorPersistentStoreIdentities;
	resumeAttemptAllowed: boolean;
	resumeFallback: boolean;
} | {
	persistent: false;
	identities: { sessionStore: CursorSessionStoreIdentity };
	resumeAttemptAllowed: false;
	resumeFallback: false;
});

interface CursorSessionStoreSdkOperations {
	getDefaultStateRoot(cwd: string): string | Promise<string>;
	openSqliteStore(options: { workspaceRef: string; stateRoot: string }): Promise<LocalAgentStore & { dispose(): Promise<void> }>;
}

let sdkOperationsForTests: CursorSessionStoreSdkOperations | undefined;
interface WorkspaceRootOwnership {
	key: string;
	cwd: string;
	root: Promise<string>;
	resolvedRoot?: string;
	users: number;
}
const activeWorkspaceRoots = new Map<string, WorkspaceRootOwnership>();
const activeWorkspaceRootsByPath = new Map<string, WorkspaceRootOwnership>();
const activeWorkspaceRootCounts = new Map<string, number>();

export function resolveCursorStoreRootBase(cwd: string, raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	if (!raw.trim() || /[\x00-\x1f\x7f]/.test(raw)) throw new Error("Invalid Cursor local storeRoot path");
	const value = raw.trim();
	const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
	return resolve(cwd, expanded);
}

export function buildCursorCustomWorkspaceRoot(base: string, cwd: string): string {
	return join(base, "pi-cursor-sdk", `cwd-${createHash("sha256").update(cwd).digest("hex")}`);
}

/** Recognizes a configured identity only for cleanup retry classification, never admission. */
export function isCanonicalConfiguredSessionStoreIdentity(cwd: string, scopeKey: string, identity: CursorSessionStoreIdentity | undefined): boolean {
	if (!identity || identity.version !== 1 || !isAbsolute(identity.stateRoot)) return false;
	const base = dirname(dirname(dirname(dirname(identity.stateRoot))));
	return identity.stateRoot === buildCursorSessionStateRoot(buildCursorCustomWorkspaceRoot(base, cwd), scopeKey);
}

/** Pure retry classification; restoring the default must still pass ordinary identity admission. */
export function isCanonicalDefaultSessionStoreIdentity(cwd: string, scopeKey: string, identity: CursorSessionStoreIdentity | undefined): boolean {
	if (!identity || identity.version !== 1 || !isAbsolute(identity.stateRoot)) return false;
	const prefix = defaultWorkspacePrefix(cwd);
	const { current, legacy } = workspaceHashes(cwd);
	return [current, legacy].some((hash) => {
		if (!hash) return false;
		const root = join(prefix, hash);
		return identity.stateRoot === root || identity.stateRoot === buildCursorSessionStateRoot(root, scopeKey);
	});
}

function workspacePathKey(cwd: string, root: string): string {
	return JSON.stringify([cwd, root]);
}
// ponytail: leases protect only extension-owned stores in this process. Other SDK
// users/processes must stop before upgrade; a cross-process lock belongs in the SDK.

export function hashCursorSessionStoreScope(scopeKey: string): string {
	return createHash("sha256")
		.update("pi-cursor-sdk-session-store\0")
		.update(scopeKey)
		.digest("hex")
		.slice(0, 32);
}

export function buildCursorSessionStateRoot(defaultStateRoot: string, scopeKey: string): string {
	return join(defaultStateRoot, "pi-sessions", hashCursorSessionStoreScope(scopeKey));
}

async function getSdkOperations(): Promise<CursorSessionStoreSdkOperations> {
	if (sdkOperationsForTests) return sdkOperationsForTests;
	const [{ getDefaultSdkStateRoot }, { SqliteLocalAgentStore }] = await Promise.all([
		loadCursorSdk(),
		import("@cursor/sdk/sqlite"),
	]);
	return {
		getDefaultStateRoot: getDefaultSdkStateRoot,
		openSqliteStore: (options) => SqliteLocalAgentStore.open(options),
	};
}

function leaseWorkspaceRoot(ownership: WorkspaceRootOwnership) {
	ownership.users++;
	let released = false;
	return {
		root: ownership.root,
		release: () => {
			if (released) return;
			released = true;
			if (--ownership.users === 0) {
				activeWorkspaceRoots.delete(ownership.key);
				const count = (activeWorkspaceRootCounts.get(ownership.cwd) ?? 1) - 1;
				if (count === 0) activeWorkspaceRootCounts.delete(ownership.cwd);
				else activeWorkspaceRootCounts.set(ownership.cwd, count);
				if (ownership.resolvedRoot) activeWorkspaceRootsByPath.delete(workspacePathKey(ownership.cwd, ownership.resolvedRoot));
			}
		},
	};
}

function acquireWorkspaceRoot(cwd: string, storeRootBase?: string) {
	const base = resolveCursorStoreRootBase(cwd, storeRootBase);
	const key = JSON.stringify([cwd, base ?? null]);
	let ownership = activeWorkspaceRoots.get(key);
	if (!ownership) {
		ownership = { key, cwd, users: 0, root: Promise.resolve("") };
		const captured = ownership;
		// Publish ownership before SDK loading or its migration-capable getter.
		captured.root = Promise.resolve().then(async () => {
			let root: string;
			if (base) {
				root = buildCursorCustomWorkspaceRoot(base, cwd);
				assertSafeStorePath(root, dirname(root), "custom local store");
				mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
				assertSafeStorePath(root, dirname(root), "custom local store");
			} else {
				const operations = await getSdkOperations();
				assertSafeWorkspaceLayout(cwd);
				root = await operations.getDefaultStateRoot(cwd);
				assertSafeStorePath(root, dirname(root), "local store");
			}
			captured.resolvedRoot = root;
			activeWorkspaceRootsByPath.set(workspacePathKey(cwd, root), captured);
			return root;
		});
		activeWorkspaceRoots.set(key, captured);
		activeWorkspaceRootCounts.set(cwd, (activeWorkspaceRootCounts.get(cwd) ?? 0) + 1);
	}
	return leaseWorkspaceRoot(ownership);
}

function retainWorkspaceRoot(cwd: string, workspaceRoot: string) {
	const ownership = activeWorkspaceRootsByPath.get(workspacePathKey(cwd, workspaceRoot));
	if (!ownership) {
		throw new Error(activeWorkspaceRootCounts.has(cwd)
			? "Cursor local workspace ownership root mismatch"
			: "Cursor local workspace ownership is not active");
	}
	return leaseWorkspaceRoot(ownership);
}

export async function withCursorSessionStoreIdentities<T>(
	cwd: string,
	scopeKey: string,
	use: (identities: CursorPersistentStoreIdentities) => Promise<T>,
	storeRootBase?: string,
): Promise<T> {
	const lease = acquireWorkspaceRoot(cwd, storeRootBase);
	try {
		const defaultStateRoot = await lease.root;
		return await use({
			defaultStore: { version: 1, stateRoot: defaultStateRoot },
			sessionStore: { version: 1, stateRoot: buildCursorSessionStateRoot(defaultStateRoot, scopeKey) },
		});
	} finally { lease.release(); }
}

export function cursorSessionStoreIdentitiesEqual(
	left: CursorSessionStoreIdentity,
	right: CursorSessionStoreIdentity,
): boolean {
	return left.version === right.version && left.stateRoot === right.stateRoot;
}

function rejectedStorePath(stateRoot: string, base: string): string | undefined {
	// User-managed ancestors above the SDK prefix (or our temporary removal root)
	// may be links/junctions. Owned components, including the base, may not.
	let path = resolve(base);
	const suffix = relative(path, resolve(stateRoot));
	if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return stateRoot;
	for (const component of ["", ...suffix.split(sep).filter(Boolean)]) {
		path = join(path, component);
		try {
			if (!lstatSync(path).isDirectory()) return path;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function assertSafeStorePath(stateRoot: string, base: string, label: string): void {
	const rejected = rejectedStorePath(stateRoot, base);
	if (rejected) throw new Error(`Cursor ${label} path contains a link or non-directory: ${rejected}`);
}

function workspaceHashes(cwd: string): { current: string; legacy: string | undefined } {
	const current = createHash("sha256").update(cwd).digest("hex");
	try {
		return { current, legacy: createHash("md5").update(cwd).digest("hex") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ERR_OSSL_EVP_UNSUPPORTED" ||
			(error instanceof Error && error.message === "Digest method not supported")) return { current, legacy: undefined };
		throw error;
	}
}

function defaultWorkspacePrefix(cwd: string): string {
	const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	return join(homedir(), ".cursor", "projects", slug, "sdk-agent-store");
}

function assertSafeWorkspaceLayout(cwd: string): void {
	// ponytail: SDK 1.0.35 has no public read-only root resolver; use one when exposed.
	// This pure layout is contract-verified against its factory and public getter;
	// guard it before that getter can rename MD5 history through an owned link.
	const prefix = defaultWorkspacePrefix(cwd);
	const { current, legacy } = workspaceHashes(cwd);
	for (const hash of [current, legacy]) {
		if (hash) assertSafeStorePath(join(prefix, hash), prefix, "local store");
	}
}

function legacyWorkspaceRoot(cwd: string, defaultStateRoot: string): string | undefined {
	// The public getter owns migration and may return MD5 after a failed rename.
	const { current, legacy } = workspaceHashes(cwd);
	if (!legacy) return undefined;
	const prefix = dirname(defaultStateRoot);
	if (defaultStateRoot !== join(prefix, current) && defaultStateRoot !== join(prefix, legacy)) return undefined;
	return join(prefix, legacy);
}

export async function resolveCursorSessionStoreIdentity(options: {
	cwd: string;
	scopeKey: string;
	identities: CursorPersistentStoreIdentities;
	recordedIdentity?: CursorSessionStoreIdentity;
	agentId: string;
}): Promise<CursorSessionStoreIdentity | undefined> {
	const { cwd, scopeKey, identities, agentId } = options;
	const legacyRoot = legacyWorkspaceRoot(cwd, identities.defaultStore.stateRoot);
	const legacyDefault = legacyRoot ? { version: 1 as const, stateRoot: legacyRoot } : undefined;
	// Version-1 handles predate recorded identities and used the default workspace
	// store. If both roots survive, that old store still owns their data.
	const recorded = options.recordedIdentity ?? legacyDefault ?? identities.defaultStore;
	const base = dirname(identities.defaultStore.stateRoot);
	const current = [identities.defaultStore, identities.sessionStore];
	const exact = current.find((identity) => cursorSessionStoreIdentitiesEqual(identity, recorded));
	if (exact) {
		assertSafeStorePath(exact.stateRoot, base, "local store");
		return exact;
	}
	if (!legacyRoot) return undefined;
	const legacySession = { version: 1 as const, stateRoot: buildCursorSessionStateRoot(legacyRoot, scopeKey) };
	const legacy = [legacyDefault, legacySession].find((identity) =>
		identity && cursorSessionStoreIdentitiesEqual(identity, recorded));
	if (!legacy) return undefined;
	assertSafeStorePath(legacy.stateRoot, base, "local store");
	if (existsSync(legacyRoot)) return legacy; // No merge or silent owner switch.
	const migrated = legacy === legacyDefault ? identities.defaultStore : identities.sessionStore;
	assertSafeStorePath(migrated.stateRoot, base, "local store");
	if (!existsSync(migrated.stateRoot)) return undefined;
	// A missing legacy path alone is not migration proof. The exact cwd/scope
	// destination must independently contain this recorded agent with this cwd.
	const opened = await openCursorSessionStore(cwd, migrated, identities.defaultStore.stateRoot);
	try {
		const agent = await opened.store.agents.get({ agentId });
		return agent?.cwd === cwd ? migrated : undefined;
	} finally {
		await opened.dispose();
	}
}

async function openOwnedCursorSessionStore(
	cwd: string,
	identity: CursorSessionStoreIdentity,
	options: { workspaceRoot: string } | { removalRoot: string },
): Promise<OpenCursorSessionStore> {
	const openedIdentity = Object.freeze({ ...identity });
	const lease = "workspaceRoot" in options ? retainWorkspaceRoot(cwd, options.workspaceRoot) : undefined;
	const removalRoot = "removalRoot" in options ? options.removalRoot : undefined;
	const removeTemporaryStore = async () => {
		if (removalRoot) {
			assertSafeStorePath(openedIdentity.stateRoot, removalRoot, "temporary store removal");
			await rm(removalRoot, { recursive: true, force: true });
		}
	};
	let store: LocalAgentStore & { dispose(): Promise<void> };
	try {
		await lease?.root;
		const base = "workspaceRoot" in options ? dirname(options.workspaceRoot) : options.removalRoot;
		assertSafeStorePath(openedIdentity.stateRoot, base, "local store");
		store = await (await getSdkOperations()).openSqliteStore({
			workspaceRef: cwd,
			stateRoot: toNamespacedPath(openedIdentity.stateRoot),
		});
	} catch (error) {
		lease?.release();
		await removeTemporaryStore().catch(() => undefined);
		throw error;
	}
	return {
		identity: openedIdentity,
		store,
		dispose: async () => {
			try {
				await store.dispose();
			} finally {
				lease?.release();
				await removeTemporaryStore();
			}
		},
	};
}

export function openCursorSessionStore(
	cwd: string,
	identity: CursorSessionStoreIdentity,
	workspaceRoot: string,
): Promise<OpenCursorSessionStore> {
	return openOwnedCursorSessionStore(cwd, identity, { workspaceRoot });
}

export async function openCursorSessionStoreForScope(options: {
	cwd: string;
	scopeKey: string;
	persistent: boolean;
	storeRootBase?: string;
	resume?: { identity?: CursorSessionStoreIdentity; agentId: string };
}): Promise<CursorSessionStoreSelection> {
	if (!options.persistent) {
		const removalRoot = join(tmpdir(), `pi-cursor-sdk-${randomUUID()}`);
		const identity = { version: 1 as const, stateRoot: buildCursorSessionStateRoot(removalRoot, options.scopeKey) };
		const sessionStore = await openOwnedCursorSessionStore(options.cwd, identity, { removalRoot });
		return { persistent: false, sessionStore, identities: { sessionStore: identity }, resumeAttemptAllowed: false, resumeFallback: false };
	}
	return withCursorSessionStoreIdentities(options.cwd, options.scopeKey, async (identities) => {
		const resumeIdentity = options.resume ? await resolveCursorSessionStoreIdentity({
			cwd: options.cwd, scopeKey: options.scopeKey, identities,
			recordedIdentity: options.resume.identity, agentId: options.resume.agentId,
		}).catch(() => undefined) : undefined; // Unreadable resume storage falls back; fresh-store failures still propagate.
		let resumeAttemptAllowed = resumeIdentity !== undefined;
		let resumeFallback = options.resume !== undefined && !resumeIdentity;
		const selectedIdentity = resumeIdentity ?? identities.sessionStore;
		let sessionStore: OpenCursorSessionStore;
		try {
			sessionStore = await openCursorSessionStore(options.cwd, selectedIdentity, identities.defaultStore.stateRoot);
		} catch (error) {
			if (!resumeIdentity || cursorSessionStoreIdentitiesEqual(resumeIdentity, identities.sessionStore)) throw error;
			resumeAttemptAllowed = false;
			resumeFallback = true;
			sessionStore = await openCursorSessionStore(options.cwd, identities.sessionStore, identities.defaultStore.stateRoot);
		}
		return { persistent: true, sessionStore, identities, resumeAttemptAllowed, resumeFallback };
	}, options.storeRootBase);
}

export const __testUtils = {
	setSdkOperations(operations: CursorSessionStoreSdkOperations | undefined): void {
		sdkOperationsForTests = operations;
	},
};
