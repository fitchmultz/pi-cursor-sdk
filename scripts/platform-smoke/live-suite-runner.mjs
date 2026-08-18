#!/usr/bin/env node
/**
 * Remote live suite runner for platform smoke.
 *
 * Runs inside a Crabbox target. It installs the packed extension into a
 * run-scoped pi agent dir, drives pi through node-pty/ConPTY, and prints a
 * base64 artifact bundle for the host-side platform-smoke runner to unpack and
 * render.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { redactSecrets, writePlatformArtifactBundle } from "./artifacts.mjs";
import { extractContentText, jsonlHasAssistantFinalTextMarker } from "./jsonl-text.mjs";
import { getScenario, renderPrompt } from "./scenarios.mjs";

const DEFAULT_MODEL = "cursor/grok-4.6";
const DEFAULT_WAIT_MS = 240_000;
const SESSION_JSONL_WAIT_MS = 60_000;
const COLS = 150;
const ROWS = 45;

function writeRedactedTextFile(path, text) {
	writeFileSync(path, redactSecrets(text ?? ""));
}

function usage() {
	console.log(`Run one live platform-smoke suite inside a Crabbox target.

Usage:
  node scripts/platform-smoke/live-suite-runner.mjs --suite SUITE --target TARGET [options]

Options:
  --suite <name>      Required suite name.
  --target <name>     Required target name.
  --model <id>        Cursor model id. Default: ${DEFAULT_MODEL}.
  --package-name <n>  Packed package name. Default: pi-cursor-sdk.
  --out-dir <dir>     Remote artifact dir. Default: .platform-smoke-runs/live-<suite>-<timestamp>.
  --prep-dir <dir>    Optional shared packed-install prep dir reused by live suites on one target.
  --prepare-only      Prepare/reuse --prep-dir and print the packed package path without a live run.
  --wait-ms <ms>      Max wait for final marker. Default: ${DEFAULT_WAIT_MS}.
  -h, --help          Show help.
`);
}

function fail(message, code = 2) {
	console.error(`[platform-live] ${message}`);
	process.exit(code);
}

function parseArgs(argv) {
	const out = { model: DEFAULT_MODEL, packageName: "pi-cursor-sdk", waitMs: DEFAULT_WAIT_MS };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") {
			out.help = true;
			continue;
		}
		const next = () => {
			const value = argv[++i];
			if (!value) fail(`${arg} requires a value`);
			return value;
		};
		switch (arg) {
			case "--suite": out.suite = next(); break;
			case "--target": out.target = next(); break;
			case "--model": out.model = next(); break;
			case "--package-name": out.packageName = next(); break;
			case "--out-dir": out.outDir = resolve(next()); break;
			case "--prep-dir": out.prepDir = resolve(next()); break;
			case "--prepare-only": out.prepareOnly = true; break;
			case "--wait-ms": out.waitMs = Number(next()); break;
			default: fail(`unknown argument: ${arg}`);
		}
	}
	if (out.help) return out;
	if (!out.prepareOnly && !out.suite) fail("--suite is required");
	if (!out.target) fail("--target is required");
	if (out.prepareOnly && !out.prepDir) fail("--prepare-only requires --prep-dir");
	if (!Number.isSafeInteger(out.waitMs) || out.waitMs <= 0) fail("--wait-ms must be a positive integer");
	out.outDir ??= resolve(".platform-smoke-runs", `live-${out.suite}-${Date.now()}`);
	return out;
}

function platformForTarget(target) {
	return target === "windows-native" ? "powershell" : "posix";
}

function commandName(name) {
	return process.platform === "win32" ? `${name}.cmd` : name;
}

function runLogged(logDir, label, command, args, options = {}) {
	const startedAt = Date.now();
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? process.cwd(),
		env: options.env ?? process.env,
		encoding: "utf8",
		shell: options.shell ?? (process.platform === "win32" && /(?:^|[\\/])(?:npm|npx|pi)\.cmd$/i.test(command)),
		timeout: options.timeout ?? 300_000,
	});
	const safeLabel = label.replace(/[^A-Za-z0-9_.-]+/g, "-");
	writeRedactedTextFile(join(logDir, `${safeLabel}.stdout.txt`), result.stdout ?? "");
	writeRedactedTextFile(join(logDir, `${safeLabel}.stderr.txt`), result.stderr ?? (result.error?.message ?? ""));
	writeFileSync(join(logDir, `${safeLabel}.json`), JSON.stringify({
		label,
		command,
		args,
		cwd: options.cwd ?? process.cwd(),
		status: result.status,
		signal: result.signal,
		error: result.error?.message,
		elapsedMs: Date.now() - startedAt,
	}, null, 2));
	return result;
}

function requireOk(result, label) {
	if (result.status !== 0) {
		throw new Error(`${label} exited ${result.status ?? "null"}: ${(result.stderr || result.stdout || result.error?.message || "").slice(-1000)}`);
	}
}

function resolvePiCli() {
	const local = resolve(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
	return existsSync(local) ? local : commandName("pi");
}

function hasInstalledDependencies() {
	return existsSync(resolve(process.cwd(), "node_modules", ".package-lock.json"))
		&& existsSync(resolve(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi"));
}

function ensureNodePtySpawnHelperExecutable(logDir) {
	if (process.platform === "win32") return;
	const candidates = [
		resolve(process.cwd(), "node_modules", "node-pty", "build", "Release", "spawn-helper"),
		resolve(process.cwd(), "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
	];
	const repaired = [];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		chmodSync(candidate, 0o755);
		repaired.push(candidate);
	}
	writeFileSync(join(logDir, "node-pty-spawn-helper.json"), JSON.stringify({ repaired }, null, 2));
}

function copyFixtureWorkspace(workspaceDir) {
	mkdirSync(workspaceDir, { recursive: true });
	for (const file of ["package.json", "README.md"]) {
		writeFileSync(join(workspaceDir, file), readFileSync(resolve(process.cwd(), file)));
	}
	copyDir(resolve(process.cwd(), "src"), join(workspaceDir, "src"));
	mkdirSync(join(workspaceDir, ".debug", "platform-smoke"), { recursive: true });
}

function copyDir(src, dest) {
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const from = join(src, entry.name);
		const to = join(dest, entry.name);
		if (entry.isDirectory()) copyDir(from, to);
		else if (entry.isFile()) writeFileSync(to, readFileSync(from));
	}
}

function readJsonFile(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function writeSkippedLog(logDir, label, reason, extra = {}) {
	const safeLabel = label.replace(/[^A-Za-z0-9_.-]+/g, "-");
	writeFileSync(join(logDir, `${safeLabel}.stdout.txt`), `skipped: ${reason}\n`);
	writeFileSync(join(logDir, `${safeLabel}.stderr.txt`), "");
	writeFileSync(join(logDir, `${safeLabel}.json`), JSON.stringify({ label, skipped: true, reason, ...extra }, null, 2));
}

function ensureTargetDependencies(logDir) {
	if (hasInstalledDependencies()) {
		writeSkippedLog(logDir, "npm-ci", "node_modules already prepared by target session");
		return;
	}
	const npmCi = runLogged(logDir, "npm-ci", commandName("npm"), ["ci"], { timeout: 300_000 });
	requireOk(npmCi, "npm ci");
}

function prepareSharedPackedInstall(prepDir, logDir, artifactDir, packageName) {
	const readyPath = join(prepDir, "ready.json");
	const ready = readJsonFile(readyPath);
	if (ready?.packageName === packageName && typeof ready.packagePath === "string" && existsSync(ready.packagePath)) {
		writeSkippedLog(logDir, "shared-prep", "reusing target shared packed install", { prepDir, packagePath: ready.packagePath });
		writeFileSync(join(artifactDir, "packed-tarball.txt"), `${ready.tarball ?? ""}\n`);
		return ready;
	}

	rmSync(prepDir, { recursive: true, force: true });
	const prepPackDir = join(prepDir, "pack");
	const prepWorkspaceDir = join(prepDir, "packed-workspace");
	for (const dir of [prepDir, prepPackDir, prepWorkspaceDir]) mkdirSync(dir, { recursive: true });

	ensureTargetDependencies(logDir);
	ensureNodePtySpawnHelperExecutable(logDir);

	const pack = runLogged(logDir, "npm-pack", commandName("npm"), ["pack", "--silent"], { timeout: 120_000 });
	requireOk(pack, "npm pack");
	const tarball = pack.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
	if (!tarball || !existsSync(resolve(process.cwd(), tarball))) throw new Error("npm pack did not produce a tarball");
	const tarballPath = resolve(prepPackDir, tarball);
	writeFileSync(tarballPath, readFileSync(resolve(process.cwd(), tarball)));
	rmSync(resolve(process.cwd(), tarball), { force: true });
	writeFileSync(join(artifactDir, "packed-tarball.txt"), `${tarball}\n`);

	copyFixtureWorkspace(prepWorkspaceDir);
	const npmInit = runLogged(logDir, "shared-workspace-npm-init", commandName("npm"), ["init", "-y"], { cwd: prepWorkspaceDir, timeout: 60_000 });
	requireOk(npmInit, "shared workspace npm init");
	const npmInstallPacked = runLogged(logDir, "shared-workspace-npm-install-packed", commandName("npm"), ["install", "--no-save", tarballPath], { cwd: prepWorkspaceDir, timeout: 180_000 });
	requireOk(npmInstallPacked, "shared workspace npm install packed tarball");
	const packagePath = join(prepWorkspaceDir, "node_modules", packageName);
	if (!existsSync(packagePath)) throw new Error(`packed package install did not create ${packagePath}`);

	const prepared = {
		packageName,
		tarball,
		tarballPath,
		packagePath,
		preparedAt: new Date().toISOString(),
	};
	writeFileSync(readyPath, JSON.stringify(prepared, null, 2));
	return prepared;
}

function stripANSI(text) {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

function ptySpawnCommand(args) {
	const cliEntry = resolve(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	if (!existsSync(cliEntry)) throw new Error(`Pi CLI entry not found: ${cliEntry}`);
	return { file: process.execPath, args: [cliEntry, ...args] };
}

async function waitForSessionJsonl(sessionDir, finalMarker, startedAt, events) {
	const waitStartedAt = Date.now();
	let files = [];
	while (Date.now() - waitStartedAt < SESSION_JSONL_WAIT_MS) {
		files = findJsonlFiles(sessionDir);
		if (files.length > 0) {
			if (!finalMarker) break;
			for (const file of files) {
				try {
					if (jsonlHasAssistantFinalTextMarker(readFileSync(file, "utf8"), finalMarker)) {
						events.push({ type: "session_jsonl_seen", elapsedMs: Date.now() - startedAt, files: files.length, finalMarker: true });
						return files;
					}
				} catch {}
			}
		}
		await delay(500);
	}
	events.push({ type: "session_jsonl_wait_finished", elapsedMs: Date.now() - startedAt, files: files.length, finalMarker: false });
	return files;
}

async function runPtyPi({ artifactDir, ptyCommand, env, cwd, sessionDir, finalMarker, waitMs, abortMode, scenario }) {
	let pty;
	try {
		pty = await import("node-pty");
	} catch (error) {
		throw new Error(`node-pty is required for live visual suites: ${error instanceof Error ? error.message : String(error)}`);
	}

	let ansi = "";
	let plain = "";
	const events = [];
	const startedAt = Date.now();
	const { file, args } = ptyCommand;
	let child;
	try {
		child = pty.spawn(file, args, {
			name: "xterm-256color",
			cols: COLS,
			rows: ROWS,
			cwd,
			env,
		});
	} catch (error) {
		throw new Error(`PTY spawn failed for ${file} (exists=${existsSync(file)}) cwd=${cwd} (exists=${existsSync(cwd)}): ${error instanceof Error ? error.message : String(error)}`);
	}
	let exitEvent;
	child.onData((data) => {
		ansi += data;
		plain += stripANSI(data);
		events.push({ type: "output", elapsedMs: Date.now() - startedAt, bytes: data.length });
	});
	child.onExit((event) => {
		exitEvent = event;
		events.push({ type: "exit", elapsedMs: Date.now() - startedAt, code: event.exitCode, signal: event.signal });
	});

	const responseStartOffset = 0;
	events.push({ type: "response_watch_started", elapsedMs: Date.now() - startedAt, offset: responseStartOffset });

	let observed = false;
	let finalMarkerSeen = false;
	let abortObserved = false;
	const abortStartedPath = join(cwd, ".debug", "platform-smoke", "abort-started.txt");
	while (Date.now() - startedAt < waitMs) {
		const currentPlain = plain;
		const responsePlain = currentPlain.slice(responseStartOffset);
		if (finalMarker && responsePlain.includes(finalMarker)) finalMarkerSeen = true;
		if (finalMarkerSeen && sessionJsonlMeetsRequirements(sessionDir, scenario) && sessionJsonlHasAssistantMarker(sessionDir, finalMarker)) {
			await waitForSessionJsonl(sessionDir, finalMarker, startedAt, events);
			if (sessionJsonlMeetsRequirements(sessionDir, scenario) && sessionJsonlHasAssistantMarker(sessionDir, finalMarker)) {
				observed = true;
				break;
			}
		}
		if (abortMode && existsSync(abortStartedPath)) {
			abortObserved = true;
			child.write("\x03");
			events.push({ type: "interrupt_sent", elapsedMs: Date.now() - startedAt });
			await delay(5_000);
			break;
		}
		if (exitEvent) break;
		await delay(500);
	}

	if (!exitEvent) {
		child.write("/quit\r");
		events.push({ type: "quit_command_sent", elapsedMs: Date.now() - startedAt });
		const exitWaitStarted = Date.now();
		while (!exitEvent && Date.now() - exitWaitStarted < 10_000) await delay(500);
	}
	if (!exitEvent) {
		child.write("\x04");
		events.push({ type: "eof_sent", elapsedMs: Date.now() - startedAt });
		const exitWaitStarted = Date.now();
		while (!exitEvent && Date.now() - exitWaitStarted < 5_000) await delay(500);
	}
	if (!exitEvent) {
		child.write("\x03");
		events.push({ type: "interrupt_exit_sent", elapsedMs: Date.now() - startedAt });
		const exitWaitStarted = Date.now();
		while (!exitEvent && Date.now() - exitWaitStarted < 5_000) await delay(500);
	}
	if (!exitEvent) {
		if (process.platform === "win32") {
			const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", timeout: 10_000 });
			events.push({ type: "taskkill_sent", elapsedMs: Date.now() - startedAt, pid: child.pid, status: result.status, stderr: result.stderr?.slice(0, 500) });
		} else {
			try { child.kill(); } catch {}
			events.push({ type: "kill_sent", elapsedMs: Date.now() - startedAt });
		}
	}
	await waitForSessionJsonl(sessionDir, null, startedAt, events);
	await delay(1_000);

	writeRedactedTextFile(join(artifactDir, "terminal.ansi"), ansi);
	writeRedactedTextFile(join(artifactDir, "terminal.txt"), plain);
	writeFileSync(join(artifactDir, "pty.events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
	writeFileSync(join(artifactDir, "pty.exit.json"), JSON.stringify(exitEvent ?? null, null, 2));
	return { observed, abortObserved, exitEvent, plain };
}

function sessionJsonlHasAssistantMarker(sessionDir, finalMarker) {
	if (!finalMarker) return true;
	for (const file of findJsonlFiles(sessionDir)) {
		let raw;
		try { raw = readFileSync(file, "utf8"); } catch { continue; }
		if (jsonlHasAssistantFinalTextMarker(raw, finalMarker)) return true;
	}
	return false;
}

function sessionJsonlMeetsRequirements(sessionDir, scenario) {
	const required = scenario?.requiredJSONLResults ?? [];
	if (required.length === 0) return true;
	const raw = findJsonlFiles(sessionDir).map((file) => {
		try { return readFileSync(file, "utf8"); } catch { return ""; }
	}).join("\n");
	if (!raw.trim()) return false;
	const results = collectJsonlToolResults(raw);
	return required.every((requirement) => results.some((result) => matchesJsonlResult(result, requirement)));
}

function collectJsonlToolResults(jsonlRaw) {
	const results = [];
	for (const line of jsonlRaw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		const message = event?.message;
		if (message?.role !== "toolResult" || typeof message.toolName !== "string") continue;
		results.push({
			toolName: message.toolName,
			isError: message.isError === true,
			sourceToolName: message.details?.sourceToolName,
			path: message.details?.path,
			contentText: extractContentText(message.content),
		});
	}
	return results;
}

function matchesJsonlResult(result, requirement) {
	if (requirement.toolName && result.toolName !== requirement.toolName) return false;
	if (requirement.sourceToolName && result.sourceToolName !== requirement.sourceToolName) return false;
	if (typeof requirement.isError === "boolean" && result.isError !== requirement.isError) return false;
	const haystack = `${result.contentText}\n${result.path ?? ""}`;
	if (requirement.contains && !haystack.includes(requirement.contains)) return false;
	if (requirement.pattern && !(new RegExp(requirement.pattern, requirement.flags ?? "i")).test(haystack)) return false;
	return true;
}

function findJsonlFiles(root) {
	const out = [];
	function visit(dir) {
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
		}
	}
	visit(root);
	out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return out;
}

function writeJsonlArtifacts(artifactDir, sessionDir) {
	const jsonlFiles = findJsonlFiles(sessionDir);
	writeRedactedTextFile(join(artifactDir, "session-jsonl-files.txt"), jsonlFiles.join("\n") + (jsonlFiles.length ? "\n" : ""));
	if (jsonlFiles[0]) {
		writeRedactedTextFile(join(artifactDir, "session.jsonl"), readFileSync(jsonlFiles[0], "utf8"));
	}
	return jsonlFiles;
}

function writeProcessSnapshot(logDir, name, platform) {
	const startedAt = Date.now();
	const result = platform === "powershell"
		? spawnSync("powershell.exe", [
			"-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
			"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
		], { encoding: "utf8", timeout: 90_000 })
		: spawnSync("sh", ["-lc", "ps -axo pid,ppid,comm,args"], { encoding: "utf8", timeout: 30_000 });
	writeRedactedTextFile(join(logDir, `${name}.stdout.txt`), result.stdout ?? "");
	writeRedactedTextFile(join(logDir, `${name}.stderr.txt`), result.stderr ?? "");
	writeFileSync(join(logDir, `${name}.json`), JSON.stringify({ label: name, status: result.status, signal: result.signal, durationMs: Date.now() - startedAt, error: result.error?.message }, null, 2));
	requireOk({ status: result.status, stderr: result.stderr, error: result.error }, `${name} snapshot`);
}

function assertNoAbortLeftover(logDir, platform) {
	if (platform === "powershell") {
		const result = runLogged(logDir, "leftover-process-check", "powershell.exe", [
			"-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
			"$self = $PID; $p = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -match 'PLATFORM_ABORT_MARKER' }; if ($p) { $p | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress; exit 1 }",
		], { timeout: 30_000 });
		requireOk(result, "leftover process check");
		return;
	}
	const result = runLogged(logDir, "leftover-process-check", "sh", ["-lc", "if ps -axo pid,command | grep PLATFORM_ABORT_MARKER | grep -v grep; then exit 1; fi"], { timeout: 30_000 });
	requireOk(result, "leftover process check");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		usage();
		return;
	}
	if (args.prepareOnly) {
		const bootstrapDir = `${args.prepDir}-bootstrap`;
		const logDir = join(bootstrapDir, "logs");
		const artifactDir = join(bootstrapDir, "artifacts");
		mkdirSync(logDir, { recursive: true });
		mkdirSync(artifactDir, { recursive: true });
		const prep = prepareSharedPackedInstall(args.prepDir, logDir, artifactDir, args.packageName);
		console.log(`PLATFORM_PACKED_PACKAGE_PATH=${prep.packagePath}`);
		return;
	}
	const scenario = getScenario(args.suite);
	if (!scenario) fail(`unknown suite: ${args.suite}`);
	const platform = platformForTarget(args.target);
	const runRoot = args.outDir;
	const artifactDir = join(runRoot, "artifacts");
	const logDir = join(runRoot, "logs");
	const packDir = join(runRoot, "pack");
	const workspaceDir = join(runRoot, "test-workspace");
	const piProjectDir = join(runRoot, "pi-project");
	const packageName = args.packageName;
	const agentDir = join(runRoot, "pi-agent");
	const sessionDir = join(runRoot, "session");
	const debugDir = join(runRoot, "cursor-sdk-events");
	for (const dir of [artifactDir, logDir, packDir, workspaceDir, piProjectDir, agentDir, sessionDir, debugDir]) mkdirSync(dir, { recursive: true });

	let ok = false;
	let error;
	const status = {
		suite: args.suite,
		target: args.target,
		model: args.model,
		cursorNoFast: true,
		startedAt: new Date().toISOString(),
		platform,
	};
	try {
		console.log(`[platform-live] suite=${args.suite} target=${args.target} model=${args.model}`);
		copyFixtureWorkspace(workspaceDir);
		const piEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
		let installPath = `./node_modules/${packageName}`;
		if (args.prepDir) {
			const prep = prepareSharedPackedInstall(args.prepDir, logDir, artifactDir, packageName);
			installPath = prep.packagePath;
		} else {
			ensureTargetDependencies(logDir);
			ensureNodePtySpawnHelperExecutable(logDir);
			const pack = runLogged(logDir, "npm-pack", commandName("npm"), ["pack", "--silent"], { timeout: 120_000 });
			requireOk(pack, "npm pack");
			const tarball = pack.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
			if (!tarball || !existsSync(resolve(process.cwd(), tarball))) throw new Error("npm pack did not produce a tarball");
			const tarballPath = resolve(packDir, tarball);
			writeFileSync(tarballPath, readFileSync(resolve(process.cwd(), tarball)));
			rmSync(resolve(process.cwd(), tarball), { force: true });
			writeFileSync(join(artifactDir, "packed-tarball.txt"), `${tarball}\n`);
			const npmInit = runLogged(logDir, "workspace-npm-init", commandName("npm"), ["init", "-y"], { cwd: workspaceDir, timeout: 60_000 });
			requireOk(npmInit, "workspace npm init");
			const npmInstallPacked = runLogged(logDir, "workspace-npm-install-packed", commandName("npm"), ["install", "--no-save", tarballPath], { cwd: workspaceDir, timeout: 180_000 });
			requireOk(npmInstallPacked, "workspace npm install packed tarball");
		}
		const piCli = resolvePiCli();
		const install = runLogged(logDir, "pi-install", piCli, ["install", "--approve", "-l", installPath], { cwd: workspaceDir, env: piEnv, timeout: 120_000 });
		requireOk(install, "pi install --approve packed package directory");
		const list = runLogged(logDir, "pi-list", piCli, ["list", "--approve"], { cwd: workspaceDir, env: piEnv, timeout: 60_000 });
		requireOk(list, "pi list --approve");

		const suiteEnv = {
			...process.env,
			...scenario.env,
			PI_OFFLINE: "1",
			...(args.suite === "cursor-abort-cleanup" ? { PLATFORM_ABORT_MARKER: "SHOULD_NOT_PRINT" } : {}),
			PI_CODING_AGENT_DIR: agentDir,
			PI_CURSOR_SDK_EVENT_DEBUG_DIR: debugDir,
			PI_CURSOR_PI_TOOL_BRIDGE_DEBUG_FILE: join(artifactDir, "bridge-diagnostics.jsonl"),
			TERM: "xterm-256color",
		};
		if (args.suite === "cursor-abort-cleanup") writeProcessSnapshot(logDir, "process-before", platform);
		const prompt = renderPrompt(scenario, platform);
		writeFileSync(join(artifactDir, "prompt.txt"), prompt);
		const piArgs = ["--approve", "--cursor-no-fast", "--cursor-mode", "agent", "--model", args.model, "--session-dir", sessionDir, "--session-id", `platform-${args.suite}-${Date.now()}`, prompt];
		const ptyCommand = ptySpawnCommand(piArgs);
		writeFileSync(join(artifactDir, "pi-command.json"), JSON.stringify({
			...ptyCommand,
			cwd: workspaceDir,
			fileExists: existsSync(ptyCommand.file),
			cwdExists: existsSync(workspaceDir),
			env: Object.fromEntries(Object.entries(suiteEnv).filter(([key]) => key.startsWith("PI_CURSOR_") || key === "PI_CODING_AGENT_DIR" || key === "PI_OFFLINE" || key === "TERM")),
		}, null, 2));
		const ptyResult = await runPtyPi({
			artifactDir,
			ptyCommand,
			env: suiteEnv,
			cwd: workspaceDir,
			sessionDir,
			finalMarker: scenario.finalMarker,
			waitMs: args.waitMs,
			abortMode: args.suite === "cursor-abort-cleanup",
			scenario,
		});
		const jsonlFiles = writeJsonlArtifacts(artifactDir, sessionDir);
		status.jsonlCount = jsonlFiles.length;
		status.finalMarkerObserved = ptyResult.observed;
		status.abortObserved = ptyResult.abortObserved;
		if (scenario.finalMarker && !ptyResult.observed) throw new Error(`final marker ${scenario.finalMarker} was not observed before timeout`);
		if (args.suite === "cursor-abort-cleanup") {
			const abortStartedPath = join(workspaceDir, ".debug", "platform-smoke", "abort-started.txt");
			if (existsSync(abortStartedPath)) copyFileSync(abortStartedPath, join(artifactDir, "abort-started.txt"));
			if (!ptyResult.abortObserved) throw new Error("abort suite did not observe bridge/shell process start before interrupt");
			if (ptyResult.plain.includes("SHOULD_NOT_PRINT")) throw new Error("abort suite printed SHOULD_NOT_PRINT, so cancellation did not happen in time");
			writeProcessSnapshot(logDir, "process-after", platform);
			assertNoAbortLeftover(logDir, platform);
		}
		if (jsonlFiles.length === 0) throw new Error("no pi session JSONL artifact was written");
		ok = true;
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
		console.error(`[platform-live] ${error}`);
	} finally {
		status.ok = ok;
		status.error = error;
		status.finishedAt = new Date().toISOString();
		writeFileSync(join(artifactDir, "live-status.json"), JSON.stringify(status, null, 2));
		writePlatformArtifactBundle(runRoot);
	}
	if (!ok) process.exitCode = 1;
}

main()
	.then(() => {
		process.exit(process.exitCode ?? 0);
	})
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
