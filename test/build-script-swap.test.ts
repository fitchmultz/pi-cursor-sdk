import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const buildScript = fileURLToPath(new URL("../scripts/build.mjs", import.meta.url));

const tscStub = fileURLToPath(new URL("./fixtures/build-tsc-stub.cjs", import.meta.url));
const faultPreload = fileURLToPath(new URL("./fixtures/build-fs-fault-preload.mjs", import.meta.url));

function makeFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "build-swap-"));
	mkdirSync(join(dir, "node_modules", "typescript", "bin"), { recursive: true });
	copyFileSync(tscStub, join(dir, "node_modules", "typescript", "bin", "tsc"));
	return dir;
}

function faultArgs(): string[] {
	return ["--import", pathToFileURL(faultPreload).href];
}

// Returns stderr alongside the exit code so a storm failure in CI reports the
// build's own diagnostic instead of a bare "expected 1 to be 0".
async function runBuild(cwd: string, env: Record<string, string> = {}, nodeArgs: string[] = []) {
	try {
		const { stderr } = await execFile(process.execPath, [...nodeArgs, buildScript], {
			cwd,
			env: { ...process.env, ...env },
		});
		return { code: 0, stderr };
	} catch (error) {
		const failure = error as { code?: number; stderr?: string };
		return { code: failure.code ?? 1, stderr: failure.stderr ?? "" };
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

		const { code: exitCode } = await runBuild(dir, { TSC_STUB_FAIL: "1" });

		expect(exitCode).not.toBe(0);
		expect(existsSync(join(dir, "dist", "sentinel.txt"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	});

	it("replaces dist atomically, purging stale files", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "stale.txt"), "old output");

		expect((await runBuild(dir)).code).toBe(0);

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
		const livePid = process.pid;
		mkdirSync(join(dir, `dist.staging.${livePid}`, "inflight"), { recursive: true });

		expect((await runBuild(dir)).code).toBe(0);

		expect(existsSync(join(dir, `dist.staging.${deadPid}`))).toBe(false);
		expect(existsSync(join(dir, `dist.staging.${livePid}`))).toBe(true);
	});

	it("warns and continues when stranded staging cannot be removed", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		expect(typeof deadPid).toBe("number");
		const lockedName = `dist.staging.${deadPid}`;
		mkdirSync(join(dir, lockedName, "partial"), { recursive: true });

		const result = await runBuild(
			dir,
			{ BUILD_SWAP_FAULT: "stale-rm", LOCKED_STAGING_NAME: lockedName },
			faultArgs(),
		);

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("could not remove staging");
		expect(existsSync(join(dir, lockedName))).toBe(true);
		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
	});

	it("fails loudly when the previous dist cannot be removed", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "sentinel.txt"), "previous build");

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "stale-rm", LOCKED_STAGING_NAME: "dist" }, faultArgs());

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("synthetic stale-staging lock");
		expect(existsSync(join(dir, "dist", "sentinel.txt"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	});

	it("concurrent build storms all succeed and leave a valid dist", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		const results = await Promise.all(Array.from({ length: 4 }, () => runBuild(dir)));
		expect(results.flatMap((result) => (result.code === 0 ? [] : [result.stderr]))).toEqual([]);
		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	}, 30_000);

	it("publishes its retained staging tree instead of timing out on a slow winner", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "late-winner" }, faultArgs());

		expect(result).toEqual({ code: 0, stderr: "" });
		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
		expect(existsSync(join(dir, "dist", "late-winner.txt"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	}, 10_000);

	it("deterministically discards staging after a concurrent winner publishes", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "race-loss" }, faultArgs());

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("dist/ was published by a concurrent build");
		expect(existsSync(join(dir, "dist", "winner.txt"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	});

	it("fails closed when a requested filesystem fault is unknown", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "unknown" }, faultArgs());

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("unknown build-swap fault: unknown");
	});

	it("does not accept an empty dist directory as a published winner", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "empty-dist" }, faultArgs());

		expect(result).toEqual({ code: 0, stderr: "" });
		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	});

	it("caps persistent rename failures and preserves the original diagnostic", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "sentinel.txt"), "previous build");

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "rename-always" }, faultArgs());

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("synthetic permanent rename failure");
		expect(existsSync(join(dir, "dist"))).toBe(false);
		expect(existsSync(join(dir, "dist", "sentinel.txt"))).toBe(false);
		expect(stagingDirs(dir)).toEqual([]);
	}, 10_000);

	it("rethrows when the staged emit disappears before publication", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "vanish-staging" }, faultArgs());

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("ENOENT");
		expect(existsSync(join(dir, "dist"))).toBe(false);
		expect(stagingDirs(dir)).toEqual([]);
	}, 10_000);
});
