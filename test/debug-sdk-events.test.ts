import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CURSOR_SDK_STARTUP_NOISE_PATTERNS as providerNoisePatterns } from "../src/cursor-sdk-output-filter.js";
import { resolveCursorSettingSources as resolveProviderSettingSources } from "../src/cursor-setting-sources.js";
import { scrubSensitiveText as scrubProviderSensitiveText } from "../src/cursor-sensitive-text.js";
import { CURSOR_SDK_STARTUP_NOISE_PATTERNS as scriptNoisePatterns } from "../scripts/lib/cursor-sdk-output-filter.mjs";
import {
	CURSOR_SETTING_SOURCES_ENV,
	resolveCursorSettingSources as resolveScriptSettingSources,
} from "../shared/cursor-setting-sources.mjs";
import { scrubSensitiveText as scrubScriptSensitiveText } from "../shared/cursor-sensitive-text.mjs";
import {
	buildSummary,
	createEventJsonlSink,
	parseDebugSdkEventsArgs,
} from "../scripts/debug-sdk-events.mjs";
import { installCursorSdkOutputFilter, suppressCursorSdkOutput } from "../scripts/lib/cursor-sdk-output-filter.mjs";

const scriptPath = "scripts/debug-sdk-events.mjs";

function run(args: string[], env: Record<string, string | undefined> = {}) {
	return spawnSync(process.execPath, [scriptPath, ...args], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

function collectStrings(value: unknown, strings: string[] = []): string[] {
	if (typeof value === "string") {
		strings.push(value);
		return strings;
	}
	if (Array.isArray(value)) {
		for (const entry of value) collectStrings(entry, strings);
		return strings;
	}
	if (value && typeof value === "object") {
		for (const entry of Object.values(value)) collectStrings(entry, strings);
	}
	return strings;
}

describe("debug-sdk-events maintainer probe", () => {
	it("parses args and setting source overrides", () => {
		expect(
			parseDebugSdkEventsArgs(["--cwd", "/tmp/work", "--model", "composer-2.5", "--prompt", "hello"], {
				CURSOR_API_KEY: "key",
				PI_CURSOR_SETTING_SOURCES: "all",
			}),
		).toMatchObject({
			cwd: resolve("/tmp/work"),
			model: "composer-2.5",
			prompt: "hello",
			apiKey: "key",
			settingSources: ["all"],
		});

		expect(
			parseDebugSdkEventsArgs(["--setting-sources", "project,user", "--prompt", "x"], {
				PI_CURSOR_SETTING_SOURCES: "all",
			}),
		).toMatchObject({
			settingSources: ["project", "user"],
		});

		expect(parseDebugSdkEventsArgs(["--setting-sources", "none", "--prompt", "x"], {})).toMatchObject({
			settingSources: undefined,
		});
	});

	it("builds stdout-safe summaries without raw SDK payloads", () => {
		const artifactDir = "/tmp/pi-cursor-sdk-sdk-events-test";
		const summary = buildSummary({
			artifactDir,
			counts: {
				stream: { assistant: 1 },
				onDelta: { "text-delta": 1 },
				onStep: { toolCall: 1 },
			},
			timing: {
				stream: { eventCount: 1, firstMs: 0, lastMs: 0, maxGapMs: undefined },
				onDelta: { eventCount: 1, firstMs: 100, lastMs: 100, maxGapMs: undefined },
				onStep: { eventCount: 1, firstMs: 200, lastMs: 200, maxGapMs: undefined },
			},
			waitResult: { status: "finished", durationMs: 250, result: "done" },
			conversation: [{ role: "user", content: "hello" }],
			includeConversation: true,
		});

		expect(summary.counts).toEqual({
			stream: { assistant: 1 },
			onDelta: { "text-delta": 1 },
			onStep: { toolCall: 1 },
		});
		expect(summary.wait).toEqual({ status: "finished", durationMs: 250, hasResultText: true });
		expect(summary.conversation).toEqual({ turnCount: 1 });
		expect(summary.files.streamEvents).toBe(join(artifactDir, "stream-events.jsonl"));

		const stdoutPayload = JSON.stringify(summary);
		expect(stdoutPayload).not.toContain("secret payload");
		expect(stdoutPayload).not.toContain('"text": "delta"');
		expect(collectStrings(summary)).not.toContain("hello");
	});

	it("appends JSONL event records incrementally and preserves partial artifacts", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-sdk-events-"));
		writeFileSync(join(artifactDir, "stream-events.jsonl"), "stale\n");
		const startedAt = Date.now();
		const sink = createEventJsonlSink(artifactDir, startedAt);
		try {
			sink.appendStream({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } });
			sink.appendDelta({ type: "text-delta", text: "delta" });
			sink.appendStep({ type: "toolCall", message: { name: "read" } });

			const streamEvents = readFileSync(join(artifactDir, "stream-events.jsonl"), "utf8");
			expect(streamEvents).not.toContain("stale");
			expect(streamEvents.trim().split("\n")).toHaveLength(1);
			expect(JSON.parse(streamEvents.trim()).event.type).toBe("assistant");

			const deltaEvents = readFileSync(join(artifactDir, "on-delta.jsonl"), "utf8");
			expect(JSON.parse(deltaEvents.trim()).update.type).toBe("text-delta");

			expect(sink.getSummaryState().counts.stream).toEqual({ assistant: 1 });
			expect(readFileSync(join(artifactDir, "on-step.jsonl"), "utf8").trim()).not.toBe("");
		} finally {
			await sink.close();
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});

	it("matches provider setting-source parsing and secret scrubbing helpers", () => {
		expect(CURSOR_SETTING_SOURCES_ENV).toBe("PI_CURSOR_SETTING_SOURCES");
		expect(scriptNoisePatterns).toEqual(providerNoisePatterns);

		for (const raw of [undefined, "", "all", "none", "project,user", "OFF", "0"]) {
			expect(resolveScriptSettingSources(raw)).toEqual(resolveProviderSettingSources(raw));
		}

		const leakedKey = "super-secret-cursor-key-12345";
		const sample = `Bearer ${leakedKey} api_key=${leakedKey}`;
		expect(scrubScriptSensitiveText(sample, leakedKey)).toBe(scrubProviderSensitiveText(sample, leakedKey));
	});

	it("retains the script creation-only mute without hiding its final summary", async () => {
		const terminalWrites: string[] = [];
		const originalStdoutWrite = process.stdout.write;
		process.stdout.write = ((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			terminalWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.();
			return true;
		}) as typeof process.stdout.write;

		const restore = installCursorSdkOutputFilter();
		try {
			await suppressCursorSdkOutput(async () => {
				process.stdout.write("managed_skills.example load completed\n");
				process.stdout.write("[hooks] SessionStart trigger matcher is not supported in Cursor\n");
			});

			process.stdout.write(`${JSON.stringify({ artifactDir: "/tmp/example", counts: { stream: { assistant: 1 } } })}\n`);
		} finally {
			restore();
			process.stdout.write = originalStdoutWrite;
		}

		const output = terminalWrites.join("");
		expect(output).not.toContain("managed_skills.");
		expect(output).not.toContain("[hooks]");
		expect(output).toContain('"/tmp/example"');
	});

	it("runs packaged help from node_modules without importing TypeScript helpers", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-package-runtime-"));
		const packageRoot = join(root, "node_modules", "pi-cursor-sdk");
		try {
			mkdirSync(join(packageRoot, "scripts", "lib"), { recursive: true });
			mkdirSync(join(packageRoot, "shared"), { recursive: true });
			mkdirSync(join(packageRoot, "src"), { recursive: true });
			cpSync("package.json", join(packageRoot, "package.json"));
			cpSync(scriptPath, join(packageRoot, scriptPath));
			for (const sharedFile of ["cursor-setting-sources.mjs", "cursor-sensitive-text.mjs", "cursor-sdk-output-filter.mjs"]) {
				cpSync(`shared/${sharedFile}`, join(packageRoot, "shared", sharedFile));
			}
			for (const libFile of [
				"cursor-cli-args.mjs",
				"cursor-script-fail.mjs",
				"cursor-sdk-output-filter.mjs",
			]) {
				cpSync(`scripts/lib/${libFile}`, join(packageRoot, "scripts/lib", libFile));
			}

			const result = spawnSync(process.execPath, [scriptPath, "--help"], { cwd: packageRoot, encoding: "utf8" });
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("Capture timestamped Cursor SDK event timelines");
			expect(result.stderr).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows help and validates script syntax without live Cursor auth", () => {
		expect(spawnSync(process.execPath, ["--check", scriptPath], { cwd: process.cwd(), encoding: "utf8" }).status).toBe(0);

		const help = run(["--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("Capture timestamped Cursor SDK event timelines");
		expect(help.stdout).toContain("run.stream()");
		expect(help.stdout).toContain("onDelta");
		expect(help.stdout).toContain("onStep");
		expect(help.stdout).toContain("https://cursor.com/docs/sdk/typescript");
	});

	it("fails fast on missing prompt and missing api key without printing secrets", () => {
		const leakedKey = "super-secret-cursor-key-12345";

		const missingPrompt = run(["--api-key", leakedKey], { CURSOR_API_KEY: undefined });
		expect(missingPrompt.status).toBe(1);
		expect(missingPrompt.stderr).toContain("--prompt is required");
		expect(`${missingPrompt.stdout}${missingPrompt.stderr}`).not.toContain(leakedKey);

		const missingKey = run(["--prompt", "hello"], { CURSOR_API_KEY: undefined });
		expect(missingKey.status).toBe(1);
		expect(missingKey.stderr).toContain("Cursor API key is required");
		expect(`${missingKey.stdout}${missingKey.stderr}`).not.toContain("hello");
	});
});
