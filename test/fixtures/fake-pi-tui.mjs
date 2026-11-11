// Stands in for pi's interactive CLI entry inside the live-suite runner's real node-pty PTY.
// It supplies only pi's side of the interaction; the runner decides what was observed and whether pi exited.
// Never contacts Cursor. FAKE_PI_MODE selects pi's behavior; FAKE_PI_PIDFILE records the pid for the test's cleanup.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_PI_MODE;
const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
const sessionId = args[args.indexOf("--session-id") + 1];
if (process.env.FAKE_PI_PIDFILE) writeFileSync(process.env.FAKE_PI_PIDFILE, `${process.pid}\n`);

// "evidence-ignore-exit" is a pi that prints its answer but survives /quit, EOF, Ctrl+C and SIGHUP.
const ignoresExit = mode === "evidence-ignore-exit";
// Bounded backstop. Only the exit-ignoring pi holds the event loop with it, so it outlives its runner's PTY and
// stdin ending until the test kills it; every other mode still ends on its own.
const backstop = setTimeout(() => process.exit(70), 120_000);
if (!ignoresExit) backstop.unref();
process.on("SIGHUP", () => {
	if (!ignoresExit) process.exit(129);
});

function writeAnsweredSession(marker) {
	mkdirSync(sessionDir, { recursive: true });
	const now = new Date().toISOString();
	const lines = [
		{ type: "session", version: 3, id: sessionId, timestamp: now, cwd: process.cwd() },
		{ type: "message", id: "u1", parentId: null, timestamp: now, message: { role: "user", content: [{ type: "text", text: "prompt" }], timestamp: Date.now() } },
		{ type: "message", id: "a1", parentId: "u1", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: marker }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() } },
	];
	writeFileSync(join(sessionDir, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
let input = "";
process.stdin.on("data", (chunk) => {
	input += chunk.toString("utf8");
	if (input.includes("/quit\r") && !ignoresExit) process.exit(0);
});

switch (mode) {
	case "early-exit":
		setTimeout(() => {
			process.stdout.write("fake pi failed before answering\r\n");
			process.exit(3);
		}, 300);
		break;
	case "signal-exit":
		setTimeout(() => {
			process.stdout.write("fake pi killed before answering\r\n");
			process.kill(process.pid, "SIGKILL");
		}, 300);
		break;
	case "evidence-then-quit":
	case "evidence-ignore-exit":
		setTimeout(() => {
			process.stdout.write("HTTP1_LIVE_OK\r\n");
			writeAnsweredSession("HTTP1_LIVE_OK");
		}, 300);
		break;
	default:
		process.stdout.write(`unknown FAKE_PI_MODE ${mode}\r\n`);
		process.exit(64);
}
