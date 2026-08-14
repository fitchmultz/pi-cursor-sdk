import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const buildScript = fileURLToPath(new URL("../scripts/build.mjs", import.meta.url));

// Stub tsc: build.mjs runs node_modules/typescript/bin/tsc through process.execPath,
// so a plain CJS file suffices. It honors --outDir and fails on demand, which lets
// these tests drive the swap logic without a real TypeScript compile.
const TSC_STUB = `
if (process.env.TSC_STUB_FAIL === "1") {
	console.error("stub-tsc: induced failure");
	process.exit(1);
}
const fs = require("node:fs");
const path = require("node:path");
const outDir = process.argv[process.argv.indexOf("--outDir") + 1];
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "index.js"), "export const built = true;\\n");
if (process.env.TSC_STUB_SABOTAGE_STAGING === "1") {
	fs.rmSync(outDir, { recursive: true, force: true });
}
`;

function makeFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "build-swap-"));
	mkdirSync(join(dir, "node_modules", "typescript", "bin"), { recursive: true });
	writeFileSync(join(dir, "node_modules", "typescript", "bin", "tsc"), TSC_STUB);
	return dir;
}

async function runBuild(cwd: string, env: Record<string, string> = {}) {
	try {
		await execFile(process.execPath, [buildScript], { cwd, env: { ...process.env, ...env } });
		return 0;
	} catch (error) {
		return (error as { code?: number }).code ?? 1;
	}
}

function stagingDirs(cwd: string): string[] {
	return readdirSync(cwd).filter((name) => name.startsWith("dist.staging."));
}

const fixtures: string[] = [];
afterAll(() => {
	for (const dir of fixtures) rmSync(dir, { force: true, recursive: true });
});

describe("build.mjs staging swap", () => {
	it("preserves the previous dist and cleans staging when the compile fails", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "sentinel.txt"), "previous build");

		const exitCode = await runBuild(dir, { TSC_STUB_FAIL: "1" });

		expect(exitCode).not.toBe(0);
		expect(existsSync(join(dir, "dist", "sentinel.txt"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	});

	it("replaces dist atomically, purging stale files", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "stale.txt"), "old output");

		expect(await runBuild(dir)).toBe(0);

		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
		expect(existsSync(join(dir, "dist", "stale.txt"))).toBe(false);
		expect(stagingDirs(dir)).toEqual([]);
	});

	it("reaps staging dirs owned by dead pids and keeps live ones", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		expect(typeof deadPid).toBe("number");
		mkdirSync(join(dir, `dist.staging.${deadPid}`, "partial"), { recursive: true });
		const livePid = process.pid; // this test runner is alive for the whole build
		mkdirSync(join(dir, `dist.staging.${livePid}`, "inflight"), { recursive: true });

		expect(await runBuild(dir)).toBe(0);

		expect(existsSync(join(dir, `dist.staging.${deadPid}`))).toBe(false);
		expect(existsSync(join(dir, `dist.staging.${livePid}`))).toBe(true);
	});

	it("concurrent build storms all succeed and leave a valid dist", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		// 12-wide x 3 rounds: wide enough to exercise the rename race and the
		// mid-swap winner poll with useful probability on every run.
		for (let round = 0; round < 3; round++) {
			const exitCodes = await Promise.all(Array.from({ length: 12 }, () => runBuild(dir)));

			expect(exitCodes).toEqual(Array.from({ length: 12 }, () => 0));
			expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
			expect(stagingDirs(dir)).toEqual([]);
		}
	}, 30_000);

	it("rethrows the rename failure when no concurrent winner exists", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		// The sabotage stub deletes its own emit after compiling, so the build's
		// rename fails (ENOENT) and no winner ever repopulates dist/: the poll
		// must exhaust and rethrow instead of reporting a phantom race win.
		const exitCode = await runBuild(dir, { TSC_STUB_SABOTAGE_STAGING: "1" });

		expect(exitCode).not.toBe(0);
		expect(existsSync(join(dir, "dist"))).toBe(false);
	}, 10_000);
});
