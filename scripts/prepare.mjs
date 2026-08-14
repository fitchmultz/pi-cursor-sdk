#!/usr/bin/env node
/**
 * Purpose: Build generated dist output for GitHub/source installs even when Pi invokes npm install --omit=dev.
 * Responsibilities: Detect missing source-build dependencies, install dev dependencies with lifecycle scripts disabled, then run the canonical build.
 * Scope: Package install lifecycle only; runtime behavior remains owned by scripts/build.mjs.
 * Usage: package.json prepare script.
 */

import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const REQUIRED_SOURCE_BUILD_MODULES = [
	"typescript",
	"typebox",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

function canResolveBuildDependencies() {
	return REQUIRED_SOURCE_BUILD_MODULES.every((moduleName) => {
		try {
			require.resolve(moduleName);
			return true;
		} catch {
			return false;
		}
	});
}

async function runNpmInstallDevDependencies() {
	const npmExecPath = process.env.npm_execpath;
	const options = process.platform === "win32" ? { shell: true } : {};
	if (npmExecPath) {
		await execFile(process.execPath, [npmExecPath, "install", "--include=dev", "--ignore-scripts"], {
			...options,
			cwd: process.cwd(),
			maxBuffer: 20 * 1024 * 1024,
		});
		return;
	}
	await execFile("npm", ["install", "--include=dev", "--ignore-scripts"], {
		...options,
		cwd: process.cwd(),
		maxBuffer: 20 * 1024 * 1024,
	});
}

async function main() {
	if (!canResolveBuildDependencies()) {
		await runNpmInstallDevDependencies();
	}
	await execFile(process.execPath, [join(process.cwd(), "scripts", "build.mjs")], {
		cwd: process.cwd(),
		maxBuffer: 20 * 1024 * 1024,
	});
}

main().catch((error) => {
	if (error?.stdout) process.stdout.write(error.stdout);
	if (error?.stderr) process.stderr.write(error.stderr);
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
