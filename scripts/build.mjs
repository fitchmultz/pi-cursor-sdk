#!/usr/bin/env node
/**
 * Purpose: Produce the compiled runtime files that the Pi extension manifest loads.
 * Responsibilities: Run TypeScript emit into a staging directory, then atomically swap it
 * into dist/ so a failed build never destroys a previously working dist.
 * Usage: `npm run build`; also invoked by scripts/prepare.mjs during install lifecycles.
 * Invariants/Assumptions: `node_modules` provides `typescript`; deleting `dist/` is safe generated output.
 */

import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
// Run tsc's JS entrypoint directly through the current node binary: no .cmd shim,
// no shell, safe for install paths containing spaces on every platform.
const tscPath = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");

async function main() {
	if (!existsSync(tscPath)) {
		throw new Error(`typescript is not installed at ${tscPath}; run npm install first.`);
	}
	// Reap staging dirs stranded by dead builds (SIGKILL or crash mid-emit).
	// Signal 0 probes liveness; only ESRCH proves the owning process was gone at
	// probe time, so live concurrent builds (and pid-reused strangers) are left
	// alone. Pid reuse between the probe and the rm is inherent to pid-based
	// reaping and astronomically unlikely; the storm tests cover the live case.
	for (const entry of await readdir(process.cwd(), { withFileTypes: true })) {
		const staleMatch = /^dist\.staging\.(\d+)$/.exec(entry.name);
		if (!staleMatch || !entry.isDirectory()) continue;
		const ownerPid = Number(staleMatch[1]);
		if (ownerPid === process.pid) continue;
		try {
			process.kill(ownerPid, 0);
		} catch (error) {
			if (error?.code !== "ESRCH") continue;
			try {
				await rm(join(process.cwd(), entry.name), { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
			} catch (reapError) {
				// Best-effort: an unreapable strand (foreign-owned, locked) must not
				// fail the build that merely tried to tidy it.
				console.warn(`could not remove stale ${entry.name}: ${reapError?.message ?? reapError}`);
			}
		}
	}
	// Pid-scoped so concurrent builds (pack-triggered prepare, smoke lanes) cannot
	// clobber each other's staging tree or swap a partial emit into dist/.
	const stagingDir = join(process.cwd(), `dist.staging.${process.pid}`);
	await rm(stagingDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	try {
		const { stderr, stdout } = await execFile(
			process.execPath,
			[tscPath, "-p", "tsconfig.build.json", "--outDir", stagingDir],
			{ cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
		);
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
	} catch (error) {
		await rm(stagingDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
		if (error?.stdout) process.stdout.write(error.stdout);
		if (error?.stderr) process.stderr.write(error.stderr);
		throw error;
	}
	const distDir = join(process.cwd(), "dist");
	// A failed dist removal (for example a Windows file lock) must fail loudly:
	// it stays outside the publish handling below. This rm runs exactly once per
	// build, which is what bounds the retry loop: a finite number of concurrent
	// builds can steal the slot a finite number of times. Never move it inside.
	await rm(distDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(stagingDir, distDir);
			return;
		} catch (error) {
			// Decide by existence, never by errno: rename onto an existing
			// directory does not report the same code on every platform, so a
			// code-gated branch would misclassify a race loss on Windows.
			if (existsSync(distDir)) {
				// A concurrent build published first. Its output is an equivalent
				// fresh emit of the same tree, so discard ours and succeed.
				await rm(stagingDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
				console.warn("dist/ was published by a concurrent build; discarding this build's staging tree.");
				return;
			}
			// dist/ is absent, so nobody holds the slot. Our own staging tree is
			// still intact and retrying our rename publishes it, which is why no
			// build ever waits on another build's timing.
			if (existsSync(stagingDir) && attempt < 50) {
				await delay(50);
				continue;
			}
			// Our emit vanished, or the slot never settled: fail loudly.
			await rm(stagingDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
			throw error;
		}
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
