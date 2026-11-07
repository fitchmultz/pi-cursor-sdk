#!/usr/bin/env node
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { hash, run as captured, writeJson } from "./lib/release-review-io.mjs";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));

function run(command, args, { cwd, env, log, allow = [0] }) {
	const fd = openSync(log, "w");
	let result;
	try {
		result = spawnSync(command, args, { cwd, env, stdio: ["ignore", fd, fd] });
	} finally {
		closeSync(fd);
	}
	if (result.error) throw result.error;
	assert.ok(allow.includes(result.status), `${command} ${args.join(" ")} failed: ${result.status}; see ${log}`);
	return result.status;
}

function environment(root) {
	const home = join(root, "home");
	const temp = join(root, "tmp");
	mkdirSync(home, { recursive: true });
	mkdirSync(temp, { recursive: true });
	return {
		PATH: process.env.PATH, HOME: home, TMPDIR: temp, PI_CODING_AGENT_DIR: join(root, "agent"), PI_TELEMETRY: "0",
		npm_config_cache: join(root, "npm-cache"), npm_config_registry: "https://registry.npmjs.org/",
	};
}

function dependencyShape(manifest) {
	return Object.fromEntries(["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundledDependencies"]
		.map((key) => [key, manifest[key] ?? null]));
}

function runtimeLock(ref, env) {
	const lock = JSON.parse(captured("git", ["show", `${ref}:package-lock.json`], { cwd: process.cwd(), env }));
	assert.ok(lock.packages && typeof lock.packages === "object", "npm lockfile has no package graph");
	return Object.fromEntries(Object.entries(lock.packages).filter(([path, entry]) => path && !entry.dev));
}

function inspectScope(scope, directory, env, evidence) {
	assert.equal(scope.mode, "release", "Expected release-review inputs");
	assert.equal(hash(scope.tarball), scope.candidateSha256, "Candidate tarball changed");
	assert.equal(hash(scope.previousTarball), scope.previousTarballSha256, "Previously published tarball changed");
	assert.equal(hash(scope.patch), scope.diffSha256, "Release source diff changed");
	assert.equal(hash(scope.candidateManifest), scope.candidateManifestSha256, "Candidate receipt changed");
	const receipt = json(scope.candidateManifest);
	assert.equal(receipt.sha256, scope.candidateSha256);
	assert.equal(receipt.source, scope.head);
	const oldDir = join(directory, "previous");
	const newDir = join(directory, "candidate");
	mkdirSync(oldDir); mkdirSync(newDir);
	run("tar", ["-xzf", scope.previousTarball, "-C", oldDir], { cwd: directory, env, log: join(evidence, "extract-previous.log") });
	run("tar", ["-xzf", scope.tarball, "-C", newDir], { cwd: directory, env, log: join(evidence, "extract-candidate.log") });
	const oldPackage = join(oldDir, "package"), newPackage = join(newDir, "package");
	const previous = json(join(oldPackage, "package.json")), candidate = json(join(newPackage, "package.json"));
	assert.equal(previous.name, receipt.name);
	assert.equal(candidate.name, receipt.name);
	assert.equal(candidate.version, receipt.version);
	const reasons = [];
	if (JSON.stringify(dependencyShape(previous)) !== JSON.stringify(dependencyShape(candidate))) reasons.push("runtime dependency metadata changed");
	if (!isDeepStrictEqual(runtimeLock(scope.base, env), runtimeLock(scope.head, env))) reasons.push("runtime lockfile graph changed");
	const oldBundle = join(oldPackage, "node_modules"), newBundle = join(newPackage, "node_modules");
	if (existsSync(oldBundle) !== existsSync(newBundle)) reasons.push("bundled dependency files changed");
	else if (existsSync(oldBundle) && run("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--quiet", "--no-ext-diff",
		"--no-textconv", "--", oldBundle, newBundle], { cwd: directory, env, log: join(evidence, "bundle-diff.log"), allow: [0, 1] }) === 1) {
		reasons.push("bundled dependency files changed");
	}
	if (readFileSync(scope.patch, "utf8").split("\n").some((line) => /^[+-](?![+-]).*\bzod\b/i.test(line))) reasons.push("added or removed source line mentions Zod");
	return { receipt, candidatePath: newPackage, reasons };
}

function main() {
	const { values } = parseArgs({ options: { scope: { type: "string" }, receipt: { type: "string" }, pi: { type: "string" } } });
	assert.ok(values.scope && values.receipt && values.pi, "Use --scope <release-review scope.json> --receipt <path> --pi <official CLI>");
	const scopePath = resolve(values.scope), scope = json(scopePath);
	const receiptPath = resolve(values.receipt), evidence = dirname(receiptPath);
	const complete = (result) => {
		writeJson(receiptPath, result);
		writeJson(scopePath, { ...scope, reviewContext: { path: receiptPath, sha256: hash(receiptPath) } });
	};
	mkdirSync(evidence, { recursive: true });
	let result = { status: "pending", source: scope.head, candidateSha256: scope.candidateSha256 };
	writeJson(receiptPath, result);
	const directory = mkdtempSync(join(tmpdir(), "cursor-zod-installers-"));
	const baseEnv = environment(directory);
	try {
		const { receipt, candidatePath, reasons } = inspectScope(scope, directory, baseEnv, evidence);
		result = { status: reasons.length ? "running" : "skipped", source: scope.head, releaseSource: scope.releaseSource,
			candidateSha256: scope.candidateSha256, previousTarballSha256: scope.previousTarballSha256,
			diffSha256: scope.diffSha256, runId: scope.runId, runAttempt: scope.runAttempt, reasons, modes: [] };
		if (!reasons.length) {
			complete({ ...result, reason: "Runtime dependency metadata, lockfile graph, and bundled files are unchanged. No changed source line mentions Zod." });
			console.log(`Zod installer qualification skipped: ${receiptPath}`);
			return;
		}
		const pi = realpathSync(resolve(values.pi));
		assert.equal(hash(pi), receipt.hosts.official.cliSha256, "Official Pi CLI differs from the selected release host");
		result.tools = { node: process.version, npm: captured("npm", ["--version"], { cwd: directory, env: baseEnv }),
			pnpm: captured("pnpm", ["--version"], { cwd: directory, env: baseEnv }),
			bun: captured("bun", ["--version"], { cwd: directory, env: baseEnv }),
			pi: captured(pi, ["--version"], { cwd: directory, env: baseEnv }), piSha256: hash(pi) };
		const verifier = resolve("scripts/lib/verify-release-install.mjs");
		for (const [name, manager] of [["npm", null], ["pi-npm", "npm"], ["npm-omit-peer", null], ["pi-pnpm", "pnpm"], ["pi-bun", "bun"]]) {
			const root = join(directory, name), env = environment(root);
			mkdirSync(root, { recursive: true });
			const installLog = join(evidence, `${name}-install.log`);
			let installed;
			if (manager) {
				mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
				writeJson(join(env.PI_CODING_AGENT_DIR, "settings.json"), { npmCommand: [manager] });
				run(pi, ["install", "-l", "--approve", `npm:${receipt.name}@file:${scope.tarball}`], { cwd: root, env, log: installLog });
				installed = join(root, ".pi/npm/node_modules", receipt.name);
			} else {
				writeJson(join(root, "package.json"), { name: "cursor-release-consumer", private: true });
				const args = ["install", "--no-audit", "--no-fund", ...(name === "npm-omit-peer" ? ["--omit=peer"] : []), scope.tarball];
				run("npm", args, { cwd: root, env, log: installLog });
				installed = join(root, "node_modules", receipt.name);
			}
			const proofs = {};
			for (const [runtime, executable] of [["node", process.execPath], ["bun", "bun"]]) {
				const log = join(evidence, `${name}-${runtime}.json`);
				run(executable, [verifier, installed, candidatePath], { cwd: root, env, log });
				proofs[runtime] = { path: log, sha256: hash(log), result: json(log) };
			}
			result.modes.push({ name, installLog, installLogSha256: hash(installLog), proofs });
		}
		assert.equal(hash(scope.tarball), scope.candidateSha256, "Candidate tarball changed during installer qualification");
		assert.equal(hash(scope.previousTarball), scope.previousTarballSha256, "Previously published tarball changed during installer qualification");
		assert.equal(hash(scope.patch), scope.diffSha256, "Source diff changed during installer qualification");
		result.status = "passed";
		complete(result);
		console.log(`Zod installer qualification passed: ${receiptPath}`);
	} catch (error) {
		writeJson(receiptPath, { ...result, status: "failed",
			error: error instanceof Error ? error.message : String(error) });
		throw error;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

main();
