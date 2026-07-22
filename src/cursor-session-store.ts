import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, toNamespacedPath } from "node:path";
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

interface CursorSessionStoreSdkOperations {
	getDefaultStateRoot(cwd: string): string | Promise<string>;
	openSqliteStore(options: { workspaceRef: string; stateRoot: string }): Promise<LocalAgentStore & { dispose(): Promise<void> }>;
}

const removableTemporaryStateRoots = new Map<string, string>();
let sdkOperationsForTests: CursorSessionStoreSdkOperations | undefined;

export function hashCursorSessionStoreScope(scopeKey: string): string {
	return createHash("sha256")
		.update("pi-cursor-sdk-session-store\0")
		.update(scopeKey)
		.digest("hex")
		.slice(0, 32);
}

export function buildCursorSessionStateRoot(defaultStateRoot: string, scopeKey: string, persistent: boolean): string {
	const baseRoot = persistent ? defaultStateRoot : join(tmpdir(), `pi-cursor-sdk-${randomUUID()}`);
	return join(baseRoot, "pi-sessions", hashCursorSessionStoreScope(scopeKey));
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

export async function getCursorSessionStoreIdentities(
	cwd: string,
	scopeKey: string,
	persistent: boolean,
): Promise<{ defaultStore: CursorSessionStoreIdentity; sessionStore: CursorSessionStoreIdentity }> {
	const defaultStateRoot = await (await getSdkOperations()).getDefaultStateRoot(cwd);
	return {
		defaultStore: { version: 1, stateRoot: defaultStateRoot },
		sessionStore: {
			version: 1,
			stateRoot: buildCursorSessionStateRoot(defaultStateRoot, scopeKey, persistent),
		},
	};
}

export function cursorSessionStoreIdentitiesEqual(
	left: CursorSessionStoreIdentity,
	right: CursorSessionStoreIdentity,
): boolean {
	return left.version === right.version && left.stateRoot === right.stateRoot;
}

export function claimCursorTemporarySessionStore(identity: CursorSessionStoreIdentity): void {
	removableTemporaryStateRoots.set(identity.stateRoot, dirname(dirname(identity.stateRoot)));
}

export async function openCursorSessionStore(
	cwd: string,
	identity: CursorSessionStoreIdentity,
	removeOnDispose = false,
): Promise<OpenCursorSessionStore> {
	const openedIdentity = Object.freeze({ ...identity });
	const stateRoot = openedIdentity.stateRoot;
	const removalRoot = removeOnDispose ? removableTemporaryStateRoots.get(stateRoot) : undefined;
	if (removeOnDispose && !removalRoot) {
		throw new Error("Refusing to remove a Cursor SDK store without temporary-store ownership");
	}
	if (removeOnDispose) removableTemporaryStateRoots.delete(stateRoot);
	let store: LocalAgentStore & { dispose(): Promise<void> };
	try {
		store = await (await getSdkOperations()).openSqliteStore({ workspaceRef: cwd, stateRoot: toNamespacedPath(stateRoot) });
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

export const __testUtils = {
	setSdkOperations(operations: CursorSessionStoreSdkOperations | undefined): void {
		sdkOperationsForTests = operations;
	},
};
