import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { resetSessionCursorAgent } from "./cursor-session-agent.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";

/**
 * Release scoped conversation runs and reset the pool before compaction.
 * Summary execution owns a separate temporary agent, never this pool.
 */
export async function prepareCursorSessionForCompaction(
	scopeKey: string = getCursorSessionScopeKey(),
): Promise<void> {
	while (true) {
		const run = cursorLiveRuns.getActiveForScope(scopeKey);
		if (!run || run.disposed) break;
		await cursorLiveRuns.release(run);
	}
	await resetSessionCursorAgent(scopeKey);
}
