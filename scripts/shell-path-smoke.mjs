#!/usr/bin/env node
/**
 * Shell-path smoke: confirm pi-cursor-sdk applies Pi's `shellPath` as Cursor's `SHELL`.
 *
 * Each block gets its own Pi agent directory, so a host `shellPath` cannot decide
 * the result. One block sets a bash path, one leaves it unset, and one loads no
 * extension. The expected SHELL is that setting, or Pi's own default when the
 * setting is unset. It is not computed by calling the override under test.
 * Windows is the exception: the override does not write, so SHELL stays pinned.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import {
	CHILD_PROCESS_TREE_SPAWN_OPTIONS,
	describeProcessExit,
	terminateChild,
	waitForChildClose,
} from "./lib/cursor-child-process.mjs";
import { parseArgv } from "./lib/cursor-cli-args.mjs";
import { createScriptFail } from "./lib/cursor-script-fail.mjs";
import { ensureBuilt } from "./lib/ensure-built.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_TIMEOUT_MS = 120_000;
const PROBE_PREFIX = "pi-cursor-shell-path ";
/** Kept in the probe source so `JSON.stringify(undefined)` cannot emit a bare `undefined`. */
export const PROBE_JSON_OBJECT = "{ shell: process.env.SHELL ?? null, shellPath: pi.getSettings().shellPath ?? null }";
export const PROBE_SOURCE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		// SHELL is already decided here. Exit before the print prompt so the
		// check does not spend a model turn.
		process.stdout.write(\`${PROBE_PREFIX}\${JSON.stringify(${PROBE_JSON_OBJECT})}\\n\`, () => {
			process.exit(0);
		});
	});
}
`;

const HOST_BASH_CANDIDATES = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"];

const fail = createScriptFail("shell-path-smoke");

function isMainModule() {
	if (!process.argv[1]) return false;
	return SCRIPT_PATH === resolve(process.argv[1]);
}

function printHelp() {
	console.log(`Verify that pi-cursor-sdk applies Pi's shellPath as Cursor's SHELL.

Usage:
  node scripts/shell-path-smoke.mjs [options]
  npm run smoke:shell-path

Options:
  --timeout-ms <ms>   Per-block timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  -h, --help          Show this help without building or running Pi.

Output:
  One probe line per block plus the expectation it was checked against.
  An explicit bash shellPath must be applied verbatim. An unset shellPath must
  become Pi's platform default. On Windows the override does not write, so both
  of those blocks keep the pinned starting shell. The control always does.

Exit codes:
  0  every block matched its expectation
  1  bad arguments, a block with no evidence, or a value that did not match

Cost:
  No model turn. Each block starts Pi and exits from session_start once SHELL
  is visible. The offline unit tests cover the override, including the Windows
  skip, when no real Pi process is needed.`);
}

function parseArgs(argv) {
	return parseArgv(argv, {
		defaults: { timeoutMs: DEFAULT_TIMEOUT_MS },
		flags: {
			timeoutMs: {
				names: ["--timeout-ms"],
				assign: (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed <= 0) fail(`--timeout-ms must be a positive number: ${value}`);
					return Math.trunc(parsed);
				},
			},
		},
		fail,
	});
}

/** Prefer the repo's own Pi, then the installed shim, then PATH. */
function findPiCommand() {
	const cli = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	if (existsSync(cli)) return { command: process.execPath, argsPrefix: [cli] };
	const local = join(root, "node_modules", ".bin", "pi");
	return { command: existsSync(local) ? local : "pi", argsPrefix: [] };
}

function findHostBash() {
	for (const candidate of HOST_BASH_CANDIDATES) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep looking: no single bash location exists on every host.
		}
	}
	throw new Error(`No bash found on this host. Checked: ${HOST_BASH_CANDIDATES.join(", ")}`);
}

/**
 * The SHELL a block must observe. Derived from the setting and platform, not
 * from `applyPiShellToCursorProcess`, so a no-op override fails this check.
 * `shellPath` null means Pi's unset default (`piDefaultShell`).
 */
export function expectedAppliedShell(shellPath, startingShell, platform, piDefaultShell) {
	if (platform === "win32") return startingShell;
	return shellPath ?? piDefaultShell;
}

/** One JSON object, so a missing shellPath is `null` rather than the token `undefined`. */
export function formatShellPathProbe(shell, shellPath) {
	return `${PROBE_PREFIX}${JSON.stringify({
		shell: shell ?? null,
		shellPath: shellPath ?? null,
	})}`;
}

/** Read the probe line, or undefined when no complete line is present. */
export function parseShellPathEvidence(lines) {
	for (const line of lines) {
		if (!line.startsWith(PROBE_PREFIX)) continue;
		try {
			const parsed = JSON.parse(line.slice(PROBE_PREFIX.length));
			if (!parsed || typeof parsed !== "object" || !("shell" in parsed) || !("shellPath" in parsed)) continue;
			return { shell: parsed.shell, shellPath: parsed.shellPath };
		} catch {
			// A truncated or foreign line can share the prefix. Keep scanning.
		}
	}
	return undefined;
}

function seedAgentDir(dir, shellPath) {
	mkdirSync(dir, { recursive: true });
	const settings = {
		quietStartup: true,
		enableInstallTelemetry: false,
	};
	if (shellPath) settings.shellPath = shellPath;
	writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings)}\n`);
}

function runPi(args, { startingShell, agentDir, timeoutMs }) {
	return new Promise((resolvePromise) => {
		const pi = findPiCommand();
		const child = spawn(pi.command, [...pi.argsPrefix, ...args], {
			cwd: root,
			// Pin the starting shell: Pi exports its own bash, so an inherited
			// value would make the control look like the override working.
			env: {
				...process.env,
				SHELL: startingShell,
				PI_CODING_AGENT_DIR: agentDir,
				PI_SKIP_VERSION_CHECK: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
			...CHILD_PROCESS_TREE_SPAWN_OPTIONS,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			timedOut = true;
			terminateChild(child).catch(() => undefined);
		}, timeoutMs);

		void waitForChildClose(child).then(async (code) => {
			clearTimeout(timer);
			// A descendant can outlive the child; finish group teardown so a
			// leftover Pi cannot keep this probe from returning.
			if (timedOut) await terminateChild(child).catch(() => undefined);
			const evidence = [...stdout.split("\n"), ...stderr.split("\n")].filter(
				(line) => line.startsWith(PROBE_PREFIX) || line.includes("Failed to load"),
			);
			resolvePromise({
				evidence,
				timedOut,
				detail: timedOut
					? `timed out after ${timeoutMs}ms`
					: `exited with ${describeProcessExit(code, child.signalCode)}`,
			});
		});
	});
}

async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	if (args.help) {
		printHelp();
		return;
	}

	// The probe loads the built manifest, so a stale dist/ would validate
	// previous behavior. Match the other launchers and build first.
	ensureBuilt();

	const startingShell = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
	const piDefaultShell = getShellConfig(undefined).shell;
	const workDir = mkdtempSync(join(tmpdir(), "pi-cursor-shell-path-"));
	const problems = [];
	try {
		const probePath = join(workDir, "shell-path-probe.ts");
		const bashPath = join(workDir, "bash");
		writeFileSync(probePath, PROBE_SOURCE);
		symlinkSync(findHostBash(), bashPath);

		const configuredDir = join(workDir, "agent-configured");
		const unsetDir = join(workDir, "agent-unset");
		seedAgentDir(configuredDir, bashPath);
		seedAgentDir(unsetDir, undefined);

		const blocks = [
			{
				label: "with pi-cursor-sdk loaded and an explicit bash shellPath",
				extensionPaths: [root],
				agentDir: configuredDir,
				shellPath: bashPath,
			},
			{
				label: "with pi-cursor-sdk loaded and shellPath unset",
				extensionPaths: [root],
				agentDir: unsetDir,
				shellPath: null,
			},
			{
				label: "without pi-cursor-sdk (control)",
				extensionPaths: [],
				agentDir: configuredDir,
				shellPath: bashPath,
				control: true,
			},
		];
		console.log(`starting SHELL: ${startingShell}`);
		for (const block of blocks) {
			console.log(`--- ${block.label} ---`);
			const expectedShell = block.control
				? startingShell
				: expectedAppliedShell(block.shellPath, startingShell, process.platform, piDefaultShell);
			const result = await runPi(
				[
					// -ne keeps extension discovery out of every block, so an install
					// that already lists pi-cursor-sdk cannot load it in the control.
					"-ne",
					...block.extensionPaths.flatMap((path) => ["-e", path]),
					"-e",
					probePath,
					"--no-session",
					"-p",
					"say ok",
				],
				{ startingShell, agentDir: block.agentDir, timeoutMs: args.timeoutMs },
			);
			for (const line of result.evidence) console.log(line);
			// Reaching session_start already answers the question, but say so
			// rather than let a truncated run read as clean.
			if (result.timedOut) console.log(`(timeout fired; ${result.detail})`);

			const observed = parseShellPathEvidence(result.evidence);
			if (!observed) {
				problems.push(`${block.label}: no probe evidence (${result.detail})`);
				continue;
			}
			const shellMatches = observed.shell === expectedShell;
			const settingMatches = observed.shellPath === block.shellPath;
			console.log(`(observed SHELL=${observed.shell} shellPath=${observed.shellPath}; expect SHELL=${expectedShell})`);
			if (!shellMatches || !settingMatches) {
				problems.push(
					`${block.label}: SHELL=${observed.shell} shellPath=${observed.shellPath}; expected SHELL=${expectedShell} shellPath=${block.shellPath}`,
				);
			}
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}

	if (problems.length > 0) fail(problems.join("; "));
	console.log("OK: explicit and unset shellPath matched the extension, and the control was untouched.");
}

if (isMainModule()) {
	main().catch((error) => {
		fail(error instanceof Error ? error.message : String(error));
	});
}
