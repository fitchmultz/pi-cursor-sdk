// Preloaded through NODE_OPTIONS=--import into a Node process standing in for the Crabbox CLI.
// It must exit synchronously, before Node resolves the Crabbox subcommand as a main module.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Node has already resolved the subcommand into the main-module path argv[1].
const subcommand = basename(process.argv[1]);
const args = process.argv.slice(2);
const id = args.includes("--id") ? args[args.indexOf("--id") + 1] : undefined;
const { FAKE_CRABBOX_CALLS, FAKE_CRABBOX_WARMUP_EXIT, FAKE_CRABBOX_STOP_EXIT, FAKE_CRABBOX_BREAK_SUITE_STDOUT_IN, FAKE_CRABBOX_BREAK_STOP_STDOUT_IN, FAKE_CRABBOX_BREAK_STOP_STDOUT_OF, FAKE_CRABBOX_SUITE_STDOUT } = process.env;
// A directory at `name` (relative to each suite directory under root) makes the host's next write of that artifact fail.
function breakSuiteArtifact(root, name) {
	for (const entry of readdirSync(root, { recursive: true })) {
		if (basename(entry) === "command.txt") mkdirSync(join(root, dirname(entry), name), { recursive: true });
	}
}
if (FAKE_CRABBOX_CALLS) appendFileSync(FAKE_CRABBOX_CALLS, `${JSON.stringify({ subcommand, id })}\n`);
if (subcommand === "warmup") {
	const warmupExit = Number(FAKE_CRABBOX_WARMUP_EXIT ?? 0);
	if (warmupExit !== 0) {
		writeSync(2, "fake warmup refused\n");
		process.exit(warmupExit);
	}
	writeSync(1, "leased cbx_fake_owned\n");
	process.exit(0);
}
if (subcommand === "stop") {
	// The stop's recorder is the owning suite's directory or its target session's sibling lease-cleanup directory.
	if (FAKE_CRABBOX_BREAK_STOP_STDOUT_IN) breakSuiteArtifact(FAKE_CRABBOX_BREAK_STOP_STDOUT_IN, join("..", FAKE_CRABBOX_BREAK_STOP_STDOUT_OF, "crabbox.stop.stdout.txt"));
	process.exit(Number(FAKE_CRABBOX_STOP_EXIT ?? 0));
}

if (FAKE_CRABBOX_BREAK_SUITE_STDOUT_IN) breakSuiteArtifact(FAKE_CRABBOX_BREAK_SUITE_STDOUT_IN, "crabbox.stdout.txt");
const capture = args.indexOf("--capture-stdout");
// FAKE_CRABBOX_SUITE_STDOUT names a file holding the remote suite's full stdout, such as its artifact bundle.
if (capture !== -1) writeFileSync(args[capture + 1], FAKE_CRABBOX_SUITE_STDOUT ? readFileSync(FAKE_CRABBOX_SUITE_STDOUT) : `FAKE_CRABBOX_ARGS=${JSON.stringify(args)}\n`);
writeSync(1, "terminal output truncated by Crabbox\n");
process.exit(7);
