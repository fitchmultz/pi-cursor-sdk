import type { LocalAgentRunDocument, LocalAgentStore, Run, RunError, RunResult } from "@cursor/sdk";

const watchedRunsByStore = new WeakMap<LocalAgentStore, Map<string, Run>>();
const terminalErrors = new WeakMap<Run, RunError>();
const TERMINAL_RUN_STATUSES = new Set<LocalAgentRunDocument["status"]>(["finished", "error", "cancelled", "expired"]);

// A failed local SDK run leaves its native tool processes running, and Run.cancel() stops them only
// while run.status is "running". The SDK awaits the terminal run-row write before it changes
// run.status, so cancelling from that write is ordered before the change, not racing it.
function onRunRowWrite(watched: Map<string, Run>, row: LocalAgentRunDocument): void {
	const run = watched.get(row.runId);
	if (!run || !TERMINAL_RUN_STATUSES.has(row.status)) return;
	watched.delete(row.runId);
	if (row.status !== "error" || run.status !== "running") return;
	terminalErrors.set(run, { message: row.error?.trim() || "Cursor SDK run failed." });
	run.cancel().catch(() => {});
}

/** Wraps a local store so watched runs are cancelled while still running when the SDK records a terminal error. */
export function observeCursorLocalRunTerminalErrors(store: LocalAgentStore): LocalAgentStore {
	const watched = new Map<string, Run>();
	const { runs } = store;
	const observed: LocalAgentStore = {
		agents: store.agents,
		checkpoints: store.checkpoints,
		runEvents: store.runEvents,
		runs: {
			get: (input) => runs.get(input),
			create: (input) => runs.create(input),
			delete: (input) => runs.delete(input),
			list: (input) => runs.list(input),
			update: async (input) => {
				try {
					return await runs.update(input);
				} finally {
					onRunRowWrite(watched, input.run);
				}
			},
		},
	};
	watchedRunsByStore.set(observed, watched);
	return observed;
}

/**
 * Call as soon as send() resolves. A run can only fail with native tools running after network
 * input, which cannot be processed before this continuation.
 */
export function watchCursorLocalRunTerminalError(store: LocalAgentStore, run: Run): void {
	if (run.status === "running") watchedRunsByStore.get(store)?.set(run.id, run);
}

/** Restores the SDK failure that terminal-error cancellation turned into a "cancelled" wait result. */
export function resolveCursorLocalRunTerminalError(run: Run, waitResult: RunResult, callerAborted: boolean): RunResult {
	const terminalError = terminalErrors.get(run);
	if (!terminalError || callerAborted || waitResult.status !== "cancelled") return waitResult;
	return { ...waitResult, status: "error", error: terminalError };
}
