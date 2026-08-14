#!/usr/bin/env node
/**
 * Purpose: Produce the compiled runtime files that the Pi extension manifest loads.
 * Responsibilities: Remove stale dist output and run TypeScript emit through the local compiler.
 * Usage: `npm run build`; also invoked by scripts/prepare.mjs during install lifecycles.
 * Invariants/Assumptions: `node_modules` provides `typescript`; deleting `dist/` is safe generated output.
 */

import { execFile as execFileCallback } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const binSuffix = process.platform === "win32" ? ".cmd" : "";
const tscPath = join(process.cwd(), "node_modules", ".bin", `tsc${binSuffix}`);

async function main() {
	await rm(join(process.cwd(), "dist"), { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	const options = process.platform === "win32" ? { shell: true } : {};
	try {
		const { stderr, stdout } = await execFile(tscPath, ["-p", "tsconfig.build.json"], {
			...options,
			cwd: process.cwd(),
			maxBuffer: 10 * 1024 * 1024,
		});
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
	} catch (error) {
		if (error?.stdout) process.stdout.write(error.stdout);
		if (error?.stderr) process.stderr.write(error.stderr);
		throw error;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
