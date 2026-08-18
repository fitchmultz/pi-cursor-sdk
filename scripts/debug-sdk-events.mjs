#!/usr/bin/env node
/**
 * Maintainer-only Cursor SDK event capture probe.
 * Captures timestamped run.stream(), onDelta, and onStep surfaces for one run.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
	apiKeySecretsFromProcess,
	commonProbeFlags,
	defaultApiKeyFromEnv,
	defaultSettingSourcesFromEnv,
	defaultTimestampedDir,
	parseArgv,
	requireApiKey,
} from "./lib/cursor-cli-args.mjs";
import { createScriptFail } from "./lib/cursor-script-fail.mjs";
import { installCursorSdkOutputFilter, suppressCursorSdkOutput } from "./lib/cursor-sdk-output-filter.mjs";

function isMainModule() {
	if (!process.argv[1]) return false;
	const current = fileURLToPath(import.meta.url);
	const invoked = resolve(process.argv[1]);
	return process.platform === "win32" ? current.toLowerCase() === invoked.toLowerCase() : current === invoked;
}

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

const ARTIFACTS = {
	metadata: "metadata.json",
	streamEvents: "stream-events.jsonl",
	onDelta: "on-delta.jsonl",
	onStep: "on-step.jsonl",
	waitResult: "wait-result.json",
	conversation: "conversation.json",
	summary: "summary.json",
};

const DEFAULT_MODEL = "grok-4.6";
const RAW_ARTIFACT_WARNING =
	"Raw artifact files may contain local paths, project text, tool args/results, or secrets from the workspace. Do not commit or share them.";

function readSdkVersion() {
	try {
		const sdkEntry = require.resolve("@cursor/sdk");
		const sdkPackagePath = join(dirname(sdkEntry), "../../package.json");
		return JSON.parse(readFileSync(sdkPackagePath, "utf8")).version;
	} catch {
		return "unknown";
	}
}

function artifactPath(artifactDir, name) {
	return join(artifactDir, ARTIFACTS[name]);
}

function printHelp() {
	console.log(`Capture timestamped Cursor SDK event timelines for one local run.

Usage:
  CURSOR_API_KEY=... npm run debug:sdk-events -- [options]
  node scripts/debug-sdk-events.mjs [options]

Options:
  --cwd <path>                 Agent working directory. Default: process.cwd().
  --model <id>                 Cursor model id. Default: ${DEFAULT_MODEL}.
  --prompt <text>              Required user prompt for the run.
  --out <dir>                  Artifact directory. Default: /tmp/pi-cursor-sdk-sdk-events-<timestamp>.
  --setting-sources <value>    Comma-separated Cursor setting sources, or all/none.
                               Default: PI_CURSOR_SETTING_SOURCES env, otherwise all.
  --include-conversation       Also capture run.conversation() when supported.
  --api-key <key>              Cursor API key. Prefer CURSOR_API_KEY to avoid shell history.
  -h, --help                   Show this help.

Stdout:
  Prints artifact paths and summary counts only. Raw payloads stay on disk under:
  ${ARTIFACTS.streamEvents} (run.stream()), ${ARTIFACTS.onDelta} (onDelta), ${ARTIFACTS.onStep} (onStep).

Exit codes:
  0  capture completed
  1  invalid arguments, missing auth, or Cursor SDK failure

Safety:
  - Never prints CURSOR_API_KEY or --api-key values.
  - Default artifact root is outside the repo (/tmp/...).
  - ${RAW_ARTIFACT_WARNING}
  - Verify Cursor SDK behavior against the installed @cursor/sdk package and/or
    https://cursor.com/docs/sdk/typescript before drawing integration conclusions.`);
}

const fail = createScriptFail("debug-sdk-events");

export function parseDebugSdkEventsArgs(argv, env = process.env) {
	const includeConversation = argv.includes("--include-conversation");
	const filteredArgv = argv.filter((arg) => arg !== "--include-conversation");
	const args = parseArgv(filteredArgv, {
		defaults: {
			cwd: process.cwd(),
			model: DEFAULT_MODEL,
			prompt: undefined,
			out: undefined,
			settingSources: defaultSettingSourcesFromEnv(env),
			includeConversation,
			apiKey: defaultApiKeyFromEnv(env),
		},
		flags: {
			cwd: commonProbeFlags.cwd,
			model: commonProbeFlags.model,
			prompt: commonProbeFlags.prompt,
			out: commonProbeFlags.out,
			apiKey: commonProbeFlags.apiKey,
			settingSources: commonProbeFlags.settingSources,
		},
		fail,
	});
	return args;
}

function defaultOutDir() {
	return defaultTimestampedDir("pi-cursor-sdk-sdk-events");
}

function eventType(value) {
	if (value && typeof value === "object" && typeof value.type === "string") return value.type;
	return "unknown";
}

export function createTimingTracker() {
	return {
		eventCount: 0,
		firstMs: undefined,
		lastMs: undefined,
		maxGapMs: undefined,
		record(elapsedMs) {
			if (this.eventCount === 0) {
				this.firstMs = elapsedMs;
			} else {
				this.maxGapMs = Math.max(this.maxGapMs ?? 0, elapsedMs - (this.lastMs ?? elapsedMs));
			}
			this.eventCount += 1;
			this.lastMs = elapsedMs;
		},
		snapshot() {
			return {
				eventCount: this.eventCount,
				firstMs: this.firstMs,
				lastMs: this.lastMs,
				maxGapMs: this.maxGapMs,
			};
		},
	};
}

export function createEventJsonlSink(artifactDir, startedAt) {
	const paths = {
		streamEvents: artifactPath(artifactDir, "streamEvents"),
		onDelta: artifactPath(artifactDir, "onDelta"),
		onStep: artifactPath(artifactDir, "onStep"),
	};
	for (const path of Object.values(paths)) {
		writeFileSync(path, "");
	}
	const counts = {
		stream: {},
		onDelta: {},
		onStep: {},
	};
	const timing = {
		stream: createTimingTracker(),
		onDelta: createTimingTracker(),
		onStep: createTimingTracker(),
	};

	function append(pathKey, countKey, recordKey, value) {
		const elapsedMs = Date.now() - startedAt;
		const record = {
			ts: new Date().toISOString(),
			elapsedMs,
			[recordKey]: value,
		};
		appendFileSync(paths[pathKey], `${JSON.stringify(record)}\n`);
		const type = eventType(value);
		counts[countKey][type] = (counts[countKey][type] ?? 0) + 1;
		timing[countKey].record(elapsedMs);
		return record;
	}

	return {
		appendStream: (event) => append("streamEvents", "stream", "event", event),
		appendDelta: (update) => append("onDelta", "onDelta", "update", update),
		appendStep: (step) => append("onStep", "onStep", "step", step),
		getSummaryState() {
			return {
				counts: {
					stream: { ...counts.stream },
					onDelta: { ...counts.onDelta },
					onStep: { ...counts.onStep },
				},
				timing: {
					stream: timing.stream.snapshot(),
					onDelta: timing.onDelta.snapshot(),
					onStep: timing.onStep.snapshot(),
				},
			};
		},
		close() {
			return Promise.resolve();
		},
	};
}

function summarizeConversation(conversation) {
	if (!conversation) return undefined;
	if (Array.isArray(conversation)) return { turnCount: conversation.length };
	return conversation;
}

export function buildSummary({
	artifactDir,
	counts,
	timing,
	waitResult,
	conversation,
	includeConversation,
}) {
	return {
		artifactDir,
		files: {
			metadata: artifactPath(artifactDir, "metadata"),
			streamEvents: artifactPath(artifactDir, "streamEvents"),
			onDelta: artifactPath(artifactDir, "onDelta"),
			onStep: artifactPath(artifactDir, "onStep"),
			waitResult: artifactPath(artifactDir, "waitResult"),
			conversation: includeConversation ? artifactPath(artifactDir, "conversation") : undefined,
		},
		counts,
		timing,
		wait: waitResult
			? {
					status: waitResult.status,
					durationMs: waitResult.durationMs,
					hasResultText: Boolean(waitResult.result?.trim()),
				}
			: undefined,
		conversation: summarizeConversation(conversation),
		warnings: [RAW_ARTIFACT_WARNING],
	};
}

function printStdoutSummary(summary) {
	console.log(JSON.stringify(summary, null, 2));
}

async function captureEvents(args) {
	const artifactDir = args.out ?? defaultOutDir();
	mkdirSync(artifactDir, { recursive: true });
	const startedAt = Date.now();
	const metadata = {
		capturedAt: new Date(startedAt).toISOString(),
		cwd: args.cwd,
		model: args.model,
		settingSources: args.settingSources ?? null,
		prompt: args.prompt,
		packageVersion: packageJson.version,
		sdkVersion: readSdkVersion(),
		includeConversation: args.includeConversation,
		warnings: [RAW_ARTIFACT_WARNING],
	};
	writeFileSync(artifactPath(artifactDir, "metadata"), `${JSON.stringify(metadata, null, 2)}\n`);

	const restoreOutputFilter = installCursorSdkOutputFilter();
	const eventSink = createEventJsonlSink(artifactDir, startedAt);
	let agent;
	try {
		const { Agent } = await suppressCursorSdkOutput(() => import("@cursor/sdk"));
		agent = await suppressCursorSdkOutput(() =>
			Agent.create({
				apiKey: args.apiKey,
				model: { id: args.model },
				local: args.settingSources ? { cwd: args.cwd, settingSources: args.settingSources } : { cwd: args.cwd },
			}),
		);

		const run = await suppressCursorSdkOutput(() =>
			agent.send(
				{ text: args.prompt },
				{
					onDelta: ({ update }) => eventSink.appendDelta(update),
					onStep: ({ step }) => eventSink.appendStep(step),
				},
			),
		);

		await suppressCursorSdkOutput(async () => {
			for await (const event of run.stream()) {
				eventSink.appendStream(event);
			}
		});

		const waitResult = await suppressCursorSdkOutput(() => run.wait());
		writeFileSync(artifactPath(artifactDir, "waitResult"), `${JSON.stringify(waitResult, null, 2)}\n`);

		let conversation;
		if (args.includeConversation) {
			if (run.supports("conversation")) {
				conversation = await suppressCursorSdkOutput(() => run.conversation());
			} else {
				conversation = {
					skipped: true,
					reason: run.unsupportedReason("conversation") ?? "conversation unsupported",
				};
			}
			writeFileSync(artifactPath(artifactDir, "conversation"), `${JSON.stringify(conversation, null, 2)}\n`);
		}

		const summary = buildSummary({
			artifactDir,
			...eventSink.getSummaryState(),
			waitResult,
			conversation,
			includeConversation: args.includeConversation,
		});
		writeFileSync(artifactPath(artifactDir, "summary"), `${JSON.stringify(summary, null, 2)}\n`);
		printStdoutSummary(summary);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(message, [args.apiKey]);
	} finally {
		await eventSink.close().catch(() => {});
		try {
			agent?.close();
		} finally {
			restoreOutputFilter();
		}
	}
}

async function main(argv = process.argv.slice(2), env = process.env) {
	const args = parseDebugSdkEventsArgs(argv, env);
	if (args.help) {
		printHelp();
		process.exit(0);
	}
	if (!args.prompt?.trim()) {
		fail("--prompt is required");
	}
	args.apiKey = requireApiKey(args, env, fail);
	await captureEvents(args);
}

if (isMainModule()) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		fail(message, apiKeySecretsFromProcess());
	});
}
