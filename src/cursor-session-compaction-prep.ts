import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { resetSessionCursorAgent } from "./cursor-session-agent.js";
import { suppressCursorSessionAgentResumeHandlePersist } from "./cursor-session-agent-resume.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";

/**
 * Prepare the pooled Cursor session agent for pi compaction summarization.
 * Releases any scoped live-run drain state still tied to the pooled agent, then
 * disposes the pool entry so summarization acquires a clean SDK agent.
 * Suppresses local-resume handle persist so the summarizer send cannot leak
 * a one-message handle into the next normal turn (#223).
 */
export async function prepareCursorSessionForCompaction(
	scopeKey: string = getCursorSessionScopeKey(),
): Promise<void> {
	suppressCursorSessionAgentResumeHandlePersist();
	while (true) {
		const run = cursorLiveRuns.getActiveForScope(scopeKey);
		if (!run || run.disposed) break;
		await cursorLiveRuns.release(run);
	}
	await resetSessionCursorAgent(scopeKey);
}
