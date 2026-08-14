#!/usr/bin/env node
/**
 * RPC steering smoke: queue steer after a native-replay tool-use turn completes execution.
 */
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CHILD_PROCESS_TREE_SPAWN_OPTIONS,
	parseJsonLines,
	terminateChild,
	waitForChildClose,
} from "./lib/cursor-child-process.mjs";
import { apiKeySecretsFromProcess } from "./lib/cursor-cli-args.mjs";
import { buildCursorSmokeEnv, CURSOR_SDK_EVENT_DEBUG_ENV_NAMES } from "./lib/cursor-smoke-env.mjs";
import { ensureBuilt } from "./lib/ensure-built.mjs";
import { scrubSensitiveText } from "../shared/cursor-sensitive-text.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const DEBUG_ENV_NAMES = CURSOR_SDK_EVENT_DEBUG_ENV_NAMES;
const DEFAULT_CHILD_CLOSE_TIMEOUT_MS = 30_000;

function printHelp() {
	console.log(`RPC steering smoke for pi-cursor-sdk live runs.

Usage:
  node scripts/steering-rpc-smoke.mjs

Environment:
  SMOKE_SESSION_DIR            Session directory for the RPC pi run. Defaults to /tmp/pi-cursor-steer-smoke-<timestamp>.
  PI_BIN                       Optional absolute pi executable path. smoke:live injects the parent-resolved path.
  CURSOR_API_KEY               Optional fallback auth. Stored pi auth in ~/.pi/agent/auth.json is also supported.

Options:
  -h, --help                   Show this help.
  --self-test                  Run the fake-PATH resolver probe without launching pi.

Exit codes:
  0  steering scenario completed without AgentBusyError; STEER_OK and STEER_CHAIN present
  1  validation failure, timeout, AgentBusyError, or non-zero pi exit

Notes:
  - Runs pi in RPC mode with native tool replay enabled and the pi bridge disabled.
  - Sends steer after the replayed bash tool finishes execution (post toolResult boundary).
  - Prints a single JSON result line on success; errors go to stderr.`);
}

function fail(message) {
	throw new Error(message);
}

function scrubForReport(text) {
	let scrubbed = scrubSensitiveText(text);
	for (const secret of apiKeySecretsFromProcess()) {
		if (secret) scrubbed = scrubSensitiveText(scrubbed, secret);
	}
	return scrubbed;
}

function smokeOutputTail(stdout, stderr) {
	return `stdoutTail=${scrubForReport(stdout.slice(-2000))}\nstderrTail=${scrubForReport(stderr.slice(-2000))}`;
}

async function waitForChildCloseWithTimeout(child, timeoutMs, outputSummary = () => "") {
	let timeout;
	try {
		return await Promise.race([
			waitForChildClose(child),
			new Promise((_, reject) => {
				timeout = setTimeout(() => {
					const summary = outputSummary();
					reject(new Error(`pi did not exit within ${timeoutMs}ms after agent_settled${summary ? `\n${summary}` : ""}`));
				}, timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveCommand(command, envPath = process.env.PATH ?? "") {
	if (!command.trim()) fail("empty command name");
	if (command.includes("/")) {
		const path = resolve(command);
		if (!isExecutable(path)) fail(`${command} is not executable`);
		return path;
	}
	for (const entry of envPath.split(delimiter)) {
		if (!entry) continue;
		const candidate = resolve(entry, command);
		if (isExecutable(candidate)) return candidate;
	}
	fail(`${command} is required on PATH`);
}

function resolvePiBin() {
	const path = process.env.PI_BIN?.trim() || resolveCommand("pi");
	if (!path.startsWith("/")) fail(`PI_BIN must be an absolute path when provided: ${path}`);
	return path;
}

function assistantText(events) {
	return events
		.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
		.map((event) =>
			(event.message.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
		)
		.join("\n");
}

function hasToolUseTurn(events) {
	return events.some(
		(event) =>
			event.type === "message_end" &&
			event.message?.role === "assistant" &&
			event.message?.stopReason === "toolUse",
	);
}

function hasToolExecutionEnd(events) {
	return events.some((event) => event.type === "tool_execution_end");
}

function waitFor(getStdout, predicate, timeoutMs = 300_000) {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			const events = parseJsonLines(getStdout());
			if (predicate(events)) {
				resolve(events);
				return;
			}
			if (Date.now() - start > timeoutMs) {
				reject(
					new Error(
						`timeout after ${timeoutMs}ms\nassistantText=${assistantText(events)}\nstdoutTail=${getStdout().slice(-4000)}`,
					),
				);
				return;
			}
			setTimeout(tick, 500);
		};
		tick();
	});
}

function buildPiRpcEnv(baseEnv = process.env, nodePath = process.execPath) {
	return buildCursorSmokeEnv({
		baseEnv,
		nodePath,
		settingSources: "none",
		nativeToolDisplay: true,
		registerNativeTools: true,
		bridge: false,
	});
}

async function runPiRpcSmoke(sessionDir, piBin) {
	const args = ["--approve", "-e", root, "--cursor-no-fast", "--model", "cursor/composer-2-5", "--mode", "rpc", "--session-dir", sessionDir];
	const env = buildPiRpcEnv();

	const child = spawn(piBin, args, {
		cwd: root,
		env,
		stdio: ["pipe", "pipe", "pipe"],
		...CHILD_PROCESS_TREE_SPAWN_OPTIONS,
	});
	let closed = false;
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	const send = (obj) => {
		if (!child.stdin.writable) fail("pi stdin closed before smoke command could be sent");
		child.stdin.write(`${JSON.stringify(obj)}\n`);
	};

	try {
		send({
			type: "prompt",
			message:
				"Steering smoke. Use bash once to run: git status --short. Do not answer until after the tool completes. Final answer must include STEER_OK=yes.",
		});

		await waitFor(
			() => stdout,
			(events) => hasToolUseTurn(events),
		);

		await waitFor(
			() => stdout,
			(events) => hasToolExecutionEnd(events),
		);

		send({ type: "steer", message: "and also include STEER_CHAIN=ok in the final answer" });

		await waitFor(
			() => stdout,
			(events) => {
				const text = assistantText(events);
				return text.includes("STEER_OK=yes") && text.includes("STEER_CHAIN=ok") && events.some((event) => event.type === "agent_settled");
			},
		);

		const combined = stdout + stderr;
		if (/already has active run|AgentBusyError/i.test(combined)) {
			fail("AgentBusyError detected in smoke output");
		}

		const text = assistantText(parseJsonLines(stdout));
		if (!text.includes("STEER_OK=yes")) {
			fail(`missing STEER_OK=yes in assistant output: ${text.slice(0, 500)}`);
		}
		if (!text.includes("STEER_CHAIN=ok")) {
			fail(`missing STEER_CHAIN=ok in assistant output: ${text.slice(0, 500)}`);
		}

		child.stdin.end();
		const exitCode = await waitForChildCloseWithTimeout(child, DEFAULT_CHILD_CLOSE_TIMEOUT_MS, () => smokeOutputTail(stdout, stderr));
		closed = true;
		if (exitCode !== 0) {
			fail(`pi exited ${exitCode}\nstderr=${scrubForReport(stderr.slice(-2000))}`);
		}

		return {
			ok: true,
			sessionDir,
			steerOk: true,
			steerChain: true,
		};
	} finally {
		if (!closed) await terminateChild(child);
	}
}

async function runSelfTest() {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-steering-self-test-"));
	try {
		const binDir = join(tempDir, "bin");
		mkdirSync(binDir, { recursive: true });
		const fakePi = join(binDir, "pi");
		const fakeNode = join(binDir, "node");
		const fakeNodeMarker = join(tempDir, "fake-node-used");
		const envCapture = join(tempDir, "fake-pi.env");
		writeFileSync(
			fakePi,
			`#!/usr/bin/env node\nconst { writeFileSync } = require("node:fs");\nwriteFileSync(${JSON.stringify(envCapture)}, Object.entries(process.env).map(([key, value]) => key + "=" + (value ?? "")).join("\\n") + "\\n", "utf8");\n`,
			"utf8",
		);
		writeFileSync(fakeNode, `#!/bin/sh\necho fake-node-used > ${JSON.stringify(fakeNodeMarker)}\nexit 99\n`, "utf8");
		chmodSync(fakePi, 0o755);
		chmodSync(fakeNode, 0o755);
		const hostilePath = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
		if (buildPiRpcEnv({ PATH: "" }).PATH?.includes(delimiter)) fail("self-test failed: empty inherited PATH left an empty PATH segment");
		if (resolveCommand("pi", hostilePath) !== fakePi) fail("self-test failed: direct PATH resolver did not prefer fake PATH head");
		const originalPiBin = process.env.PI_BIN;
		const originalPath = process.env.PATH;
		try {
			delete process.env.PI_BIN;
			process.env.PATH = hostilePath;
			if (resolvePiBin() !== fakePi) fail("self-test failed: resolvePiBin should use PATH when PI_BIN is absent");
			process.env.PI_BIN = fakePi;
			if (resolvePiBin() !== fakePi) fail("self-test failed: resolvePiBin should honor absolute PI_BIN");
			const hostileEnv = buildPiRpcEnv({
				...Object.fromEntries(DEBUG_ENV_NAMES.map((name) => [name, join(tempDir, name)])),
				PATH: hostilePath,
				PI_CURSOR_REGISTER_NATIVE_TOOLS: "0",
				PI_CURSOR_SETTING_SOURCES: "all",
				PI_CURSOR_PI_TOOL_BRIDGE: "1",
			});
			if ((hostileEnv.PATH ?? "").split(delimiter)[0] !== dirname(process.execPath)) fail("self-test failed: sealed PATH should start with resolved node directory");
			if (hostileEnv.PI_CURSOR_REGISTER_NATIVE_TOOLS !== "1") fail("self-test failed: native registration should be forced on");
			if (hostileEnv.PI_CURSOR_SETTING_SOURCES !== "none") fail("self-test failed: setting sources should be forced off");
			if (hostileEnv.PI_CURSOR_PI_TOOL_BRIDGE !== "0") fail("self-test failed: bridge should be forced off");
			for (const name of DEBUG_ENV_NAMES) {
				if (name in hostileEnv) fail(`self-test failed: ${name} should be cleared`);
			}
			const probe = spawnSync(fakePi, ["--version"], { cwd: root, env: hostileEnv, encoding: "utf8" });
			if (probe.status !== 0) fail(`self-test failed: fake pi shim exited ${probe.status}; stderr=${probe.stderr}`);
			let fakeNodeUsed = false;
			try {
				accessSync(fakeNodeMarker, constants.F_OK);
				fakeNodeUsed = true;
			} catch {
				// Expected: sealed PATH should keep /usr/bin/env node away from the hostile fake node.
			}
			if (fakeNodeUsed) fail("self-test failed: steering child env used hostile fake node");
			const hangingChild = new EventEmitter();
			hangingChild.exitCode = null;
			hangingChild.signalCode = null;
			let closeTimedOut = false;
			try {
				await waitForChildCloseWithTimeout(hangingChild, 10, () => smokeOutputTail("STEER_OK=yes", ""));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				closeTimedOut = message.includes("pi did not exit within 10ms after agent_settled") && message.includes("stdoutTail=STEER_OK=yes");
			}
			if (!closeTimedOut) fail("self-test failed: post-agent_settled child close wait should be bounded and report output tail");
		} finally {
			if (originalPiBin === undefined) delete process.env.PI_BIN;
			else process.env.PI_BIN = originalPiBin;
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
		console.log("[steering-rpc-smoke] self-test PASS");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

async function main() {
	if (process.argv.includes("-h") || process.argv.includes("--help")) {
		printHelp();
		return;
	}
	ensureBuilt();
	if (process.argv.includes("--self-test")) {
		await runSelfTest();
		return;
	}

	const sessionDir = process.env.SMOKE_SESSION_DIR ?? join("/tmp", `pi-cursor-steer-smoke-${Date.now()}`);
	const piBin = resolvePiBin();
	mkdirSync(sessionDir, { recursive: true });
	console.log(JSON.stringify(await runPiRpcSmoke(sessionDir, piBin)));
}

main().catch((error) => {
	let scrubbed = scrubSensitiveText(error instanceof Error ? error.message : String(error));
	for (const secret of apiKeySecretsFromProcess()) {
		if (secret) scrubbed = scrubSensitiveText(scrubbed, secret);
	}
	console.error(scrubbed);
	process.exitCode = 1;
});
