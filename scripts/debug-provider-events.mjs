#!/usr/bin/env node
/**
 * Maintainer probe: run one prompt through pi's Cursor provider and capture raw SDK callbacks.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	apiKeySecretsFromProcess,
	commonProbeFlags,
	defaultApiKeyFromEnv,
	defaultSettingSourcesFromEnv,
	parseArgv,
	requireApiKey,
} from "./lib/cursor-cli-args.mjs";
import {
	CHILD_PROCESS_TREE_SPAWN_OPTIONS,
	parseJsonLines,
	terminateChild,
	waitForChildClose,
} from "./lib/cursor-child-process.mjs";
import { scrubSensitiveText } from "../shared/cursor-sensitive-text.mjs";
import { createScriptFail } from "./lib/cursor-script-fail.mjs";
import { ensureBuilt } from "./lib/ensure-built.mjs";
import { serializeCursorSettingSources } from "../shared/cursor-setting-sources.mjs";

function isMainModule() {
	if (!process.argv[1]) return false;
	const current = fileURLToPath(import.meta.url);
	const invoked = resolve(process.argv[1]);
	return process.platform === "win32" ? current.toLowerCase() === invoked.toLowerCase() : current === invoked;
}

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = require("../package.json");
const DEFAULT_MODEL = "cursor/composer-2-5";
const DEFAULT_OUT_BASE = ".debug/cursor-sdk-events";
const SDK_EVENT_DEBUG_LOG_PREFIX = "[pi-cursor-sdk:sdk-events]";
const PI_SESSION_SNAPSHOT_ARTIFACT = "pi-session-snapshot.jsonl";
const SESSION_PI_SESSION_SNAPSHOT = "pi-session.jsonl";
const SUMMARY_ARTIFACT = "summary.json";

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

const fail = createScriptFail("debug-provider-events");

export function parseDebugProviderEventsArgs(argv, env = process.env) {
	return parseArgv(argv, {
		defaults: {
			cwd: root,
			model: DEFAULT_MODEL,
			prompt: undefined,
			promptFile: undefined,
			out: undefined,
			settingSources: defaultSettingSourcesFromEnv(env),
			sessionDir: undefined,
			apiKey: defaultApiKeyFromEnv(env),
		},
		flags: {
			cwd: commonProbeFlags.cwd,
			model: commonProbeFlags.model,
			prompt: commonProbeFlags.prompt,
			promptFile: commonProbeFlags.promptFile,
			out: commonProbeFlags.out,
			sessionDir: commonProbeFlags.sessionDir,
			apiKey: commonProbeFlags.apiKey,
			settingSources: commonProbeFlags.settingSources,
		},
		fail,
	});
}

function defaultOutDir(cwd) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(cwd, DEFAULT_OUT_BASE, stamp);
}

function readCaptureSummary(artifactDir, stderr) {
	const summaryPath = join(artifactDir, SUMMARY_ARTIFACT);
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

function assertCompleteCaptureSummary(captureSummary, artifactDir, apiKey) {
	if (!captureSummary?.artifactDir) {
		fail(`missing summary.json in ${artifactDir}`, [apiKey]);
	}
	if (!captureSummary.artifacts || typeof captureSummary.artifacts !== "object") {
		fail(`summary.json missing artifacts in ${artifactDir}`, [apiKey]);
	}
	if (!captureSummary.counts || typeof captureSummary.counts !== "object") {
		fail(`summary.json missing counts in ${artifactDir}`, [apiKey]);
	}
	if (typeof captureSummary.elapsedMs !== "number") {
		fail(`summary.json missing elapsedMs in ${artifactDir}`, [apiKey]);
	}
	if (typeof captureSummary.waitResultRecorded !== "boolean") {
		fail(`summary.json missing waitResultRecorded in ${artifactDir}`, [apiKey]);
	}
	return captureSummary;
}

export function backfillPiSessionSnapshot(captureSummary, artifactDir, sessionDir) {
	const sessionFile = captureSummary?.piSessionSnapshot?.sessionFile ?? captureSummary?.sessionFile;
	if (!captureSummary || captureSummary.piSessionSnapshot?.copied || !sessionFile || !existsSync(sessionFile)) {
		return captureSummary;
	}
	try {
		copyFileSync(sessionFile, join(artifactDir, PI_SESSION_SNAPSHOT_ARTIFACT));
		if (sessionDir) {
			copyFileSync(sessionFile, join(sessionDir, SESSION_PI_SESSION_SNAPSHOT));
		}
		const updated = {
			...captureSummary,
			piSessionSnapshot: {
				copied: true,
				sessionFile,
				recoveredAfterChildExit: true,
			},
		};
		writeFileSync(join(artifactDir, SUMMARY_ARTIFACT), `${JSON.stringify(updated, null, 2)}\n`);
		return updated;
	} catch {
		return captureSummary;
	}
}

export async function runDebugProviderEvents(args, envInput = process.env) {
	if (args.promptFile) {
		args.prompt = readFileSync(args.promptFile, "utf8");
	}
	if (!args.prompt?.trim()) fail("--prompt or --prompt-file is required");
	args.apiKey = requireApiKey(args, envInput, fail);

	const artifactDir = args.out ?? defaultOutDir(args.cwd);
	const sessionDir = args.sessionDir ?? join(artifactDir, "session");
	mkdirSync(artifactDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	const piArgs = [
		"--approve",
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
		...envInput,
		CURSOR_API_KEY: args.apiKey,
		PI_CURSOR_SDK_EVENT_DEBUG: "1",
		PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR: artifactDir,
		PI_CURSOR_SETTING_SOURCES: serializeCursorSettingSources(args.settingSources),
		PI_CURSOR_NATIVE_TOOL_DISPLAY: envFlag(envInput.PI_CURSOR_NATIVE_TOOL_DISPLAY, "1"),
		PI_CURSOR_PI_TOOL_BRIDGE: envFlag(envInput.PI_CURSOR_PI_TOOL_BRIDGE, "1"),
	};

	const child = spawn("pi", piArgs, {
		cwd: args.cwd,
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
		if (!child.stdin.writable) fail("pi stdin closed before prompt could be sent");
		child.stdin.write(`${JSON.stringify(obj)}\n`);
	};

	try {
		send({ type: "prompt", message: args.prompt });
		await new Promise((resolve, reject) => {
			const timeoutMs = Number(envInput.PI_PROVIDER_EVENT_DEBUG_TIMEOUT_MS ?? 600_000);
			const start = Date.now();
			const tick = () => {
				const events = parseJsonLines(stdout);
				if (events.some((event) => event.type === "agent_settled")) {
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

		const captureSummary = assertCompleteCaptureSummary(
			backfillPiSessionSnapshot(readCaptureSummary(artifactDir, stderr), artifactDir, sessionDir),
			artifactDir,
			args.apiKey,
		);

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
	ensureBuilt();
	console.log(JSON.stringify(await runDebugProviderEvents(args, env)));
}

if (isMainModule()) {
	main().catch((error) => {
		fail(error instanceof Error ? error.message : String(error), apiKeySecretsFromProcess());
	});
}
