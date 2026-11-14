#!/usr/bin/env node
/**
 * Shell-path smoke: confirm pi-cursor-sdk applies Pi's `shellPath` as Cursor's `SHELL`.
 *
 * Runs the same Pi settings twice, once with the extension loaded and once
 * without it. Only the extension block should change `SHELL`, so the pair
 * proves the override rather than the ambient environment supplying a bash.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const PROBE_SOURCE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		process.stdout.write(\`SHELL=\${JSON.stringify(process.env.SHELL)} shellPath=\${JSON.stringify(pi.getSettings().shellPath)}\\n\`);
	});
}
`;

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
  One SHELL= line per block plus the expectation it was checked against.
  A bash shellPath must be applied verbatim; a non-bash choice is left alone,
  so both blocks legitimately keep the pinned starting shell there.

Exit codes:
  0  both blocks matched their expectation
  1  bad arguments, a block with no evidence, or a value that did not match

Cost:
  Two live Cursor turns. The offline unit tests cover the same override
  logic when no real-service proof is needed.`);
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

/** Mirrors cursorShellEnvValue: only a bash path is applied. */
function isBashPath(shellPath) {
	return typeof shellPath === "string" && shellPath.includes("bash");
}

/** Read the probe's `SHELL=... shellPath=...` line, or undefined when absent. */
function parseEvidence(lines) {
	for (const line of lines) {
		const match = /^SHELL=(.+?) shellPath=(.+)$/.exec(line);
		if (!match) continue;
		try {
			return { shell: JSON.parse(match[1]), shellPath: JSON.parse(match[2]) };
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function runPi(args, { shellPath, timeoutMs }) {
	return new Promise((resolvePromise) => {
		const pi = findPiCommand();
		const child = spawn(pi.command, [...pi.argsPrefix, ...args], {
			cwd: root,
			// Pin the starting shell: Pi exports its own bash, so an inherited
			// value would make the control look like the override working.
			env: { ...process.env, SHELL: shellPath },
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
				(line) => line.startsWith("SHELL=") || line.includes("Failed to load"),
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
	const workDir = mkdtempSync(join(tmpdir(), "pi-cursor-shell-path-"));
	const probePath = join(workDir, "shell-path-probe.ts");
	writeFileSync(probePath, PROBE_SOURCE);

	const problems = [];
	try {
		const blocks = [
			{
				label: "with pi-cursor-sdk loaded",
				extensionPaths: [root],
				// A bash shellPath must be applied verbatim. A non-bash choice is
				// deliberately left alone, so SHELL keeping the pinned value is
				// the correct outcome there rather than a failure.
				expect: (observed) =>
					isBashPath(observed.shellPath)
						? observed.shell === observed.shellPath
						: observed.shell === startingShell,
				describe: (observed) =>
					isBashPath(observed.shellPath)
						? `expect SHELL == shellPath (${observed.shellPath})`
						: `expect SHELL == ${startingShell} because shellPath is not bash`,
			},
			{
				label: "without pi-cursor-sdk (control)",
				extensionPaths: [],
				// Without the extension nothing should touch the value.
				expect: (observed) => observed.shell === startingShell,
				describe: () => `expect SHELL == ${startingShell}`,
			},
		];
		console.log(`starting SHELL: ${startingShell}`);
		for (const block of blocks) {
			console.log(`--- ${block.label} ---`);
			const result = await runPi(
				[
					// -ne keeps extension discovery out of both blocks, so an install
					// that already lists pi-cursor-sdk cannot load it in the control.
					"-ne",
					...block.extensionPaths.flatMap((path) => ["-e", path]),
					"-e",
					probePath,
					"--no-session",
					"-p",
					"say ok",
				],
				{ shellPath: startingShell, timeoutMs: args.timeoutMs },
			);
			for (const line of result.evidence) console.log(line);
			// Reaching session_start already answers the question, but say so
			// rather than let a truncated run read as clean.
			if (result.timedOut) console.log(`(timeout fired; ${result.detail})`);

			const observed = parseEvidence(result.evidence);
			if (!observed) {
				problems.push(`${block.label}: no SHELL= evidence (${result.detail})`);
				continue;
			}
			console.log(`(observed ${block.describe(observed)})`);
			if (!block.expect(observed)) {
				problems.push(
					`${block.label}: SHELL=${observed.shell} shellPath=${observed.shellPath} does not match expectation`,
				);
			}
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}

	if (problems.length > 0) fail(problems.join("; "));
	console.log("OK: the extension applied shellPath, and the control was untouched.");
}

if (isMainModule()) {
	main().catch((error) => {
		fail(error instanceof Error ? error.message : String(error));
	});
}
