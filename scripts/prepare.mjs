#!/usr/bin/env node
/**
 * Purpose: Build generated dist output for GitHub/source installs even when Pi invokes npm install --omit=dev.
 * Responsibilities: Detect missing source-build dependencies via the local node_modules tree, install dev
 * dependencies with lifecycle scripts disabled, run the canonical build, then prune the dev tree so installs
 * keep a runtime-only footprint.
 * Scope: Package install lifecycle only; runtime behavior remains owned by scripts/build.mjs.
 * Usage: package.json prepare script.
 */

import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

// Checked as literal node_modules paths: require.resolve() is unusable here because
// several @earendil-works packages expose import-only "exports" maps and throw
// ERR_PACKAGE_PATH_NOT_EXPORTED even when installed.
const REQUIRED_SOURCE_BUILD_MODULES = [
	"typescript",
	"typebox",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

function hasBuildDependencies() {
	return REQUIRED_SOURCE_BUILD_MODULES.every((moduleName) =>
		existsSync(join(process.cwd(), "node_modules", ...moduleName.split("/"), "package.json")),
	);
}

async function runNpm(args) {
	const npmExecPath = process.env.npm_execpath;
	if (!npmExecPath) {
		throw new Error(
			`npm_execpath is not set; run "npm ${args.join(" ")}" manually in ${process.cwd()} and retry.`,
		);
	}
	// No shell: process.execPath runs npm's cli.js directly, which is safe for paths
	// containing spaces on every platform (shell:true concatenates args unescaped).
	await execFile(process.execPath, [npmExecPath, ...args], {
		cwd: process.cwd(),
		maxBuffer: 20 * 1024 * 1024,
	});
}

async function main() {
	const devDependenciesWereMissing = !hasBuildDependencies();
	if (devDependenciesWereMissing) {
		await runNpm(["install", "--include=dev", "--ignore-scripts"]);
	}
	let buildFailed = false;
	try {
		const { stderr, stdout } = await execFile(process.execPath, [join(process.cwd(), "scripts", "build.mjs")], {
			cwd: process.cwd(),
			maxBuffer: 20 * 1024 * 1024,
		});
		// Forward build output on success too: install-time diagnostics such as the
		// concurrent-swap race-loss warning are otherwise swallowed.
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
	} catch (error) {
		buildFailed = true;
		throw error;
	} finally {
		if (devDependenciesWereMissing) {
			try {
				// Return node_modules to the runtime-only set (even when the build fails) so
				// end-user installs never keep the full dev toolchain on disk.
				await runNpm(["prune", "--omit=dev", "--ignore-scripts"]);
			} catch (pruneError) {
				// A prune failure alone still fails the install, but it must never
				// mask the build error, which is the diagnostic that matters.
				if (!buildFailed) throw pruneError;
				console.warn(`npm prune failed after a failed build: ${pruneError?.message ?? pruneError}`);
			}
		}
	}
}

main().catch((error) => {
	if (error?.stdout) process.stdout.write(error.stdout);
	if (error?.stderr) process.stderr.write(error.stderr);
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
