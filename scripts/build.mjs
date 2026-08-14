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
import { rename, rm } from "node:fs/promises";
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
	const stagingDir = join(process.cwd(), "dist.staging");
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
	await rm(join(process.cwd(), "dist"), { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	await rename(stagingDir, join(process.cwd(), "dist"));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
