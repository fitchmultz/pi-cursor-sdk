import { execFile as execFileCallback, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

// Node 24.0-24.14 announce node:sqlite as experimental on stderr. The exact stderr assertions
// below check the build's own diagnostics, so these children suppress ExperimentalWarning,
// including warnings from any other experimental API. Build errors, cleanup warnings and
// other warning classes still print; real npm run build keeps all warnings.
const buildNodeArgs = ["--disable-warning=ExperimentalWarning"];

// Returns stderr alongside the exit code so a storm failure in CI reports the
// build's own diagnostic instead of a bare "expected 1 to be 0".
async function runBuild(cwd: string, env: Record<string, string> = {}, nodeArgs: string[] = []) {
	try {
		const { stderr } = await execFile(process.execPath, [...buildNodeArgs, ...nodeArgs, buildScript], {
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

function previousDirs(cwd: string): string[] {
	return readdirSync(cwd).filter((name) => name.startsWith("dist.previous."));
}

function writePreviousDist(cwd: string): void {
	mkdirSync(join(cwd, "dist"));
	writeFileSync(join(cwd, "dist", "sentinel.txt"), "previous build");
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const fixtures: string[] = [];
afterAll(() => {
	for (const dir of fixtures) rmSync(dir, { force: true, recursive: true });
});

describe("build.mjs publication", () => {
	it("preserves the previous dist and cleans staging when the compile fails", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		writePreviousDist(dir);

		const { code: exitCode } = await runBuild(dir, { TSC_STUB_FAIL: "1" });

		expect(exitCode).not.toBe(0);
		expect(existsSync(join(dir, "dist", "sentinel.txt"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	});

	it("replaces dist and discards the previous build, purging stale files", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "stale.txt"), "old output");

		expect((await runBuild(dir)).code).toBe(0);

		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
		expect(existsSync(join(dir, "dist", "stale.txt"))).toBe(false);
		expect(stagingDirs(dir)).toEqual([]);
		expect(previousDirs(dir)).toEqual([]);
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

	it("fails loudly and keeps the previous dist when it cannot be moved aside", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		writePreviousDist(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "dist-locked" }, faultArgs());

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("synthetic dist lock after 2500ms");
		expect(existsSync(join(dir, "dist", "sentinel.txt"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
		expect(previousDirs(dir)).toEqual([]);
	}, 10_000);

	it("concurrent build storms all succeed and leave a valid dist", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		writePreviousDist(dir);
		const results = await Promise.all(Array.from({ length: 4 }, () => runBuild(dir)));
		expect(results).toEqual(Array.from({ length: 4 }, () => ({ code: 0, stderr: "" })));
		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
		expect(existsSync(join(dir, "dist", "sentinel.txt"))).toBe(false);
		expect(stagingDirs(dir)).toEqual([]);
		expect(previousDirs(dir)).toEqual([]);
	}, 30_000);

	it("publishes its retained staging tree after a rename is unavailable beyond two seconds", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "late-winner" }, faultArgs());

		expect(result).toEqual({ code: 0, stderr: "" });
		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
		expect(readFileSync(join(dir, "dist", "late-winner.txt"), "utf8")).toBe("2200");
		expect(stagingDirs(dir)).toEqual([]);
	}, 10_000);

	it("fails and keeps its previous build when another writer fills dist/ during publication", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		writePreviousDist(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "race-loss" }, faultArgs());

		const retained = previousDirs(dir);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("synthetic race loss");
		expect(result.stderr).toContain("the previous build is retained at");
		expect(readFileSync(join(dir, "dist", "winner.txt"), "utf8")).toBe("published");
		expect(retained).toHaveLength(1);
		expect(readFileSync(join(dir, retained[0], "sentinel.txt"), "utf8")).toBe("previous build");
		expect(stagingDirs(dir)).toEqual([]);
	}, 10_000);

	it("retries its own publication when an empty dist directory appears before its rename", async () => {
		const dir = makeFixture();
		fixtures.push(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "empty-dist" }, faultArgs());

		expect(result).toEqual({ code: 0, stderr: "" });
		expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
		expect(stagingDirs(dir)).toEqual([]);
	});

	it("caps persistent rename failures, restores the previous dist and preserves the original diagnostic", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		writePreviousDist(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "rename-always" }, faultArgs());

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("synthetic permanent rename failure after 2500ms");
		expect(readFileSync(join(dir, "dist", "sentinel.txt"), "utf8")).toBe("previous build");
		expect(stagingDirs(dir)).toEqual([]);
		expect(previousDirs(dir)).toEqual([]);
	}, 10_000);

	it("retains and names the previous build when restoring it also fails", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		writePreviousDist(dir);

		const result = await runBuild(dir, { BUILD_SWAP_FAULT: "rename-into-dist-always" }, faultArgs());

		const retained = previousDirs(dir);
		expect(result.code).not.toBe(0);
		expect(retained).toHaveLength(1);
		expect(readFileSync(join(dir, retained[0], "sentinel.txt"), "utf8")).toBe("previous build");
		expect(result.stderr).toContain("the previous build is retained at");
		expect(result.stderr).toContain(retained[0]);
		expect(result.stderr).toContain("synthetic permanent rename failure after 2500ms");
		expect(existsSync(join(dir, "dist"))).toBe(false);
		expect(stagingDirs(dir)).toEqual([]);
	}, 10_000);

	it("publishes one build at a time, so failing builds' rollbacks never displace a successful build", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		writePreviousDist(dir);
		const barriers = mkdtempSync(join(tmpdir(), "build-swap-barriers-"));
		fixtures.push(barriers);
		const env = { BUILD_SWAP_FAULT: "serialized-publication", BUILD_SWAP_BARRIER_DIR: barriers };

		const [holder, healthy, failing] = await Promise.all(
			["holder", "healthy", "failing"].map((role) => runBuild(dir, { ...env, BUILD_SWAP_ROLE: role }, faultArgs())),
		);

		// Both other builds waited for the lock while the holder failed and restored dist/.
		expect(readdirSync(barriers).sort()).toEqual(["failing-waiting", "healthy-locked", "healthy-waiting", "holder-moved-dist"]);
		expect(healthy).toEqual({ code: 0, stderr: "" });
		expect(readdirSync(join(dir, "dist"))).toEqual(["index.js"]);
		for (const failed of [holder, failing]) {
			expect(failed.code).not.toBe(0);
			expect(failed.stderr).toContain("synthetic permanent rename failure after 2500ms");
		}
		expect(stagingDirs(dir)).toEqual([]);
		expect(previousDirs(dir)).toEqual([]);
	}, 30_000);

	it("lets the next build publish after a build is killed while it holds the publication lock", async () => {
		const dir = makeFixture();
		fixtures.push(dir);
		writePreviousDist(dir);
		const barriers = mkdtempSync(join(tmpdir(), "build-swap-barriers-"));
		fixtures.push(barriers);
		const victim = spawn(process.execPath, [...buildNodeArgs, ...faultArgs(), buildScript], {
			cwd: dir,
			env: { ...process.env, BUILD_SWAP_FAULT: "hold-publication", BUILD_SWAP_BARRIER_DIR: barriers },
			stdio: "ignore",
		});
		const victimExit = once(victim, "exit");
		try {
			await waitForFile(join(barriers, "victim-holding"));
		} finally {
			// The crash under test, in finally so a failed wait never leaves the victim running.
			victim.kill("SIGKILL");
			await victimExit;
		}

		expect(await runBuild(dir)).toEqual({ code: 0, stderr: "" });
		expect(readdirSync(join(dir, "dist"))).toEqual(["index.js"]);
		expect(stagingDirs(dir)).toEqual([]);
		// The killed build's backup stays where it moved it; no build deletes it.
		const stranded = previousDirs(dir);
		expect(stranded).toHaveLength(1);
		expect(readFileSync(join(dir, stranded[0], "sentinel.txt"), "utf8")).toBe("previous build");
	}, 30_000);

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
