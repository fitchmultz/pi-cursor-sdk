import type { LocalAgentStore } from "@cursor/sdk";
import { expect, vi } from "vitest";
import { __testUtils as cursorSessionStoreTestUtils } from "../../src/cursor-session-store.js";

export function installCursorSessionStoreMock(
	getDefaultStateRoot: () => string | Promise<string> = () => "/tmp/cursor-sdk-state/workspace",
) {
	const stores: Array<LocalAgentStore & { dispose(): Promise<void> }> = [];
	const openedOptions: Array<{ workspaceRef: string; stateRoot: string }> = [];
	const openSqliteStore = vi.fn(async (options: { workspaceRef: string; stateRoot: string }) => {
		openedOptions.push(options);
		const id = stores.length;
		const store = {
			agents: { id },
			checkpoints: { id },
			runs: { id, update: vi.fn(async () => {}) },
			runEvents: { id },
			dispose: vi.fn(async () => {}),
		} as unknown as LocalAgentStore & { dispose(): Promise<void> };
		stores.push(store);
		return store;
	});
	cursorSessionStoreTestUtils.setSdkOperations({
		getDefaultStateRoot,
		openSqliteStore,
	});
	return { openSqliteStore, openedOptions, stores };
}

/** Matches the store handed to the SDK, which wraps the opened SDK store to observe terminal run errors. */
export function sessionStoreBackedBy(opened: LocalAgentStore) {
	return expect.objectContaining({ agents: opened.agents, checkpoints: opened.checkpoints, runEvents: opened.runEvents });
}
