import type { LocalAgentStore } from "@cursor/sdk";
import { vi } from "vitest";
import { __testUtils as cursorSessionStoreTestUtils } from "../../src/cursor-session-store.js";

export function installCursorSessionStoreMock(
	getDefaultStateRoot: () => string | Promise<string> = () => "/tmp/cursor-sdk-state",
) {
	const stores: Array<LocalAgentStore & { dispose(): Promise<void> }> = [];
	const openedOptions: Array<{ workspaceRef: string; stateRoot: string }> = [];
	const openSqliteStore = vi.fn(async (options: { workspaceRef: string; stateRoot: string }) => {
		openedOptions.push(options);
		const store = {
			agents: {},
			checkpoints: {},
			runs: {},
			runEvents: {},
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
