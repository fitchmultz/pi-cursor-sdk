import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";

// Live-suite runner PTY contract: run with node --test. It needs a built node-pty (1.1.0 ships only darwin and
// win32 prebuilds), so CI runs it in the native-platforms job after that job's node-pty check, not in Vitest.
// A real node-pty PTY runs test/fixtures/fake-pi-tui.mjs as pi's CLI entry. The fixture only behaves like pi;
// the runner's exit, live-status.json and PTY event log decide what was observed and whether pi exited.
const windows = process.platform === "win32";
const runner = resolve("scripts/platform-smoke/live-suite-runner.mjs");
const root = mkdtempSync(join(tmpdir(), "platform-live-runner-"));
const repo = join(root, "repo");
const prepDir = join(root, "prep");
const home = join(root, "home");
const pidFile = (mode) => join(root, `${mode}.pid`);
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
// No inherited credentials: only what npm, the runner's shells and the PTY need.
const env = {
	HOME: home,
	TERM: "xterm-256color",
	npm_config_offline: "true",
	PATH: [dirname(process.execPath), ...(windows ? [join(systemRoot, "System32")] : ["/usr/bin", "/bin"])].join(delimiter),
	...(windows ? {
		SystemRoot: systemRoot,
		ComSpec: process.env.ComSpec,
		PATHEXT: process.env.PATHEXT,
		TEMP: process.env.TEMP,
		TMP: process.env.TMP,
		USERPROFILE: home,
		APPDATA: join(home, "AppData", "Roaming"),
		LOCALAPPDATA: join(home, "AppData", "Local"),
	} : {}),
};

before(() => {
	const piPackage = join(repo, "node_modules", "@earendil-works", "pi-coding-agent");
	for (const dir of [join(repo, "src"), join(repo, "node_modules", ".bin"), join(piPackage, "dist"), home]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "pi-cursor-sdk", version: "0.0.0" })}\n`);
	writeFileSync(join(repo, "README.md"), "fixture\n");
	writeFileSync(join(repo, "src", "index.ts"), "export {};\n");
	writeFileSync(join(repo, "node_modules", ".package-lock.json"), "{}\n");
	// The runner's own `pi install` and `pi list` steps only need a successful pi command.
	if (windows) writeFileSync(join(repo, "node_modules", ".bin", "pi.cmd"), "@exit /b 0\r\n");
	else writeFileSync(join(repo, "node_modules", ".bin", "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	writeFileSync(join(piPackage, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
	copyFileSync("test/fixtures/fake-pi-tui.mjs", join(piPackage, "dist", "cli.js"));
	// The runner loads this checkout's node-pty and, on POSIX, repairs its spawn-helper mode as on every target checkout.
	if (!windows) symlinkSync(resolve("node_modules/node-pty"), join(repo, "node_modules", "node-pty"));
	const prepare = spawnSync(process.execPath, [runner, "--prepare-only", "--target", windows ? "windows-native" : "macos", "--prep-dir", prepDir], { cwd: repo, env, encoding: "utf8" });
	assert.equal(prepare.status, 0, prepare.stderr);
});

after(() => {
	// Only the exit-ignoring pi outlives its runner; the others' pids are already gone and may be reused.
	try { process.kill(Number(readFileSync(pidFile("evidence-ignore-exit"), "utf8")), "SIGKILL"); } catch {}
	rmSync(root, { recursive: true, force: true });
});

function runLiveSuite(mode) {
	const outDir = join(root, mode);
	const startedAt = Date.now();
	const child = spawn(process.execPath, [runner, "--suite", "cursor-http1-live", "--target", windows ? "windows-native" : "macos", "--prep-dir", prepDir, "--out-dir", outDir, "--wait-ms", "8000"], {
		cwd: repo,
		env: { ...env, FAKE_PI_MODE: mode, FAKE_PI_PIDFILE: pidFile(mode) },
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	return new Promise((settle) => child.on("close", (status) => {
		const read = (name) => readFileSync(join(outDir, "artifacts", name), "utf8");
		const exitSteps = read("pty.events.jsonl").trim().split("\n").map((line) => JSON.parse(line).type)
			.filter((type) => ["quit_command_sent", "eof_sent", "interrupt_exit_sent", "kill_sent", "taskkill_sent", "exit"].includes(type));
		settle({ status, stderr, elapsedMs: Date.now() - startedAt, read, liveStatus: JSON.parse(read("live-status.json")), exitSteps });
	}));
}

test("pi answering but outliving every exit step fails the run while the answer stays observed", {
	skip: windows && "the runner's taskkill /T /F always ends pi on Windows, so an unobserved exit has no reproduction there",
	timeout: 90_000,
}, async () => {
	const run = await runLiveSuite("evidence-ignore-exit");
	assert.equal(run.status, 1, run.stderr);
	assert.match(run.stderr, /pi PTY exit was not observed after \/quit, EOF, Ctrl\+C and kill; pi may still be running/);
	assert.equal(run.liveStatus.ok, false);
	assert.equal(run.liveStatus.observation, "evidence-observed");
	assert.deepEqual(run.liveStatus.ptyExit, { kind: "not-observed" });
	assert.deepEqual(run.exitSteps, ["quit_command_sent", "eof_sent", "interrupt_exit_sent", "kill_sent"]);
	// Independent of the runner's record: that pi really is still running.
	assert.doesNotThrow(() => process.kill(Number(readFileSync(pidFile("evidence-ignore-exit"), "utf8")), 0));
});

test("pi answering and then quitting passes with the answer and the exit both recorded", { timeout: 60_000 }, async () => {
	const run = await runLiveSuite("evidence-then-quit");
	assert.equal(run.status, 0, run.stderr);
	assert.equal(run.liveStatus.ok, true);
	assert.equal(run.liveStatus.observation, "evidence-observed");
	assert.equal(run.liveStatus.ptyExit.kind, "exited");
	assert.equal(run.liveStatus.ptyExit.exitCode, 0);
	assert.deepEqual(run.exitSteps, ["quit_command_sent", "exit"]);
	assert.match(run.read("session.jsonl"), /HTTP1_LIVE_OK/);
});

const EARLY_EXITS = [
	{ name: "pi exiting before it answers is reported as that exit at once", mode: "early-exit", reported: "exit code 3", ptyExit: { kind: "exited", exitCode: 3 } },
	// POSIX only: node-pty's unix receipt for a signal death is { exitCode: 0 (its placeholder), signal }.
	{
		name: "pi killed by a signal before it answers is reported as that signal at once",
		mode: "signal-exit",
		reported: "signal 9",
		ptyExit: { kind: "exited", exitCode: 0, signal: 9 },
		skip: windows && "node-pty's Windows exit callback carries no signal",
	},
];

for (const { name, mode, reported, ptyExit, skip } of EARLY_EXITS) {
	test(name, { skip, timeout: 60_000 }, async () => {
		const run = await runLiveSuite(mode);
		assert.equal(run.status, 1, run.stderr);
		assert.ok(run.stderr.includes(`pi exited (${reported}) before final marker HTTP1_LIVE_OK`), run.stderr);
		assert.equal(run.liveStatus.ok, false);
		assert.equal(run.liveStatus.observation, "pi-exited");
		for (const [field, value] of Object.entries(ptyExit)) assert.equal(run.liveStatus.ptyExit[field], value, `ptyExit.${field}`);
		assert.deepEqual(run.exitSteps, ["exit"]);
		// Not after waiting for a session only a live pi could still write.
		assert.ok(run.elapsedMs < 15_000, `${run.elapsedMs}ms`);
	});
}
