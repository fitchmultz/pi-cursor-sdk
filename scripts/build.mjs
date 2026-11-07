#!/usr/bin/env node
/**
 * Purpose: Produce the compiled runtime files that the Pi extension manifest loads.
 * Responsibilities: Run TypeScript emit into a staging directory, then publish it with two renames:
 * the previous dist/ moves aside and the staged tree moves into dist/. This is not an atomic swap;
 * dist/ is briefly absent between the renames. A failed emit never touches dist/, and a failed
 * publication restores the previous build or reports where it is retained.
 * Usage: `npm run build`; also invoked by scripts/prepare.mjs during install lifecycles.
 * Invariants/Assumptions: `node_modules` provides `typescript`; dist/ is generated output. Builds of
 * one checkout compile concurrently but publish one at a time under dist.lock, so only the lock
 * holder moves trees in or out of dist/, and the previous build is deleted only after dist/ holds
 * this build's output.
 */

import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const RM_OPTIONS = { force: true, maxRetries: 5, recursive: true, retryDelay: 100 };
const RENAME_RETRY_LIMIT = 50;
const RENAME_RETRY_MS = 50;
const SQLITE_BUSY = 5;
// Run tsc's JS entrypoint directly through the current node binary: no .cmd shim,
// no shell, safe for install paths containing spaces on every platform.
const tscPath = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");

async function discard(path, label) {
	try {
		await rm(path, RM_OPTIONS);
	} catch (error) {
		// Cleanup is always best-effort: it must not turn a successful publication
		// into failure or replace the compiler/publish error that matters.
		console.warn(`could not remove ${label} ${path}: ${error?.message ?? error}`);
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

async function reapStrandedStaging(cwd) {
	// Signal 0 proves only that the owner was gone at probe time. Pid reuse
	// between this probe and removal is inherent to pid-based reaping.
	for (const entry of await readdir(cwd, { withFileTypes: true })) {
		const match = /^dist\.staging\.(\d+)$/.exec(entry.name);
		if (!match || !entry.isDirectory()) continue;
		const ownerPid = Number(match[1]);
		if (ownerPid === process.pid || !isOwnerGone(ownerPid)) continue;
		await discard(join(cwd, entry.name), "staging");
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
		await discard(stagingDir, "staging");
		throw error;
	}
}

// Serializes publication across the builds of one checkout. SQLite holds the EXCLUSIVE
// transaction with OS file locks (POSIX advisory locks, LockFileEx on Windows) that the OS
// releases when this process exits, even after a crash, so a dead holder never blocks the next
// build. There is no deadline: a live holder only runs the bounded renames below.
function lockPublication(lockPath) {
	const lock = new DatabaseSync(lockPath, { timeout: RENAME_RETRY_MS });
	for (;;) {
		try {
			lock.exec("BEGIN EXCLUSIVE");
			return lock;
		} catch (error) {
			// SQLITE_BUSY after the busy timeout means another build still holds the lock.
			if ((error?.errcode & 0xff) === SQLITE_BUSY) continue;
			lock.close();
			throw error;
		}
	}
}

// Renames one tree within the bounded retry policy: at most 50 retries (~2.5s) while the
// source still exists, so persistent filesystem errors fail instead of hanging.
async function renameWithRetry(from, to) {
	for (let retry = 0; ; retry++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			if (existsSync(from) && retry < RENAME_RETRY_LIMIT) {
				await delay(RENAME_RETRY_MS);
				continue;
			}
			throw error;
		}
	}
}

// Returns whether the previous build is back in dist/. If not, it stays where it is and its
// path is reported; it is never deleted.
async function restorePrevious(previousDir, distDir) {
	try {
		await renameWithRetry(previousDir, distDir);
		return true;
	} catch (error) {
		console.error(`could not restore dist/; the previous build is retained at ${previousDir}: ${error?.message ?? error}`);
		return false;
	}
}

async function publishStaging(stagingDir, distDir) {
	let lock;
	let previousDir;
	let retainPrevious = false;
	try {
		lock = lockPublication(`${distDir}.lock`);
		// Move the previous build aside instead of deleting it, so a failed publication can
		// restore it. The unique name never collides with a backup a crashed build left behind.
		if (existsSync(distDir)) {
			const target = `${distDir}.previous.${process.pid}.${randomUUID()}`;
			await renameWithRetry(distDir, target);
			previousDir = target;
		}
		try {
			// Two renames, not an atomic swap: dist/ stays absent until this rename publishes.
			await renameWithRetry(stagingDir, distDir);
		} catch (error) {
			if (previousDir) retainPrevious = !(await restorePrevious(previousDir, distDir));
			throw error;
		}
	} finally {
		lock?.close();
		// Safe after success too: rename moved stagingDir, so force makes this a no-op.
		await discard(stagingDir, "staging");
		// dist/ holds this build or the restored previous build; a failed restore keeps it.
		if (previousDir && !retainPrevious) await discard(previousDir, "previous build");
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
