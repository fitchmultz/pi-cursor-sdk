import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeSmokeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-cursor-smoke-jsonl-test-"));
	tempDirs.push(dir);
	return dir;
}

function runValidator(smokeDir: string, extraArgs: string[] = []) {
	return spawnSync(process.execPath, ["scripts/validate-smoke-jsonl.mjs", ...extraArgs, smokeDir], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
}

function writeSessionJsonl(smokeDir: string, name: string, lines: unknown[]): void {
	const sessionDir = join(smokeDir, name);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "session.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

const nativeFixtureText = "NATIVE_READ_FIXTURE_CONTENT_MUST_STAY_PRIVATE";
const validUsage = { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 };
function readCall(id = "cursor-replay-offline-read") {
	return { type: "message", message: { role: "assistant", usage: validUsage, content: [{ type: "toolCall", name: "read", id, arguments: { path: nativeFixtureText } }] } };
}
function readResult(id = "cursor-replay-offline-read", isError = false) {
	return { type: "message", message: { role: "toolResult", toolName: "read", toolCallId: id, isError, content: [{ type: "text", text: nativeFixtureText }] } };
}
const textOnly = { type: "message", message: { role: "assistant", usage: validUsage, content: [{ type: "text", text: nativeFixtureText }] } };

describe("validate-smoke-jsonl", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		{ name: "text-only", records: [textOnly] },
		{ name: "bridge-only", records: [readCall("pi-tool-read"), readResult("pi-tool-read")] },
		{ name: "unmatched-call", records: [readCall()] },
		{ name: "unmatched-result", records: [readResult()] },
		{ name: "wrong-result-id", records: [readCall(), readResult("cursor-replay-other")] },
		{ name: "errored-result", records: [readCall(), readResult(undefined, true)] },
		{ name: "missing-error-status", records: [readCall(), { type: "message", message: { ...readResult().message, isError: undefined } }] },
		{ name: "wrong-result-tool", records: [readCall(), { type: "message", message: { ...readResult().message, toolName: "bash" } }] },
		{ name: "non-assistant-call", records: [{ type: "message", message: { ...readCall().message, role: "user" } }, readResult()] },
		{ name: "non-tool-call-block", records: [{ type: "message", message: { role: "assistant", content: [{ type: "text", name: "read", id: "cursor-replay-offline-read" }] } }, readResult()] },
		{ name: "result-before-call", records: [readResult(), readCall()] },
		{ name: "error-then-duplicate-success", records: [readCall(), readResult(undefined, true), readResult()] },
	])("rejects $name as positive native-read proof without changing replay-error-only defaults", ({ name, records }) => {
		const smokeDir = makeSmokeDir();
		writeSessionJsonl(smokeDir, name, records);
		expect(runValidator(smokeDir, ["--replay-errors-only"]).status).toBe(0);
		const result = runValidator(smokeDir, ["--replay-errors-only", "--require-native-read"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no successful native read call/result pair");
		expect(result.stdout + result.stderr).not.toContain(nativeFixtureText);
	});

	it.each([{ options: [] }, { options: ["--replay-errors"] }, { options: ["--replay-errors-only"] }])("accepts a native read pair across the directory with additive options $options", ({ options }) => {
		const smokeDir = makeSmokeDir();
		writeSessionJsonl(smokeDir, "text-session", [textOnly]);
		writeSessionJsonl(smokeDir, "native-session", [readCall(), readResult()]);
		const result = runValidator(smokeDir, [...options, "--require-native-read"]);
		expect(result.status, result.stderr).toBe(0);
		const summaries = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
		expect(summaries.reduce((sum, summary) => sum + summary.nativeReadPairCount, 0)).toBe(1);
		expect(result.stdout + result.stderr).not.toContain(nativeFixtureText);
	});

	it("does not match calls and results from different session files", () => {
		const smokeDir = makeSmokeDir();
		writeSessionJsonl(smokeDir, "call-session", [readCall()]);
		writeSessionJsonl(smokeDir, "result-session", [readResult()]);
		expect(runValidator(smokeDir, ["--replay-errors-only", "--require-native-read"]).status).toBe(1);
	});

	it("rejects malformed JSONL even alongside a valid native pair in replay-only proof mode", () => {
		const smokeDir = makeSmokeDir();
		writeSessionJsonl(smokeDir, "valid", [readCall(), readResult()]);
		mkdirSync(join(smokeDir, "malformed"));
		writeFileSync(join(smokeDir, "malformed", "session.jsonl"), "{not-json}\n");
		expect(runValidator(smokeDir, ["--replay-errors-only"]).status).toBe(0);
		const result = runValidator(smokeDir, ["--replay-errors-only", "--require-native-read"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain('"parseErrorCount":1');
		expect(result.stdout + result.stderr).not.toContain("{not-json}");
	});

	it("accepts assistant messages with valid usage", () => {
		const smokeDir = makeSmokeDir();
		writeSessionJsonl(smokeDir, "valid", [
			{ type: "message", message: { role: "user", content: "hi" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					usage: { input: 1, output: 2, totalTokens: 3, cacheRead: 4, cacheWrite: 0 },
				},
			},
		]);

		const result = runValidator(smokeDir);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"assistantCount":1');
		expect(result.stdout).toContain('"badUsageCount":0');
	});

	it.each([
		{ name: "empty", content: "", expectedFragments: ['"lineCount":0', '"assistantCount":0'] },
		{ name: "no-assistant", content: JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }) + "\n", expectedFragments: ['"assistantCount":0'] },
	])("rejects $name JSONL files", ({ name, content, expectedFragments }) => {
		const smokeDir = makeSmokeDir();
		const sessionDir = join(smokeDir, name);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "session.jsonl"), content);

		const result = runValidator(smokeDir);

		expect(result.status).toBe(1);
		for (const fragment of expectedFragments) expect(result.stdout).toContain(fragment);
	});

	it("fails assistant messages with missing or negative usage", () => {
		const smokeDir = makeSmokeDir();
		writeSessionJsonl(smokeDir, "bad-usage", [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "missing" }] } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "bad cache" }],
					usage: { input: 1, output: 1, totalTokens: 2, cacheRead: -1, cacheWrite: 0 },
				},
			},
		]);

		const result = runValidator(smokeDir);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain('"assistantCount":2');
		expect(result.stdout).toContain('"usageCount":1');
		expect(result.stdout).toContain('"badUsageCount":2');
	});

	it("fails invalid JSONL", () => {
		const smokeDir = makeSmokeDir();
		const sessionDir = join(smokeDir, "invalid");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "session.jsonl"), "{not-json}\n");

		const result = runValidator(smokeDir);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain('"parseErrorCount":1');
	});

	it("returns exit code 2 when no JSONL files are found", () => {
		const smokeDir = makeSmokeDir();

		const result = runValidator(smokeDir);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("no JSONL files");
	});

	it("fails replay-errors-only when JSONL contains Tool grep not found", () => {
		const smokeDir = makeSmokeDir();
		writeSessionJsonl(smokeDir, "replay-error", [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "grep",
					content: [{ type: "text", text: "Tool grep not found" }],
					isError: true,
				},
			},
		]);

		const result = runValidator(smokeDir, ["--replay-errors-only"]);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain('"replayErrorCount":1');
	});

	it("ignores replay error strings in successful read tool results", () => {
		const smokeDir = makeSmokeDir();
		writeSessionJsonl(smokeDir, "clean-replay", [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "grep",
					content: [{ type: "text", text: "src/app.css" }],
					isError: false,
				},
			},
		]);

		writeSessionJsonl(smokeDir, "doc-mention", [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					content: [{ type: "text", text: "The replay scan fails on records containing:\n\n- Tool grep not found\n- Tool cursor not found" }],
					isError: false,
				},
			},
		]);

		const result = runValidator(smokeDir, ["--replay-errors-only"]);

		expect(result.status).toBe(0);
		const summaries = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
		expect(summaries.map((summary) => summary.replayErrorCount)).toEqual([0, 0]);
	});

	it("fails default usage validation with --replay-errors when replay tool failures are present", () => {
		const smokeDir = makeSmokeDir();
		writeSessionJsonl(smokeDir, "usage-and-replay", [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "cursor",
					content: [{ type: "text", text: "Tool cursor not found" }],
					isError: true,
				},
			},
		]);

		const result = runValidator(smokeDir, ["--replay-errors"]);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain('"replayErrorCount":1');
	});
});
