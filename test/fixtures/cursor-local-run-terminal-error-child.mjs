// Runs one real installed @cursor/sdk local run against the test's loopback backend and prints one JSON line.
// mode "observed" wraps the SDK SQLite store with the extension's terminal-error observer (Node 24 strips its types).
import { join } from "node:path";

const [mode, root] = process.argv.slice(2);
const { Agent } = await import("@cursor/sdk");
const { SqliteLocalAgentStore } = await import("@cursor/sdk/sqlite");
const { observeCursorLocalRunTerminalErrors, resolveCursorLocalRunTerminalError, watchCursorLocalRunTerminalError } =
	await import("../../src/cursor-local-run-terminal-error.ts");

const sqlite = await SqliteLocalAgentStore.open({ workspaceRef: root, stateRoot: join(root, "state") });
const store = mode === "observed" ? observeCursorLocalRunTerminalErrors(sqlite) : sqlite;
const agent = await Agent.create({ apiKey: "offline-not-a-key", model: { id: "offline-model" }, local: { cwd: root, settingSources: [], store } });
const run = await agent.send("offline terminal failure");
if (mode === "observed") watchCursorLocalRunTerminalError(store, run);
const statusAtSend = run.status;
const waitResult = await run.wait();
const result = { statusAtSend, wait: { status: waitResult.status, ...(waitResult.error ? { error: waitResult.error } : {}) } };
if (mode === "observed") {
	const resolved = resolveCursorLocalRunTerminalError(run, waitResult, false);
	result.resolved = { status: resolved.status, error: resolved.error };
}
const row = await sqlite.runs.get({ agentId: run.agentId, runId: run.id });
result.row = { status: row?.status, error: row?.error };
await agent[Symbol.asyncDispose]();
await sqlite.dispose();
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
