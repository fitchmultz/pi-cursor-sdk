#!/usr/bin/env node
/**
 * Maintainer probe: measure Cursor SDK cold-start timing with/without ambient MCP settings
 * and with the pi-cursor-sdk MCP connect timeout override installed.
 */
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
	installCursorMcpToolTimeoutOverride,
	restoreCursorMcpToolTimeoutOverride,
} from "../src/cursor-mcp-timeout-override.ts";
import { apiKeySecretsFromProcess, defaultApiKeyFromEnv, parseArgv } from "./lib/cursor-cli-args.mjs";
import { scrubSensitiveText } from "../shared/cursor-sensitive-text.mjs";
import { createScriptFail } from "./lib/cursor-script-fail.mjs";
import { installCursorSdkOutputFilter, suppressCursorSdkOutput } from "./lib/cursor-sdk-output-filter.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function isMainModule() {
	if (!process.argv[1]) return false;
	const invoked = resolve(process.argv[1]);
	return SCRIPT_PATH === invoked;
}
const SCENARIOS = [
	{ label: "with-all-settings", settingSources: ["all"] },
	{ label: "with-all-settings+connect-override", settingSources: ["all"], installConnectOverride: true },
	{ label: "no-setting-sources", settingSources: undefined },
];

function printHelp() {
	console.log(`Measure Cursor SDK first-send MCP cold-start timing.

Usage:
  CURSOR_API_KEY=... npm run debug:mcp-coldstart
  node scripts/probe-mcp-coldstart.mjs [options]

Options:
  --api-key <key>     Cursor API key. Prefer CURSOR_API_KEY to avoid shell history.
  --scenario <label>  Run one scenario in this process. Used by the orchestrator.
  -h, --help          Show this help without importing or calling the Cursor SDK.

Stdout:
  Emits one JSON object per scenario. Human status lines go to stderr.

Scenarios:
  with-all-settings                   Cursor settingSources=["all"]
  with-all-settings+connect-override  Same, with pi-cursor-sdk timeout override installed
  no-setting-sources                  No explicit settingSources

Safety:
  - --help never performs live Cursor calls.
  - Each default scenario runs in a fresh child process before its first Cursor SDK import.
  - SDK startup noise is suppressed.
  - Error messages are scrubbed for API keys, bearer tokens, cookies, and bridge endpoints.`);
}

const exitWithFailure = createScriptFail("probe-mcp-coldstart");

function fail(message, secrets) {
	const secretList = secrets === undefined ? [] : Array.isArray(secrets) ? secrets : [secrets];
	exitWithFailure(message, secretList.filter(Boolean));
}

function findScenario(label) {
	return SCENARIOS.find((scenario) => scenario.label === label);
}

function parseArgs(argv, env = process.env) {
	const args = parseArgv(argv, {
		defaults: {
			apiKey: defaultApiKeyFromEnv(env),
			scenario: undefined,
		},
		flags: {
			apiKey: { names: ["--api-key"], assign: (value) => value.trim() },
			scenario: { names: ["--scenario"], assign: (value) => value.trim() },
		},
		fail: (message) => fail(message, defaultApiKeyFromEnv(env)),
	});
	if (args.scenario && !findScenario(args.scenario)) {
		fail(`unknown scenario: ${args.scenario}`, args.apiKey);
	}
	return args;
}

async function probe(Agent, apiKey, label, { settingSources, installConnectOverride = false } = {}) {
	let agent;
	try {
		const marks = [];
		const t0 = performance.now();
		const mark = (name) => marks.push({ name, ms: Math.round(performance.now() - t0) });

		mark("start");
		agent = await suppressCursorSdkOutput(() =>
			Agent.create({
				apiKey,
				model: { id: "composer-2.5" },
				local: settingSources
					? { cwd: process.cwd(), settingSources }
					: { cwd: process.cwd() },
			}),
		);
		mark("agent.create");

		let firstDeltaMs;
		const run = await suppressCursorSdkOutput(() =>
			agent.send("Reply with exactly: pong", {
				onDelta: ({ update }) => {
					if (firstDeltaMs === undefined && update.type === "text-delta") {
						firstDeltaMs = Math.round(performance.now() - t0);
						mark("first-delta");
					}
				},
			}),
		);
		mark("agent.send-returned");

		const result = await suppressCursorSdkOutput(() => run.wait());
		mark("run.wait");

		await suppressCursorSdkOutput(() => agent[Symbol.asyncDispose]());
		agent = undefined;
		mark("dispose");

		const sendReturnedMs = marks.find((entry) => entry.name === "agent.send-returned")?.ms;
		const mcpBlockingMs =
			firstDeltaMs !== undefined && sendReturnedMs !== undefined ? firstDeltaMs - sendReturnedMs : undefined;

		return {
			label,
			settingSources: settingSources ?? null,
			installConnectOverride,
			marks,
			firstDeltaMs,
			mcpBlockingMs,
			status: result.status,
			text: typeof result.result === "string" ? result.result.slice(0, 120) : null,
		};
	} finally {
		if (agent) {
			await suppressCursorSdkOutput(() => agent[Symbol.asyncDispose]()).catch(() => undefined);
		}
	}
}

async function runScenarioInThisProcess(args, scenario) {
	const restoreOutputFilter = installCursorSdkOutputFilter();
	try {
		if (scenario.installConnectOverride) {
			const state = installCursorMcpToolTimeoutOverride();
			console.error(
				`probe-mcp-coldstart: installed connect override (${state.connectTimeoutMs}ms initialize/listTools, ${state.timeoutMs}ms callTool)`,
			);
		}
		const { Agent } = await suppressCursorSdkOutput(() => import("@cursor/sdk"));
		console.log(JSON.stringify(await probe(Agent, args.apiKey, scenario.label, scenario)));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.log(
			JSON.stringify({
				label: scenario.label,
				error: scrubSensitiveText(message, args.apiKey),
			}),
		);
	} finally {
		restoreCursorMcpToolTimeoutOverride();
		restoreOutputFilter();
	}
}

function runScenarioChild(args, scenario) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [SCRIPT_PATH, "--scenario", scenario.label], {
			cwd: process.cwd(),
			env: { ...process.env, CURSOR_API_KEY: args.apiKey },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			stderr += error instanceof Error ? error.message : String(error);
		});
		child.on("close", (code) => {
			const scrubbedStderr = scrubSensitiveText(stderr, args.apiKey);
			if (scrubbedStderr) process.stderr.write(scrubbedStderr.endsWith("\n") ? scrubbedStderr : `${scrubbedStderr}\n`);
			if (code === 0 && stdout.trim()) {
				process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
				resolve();
				return;
			}
			const error = scrubbedStderr.trim() || `child process exited with code ${code ?? "unknown"}`;
			console.log(JSON.stringify({ label: scenario.label, error }));
			resolve();
		});
	});
}

async function main(argv = process.argv.slice(2), env = process.env) {
	const args = parseArgs(argv, env);
	if (args.help) {
		printHelp();
		return;
	}
	if (!args.apiKey) {
		fail("CURSOR_API_KEY is required. Set CURSOR_API_KEY or pass --api-key.");
	}

	const scenario = args.scenario ? findScenario(args.scenario) : undefined;
	if (scenario) {
		await runScenarioInThisProcess(args, scenario);
		return;
	}

	for (const scenarioToRun of SCENARIOS) {
		await runScenarioChild(args, scenarioToRun);
	}
}

if (isMainModule()) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		fail(message, apiKeySecretsFromProcess());
	});
}
