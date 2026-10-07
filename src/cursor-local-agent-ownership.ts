import type { CursorSessionStoreIdentity } from "./cursor-session-store.js";

// ponytail: process-local claims protect extension-owned handles and cleanup.
// Cross-process SDK ownership requires an upstream store/agent lease contract.
// Unproven disposal retains the exact handle claim until process exit.
const claims = new Set<string>();

export function claimCursorLocalAgent(identity: CursorSessionStoreIdentity, agentId: string): (() => void) | undefined {
	const key = JSON.stringify([identity.stateRoot, agentId]);
	if (claims.has(key)) return undefined;
	claims.add(key);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		claims.delete(key);
	};
}
