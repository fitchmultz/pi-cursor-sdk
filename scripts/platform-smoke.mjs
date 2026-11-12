#!/usr/bin/env node

import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { platformSmokeSuiteEvidence, prunePlatformSmokeArtifacts, redactSecrets, writeLatestPlatformSmokeIndex } from "./platform-smoke/artifacts.mjs";

// ── helpers ────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const require = createRequire(import.meta.url);
let config;
try {
	config = require(resolve(repoRoot, "platform-smoke.config.mjs"));
	if (config.default) config = config.default;
} catch (err) {
	config = null;
}

function printHelp() {
	const targetList = (config?.requiredTargets ?? ["macos", "ubuntu"]).join(",");
	const suiteList = (config?.requiredSuites ?? []).join(",");
	console.log(`Usage: node scripts/platform-smoke.mjs <command> [options]

Commands:
  doctor                     Run all preflight checks (no Cursor tokens)
  run --target <names>       Run one or more comma-separated targets sequentially
  run --suite <name>         Run one suite on all or specified targets
  run --target <n> --suite <n>

Options:
  --target       Comma-separated target names: ${targetList}
  --suite        Suite name: ${suiteList}
  --help, -h     Show this help

Examples:
  node scripts/platform-smoke.mjs doctor
  node scripts/platform-smoke.mjs run --target macos
  node scripts/platform-smoke.mjs run --target macos,ubuntu
  node scripts/platform-smoke.mjs run --suite platform-build
  node scripts/platform-smoke.mjs run --target macos --suite cursor-local-resume-restart
  node scripts/platform-smoke.mjs run --target macos --suite cursor-native-visual-matrix

Environment:
  PLATFORM_SMOKE_CRABBOX         Path to Crabbox binary
  CURSOR_API_KEY                 Cursor auth key (required for live suites)
  PLATFORM_SMOKE_MAC_HOST         macOS SSH host (default: localhost)
  PLATFORM_SMOKE_MAC_USER         macOS SSH user (default: \$USER)
  PLATFORM_SMOKE_MAC_WORK_ROOT    macOS work root
  PLATFORM_SMOKE_UBUNTU_IMAGE     Ubuntu container image
`);
}

function parseArgs(argv) {
	const args = { target: null, suite: null, command: null };
	let i = 2;
	while (i < argv.length) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") return { ...args, command: "help" };
		if (arg === "doctor" || arg === "run") {
			if (args.command) {
				throw new Error(`${args.command === arg ? "duplicate" : "conflicting"} command token: ${arg}`);
			}
			args.command = arg;
			i++;
			continue;
		}
		if (arg === "--target" || arg === "--suite") {
			const key = arg.slice(2);
			if (args[key] !== null) throw new Error(`duplicate ${arg}`);
			const value = argv[i + 1];
			if (!value?.trim() || value.startsWith("-") || value === "doctor" || value === "run") {
				throw new Error(`${arg} requires a value`);
			}
			args[key] = value;
			i += 2;
			continue;
		}
		throw new Error(`${arg.startsWith("-") ? "unknown option" : "unknown positional argument"}: ${arg}`);
	}
	if (args.command === "doctor" && (args.target !== null || args.suite !== null)) {
		throw new Error("doctor does not accept --target or --suite");
	}
	if (!args.command && (args.target !== null || args.suite !== null)) {
		throw new Error("--target and --suite require the run command");
	}
	return args;
}

function validateSelections(targets, suites) {
	if (targets.length === 0 || targets.some((target) => !target)) throw new Error("--target requires nonempty target names");
	if (new Set(targets).size !== targets.length) throw new Error("--target contains duplicate target names");
	if (suites.length === 0 || suites.some((suite) => !suite)) throw new Error("--suite requires a suite name");
	const allowedTargets = new Set(config.requiredTargets ?? []);
	const allowedSuites = new Set(config.requiredSuites ?? []);
	const badTargets = targets.filter((target) => !allowedTargets.has(target));
	const badSuites = suites.filter((suite) => !allowedSuites.has(suite));
	if (badTargets.length > 0) {
		throw new Error(`unknown target(s): ${badTargets.join(", ")}; allowed: ${[...allowedTargets].join(", ")}`);
	}
	if (badSuites.length > 0) {
		throw new Error(`unknown suite(s): ${badSuites.join(", ")}; allowed: ${[...allowedSuites].join(", ")}`);
	}
}

function failedSuiteResults(result) {
	if (!result) return [];
	if (Array.isArray(result.results)) return result.results.filter((suiteResult) => suiteResult?.ok !== true);
	return result.ok === true ? [] : [result];
}

function formatExistingPath(label, path) {
	return path && existsSync(path) ? `  ${label}: ${path}` : undefined;
}

function printFailureEvidence(results, artifactRoot) {
	const failed = [];
	for (const { targetName, result } of results) {
		let targetEvidenceCount = 0;
		for (const suiteResult of failedSuiteResults(result)) {
			const evidence = platformSmokeSuiteEvidence(suiteResult, artifactRoot);
			if (evidence) {
				targetEvidenceCount++;
				failed.push({ targetName, ...evidence });
			}
		}
		if (targetEvidenceCount === 0 && result?.ok !== true && result?.error) {
			failed.push({ targetName, suite: "target", error: result.error });
		}
	}
	if (failed.length === 0) return;
	console.log("\nFailed suite artifacts:");
	for (const item of failed) {
		const paths = item.paths ?? {};
		console.log(`- Suite: ${item.targetName}/${item.suite}`);
		if (item.error) console.log(`  Target error: ${item.error}`);
		const lines = [
			formatExistingPath("Artifact dir", item.artifactDir),
			formatExistingPath("Assertions", paths.assertions),
			formatExistingPath("Failures", paths.failures),
			formatExistingPath("Terminal HTML", paths.terminalHtml),
			formatExistingPath("Terminal full PNG", paths.terminalFullPng),
			formatExistingPath("Terminal final viewport PNG", paths.terminalFinalViewportPng),
			formatExistingPath("Visual evidence", paths.visualEvidence),
			formatExistingPath("Session JSONL", paths.sessionJsonl),
			formatExistingPath("JSONL tool results", paths.jsonlToolResults),
			formatExistingPath("Provider/Cursor debug artifacts", paths.providerDebugRoot),
		].filter(Boolean);
		for (const line of lines) console.log(line);
	}
}

// ── commands ───────────────────────────────────────────────────────────────
async function runDoctor() {
	try {
		const { runDoctor } = await import("./platform-smoke/doctor.mjs");
		await runDoctor(config);
	} catch (err) {
		if (err.code === "ERR_MODULE_NOT_FOUND") {
			console.error("doctor module not found. Is scripts/platform-smoke/doctor.mjs present?");
		} else {
			console.error("doctor failed:", err.message);
		}
		process.exit(1);
	}
}

async function runSuite(targetName, suiteName) {
	try {
		const { runTargetSuite } = await import("./platform-smoke/targets.mjs");
		const result = await runTargetSuite(config, targetName, suiteName);
		return result;
	} catch (err) {
		const message = redactSecrets(err.message);
		console.error(`suite ${suiteName} on ${targetName} exception:`, message);
		return { ok: false, error: message };
	}
}

async function runTarget(targetName, suites) {
	try {
		const { runTargetSuites } = await import("./platform-smoke/targets.mjs");
		return await runTargetSuites(config, targetName, suites);
	} catch (err) {
		const message = redactSecrets(err.message);
		console.error(`target ${targetName} exception:`, message);
		return { ok: false, error: message };
	}
}

async function main() {
	let args;
	try {
		args = parseArgs(process.argv);
	} catch (err) {
		console.error(`usage error: ${err.message}`);
		process.exit(2);
	}

	if (!args.command || args.command === "help") {
		printHelp();
		process.exit(args.command === "help" ? 0 : 1);
	}

	if (!config) {
		console.error("platform-smoke.config.mjs not found or failed to load");
		process.exit(1);
	}

	if (args.command === "doctor") {
		await runDoctor();
		return;
	}

	if (args.command === "run") {
		const targets = args.target
			? args.target.split(",").map((s) => s.trim())
			: config.requiredTargets;

		const suites = args.suite
			? [args.suite]
			: config.requiredSuites;

		try {
			validateSelections(targets, suites);
		} catch (err) {
			console.error(`usage error: ${err.message}`);
			process.exit(2);
		}

		const pruneResult = prunePlatformSmokeArtifacts(config.artifactRoot, config.artifactRetention);
		if (pruneResult.removed.length > 0) {
			console.log(`Pruned ${pruneResult.removed.length} old platform smoke artifact run(s) from ${pruneResult.root}`);
		}

		const startedAt = new Date().toISOString();
		const results = [];
		for (const targetName of targets) {
			console.log(`\n=== Target: ${targetName} ===`);
			const result = args.suite
				? await runSuite(targetName, suites[0])
				: await runTarget(targetName, suites);
			results.push({ targetName, result });
		}
		const finishedAt = new Date().toISOString();
		const latest = writeLatestPlatformSmokeIndex(config, results, {
			startedAt,
			finishedAt,
			command: {
				cwd: process.cwd(),
				targets,
				suites,
			},
		});
		console.log(`\nArtifact index: ${latest.path}`);
		const anyFailed = results.some(({ result }) => !result.ok);
		if (anyFailed) {
			printFailureEvidence(results, config.artifactRoot);
			console.log("\nOne or more suites failed.");
			process.exit(1);
		}
		return;
	}

	console.error(`Unknown command: ${args.command}`);
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
