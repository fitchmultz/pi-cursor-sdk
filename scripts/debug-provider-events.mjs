#!/usr/bin/env node
/**
 * Maintainer probe: run one prompt through pi's Cursor provider and capture raw SDK callbacks.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CURSOR_SETTING_SOURCES_ENV,
	resolveCursorSettingSources,
	scrubSensitiveText,
} from "./lib/cursor-probe-utils.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = require("../package.json");
const DEFAULT_MODEL = "cursor/composer-2.5";
const DEFAULT_OUT_BASE = ".debug/cursor-sdk-events";
const CHILD_SHUTDOWN_GRACE_MS = 2_000;
const SDK_EVENT_DEBUG_LOG_PREFIX = "[pi-cursor-sdk:sdk-events]";

function readSdkVersion() {
	try {
		const sdkEntry = require.resolve("@cursor/sdk");
		const sdkPackagePath = join(dirname(sdkEntry), "../../package.json");
		return JSON.parse(readFileSync(sdkPackagePath, "utf8")).version;
	} catch {
		return "unknown";
	}
}

function printHelp() {
	console.log(`Capture raw Cursor SDK onDelta/onStep payloads through pi's provider path.

Usage:
  CURSOR_API_KEY=... npm run debug:provider-events -- [options]
  node scripts/debug-provider-events.mjs [options]

Options:
  --cwd <path>                 Working directory for pi and artifacts. Default: repo root.
  --model <id>                 pi model id. Default: ${DEFAULT_MODEL}.
  --prompt <text>              Required user prompt for the run.
  --prompt-file <path>         Read prompt text from a file instead of --prompt.
  --out <dir>                  Artifact directory. Default: ${DEFAULT_OUT_BASE}/<timestamp> under --cwd.
  --setting-sources <value>    Cursor setting sources (comma-separated, all, or none).
                               Default: PI_CURSOR_SETTING_SOURCES env, otherwise all.
  --session-dir <path>         pi session directory. Default: <out>/session.
  --api-key <key>              Cursor API key. Prefer CURSOR_API_KEY to avoid shell history.
  -h, --help                   Show this help.

Artifacts (gitignored when under .debug/):
  metadata.json                Model, cwd, send plan metadata.
  on-delta.jsonl               Raw InteractionUpdate payloads from agent.send(onDelta).
  on-step.jsonl                Raw onStep payloads from agent.send(onStep).
  wait-result.json             run.wait() result object.
  summary.json                 Counts and artifact paths.

Stdout:
  Prints one JSON summary line on success. Raw payloads stay on disk only.

Exit codes:
  0  capture completed
  1  invalid arguments, missing auth, pi failure, or missing capture summary

Safety:
  - Never prints CURSOR_API_KEY or --api-key values.
  - Raw artifact files may contain local paths, tool args/results, or secrets. Do not commit or share them.`);
}

function fail(message, secrets = []) {
	const scrubbed = scrubSensitiveText(message, secrets[0]);
	console.error(`debug-provider-events: ${scrubbed}`);
	process.exit(1);
}

export function parseDebugProviderEventsArgs(argv, env = process.env) {
	const args = {
		cwd: root,
		model: DEFAULT_MODEL,
		prompt: undefined,
		promptFile: undefined,
		out: undefined,
		settingSources: resolveCursorSettingSources(env[CURSOR_SETTING_SOURCES_ENV]),
		sessionDir: undefined,
		apiKey: env.CURSOR_API_KEY?.trim() || undefined,
		help: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") {
			args.help = true;
			continue;
		}
		if (arg === "--cwd") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--cwd requires a path");
			args.cwd = resolve(value);
			continue;
		}
		if (arg.startsWith("--cwd=")) {
			args.cwd = resolve(arg.slice("--cwd=".length));
			continue;
		}
		if (arg === "--model") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--model requires a value");
			args.model = value.trim();
			continue;
		}
		if (arg.startsWith("--model=")) {
			args.model = arg.slice("--model=".length).trim();
			continue;
		}
		if (arg === "--prompt") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--prompt requires a value");
			args.prompt = value;
			continue;
		}
		if (arg.startsWith("--prompt=")) {
			args.prompt = arg.slice("--prompt=".length);
			continue;
		}
		if (arg === "--prompt-file") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--prompt-file requires a path");
			args.promptFile = resolve(value);
			continue;
		}
		if (arg.startsWith("--prompt-file=")) {
			args.promptFile = resolve(arg.slice("--prompt-file=".length));
			continue;
		}
		if (arg === "--out") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--out requires a directory path");
			args.out = resolve(value);
			continue;
		}
		if (arg.startsWith("--out=")) {
			args.out = resolve(arg.slice("--out=".length));
			continue;
		}
		if (arg === "--session-dir") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--session-dir requires a path");
			args.sessionDir = resolve(value);
			continue;
		}
		if (arg.startsWith("--session-dir=")) {
			args.sessionDir = resolve(arg.slice("--session-dir=".length));
			continue;
		}
		if (arg === "--setting-sources") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--setting-sources requires a value");
			args.settingSources = resolveCursorSettingSources(value);
			continue;
		}
		if (arg.startsWith("--setting-sources=")) {
			args.settingSources = resolveCursorSettingSources(arg.slice("--setting-sources=".length));
			continue;
		}
		if (arg === "--api-key") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--api-key requires a value");
			args.apiKey = value.trim();
			continue;
		}
		if (arg.startsWith("--api-key=")) {
			args.apiKey = arg.slice("--api-key=".length).trim();
			continue;
		}
		fail(`unknown argument: ${arg}`);
	}
	return args;
}

function defaultOutDir(cwd) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(cwd, DEFAULT_OUT_BASE, stamp);
}

function parseEvents(stdout) {
	const events = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// ignore partial lines
		}
	}
	return events;
}

function waitForChildClose(child) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode ?? 1);
	return new Promise((resolve) => {
		child.once("close", (code) => resolve(code ?? 1));
	});
}

function signalChild(child, signal) {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") {
			child.kill(signal);
		} else {
			process.kill(-child.pid, signal);
		}
	} catch {
		try {
			child.kill(signal);
		} catch {
			// child already exited
		}
	}
}

async function terminateChild(child) {
	child.stdin.destroy();
	if (child.exitCode !== null || child.signalCode !== null) return;
	signalChild(child, "SIGTERM");
	const killTimer = setTimeout(() => signalChild(child, "SIGKILL"), CHILD_SHUTDOWN_GRACE_MS);
	try {
		await waitForChildClose(child);
	} finally {
		clearTimeout(killTimer);
	}
}

function readCaptureSummary(artifactDir, stderr) {
	const summaryPath = join(artifactDir, "summary.json");
	try {
		return JSON.parse(readFileSync(summaryPath, "utf8"));
	} catch {
		for (const line of stderr.split("\n").reverse()) {
			const markerIndex = line.indexOf(SDK_EVENT_DEBUG_LOG_PREFIX);
			if (markerIndex === -1) continue;
			const payload = line.slice(markerIndex + SDK_EVENT_DEBUG_LOG_PREFIX.length).trim();
			try {
				return JSON.parse(payload);
			} catch {
				// keep scanning
			}
		}
	}
	return undefined;
}

export async function runDebugProviderEvents(args) {
	if (args.promptFile) {
		args.prompt = readFileSync(args.promptFile, "utf8");
	}
	if (!args.prompt?.trim()) fail("--prompt or --prompt-file is required");
	if (!args.apiKey) fail("CURSOR_API_KEY or --api-key is required");

	const artifactDir = args.out ?? defaultOutDir(args.cwd);
	const sessionDir = args.sessionDir ?? join(artifactDir, "session");
	mkdirSync(artifactDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	const piArgs = [
		"-e",
		root,
		"--cursor-no-fast",
		"--model",
		args.model,
		"--mode",
		"rpc",
		"--session-dir",
		sessionDir,
	];
	const env = {
		...process.env,
		CURSOR_API_KEY: args.apiKey,
		PI_CURSOR_SDK_EVENT_DEBUG: "1",
		PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR: artifactDir,
		PI_CURSOR_SETTING_SOURCES: args.settingSources?.join(",") ?? "all",
		PI_CURSOR_NATIVE_TOOL_DISPLAY: envFlag(process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY, "1"),
		PI_CURSOR_PI_TOOL_BRIDGE: envFlag(process.env.PI_CURSOR_PI_TOOL_BRIDGE, "1"),
	};

	const child = spawn("pi", piArgs, {
		cwd: args.cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
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
		if (!child.stdin.writable) fail("pi stdin closed before prompt could be sent");
		child.stdin.write(`${JSON.stringify(obj)}\n`);
	};

	try {
		send({ type: "prompt", message: args.prompt });
		await new Promise((resolve, reject) => {
			const timeoutMs = Number(process.env.PI_PROVIDER_EVENT_DEBUG_TIMEOUT_MS ?? 600_000);
			const start = Date.now();
			const tick = () => {
				const events = parseEvents(stdout);
				if (events.some((event) => event.type === "agent_end")) {
					resolve(events);
					return;
				}
				if (Date.now() - start > timeoutMs) {
					reject(new Error(`timeout after ${timeoutMs}ms`));
					return;
				}
				setTimeout(tick, 250);
			};
			tick();
		});
		child.stdin.end();
		const exitCode = await waitForChildClose(child);
		closed = true;
		if (exitCode !== 0) {
			fail(`pi exited ${exitCode}\nstderr=${scrubSensitiveText(stderr.slice(-2000), args.apiKey)}`, [args.apiKey]);
		}

		const captureSummary = readCaptureSummary(artifactDir, stderr);
		if (!captureSummary?.artifactDir) {
			fail(`missing summary.json in ${artifactDir}`, [args.apiKey]);
		}

		return {
			artifactDir: captureSummary.artifactDir,
			artifacts: captureSummary.artifacts,
			counts: captureSummary.counts,
			elapsedMs: captureSummary.elapsedMs,
			model: args.model,
			cwd: args.cwd,
			sessionDir,
			extensionVersion: packageJson.version,
			sdkVersion: readSdkVersion(),
			waitResultRecorded: captureSummary.waitResultRecorded,
		};
	} finally {
		if (!closed) await terminateChild(child);
	}
}

function envFlag(raw, defaultValue) {
	if (raw === undefined || raw === "") return defaultValue;
	return raw;
}

async function main(argv = process.argv.slice(2), env = process.env) {
	const args = parseDebugProviderEventsArgs(argv, env);
	if (args.help) {
		printHelp();
		return;
	}
	console.log(JSON.stringify(await runDebugProviderEvents(args)));
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
