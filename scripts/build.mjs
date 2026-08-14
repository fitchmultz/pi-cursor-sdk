#!/usr/bin/env node
/**
 * Purpose: Produce the compiled runtime files that the Pi extension manifest loads.
 * Responsibilities: Run TypeScript emit into a staging directory, then atomically swap it
 * into dist/ so a failed TypeScript emit never destroys a previously working dist.
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
const RM_OPTIONS = { force: true, maxRetries: 5, recursive: true, retryDelay: 100 };
const RENAME_RETRY_LIMIT = 50;
const RENAME_RETRY_MS = 50;
// Run tsc's JS entrypoint directly through the current node binary: no .cmd shim,
// no shell, safe for install paths containing spaces on every platform.
const tscPath = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");

async function discardStaging(path) {
	try {
		await rm(path, RM_OPTIONS);
	} catch (error) {
		// Cleanup is always best-effort: it must not turn a successful race loss
		// into failure or replace the compiler/publish error that matters.
		console.warn(`could not remove staging ${path}: ${error?.message ?? error}`);
	}
}

function isOwnerGone(pid) {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error?.code === "ESRCH";
	}
}

async function hasPublishedDist(path) {
	try {
		return (await readdir(path)).length > 0;
	} catch {
		return false;
	}
}

async function reapStrandedStaging(cwd) {
	// Signal 0 proves only that the owner was gone at probe time. Pid reuse
	// between this probe and removal is inherent to pid-based reaping.
	for (const entry of await readdir(cwd, { withFileTypes: true })) {
		const match = /^dist\.staging\.(\d+)$/.exec(entry.name);
		if (!match || !entry.isDirectory()) continue;
		const ownerPid = Number(match[1]);
		if (ownerPid === process.pid || !isOwnerGone(ownerPid)) continue;
		await discardStaging(join(cwd, entry.name));
	}
}

async function compileToStaging(cwd, stagingDir) {
	try {
		const { stderr, stdout } = await execFile(
			process.execPath,
			[tscPath, "-p", "tsconfig.build.json", "--outDir", stagingDir],
			{ cwd, maxBuffer: 10 * 1024 * 1024 },
		);
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
	} catch (error) {
		if (error?.stdout) process.stdout.write(error.stdout);
		if (error?.stderr) process.stderr.write(error.stderr);
		await discardStaging(stagingDir);
		throw error;
	}
}

async function publishStaging(stagingDir, distDir) {
	try {
		// A failed dist removal must fail loudly; keep it outside the retry loop.
		// Remove dist exactly once so retries never delete a concurrent winner.
		await rm(distDir, RM_OPTIONS);
		for (let retry = 0; ; retry++) {
			try {
				await rename(stagingDir, distDir);
				return;
			} catch (error) {
				// A completed staged build is non-empty; a bare directory is not proof
				// that a concurrent publisher won the race.
				if (await hasPublishedDist(distDir)) {
					console.warn("dist/ was published by a concurrent build; discarding this build's staging tree.");
					return;
				}
				// At most 50 retries (~2.5s) keep persistent filesystem errors bounded.
				if (existsSync(stagingDir) && retry < RENAME_RETRY_LIMIT) {
					await delay(RENAME_RETRY_MS);
					continue;
				}
				throw error;
			}
		}
	} finally {
		// Safe after success too: rename moved stagingDir, so force makes this a no-op.
		await discardStaging(stagingDir);
	}
}

async function main() {
	const cwd = process.cwd();
	if (!existsSync(tscPath)) throw new Error(`typescript is not installed at ${tscPath}; run npm install first.`);
	await reapStrandedStaging(cwd);
	// Pid-scoped staging isolates concurrent emits; only a complete tree publishes.
	const stagingDir = join(cwd, `dist.staging.${process.pid}`);
	await rm(stagingDir, RM_OPTIONS);
	await compileToStaging(cwd, stagingDir);
	await publishStaging(stagingDir, join(cwd, "dist"));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
