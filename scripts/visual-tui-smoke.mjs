#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commonBooleanFlag, commonRepeatStringFlag, parseArgv } from "./lib/cursor-cli-args.mjs";
import { buildCursorSmokeEnvPlan, CURSOR_SDK_EVENT_DEBUG_ENV_NAMES, sealedNodePath } from "./lib/cursor-smoke-env.mjs";
import { writeVisualManifest } from "./lib/cursor-visual-manifest.mjs";
import { runVisualSmokeSelfTest } from "./visual-tui-smoke-self-test.mjs";
import { buildTerminalHtml, writeTerminalScreenshot } from "./lib/cursor-visual-render.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WIDTH = 150;
const DEFAULT_HEIGHT = 45;
const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_STARTUP_MS = 5_000;
const DEFAULT_HISTORY_LINES = 3_000;
const DEFAULT_MODEL = "cursor/grok-4.6";
const DEFAULT_MODE = "plan";
const DEFAULT_SETTING_SOURCES = "none";
const DEBUG_ENV_NAMES = CURSOR_SDK_EVENT_DEBUG_ENV_NAMES;

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

function printHelp() {
	console.log(`Canonical offscreen TUI visual smoke runner for pi-cursor-sdk.

Usage:
  node scripts/visual-tui-smoke.mjs --label LABEL --prompt PROMPT [options]
  npm run smoke:visual -- --label LABEL --prompt PROMPT [options]

Required:
  --label LABEL                 Artifact filename prefix. Sanitized for paths.
  --prompt PROMPT               Prompt to paste into the interactive pi TUI.
                                Use --prompt-file PATH for multi-line prompts.

Common options:
  --ext PATH                    Extension repo to load with pi -e. Default: repo root.
  --cwd PATH                    Working directory for the pi session. Default: current directory.
  --out-dir PATH                Artifact directory. Default: /tmp/pi-cursor-sdk-visual-smoke-<timestamp>.
  --wait-ms N                   Milliseconds to wait after sending the prompt. Default: ${DEFAULT_WAIT_MS}.
  --startup-ms N                Milliseconds to wait before pasting the prompt. Default: ${DEFAULT_STARTUP_MS}.
  --model MODEL                 Cursor model. Default: ${DEFAULT_MODEL}.
  --mode agent|plan             Cursor SDK mode. Default: ${DEFAULT_MODE}.
  --session-dir PATH            pi session directory. Default: <out-dir>/<label>.session.
  --session-id ID               pi session id; pass to resume a prior capture session. Default: pi-assigned, so fresh captures avoid the new-session warning line.
  --width N                     PTY columns. Default: ${DEFAULT_WIDTH}.
  --height N                    PTY rows. Default: ${DEFAULT_HEIGHT}.
  --history-lines N             tmux capture history lines. Default: ${DEFAULT_HISTORY_LINES}.
  --setting-sources VALUE       Cursor setting sources. Default: ${DEFAULT_SETTING_SOURCES}.
  --bridge                      Opt in to the pi tool bridge for bridge-specific visual audits.
  --expose-builtin-tools        Opt in to exposing overlapping built-in pi tools to Cursor. Requires --bridge.
  --event-debug                 Set PI_CURSOR_SDK_EVENT_DEBUG=1 and write debug artifacts under <out-dir>.
  --leftover-pattern REGEX      After capture, fail if a process command still matches REGEX. Repeatable.
  --no-screenshot               Write .ansi/.txt/.html/.jsonl.path only; use agent_browser manually.
  --self-test                   Run the fake-PATH/env isolation probe without launching pi.
  -h, --help                    Show this help.

Native replay isolation defaults:
  PI_CURSOR_NATIVE_TOOL_DISPLAY=1
  PI_CURSOR_REGISTER_NATIVE_TOOLS=1
  PI_CURSOR_SETTING_SOURCES=none
  PI_CURSOR_PI_TOOL_BRIDGE=0
  PI_CURSOR_EXPOSE_BUILTIN_TOOLS=0
  PI_CODING_AGENT_DIR=<out-dir>/pi-agent  (seeded auth.json + quietStartup; host extensions stay out)
  PI_OFFLINE=1
  PI_SKIP_VERSION_CHECK=1
  TERM=xterm-256color
  tmux starts in --cwd with a non-login shell so a stale tmux-server cwd cannot print getcwd errors
  Debug artifact env is cleared before each run; --event-debug sets a deterministic debug dir.

Artifacts written:
  <label>.ansi                  Raw tmux ANSI capture.
  <label>.txt                   Plain tmux text capture.
  <label>.html                  Self-contained browser/xterm render.
  <label>.png                   Browser-rendered screenshot, unless --no-screenshot.
  <label>.jsonl.path            Latest persisted pi session JSONL path.
  <label>.manifest.json         Agent-readable artifact index for this run.

Prerequisites:
  - pi, node, tmux, and npm-installed dev dependencies on PATH / in node_modules.
  - The runner resolves pi/tmux from the parent PATH, uses process.execPath for node, and seals pi-shim PATH for prereq checks and tmux.
  - For automatic PNG capture, install a Playwright browser once when needed:
      npx playwright install chromium
  - In the pi agent harness, --no-screenshot plus agent_browser on the generated HTML is also acceptable.

Examples:
  npm run smoke:visual -- \\
    --label read-package \\
    --prompt 'Read ./package.json using the read/file tool, then answer with the package name.' \\
    --out-dir /tmp/pi-cursor-sdk-visual-review

  npm run smoke:visual -- \\
    --label after-shell-success \\
    --ext /path/to/pi-cursor-sdk \\
    --cwd /path/to/test-workspace \\
    --prompt 'Run a safe shell command that prints "cursor visual smoke" and report the output.' \\
    --wait-ms 60000 \\
    --out-dir /tmp/pi-cursor-sdk-visual-review

Exit codes:
  0  capture and required artifacts were written
  1  TUI run, JSONL discovery, HTML render, or screenshot failed
  2  invalid usage or missing prerequisite command
`);
}

function fail(message, code = EXIT_FAILURE) {
	console.error(`[visual-smoke] ${message}`);
	process.exit(code);
}

function timestamp() {
	return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseInteger(value, name) {
	if (!/^\d+$/.test(value)) fail(`${name} must be a positive integer: ${value}`, EXIT_USAGE);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer: ${value}`, EXIT_USAGE);
	return parsed;
}

function readPromptFile(path) {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		fail(`failed to read --prompt-file ${path}: ${error instanceof Error ? error.message : String(error)}`, EXIT_USAGE);
	}
}

function parseMode(value) {
	if (value !== "agent" && value !== "plan") fail(`--mode must be agent or plan: ${value}`, EXIT_USAGE);
	return value;
}

function parseSettingSources(value) {
	if (!value.trim()) fail("--setting-sources requires a non-empty value", EXIT_USAGE);
	return value;
}

function parseArgs(argv) {
	const options = parseArgv(argv, {
		defaults: {
			ext: ROOT,
			cwd: process.cwd(),
			waitMs: DEFAULT_WAIT_MS,
			startupMs: DEFAULT_STARTUP_MS,
			model: DEFAULT_MODEL,
			mode: DEFAULT_MODE,
			settingSources: DEFAULT_SETTING_SOURCES,
			bridge: false,
			exposeBuiltinTools: false,
			leftoverPatterns: [],
			width: DEFAULT_WIDTH,
			height: DEFAULT_HEIGHT,
			historyLines: DEFAULT_HISTORY_LINES,
			eventDebug: false,
			screenshot: true,
			selfTest: false,
		},
		flags: {
			label: { names: ["--label"] },
			prompt: { names: ["--prompt", "--prompt-file"], allowDashValue: true, assign: (value, flagName) => (flagName === "--prompt-file" ? readPromptFile(value) : value) },
			ext: { names: ["--ext"], assign: (value) => resolve(value) },
			cwd: { names: ["--cwd"], assign: (value) => resolve(value) },
			outDir: { names: ["--out-dir"], assign: (value) => resolve(value) },
			waitMs: { names: ["--wait-ms"], assign: (value) => parseInteger(value, "--wait-ms") },
			startupMs: { names: ["--startup-ms"], assign: (value) => parseInteger(value, "--startup-ms") },
			model: { names: ["--model"] },
			mode: { names: ["--mode"], assign: parseMode },
			sessionDir: { names: ["--session-dir"], assign: (value) => resolve(value) },
			sessionId: { names: ["--session-id"] },
			width: { names: ["--width"], assign: (value) => parseInteger(value, "--width") },
			height: { names: ["--height"], assign: (value) => parseInteger(value, "--height") },
			historyLines: { names: ["--history-lines"], assign: (value) => parseInteger(value, "--history-lines") },
			settingSources: { names: ["--setting-sources"], assign: parseSettingSources },
			bridge: commonBooleanFlag("--bridge"),
			exposeBuiltinTools: commonBooleanFlag("--expose-builtin-tools"),
			eventDebug: commonBooleanFlag("--event-debug"),
			leftoverPatterns: { ...commonRepeatStringFlag("--leftover-pattern"), allowDashValue: true },
			screenshot: { ...commonBooleanFlag("--no-screenshot"), assign: () => false },
			selfTest: commonBooleanFlag("--self-test"),
		},
		fail: (message) => fail(message, EXIT_USAGE),
	});

	if (options.help) {
		printHelp();
		process.exit(0);
	}
	if (options.selfTest) return options;
	if (!options.label?.trim()) fail("--label is required", EXIT_USAGE);
	if (!options.prompt?.trim()) fail("--prompt or --prompt-file is required", EXIT_USAGE);
	if (options.exposeBuiltinTools && !options.bridge) fail("--expose-builtin-tools requires --bridge", EXIT_USAGE);

	options.safeLabel = sanitizeLabel(options.label);
	options.outDir ??= resolve(`/tmp/pi-cursor-sdk-visual-smoke-${timestamp()}`);
	options.sessionDir ??= resolve(options.outDir, `${options.safeLabel}.session`);
	options.agentDir ??= resolve(options.outDir, "pi-agent");
	return options;
}

function seedVisualAgentDir(agentDir) {
	mkdirSync(agentDir, { recursive: true });
	const srcAuth = join(homedir(), ".pi", "agent", "auth.json");
	const destAuth = join(agentDir, "auth.json");
	try {
		copyFileSync(srcAuth, destAuth);
		chmodSync(destAuth, 0o600);
	} catch {
		// CURSOR_API_KEY remains the fallback when host auth.json is absent.
	}
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ quietStartup: true, enableInstallTelemetry: false })}\n`,
	);
}

function sanitizeLabel(label) {
	const safe = label.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe || "visual-smoke";
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: options.input === undefined ? "utf8" : undefined,
		env: options.env,
		input: options.input,
		stdio: options.stdio ?? (options.input === undefined ? "pipe" : ["pipe", "pipe", "pipe"]),
	});
	if (result.error) {
		throw result.error;
	}
	return result;
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
	if (!command.trim()) fail("empty command name", EXIT_USAGE);
	if (command.includes("/")) {
		const path = resolve(command);
		if (!isExecutable(path)) fail(`${command} is not executable`, EXIT_USAGE);
		return path;
	}
	for (const entry of envPath.split(delimiter)) {
		if (!entry) continue;
		const candidate = resolve(entry, command);
		if (isExecutable(candidate)) return candidate;
	}
	fail(`${command} is required on PATH`, EXIT_USAGE);
}

function requireCommand(command, options = {}) {
	const path = resolveCommand(command, options.envPath ?? process.env.PATH ?? "");
	const args = command === "tmux" ? ["-V"] : ["--version"];
	const result = run(path, args, { env: options.env });
	if (result.status !== 0) fail(`${command} failed prerequisite check at ${path}`, EXIT_USAGE);
	return path;
}

function requireNode() {
	const path = process.execPath;
	if (!path || !isExecutable(path)) fail(`current Node executable is not executable: ${path || "<empty>"}`, EXIT_USAGE);
	return path;
}

function resolveShell(shell) {
	if (shell.startsWith("/")) {
		if (!isExecutable(shell)) fail(`shell is not executable: ${shell}`, EXIT_USAGE);
		return shell;
	}
	return resolveCommand(shell);
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeUtf8(path, text) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf8");
}

function capturePane(tmuxBin, sessionName, args) {
	const result = run(tmuxBin, ["capture-pane", ...args, "-t", sessionName]);
	if (result.status !== 0) {
		throw new Error(result.stderr?.toString().trim() || `tmux capture-pane exited ${result.status}`);
	}
	return result.stdout.toString();
}

function collectJsonlMtimes(root) {
	const files = [];
	function visit(dir) {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				visit(path);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push({ path, mtimeMs: statSync(path).mtimeMs });
			}
		}
	}
	visit(root);
	return files;
}

function snapshotJsonlMtimes(root) {
	return new Map(collectJsonlMtimes(root).map(({ path, mtimeMs }) => [path, mtimeMs]));
}

function findLatestJsonl(root, { sinceMs = 0, previousMtimes = new Map() } = {}) {
	const matches = [];
	for (const file of collectJsonlMtimes(root)) {
		const previousMtimeMs = previousMtimes.get(file.path);
		if (previousMtimeMs === undefined ? file.mtimeMs >= sinceMs : file.mtimeMs > previousMtimeMs) matches.push(file);
	}
	matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return matches[0]?.path;
}

function checkLeftovers(patterns) {
	if (patterns.length === 0) return;
	const result = run("ps", ["-axo", "pid,etime,command"]);
	if (result.status !== 0) {
		throw new Error(`failed to inspect leftover processes: ${result.stderr?.toString().trim() || result.status}`);
	}
	const lines = result.stdout
		.toString()
		.split("\n")
		.filter((line) => line.trim() && !line.includes("scripts/visual-tui-smoke.mjs") && !line.includes("--leftover-pattern"));
	const matches = [];
	for (const pattern of patterns) {
		let regex;
		try {
			regex = new RegExp(pattern);
		} catch (error) {
			throw new Error(`invalid --leftover-pattern ${pattern}: ${error instanceof Error ? error.message : String(error)}`);
		}
		for (const line of lines) {
			if (regex.test(line)) matches.push(line.trim());
		}
	}
	if (matches.length > 0) {
		throw new Error(`leftover process pattern matched after visual smoke:\n${matches.join("\n")}`);
	}
}

function buildLaunchPlan(options, commands, shell) {
	const smokeEnvPlan = buildCursorSmokeEnvPlan({
		baseEnv: process.env,
		nodePath: commands.node,
		settingSources: options.settingSources,
		nativeToolDisplay: true,
		registerNativeTools: true,
		bridge: options.bridge,
		exposeBuiltinTools: options.exposeBuiltinTools,
		term: "xterm-256color",
		eventDebugDir: options.eventDebug ? resolve(options.outDir, `${options.safeLabel ?? "visual-smoke"}.cursor-sdk-events`) : undefined,
	});
	const sealedPath = commands.sealedPath ?? smokeEnvPlan.sealedPath;
	const agentDir = options.agentDir ?? resolve(options.outDir, "pi-agent");
	const envAssignments = [
		...smokeEnvPlan.envEntries,
		["PI_CODING_AGENT_DIR", agentDir],
		["PI_OFFLINE", "1"],
		["PI_SKIP_VERSION_CHECK", "1"],
	];
	const clearEnvNames = smokeEnvPlan.clearEnvNames;
	const command = [
		...envAssignments.map(([name, value]) => `${name}=${shellQuote(value)}`),
		"exec",
		shellQuote(commands.pi),
		"--approve",
		"-e", shellQuote(options.ext),
		"--cursor-no-fast",
		"--cursor-mode", shellQuote(options.mode),
		"--session-dir", shellQuote(options.sessionDir),
		...(options.sessionId ? ["--session-id", shellQuote(options.sessionId)] : []),
		"--model", shellQuote(options.model),
	].join(" ");
	const clearLines = clearEnvNames.map((name) => `unset ${name}`).join("\n");
	const script = [
		`export PATH=${shellQuote(sealedPath)}`,
		clearLines,
		`cd ${shellQuote(options.cwd)} || exit 97`,
		command,
	]
		.filter(Boolean)
		.join("\n");
	return { command, clearEnvNames, envAssignments, script, shell };
}

function runVisualSmoke(options) {
	const node = requireNode();
	const sealedPath = sealedNodePath(node);
	const commands = {
		pi: requireCommand("pi", { env: { ...process.env, PATH: sealedPath } }),
		node,
		sealedPath,
		tmux: requireCommand("tmux"),
	};

	mkdirSync(options.outDir, { recursive: true });
	mkdirSync(options.sessionDir, { recursive: true });
	options.agentDir ??= resolve(options.outDir, "pi-agent");
	seedVisualAgentDir(options.agentDir);

	const sessionName = `pi-visual-${options.safeLabel}-${process.pid}`;
	const bufferName = `pi-visual-prompt-${process.pid}`;
	const shell = resolveShell(process.env.SHELL || "/bin/bash");
	const { script } = buildLaunchPlan(options, commands, shell);

	console.log(`[visual-smoke] out-dir=${options.outDir}`);
	console.log(`[visual-smoke] session-dir=${options.sessionDir}`);
	console.log(`[visual-smoke] tmux-session=${sessionName}`);
	console.log(`[visual-smoke] pi=${commands.pi}`);
	console.log(`[visual-smoke] node=${commands.node}`);
	console.log(`[visual-smoke] tmux=${commands.tmux}`);
	console.log(
		`[visual-smoke] native-replay-only=${!options.bridge && !options.exposeBuiltinTools && options.settingSources === DEFAULT_SETTING_SOURCES ? "true" : "false"}`,
	);

	let sessionStarted = false;
	let bufferLoaded = false;
	const jsonlMtimesBeforeRun = snapshotJsonlMtimes(options.sessionDir);
	const runStartedAtMs = Date.now();
	try {
		const start = run(commands.tmux, [
			"new-session",
			"-d",
			"-s",
			sessionName,
			"-c",
			options.cwd,
			"-x",
			String(options.width),
			"-y",
			String(options.height),
			"--",
			shell,
			"-c",
			script,
		]);
		if (start.status !== 0) throw new Error(`tmux new-session failed: ${start.stderr?.toString().trim() || start.status}`);
		sessionStarted = true;

		sleep(options.startupMs);
		const load = run(commands.tmux, ["load-buffer", "-b", bufferName, "-"], { input: Buffer.from(options.prompt, "utf8") });
		if (load.status !== 0) throw new Error(`tmux load-buffer failed: ${load.stderr?.toString().trim() || load.status}`);
		bufferLoaded = true;
		try {
			const paste = run(commands.tmux, ["paste-buffer", "-b", bufferName, "-t", sessionName]);
			if (paste.status !== 0) throw new Error(`tmux paste-buffer failed: ${paste.stderr?.toString().trim() || paste.status}`);
			// Give bracketed paste handling a moment to finish before submitting.
			sleep(250);
			const enter = run(commands.tmux, ["send-keys", "-t", sessionName, "Enter"]);
			if (enter.status !== 0) throw new Error(`tmux send-keys failed: ${enter.stderr?.toString().trim() || enter.status}`);
		} finally {
			run(commands.tmux, ["delete-buffer", "-b", bufferName]);
			bufferLoaded = false;
		}

		sleep(options.waitMs);

		const historyStart = `-${options.historyLines}`;
		const ansi = capturePane(commands.tmux, sessionName, ["-e", "-p", "-S", historyStart]);
		const plain = capturePane(commands.tmux, sessionName, ["-p", "-S", historyStart]);

		const base = resolve(options.outDir, options.safeLabel);
		const ansiPath = `${base}.ansi`;
		const textPath = `${base}.txt`;
		const htmlPath = `${base}.html`;
		const pngPath = `${base}.png`;
		const jsonlPathFile = `${base}.jsonl.path`;
		const manifestPath = `${base}.manifest.json`;

		writeUtf8(ansiPath, ansi);
		writeUtf8(textPath, plain);
		writeUtf8(htmlPath, buildTerminalHtml({ ansi, plain, options }));

		const partialArtifacts = { ansiPath, textPath, htmlPath, pngPath, jsonlPathFile, manifestPath };
		const jsonlPath = findLatestJsonl(options.sessionDir, { sinceMs: runStartedAtMs, previousMtimes: jsonlMtimesBeforeRun });
		if (!jsonlPath) {
			const message = `no current-run persisted .jsonl found under ${options.sessionDir}`;
			writeVisualManifest(manifestPath, options, partialArtifacts, { message, writtenAt: new Date().toISOString() });
			throw new Error(message);
		}
		writeUtf8(jsonlPathFile, `${jsonlPath}\n`);

		return { ...partialArtifacts, jsonlPath };
	} finally {
		if (bufferLoaded) run(commands.tmux, ["delete-buffer", "-b", bufferName]);
		if (sessionStarted) run(commands.tmux, ["kill-session", "-t", sessionName]);
	}
}


const options = parseArgs(process.argv.slice(2));
let artifacts;
try {
	if (options.selfTest) {
		runVisualSmokeSelfTest({
			ROOT,
			DEFAULT_MODE,
			DEFAULT_MODEL,
			DEFAULT_SETTING_SOURCES,
			DEBUG_ENV_NAMES,
			shellQuote,
			parseArgs,
			snapshotJsonlMtimes,
			findLatestJsonl,
			sealedNodePath,
			resolveCommand,
			requireNode,
			requireCommand,
			buildLaunchPlan,
			run,
			runVisualSmoke,
		});
		process.exit(0);
	}
	artifacts = runVisualSmoke(options);
	writeVisualManifest(artifacts.manifestPath, options, artifacts);
	checkLeftovers(options.leftoverPatterns);
	if (options.screenshot) {
		await writeTerminalScreenshot(artifacts.htmlPath, artifacts.pngPath, options.width, options.height);
		artifacts.pngWritten = true;
		writeVisualManifest(artifacts.manifestPath, options, artifacts);
	}
	console.log("[visual-smoke] artifacts:");
	console.log(`  ansi:       ${artifacts.ansiPath}`);
	console.log(`  text:       ${artifacts.textPath}`);
	console.log(`  html:       ${artifacts.htmlPath}`);
	if (options.screenshot) console.log(`  png:        ${artifacts.pngPath}`);
	console.log(`  jsonl.path: ${artifacts.jsonlPathFile}`);
	console.log(`  jsonl:      ${artifacts.jsonlPath}`);
	console.log(`  manifest:  ${artifacts.manifestPath}`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (artifacts?.manifestPath) {
		try {
			writeVisualManifest(artifacts.manifestPath, options, artifacts, { message, writtenAt: new Date().toISOString() });
		} catch {
			// Preserve the original failure.
		}
	}
	fail(message);
}
