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

describe("validate-smoke-jsonl", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
