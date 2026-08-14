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
import { setTimeout as delay } from "node:timers/promises";
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
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
	// Signal 0 probes liveness; only ESRCH proves the owning process is gone,
	// so live concurrent builds (and pid-reused strangers) are never touched.
	for (const entry of await readdir(process.cwd(), { withFileTypes: true })) {
		const staleMatch = /^dist\.staging\.(\d+)$/.exec(entry.name);
		if (!staleMatch || !entry.isDirectory()) continue;
		const ownerPid = Number(staleMatch[1]);
		if (ownerPid === process.pid) continue;
		try {
			process.kill(ownerPid, 0);
		} catch (error) {
			if (error?.code !== "ESRCH") continue;
			await rm(join(process.cwd(), entry.name), { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
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
	// it stays outside the race-loss handling below.
	await rm(distDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	try {
		await rename(stagingDir, distDir);
	} catch (error) {
		await rm(stagingDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
		// A concurrent build can repopulate dist/ between our rm and rename; its
		// output is an equivalent fresh emit, so losing that race is a success.
		// The winner may itself be mid-swap (between its rm and rename), so poll
		// briefly before declaring a real failure: with concurrent builds of the
		// same tree, some build's rename always lands.
		for (let attempt = 0; attempt < 20; attempt++) {
			if (existsSync(distDir)) {
				console.warn("dist/ was replaced by a concurrent build; keeping that output.");
				return;
			}
			await delay(100);
		}
		throw error;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
