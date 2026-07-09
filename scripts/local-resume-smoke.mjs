#!/usr/bin/env node
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { terminateChild } from "./lib/cursor-child-process.mjs";
import { buildCursorSmokeEnv } from "./lib/cursor-smoke-env.mjs";
import { runCleanupSmoke } from "./local-resume-cleanup-smoke.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

const LOCAL_RESUME_SMOKE_LANES = [
	{ key: "restart", script: "smoke:local-resume" },
	{ key: "safety", flag: "--safety", script: "smoke:local-resume:safety" },
	{ key: "toolSurface", flag: "--tool-surface", script: "smoke:local-resume:tool-surface" },
	{ key: "abort", flag: "--abort", script: "smoke:local-resume:abort" },
	{ key: "tree", flag: "--tree", script: "smoke:local-resume:tree" },
	{ key: "copySwitch", flag: "--copy-switch", script: "smoke:local-resume:copy-switch" },
	{ key: "fallback", flag: "--fallback", script: "smoke:local-resume:fallback" },
	{ key: "compaction", flag: "--compaction", script: "smoke:local-resume:compaction" },
	{ key: "defaultDryRun", flag: "--default-dry-run", script: "smoke:local-resume:default-dry-run" },
	{ key: "cleanup", flag: "--cleanup", script: "smoke:local-resume:cleanup" },
];

const CLOUD_RUNTIME_ENV_NAMES = [
	"PI_CURSOR_CLOUD_ACK",
	"PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE",
	"PI_CURSOR_CLOUD_CONTEXT",
	"PI_CURSOR_CLOUD_REPO",
	"PI_CURSOR_CLOUD_BRANCH",
	"PI_CURSOR_CLOUD_DIRECT_PUSH",
	"PI_CURSOR_CLOUD_ENV",
	"PI_CURSOR_CLOUD_ENV_FROM_FILES",
	"PI_CURSOR_CLOUD_ENV_TYPE",
	"PI_CURSOR_CLOUD_ENV_NAME",
];

class SmokeFailure extends Error {
	constructor(message, details = "") {
		super(message);
		this.details = details;
	}
}

function printHelp() {
	const npmUsage = LOCAL_RESUME_SMOKE_LANES.map((lane) => `  npm run ${lane.script}`).join("\n");
	const nodeUsage = LOCAL_RESUME_SMOKE_LANES.map((lane) => `  node scripts/local-resume-smoke.mjs${lane.flag ? ` ${lane.flag}` : ""}`).join("\n");
	console.log(`Live local Cursor resume smoke for pi-cursor-sdk.

Usage:
${npmUsage}
${nodeUsage}

Environment:
  CURSOR_LOCAL_RESUME_SMOKE_MODEL          Cursor model id (default: cursor/composer-2-5:slow).
  CURSOR_LOCAL_RESUME_SMOKE_TIMEOUT_MS     Timeout in ms per model turn (default: 300000).
  CURSOR_LOCAL_RESUME_SMOKE_KEEP_ARTIFACTS Keep temp artifacts when set to 1.

Exit codes:
  0  local resume proof passed
  1  auth/run/assertion failure`);
}

if (args.has("-h") || args.has("--help")) {
	printHelp();
	process.exit(0);
}

function fail(message, details = "") {
	throw new SmokeFailure(message, details);
}

function assertExactStringArray(label, actual, expected) {
	const normalizedActual = [...(actual ?? [])].sort((a, b) => a.localeCompare(b));
	const normalizedExpected = [...expected].sort((a, b) => a.localeCompare(b));
	if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
		fail(`${label} mismatch`, JSON.stringify({ expected: normalizedExpected, actual: normalizedActual }, null, 2));
	}
}

function reportFailure(error) {
	console.error(`[local-resume-smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
	if (error instanceof SmokeFailure && error.details) console.error(error.details);
}

function findPiCommand() {
	const cli = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	if (existsSync(cli)) return { command: process.execPath, argsPrefix: [cli] };
	const local = join(root, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
	return { command: existsSync(local) ? local : process.platform === "win32" ? "pi.cmd" : "pi", argsPrefix: [] };
}

export function buildLocalResumeSmokeEnv(artifactDir, { baseEnv = process.env, bridge = false, exposeBuiltinTools = false, localResumeEnv = "on" } = {}) {
	const agentDir = join(artifactDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const env = buildCursorSmokeEnv({ baseEnv, settingSources: "none", bridge, nativeToolDisplay: false, registerNativeTools: false, exposeBuiltinTools, eventDebugDir: join(artifactDir, "debug") });
	const resumeMode = localResumeEnv === true ? "on" : localResumeEnv === false ? "unset" : localResumeEnv;
	for (const name of CLOUD_RUNTIME_ENV_NAMES) delete env[name];
	delete env.PI_CURSOR_LOCAL_RESUME;
	if (resumeMode === "on") env.PI_CURSOR_LOCAL_RESUME = "1";
	else if (resumeMode === "off") env.PI_CURSOR_LOCAL_RESUME = "0";
	else if (resumeMode !== "unset") fail(`unknown localResumeEnv mode: ${String(localResumeEnv)}`);
	return {
		...env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CURSOR_RUNTIME: "local",
	};
}

function startRpc({ artifactDir, sessionDir, sessionId, bridge = false, exposeBuiltinTools = false, extraExtensions = [], localResumeEnv = "on", baseEnv = process.env }) {
	const model = process.env.CURSOR_LOCAL_RESUME_SMOKE_MODEL || "cursor/composer-2-5:slow";
	const workspaceDir = join(artifactDir, "workspace");
	mkdirSync(workspaceDir, { recursive: true });
	const pi = findPiCommand();
	const child = spawn(
		pi.command,
		[...pi.argsPrefix, "--mode", "rpc", "-e", root, ...extraExtensions.flatMap((path) => ["-e", path]), "--model", model, "--cursor-runtime", "local", "--approve", "--session-dir", sessionDir, "--session-id", sessionId],
		{ cwd: workspaceDir, env: buildLocalResumeSmokeEnv(artifactDir, { baseEnv, bridge, exposeBuiltinTools, localResumeEnv }), stdio: ["pipe", "pipe", "pipe"] },
	);
	let stdoutBuffer = "";
	let stderr = "";
	const events = [];
	const pending = new Map();
	let requestId = 0;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk;
		let newlineIndex;
		while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
			const line = stdoutBuffer.slice(0, newlineIndex);
			stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
			if (!line.trim()) continue;
			let message;
			try { message = JSON.parse(line); } catch { continue; }
			if (message.type === "response" && pending.has(message.id)) {
				const request = pending.get(message.id);
				pending.delete(message.id);
				clearTimeout(request.timer);
				request.resolve(message);
				continue;
			}
			events.push(message);
		}
	});
	const send = (type, extra = {}, timeoutMs = 120000) => new Promise((resolveRequest, rejectRequest) => {
		const id = `local_resume_smoke_${++requestId}`;
		const timer = setTimeout(() => {
			pending.delete(id);
			rejectRequest(new Error(`timeout waiting for ${type}. Stderr: ${stderr}`));
		}, timeoutMs);
		pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
		child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
	});
	const stop = async () => {
		for (const request of pending.values()) clearTimeout(request.timer);
		pending.clear();
		await terminateChild(child);
	};
	return { events, send, stop, get stderr() { return stderr; } };
}

async function waitForAgentEnd(rpc, fromIndex, timeoutMs) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (rpc.events.slice(fromIndex).some((event) => event.type === "agent_end")) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	throw new Error(`timeout waiting for agent_end. Stderr: ${rpc.stderr}`);
}

async function waitForFile(path, timeoutMs, rpc) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (existsSync(path)) return;
		if (rpc?.events.some((event) => event.type === "agent_end")) fail(`agent ended before ${path} existed`, rpc.stderr);
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	fail(`timeout waiting for ${path}`, rpc?.stderr ?? "");
}

function metadataFiles(artifactDir) {
	const files = [];
	const stack = [join(artifactDir, "debug")];
	while (stack.length > 0) {
		const current = stack.pop();
		try {
			for (const entry of readdirSync(current, { withFileTypes: true })) {
				const path = join(current, entry.name);
				if (entry.isDirectory()) stack.push(path);
				else if (entry.name === "metadata.json") files.push(path);
			}
		} catch {}
	}
	return files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

function readMetadataSince(artifactDir, seenPaths) {
	return metadataFiles(artifactDir)
		.filter((metadataPath) => !seenPaths.has(metadataPath))
		.map((metadataPath) => ({ metadataPath, metadata: JSON.parse(readFileSync(metadataPath, "utf8")) }));
}

async function readLastAssistantText(rpc) {
	const started = Date.now();
	let lastResponse;
	while (Date.now() - started < 10000) {
		lastResponse = await rpc.send("get_last_assistant_text", {}, 120000);
		if (!lastResponse.success) fail("failed to read last assistant text", lastResponse.error);
		const text = typeof lastResponse.data?.text === "string" ? lastResponse.data.text : "";
		if (text.trim().length > 0) return text;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	return typeof lastResponse?.data?.text === "string" ? lastResponse.data.text : "";
}

async function rpcData(rpc, type, extra = {}, timeoutMs = 120000) {
	const response = await rpc.send(type, extra, timeoutMs);
	if (!response.success) fail(`${type} RPC failed`, response.error ?? JSON.stringify(response));
	return response.data ?? {};
}

async function getState(rpc) {
	return rpcData(rpc, "get_state");
}

async function getEntries(rpc) {
	return rpcData(rpc, "get_entries");
}

function resumeEntries(entries) {
	return (entries.entries ?? []).filter((entry) => entry?.type === "custom" && entry.customType === "cursor-sdk-agent-resume");
}

function latestResumeEntry(entries) {
	return resumeEntries(entries).at(-1)?.data;
}

function cleanupEntries(entries) {
	return (entries.entries ?? []).filter((entry) => entry?.type === "custom" && entry.customType === "cursor-sdk-agent-cleanup");
}

async function waitForCleanupEntryCount(rpc, count, timeoutMs) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const entries = await getEntries(rpc);
		const cleanups = cleanupEntries(entries);
		if (cleanups.length >= count) return cleanups;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	fail(`timeout waiting for ${count} cleanup entries`, rpc.stderr);
}

function resumeEntryCount(entries) {
	return resumeEntries(entries).length;
}

function compactionEntryCount(entries) {
	return (entries.entries ?? []).filter((entry) => entry?.type === "compaction").length;
}

function rewriteResumeAgentIds(sessionFile, agentId) {
	const lines = readFileSync(sessionFile, "utf8")
		.split(/\n/)
		.filter(Boolean)
		.map((line) => {
			const entry = JSON.parse(line);
			if (entry?.type === "custom" && entry.customType === "cursor-sdk-agent-resume" && entry.data?.agentId) entry.data.agentId = agentId;
			return JSON.stringify(entry);
		});
	writeFileSync(sessionFile, `${lines.join("\n")}\n`);
}

function entryText(entry) {
	const content = entry?.message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("\n");
	return "";
}

function userEntryContaining(entries, text) {
	return (entries.entries ?? []).find((entry) => entry?.type === "message" && entry.message?.role === "user" && entryText(entry).includes(text));
}

function writeTreeCommandExtension(artifactRoot) {
	const extensionPath = join(artifactRoot, "local-resume-tree-extension.mjs");
	writeFileSync(extensionPath, `export default function(pi) {\n  pi.registerCommand("local_resume_tree_go", {\n    description: "local resume tree proof",\n    handler: async (args, ctx) => {\n      const text = String(args || "");\n      const split = text.indexOf(" ");\n      const targetId = split >= 0 ? text.slice(0, split) : text;\n      const message = split >= 0 ? text.slice(split + 1) : "";\n      await ctx.navigateTree(targetId, { summarize: false });\n      if (message) pi.sendUserMessage(message);\n    },\n  });\n}\n`);
	return extensionPath;
}

function assistantEntryContaining(entries, text) {
	return (entries.entries ?? []).find((entry) => entry?.type === "message" && entry.message?.role === "assistant" && entryText(entry).includes(text));
}

function takeLatestMetadata(artifactDir, seenMetadata) {
	const metadata = readMetadataSince(artifactDir, seenMetadata);
	for (const item of metadata) seenMetadata.add(item.metadataPath);
	const latest = metadata.at(-1);
	if (!latest) fail("no new metadata was written", artifactDir);
	return {
		metadataPath: latest.metadataPath,
		metadata: latest.metadata,
	};
}

async function promptAndRead({ rpc, artifactDir, message, timeoutMs, seenMetadata }) {
	const eventStart = rpc.events.length;
	await rpc.send("prompt", { message }, timeoutMs);
	await waitForAgentEnd(rpc, eventStart, timeoutMs);
	const text = await readLastAssistantText(rpc);
	return {
		text,
		...takeLatestMetadata(artifactDir, seenMetadata),
	};
}

async function promptAbortAndRead({ rpc, artifactDir, message, markerPath, timeoutMs, seenMetadata }) {
	const eventStart = rpc.events.length;
	await rpc.send("prompt", { message }, timeoutMs);
	await waitForFile(markerPath, timeoutMs, rpc);
	await rpcData(rpc, "abort", {}, 120000);
	await waitForAgentEnd(rpc, eventStart, timeoutMs);
	return takeLatestMetadata(artifactDir, seenMetadata);
}

function assertTurnMetadata(label, turn, expected) {
	const meta = turn.metadata.providerMeta ?? {};
	if (meta.runtime === "cloud") fail(`${label} unexpectedly recorded cloud runtime`, turn.metadataPath);
	if (meta.localResume !== true) fail(`${label} did not record localResume=true`, turn.metadataPath);
	if (meta.resumedAgent !== expected.resumedAgent) {
		fail(`${label} resumedAgent mismatch`, JSON.stringify({ expected: expected.resumedAgent, actual: meta.resumedAgent, metadataPath: turn.metadataPath }, null, 2));
	}
	if (!turn.metadata.run?.agentId?.startsWith?.("agent-")) fail(`${label} did not record local agent id`, turn.metadataPath);
}

function assertNotResumedFrom(label, turn, agentId) {
	assertTurnMetadata(label, turn, { resumedAgent: false });
	if (turn.metadata.run.agentId === agentId) fail(`${label} reused original local SDK agent`, JSON.stringify({ original: agentId, actual: turn.metadata.run.agentId }, null, 2));
}

function createRunContext(prefix) {
	const artifactRoot = mkdtempSync(join(tmpdir(), prefix));
	return {
		artifactRoot,
		sessionDir: join(artifactRoot, "sessions"),
		sessionId: `local-resume-${Date.now()}`,
		seenMetadata: new Set(),
	};
}

function parseTimeout() {
	const timeoutMs = Number(process.env.CURSOR_LOCAL_RESUME_SMOKE_TIMEOUT_MS || 300000);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("CURSOR_LOCAL_RESUME_SMOKE_TIMEOUT_MS must be a positive number");
	return timeoutMs;
}

function cleanupArtifactRoot(artifactRoot) {
	if (process.env.CURSOR_LOCAL_RESUME_SMOKE_KEEP_ARTIFACTS === "1") return;
	try {
		rmSync(artifactRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
	} catch (error) {
		console.error(`[local-resume-smoke] warning: failed to remove temp artifacts: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function runSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-smoke-");
	const token = `LOCAL_RESUME_${Date.now()}`;
	let first;
	let second;
	console.error(`[local-resume-smoke] artifacts: ${artifactRoot}`);
	try {
		let rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId });
		try {
			first = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact token ${token}. Reply exactly FIRST_OK.`,
				timeoutMs,
				seenMetadata,
			});
		} finally {
			await rpc.stop();
		}
		assertTurnMetadata("first turn", first, { resumedAgent: false });

		rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId });
		try {
			second = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_RESUME token did I ask you to remember earlier in this pi session? Reply exactly TOKEN=<token> if visible, otherwise NO_TOKEN.",
				timeoutMs,
				seenMetadata,
			});
		} finally {
			await rpc.stop();
		}
		if (!second.text.includes(`TOKEN=${token}`)) fail("second turn did not recall local resume token", JSON.stringify({ expected: `TOKEN=${token}`, actual: second.text }, null, 2));
		assertTurnMetadata("second turn", second, { resumedAgent: true });
		if (first.metadata.run.agentId !== second.metadata.run.agentId) {
			fail("second turn did not reuse the first local SDK agent", JSON.stringify({ first: first.metadata.run.agentId, second: second.metadata.run.agentId }, null, 2));
		}
		console.log("local-resume-smoke-ok");
		console.error(`[local-resume-smoke] agent ${second.metadata.run.agentId} resumed across restart`);
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runSafetySmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-safety-smoke-");
	const baseToken = `LOCAL_BASE_${Date.now()}`;
	const futureToken = `LOCAL_FUTURE_${Date.now()}`;
	let originalSessionFile;
	let originalAgentId;
	let futureEntryId;
	console.error(`[local-resume-smoke] artifacts: ${artifactRoot}`);
	try {
		let rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId });
		try {
			const first = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact base token ${baseToken}. Reply exactly BASE_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("base turn", first, { resumedAgent: false });
			const future = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact future-only token ${futureToken}. Reply exactly FUTURE_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("future turn", future, { resumedAgent: false });
			if (future.metadata.run.agentId !== first.metadata.run.agentId) fail("same process did not keep one local SDK agent", JSON.stringify({ first: first.metadata.run.agentId, future: future.metadata.run.agentId }, null, 2));
			originalAgentId = future.metadata.run.agentId;
			const state = await getState(rpc);
			originalSessionFile = state.sessionFile;
			const entries = await getEntries(rpc);
			if (resumeEntryCount(entries) < 2) fail("original branch did not persist resume entries", JSON.stringify({ resumeEntries: resumeEntryCount(entries), sessionFile: originalSessionFile }, null, 2));
			futureEntryId = userEntryContaining(entries, futureToken)?.id;
			if (!futureEntryId) fail("could not find future-token user entry", originalSessionFile ?? "");
		} finally {
			await rpc.stop();
		}

		rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId });
		try {
			const same = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "From this conversation memory only, what exact LOCAL_FUTURE token did I ask you to remember? Reply exactly TOKEN=<token> if known, otherwise NO_TOKEN. Do not inspect environment variables or files.",
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("same-session restart", same, { resumedAgent: true });
			if (same.metadata.run.agentId !== originalAgentId) fail("same-session restart did not resume original agent", JSON.stringify({ original: originalAgentId, actual: same.metadata.run.agentId }, null, 2));

			const clone = await rpcData(rpc, "clone", {}, 120000);
			if (clone.cancelled === true) fail("clone was cancelled");
			const cloneState = await getState(rpc);
			if (cloneState.sessionFile === originalSessionFile) fail("clone did not switch session file", String(originalSessionFile));
			const cloneEntries = await getEntries(rpc);
			if (resumeEntryCount(cloneEntries) < 1) fail("clone did not carry any resume entries to reject", JSON.stringify({ sessionFile: cloneState.sessionFile }, null, 2));
			const cloneTurn = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_FUTURE token is visible in this cloned pi transcript? Reply exactly TOKEN=<token> if visible, otherwise NO_TOKEN.",
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("clone session", cloneTurn, originalAgentId);

			await rpcData(rpc, "switch_session", { sessionPath: originalSessionFile }, 120000);
			const fork = await rpcData(rpc, "fork", { entryId: futureEntryId }, 120000);
			if (fork.cancelled === true) fail("fork was cancelled");
			const forkEntries = await getEntries(rpc);
			if (JSON.stringify(forkEntries).includes(futureToken)) fail("fork branch already contained future token before prompt", String(futureEntryId));
			const forkTurn = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "On this current forked earlier branch only, what exact LOCAL_FUTURE token is visible? Reply exactly TOKEN=<token> only if the full token is present on this active branch; otherwise reply exactly NO_TOKEN. Do not use memory from other branches, environment variables, or files.",
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("fork before future", forkTurn, originalAgentId);
			if (forkTurn.text.includes(futureToken)) fail("forked earlier branch leaked future token", forkTurn.text);
		} finally {
			await rpc.stop();
		}
		console.log("local-resume-safety-smoke-ok");
		console.error(`[local-resume-smoke] original ${originalAgentId} rejected for clone and fork-before-future`);
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

function longRunningAbortPrompt(markerDir) {
	return `Call pi__bash with command:
node -e "const fs=require('fs');fs.mkdirSync('${markerDir}',{recursive:true});fs.writeFileSync('${markerDir}/started.txt',String(process.pid));setTimeout(()=>console.log('LOCAL_RESUME_ABORT_SHOULD_NOT_PRINT'),30000)"

Do not answer until the tool completes.`;
}

async function runToolSurfaceSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-tool-surface-smoke-");
	const token = `LOCAL_TOOL_SURFACE_${Date.now()}`;
	let originalAgentId;
	let originalPoolKey;
	console.error(`[local-resume-smoke] artifacts: ${artifactRoot}`);
	try {
		let rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId });
		try {
			const first = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact tool-surface token ${token}. Reply exactly TOOL_SURFACE_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("baseline tool surface", first, { resumedAgent: false });
			originalAgentId = first.metadata.run.agentId;
			originalPoolKey = latestResumeEntry(await getEntries(rpc))?.poolKey;
			if (!originalPoolKey) fail("baseline turn did not persist a resume pool key");
		} finally {
			await rpc.stop();
		}

		rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId });
		try {
			const sameSurface = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "From this conversation memory only, what exact LOCAL_TOOL_SURFACE token did I ask you to remember? Reply exactly TOKEN=<token> if known, otherwise NO_TOKEN. Do not inspect environment variables or files.",
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("same tool surface restart", sameSurface, { resumedAgent: true });
			if (sameSurface.metadata.run.agentId !== originalAgentId) fail("same tool surface restart did not resume original agent", JSON.stringify({ original: originalAgentId, actual: sameSurface.metadata.run.agentId }, null, 2));
		} finally {
			await rpc.stop();
		}

		rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId, bridge: true, exposeBuiltinTools: true });
		try {
			const changedSurface = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_TOOL_SURFACE token is visible in this pi transcript? Reply exactly TOKEN=<token> if visible, otherwise NO_TOKEN.",
				timeoutMs,
				seenMetadata,
			});
			if (!changedSurface.text.includes(`TOKEN=${token}`)) fail("changed tool surface did not bootstrap transcript token", JSON.stringify({ expected: `TOKEN=${token}`, actual: changedSurface.text }, null, 2));
			assertNotResumedFrom("changed tool surface", changedSurface, originalAgentId);
			if (!changedSurface.metadata.providerMeta?.bridgeRunId) fail("changed tool surface did not start a bridge run", changedSurface.metadataPath);
			const changedHandle = latestResumeEntry(await getEntries(rpc));
			if (!changedHandle?.poolKey) fail("changed tool surface did not persist a resume pool key");
			if (changedHandle.agentId !== changedSurface.metadata.run.agentId) fail("changed tool surface persisted handle for a different agent", JSON.stringify({ handle: changedHandle.agentId, run: changedSurface.metadata.run.agentId }, null, 2));
			if (changedHandle.poolKey === originalPoolKey) fail("changed tool surface reused the original pool key");
		} finally {
			await rpc.stop();
		}
		console.log("local-resume-tool-surface-smoke-ok");
		console.error(`[local-resume-smoke] original ${originalAgentId} rejected after bridge builtin tool surface change`);
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runAbortSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-abort-smoke-");
	const token = `LOCAL_ABORT_${Date.now()}`;
	const markerDir = ".debug/local-resume-abort";
	const markerPath = join(artifactRoot, "workspace", markerDir, "started.txt");
	let originalAgentId;
	let resumeCountBeforeAbort;
	console.error(`[local-resume-smoke] artifacts: ${artifactRoot}`);
	try {
		let rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId, bridge: true, exposeBuiltinTools: true });
		try {
			const baseline = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact abort token ${token}. Reply exactly ABORT_BASELINE_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("abort baseline", baseline, { resumedAgent: false });
			if (!baseline.metadata.providerMeta?.bridgeRunId) fail("abort baseline did not start a bridge run", baseline.metadataPath);
			originalAgentId = baseline.metadata.run.agentId;
			resumeCountBeforeAbort = resumeEntryCount(await getEntries(rpc));
			if (resumeCountBeforeAbort < 1) fail("abort baseline did not persist a resume handle");
		} finally {
			await rpc.stop();
		}

		rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId, bridge: true, exposeBuiltinTools: true });
		try {
			const aborted = await promptAbortAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: longRunningAbortPrompt(markerDir),
				markerPath,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("aborted turn", aborted, { resumedAgent: true });
			if (aborted.metadata.run.agentId !== originalAgentId) fail("aborted turn did not start from the original resumed agent", JSON.stringify({ original: originalAgentId, actual: aborted.metadata.run.agentId }, null, 2));
			const entriesAfterAbort = await getEntries(rpc);
			const resumeCountAfterAbort = resumeEntryCount(entriesAfterAbort);
			if (resumeCountAfterAbort !== resumeCountBeforeAbort) fail("aborted turn persisted a new resume handle", JSON.stringify({ before: resumeCountBeforeAbort, after: resumeCountAfterAbort }, null, 2));
		} finally {
			await rpc.stop();
		}

		rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId, bridge: true, exposeBuiltinTools: true });
		try {
			const afterAbort = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "Reply exactly AFTER_ABORT_OK.",
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("after aborted turn restart", afterAbort, originalAgentId);
			if (!afterAbort.metadata.providerMeta?.bridgeRunId) fail("after aborted turn restart did not start a bridge run", afterAbort.metadataPath);
			const handle = latestResumeEntry(await getEntries(rpc));
			if (handle?.agentId !== afterAbort.metadata.run.agentId) fail("after aborted turn did not persist the new agent handle", JSON.stringify({ handle: handle?.agentId, run: afterAbort.metadata.run.agentId }, null, 2));
		} finally {
			await rpc.stop();
		}
		console.log("local-resume-abort-smoke-ok");
		console.error(`[local-resume-smoke] original ${originalAgentId} not reused after aborted bridge turn`);
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runTreeSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-tree-smoke-");
	const baseToken = `LOCAL_TREE_BASE_${Date.now()}`;
	const futureToken = `LOCAL_TREE_FUTURE_${Date.now()}`;
	const extensionPath = writeTreeCommandExtension(artifactRoot);
	let originalAgentId;
	let baseAssistantId;
	let baseResumeEntryId;
	console.error(`[local-resume-smoke] artifacts: ${artifactRoot}`);
	try {
		const rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId, extraExtensions: [extensionPath] });
		try {
			const base = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact tree base token ${baseToken}. Reply exactly TREE_BASE_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("tree base", base, { resumedAgent: false });
			const baseEntries = await getEntries(rpc);
			baseAssistantId = assistantEntryContaining(baseEntries, "TREE_BASE_OK")?.id;
			baseResumeEntryId = resumeEntries(baseEntries).at(-1)?.id;
			if (!baseAssistantId) fail("tree smoke could not find base assistant entry");
			if (!baseResumeEntryId) fail("tree smoke could not find base resume entry");

			const future = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact tree future-only token ${futureToken}. Reply exactly TREE_FUTURE_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("tree future", future, { resumedAgent: false });
			if (future.metadata.run.agentId !== base.metadata.run.agentId) fail("tree setup did not keep one original local SDK agent", JSON.stringify({ base: base.metadata.run.agentId, future: future.metadata.run.agentId }, null, 2));
			originalAgentId = future.metadata.run.agentId;

			const question = "On this current earlier tree branch only, what exact LOCAL_TREE_FUTURE token is visible? Reply exactly TOKEN=<token> only if the full token is present on this active branch; otherwise reply exactly NO_TOKEN. Do not use memory from other branches, environment variables, or files.";
			const assistantTarget = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `/local_resume_tree_go ${baseAssistantId} ${question}`,
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("tree assistant target", assistantTarget, originalAgentId);
			if (assistantTarget.text.includes(futureToken)) fail("tree assistant target leaked future token", assistantTarget.text);

			const resumeEntryTarget = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `/local_resume_tree_go ${baseResumeEntryId} ${question}`,
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("tree resume-entry target", resumeEntryTarget, originalAgentId);
			if (resumeEntryTarget.text.includes(futureToken)) fail("tree resume-entry target leaked future token", resumeEntryTarget.text);
		} finally {
			await rpc.stop();
		}
		console.log("local-resume-tree-smoke-ok");
		console.error(`[local-resume-smoke] original ${originalAgentId} rejected for tree assistant and resume-entry targets`);
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runCopySwitchSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-copy-switch-smoke-");
	const token = `LOCAL_COPY_SWITCH_${Date.now()}`;
	let originalAgentId;
	let originalSessionFile;
	console.error(`[local-resume-smoke] artifacts: ${artifactRoot}`);
	try {
		let rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId });
		try {
			const baseline = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact copy-switch token ${token}. Reply exactly COPY_SWITCH_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("copy-switch baseline", baseline, { resumedAgent: false });
			originalAgentId = baseline.metadata.run.agentId;
			originalSessionFile = (await getState(rpc)).sessionFile;
			if (!originalSessionFile) fail("copy-switch baseline did not persist a session file");
		} finally {
			await rpc.stop();
		}

		const copiedSessionFile = join(dirname(originalSessionFile), `copied-${Date.now()}.jsonl`);
		copyFileSync(originalSessionFile, copiedSessionFile);

		rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId });
		try {
			await rpcData(rpc, "switch_session", { sessionPath: copiedSessionFile }, 120000);
			const entries = await getEntries(rpc);
			if (resumeEntryCount(entries) < 1) fail("copied session did not carry a resume entry to reject", copiedSessionFile);
			const switched = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_COPY_SWITCH token is visible in this copied session? Reply exactly TOKEN=<token> if visible, otherwise NO_TOKEN.",
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("copied session switch", switched, originalAgentId);
			if (!switched.text.includes(`TOKEN=${token}`)) fail("copied session did not bootstrap token from transcript", JSON.stringify({ expected: `TOKEN=${token}`, actual: switched.text }, null, 2));
		} finally {
			await rpc.stop();
		}
		console.log("local-resume-copy-switch-smoke-ok");
		console.error(`[local-resume-smoke] original ${originalAgentId} rejected for copied session switch`);
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runFallbackSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-fallback-smoke-");
	const token = `LOCAL_FALLBACK_${Date.now()}`;
	const bogusAgentId = `agent-missing-${Date.now()}`;
	let originalAgentId;
	let sessionFile;
	console.error(`[local-resume-smoke] artifacts: ${artifactRoot}`);
	try {
		let rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId });
		try {
			const baseline = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact fallback token ${token}. Reply exactly FALLBACK_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("fallback baseline", baseline, { resumedAgent: false });
			originalAgentId = baseline.metadata.run.agentId;
			sessionFile = (await getState(rpc)).sessionFile;
			if (!sessionFile) fail("fallback baseline did not persist a session file");
			if (resumeEntryCount(await getEntries(rpc)) < 1) fail("fallback baseline did not persist a resume handle");
		} finally {
			await rpc.stop();
		}

		rewriteResumeAgentIds(sessionFile, bogusAgentId);

		rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId });
		try {
			const fallback = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_FALLBACK token is visible after the missing local agent fallback? Reply exactly TOKEN=<token> if visible, otherwise NO_TOKEN.",
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("missing-agent fallback", fallback, originalAgentId);
			if (!fallback.text.includes(`TOKEN=${token}`)) fail("missing-agent fallback did not bootstrap token from transcript", JSON.stringify({ expected: `TOKEN=${token}`, actual: fallback.text }, null, 2));
			const streamEvents = readFileSync(join(dirname(fallback.metadataPath), "pi-stream-events.jsonl"), "utf8");
			if (!streamEvents.includes("Could not resume prior Cursor agent")) fail("missing-agent fallback did not emit resume continuity notice", fallback.metadataPath);
		} finally {
			await rpc.stop();
		}
		console.log("local-resume-fallback-smoke-ok");
		console.error(`[local-resume-smoke] missing ${bogusAgentId} fell back from original ${originalAgentId}`);
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runCompactionSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-compaction-smoke-");
	const token = `LOCAL_COMPACTION_${Date.now()}`;
	let preCompactionAgentId;
	let postCompactionAgentId;
	console.error(`[local-resume-smoke] artifacts: ${artifactRoot}`);
	mkdirSync(join(artifactRoot, "agent"), { recursive: true });
	writeFileSync(join(artifactRoot, "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 16384 } }, null, 2));
	try {
		let rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId });
		try {
			const baseline = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact compaction token ${token}. Reply exactly COMPACTION_BASELINE_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("compaction baseline", baseline, { resumedAgent: false });
			preCompactionAgentId = baseline.metadata.run.agentId;
			const result = await rpcData(rpc, "compact", { customInstructions: `Preserve the exact token ${token}.` }, timeoutMs);
			if (!result.summary || typeof result.tokensBefore !== "number") fail("manual compaction did not return a summary result", JSON.stringify(result, null, 2));
			const compactedEntries = await getEntries(rpc);
			if (compactionEntryCount(compactedEntries) < 1) fail("manual compaction did not append a compaction entry");

			const postCompaction = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_COMPACTION token is visible after compaction? Reply exactly TOKEN=<token> if visible, otherwise NO_TOKEN.",
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("post-compaction turn", postCompaction, preCompactionAgentId);
			if (!postCompaction.text.includes(`TOKEN=${token}`)) fail("post-compaction turn did not recall token", JSON.stringify({ expected: `TOKEN=${token}`, actual: postCompaction.text }, null, 2));
			postCompactionAgentId = postCompaction.metadata.run.agentId;
			const postHandle = latestResumeEntry(await getEntries(rpc));
			if (postHandle?.agentId !== postCompactionAgentId) fail("post-compaction turn did not persist the new agent handle", JSON.stringify({ handle: postHandle?.agentId, run: postCompactionAgentId }, null, 2));
			if (postHandle.compactionGeneration !== 1) fail("post-compaction handle did not record compactionGeneration=1", JSON.stringify(postHandle, null, 2));
		} finally {
			await rpc.stop();
		}

		rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId });
		try {
			const restart = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_COMPACTION token is visible after post-compaction restart? Reply exactly TOKEN=<token> if visible, otherwise NO_TOKEN.",
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("post-compaction restart", restart, { resumedAgent: true });
			if (restart.metadata.run.agentId !== postCompactionAgentId) fail("post-compaction restart did not resume the post-compaction agent", JSON.stringify({ expected: postCompactionAgentId, actual: restart.metadata.run.agentId }, null, 2));
		} finally {
			await rpc.stop();
		}
		console.log("local-resume-compaction-smoke-ok");
		console.error(`[local-resume-smoke] pre-compaction ${preCompactionAgentId} replaced by and resumed post-compaction ${postCompactionAgentId}`);
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runDefaultDryRunSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-default-dry-run-smoke-");
	const token = `LOCAL_DEFAULT_DRY_RUN_${Date.now()}`;
	let defaultAgentId;
	console.error(`[local-resume-smoke] artifacts: ${artifactRoot}`);
	try {
		let rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId, localResumeEnv: "unset" });
		try {
			const baseline = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact default-dry-run token ${token}. Reply exactly DEFAULT_DRY_RUN_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("builtin default baseline", baseline, { resumedAgent: false });
			if (baseline.metadata.providerMeta?.localResume !== true) fail("builtin default baseline did not record localResume=true", baseline.metadataPath);
		} finally {
			await rpc.stop();
		}

		rpc = startRpc({ artifactDir: artifactRoot, sessionDir, sessionId, localResumeEnv: "unset" });
		try {
			const defaultRestart = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_DEFAULT_DRY_RUN token did I ask you to remember? Reply exactly TOKEN=<token> if visible, otherwise NO_TOKEN.",
				timeoutMs,
				seenMetadata,
			});
			if (!defaultRestart.text.includes(`TOKEN=${token}`)) fail("builtin default restart did not recall token", JSON.stringify({ expected: `TOKEN=${token}`, actual: defaultRestart.text }, null, 2));
			assertTurnMetadata("builtin default restart", defaultRestart, { resumedAgent: true });
			defaultAgentId = defaultRestart.metadata.run.agentId;
		} finally {
			await rpc.stop();
		}

		rpc = startRpc({
			artifactDir: artifactRoot,
			sessionDir,
			sessionId,
			localResumeEnv: "off",
		});
		try {
			const optedOut = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_DEFAULT_DRY_RUN token did I ask you to remember? Reply exactly TOKEN=<token> if visible, otherwise NO_TOKEN.",
				timeoutMs,
				seenMetadata,
			});
			if (!optedOut.text.includes(`TOKEN=${token}`)) fail("env opt-out run did not bootstrap token from transcript", JSON.stringify({ expected: `TOKEN=${token}`, actual: optedOut.text }, null, 2));
			if (optedOut.metadata.providerMeta?.localResume !== false) fail("env opt-out run did not record localResume=false", optedOut.metadataPath);
			if (optedOut.metadata.providerMeta?.resumedAgent !== false) fail("env opt-out run unexpectedly resumed an agent", optedOut.metadataPath);
			if (optedOut.metadata.run?.agentId === defaultAgentId) fail("env opt-out run reused the default-resume agent", JSON.stringify({ configured: defaultAgentId, actual: optedOut.metadata.run?.agentId }, null, 2));
		} finally {
			await rpc.stop();
		}
		console.log("local-resume-default-dry-run-smoke-ok");
		console.error(`[local-resume-smoke] built-in default resumed ${defaultAgentId}; env opt-out rejected it`);
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

function runCleanupSmokeWithHarness() {
	return runCleanupSmoke({
		assertExactStringArray,
		assertNotResumedFrom,
		assertTurnMetadata,
		cleanupArtifactRoot,
		createRunContext,
		fail,
		getEntries,
		latestResumeEntry,
		parseTimeout,
		promptAndRead,
		resumeEntries,
		rpcData,
		startRpc,
		waitForCleanupEntryCount,
		writeTreeCommandExtension,
	});
}

const SMOKE_RUNNERS = {
	restart: runSmoke,
	safety: runSafetySmoke,
	toolSurface: runToolSurfaceSmoke,
	abort: runAbortSmoke,
	tree: runTreeSmoke,
	copySwitch: runCopySwitchSmoke,
	fallback: runFallbackSmoke,
	compaction: runCompactionSmoke,
	defaultDryRun: runDefaultDryRunSmoke,
	cleanup: runCleanupSmokeWithHarness,
};

function selectedRun() {
	const lane = LOCAL_RESUME_SMOKE_LANES.find((candidate) => candidate.flag && args.has(candidate.flag));
	return SMOKE_RUNNERS[lane?.key ?? "restart"];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const run = selectedRun();
	run().catch((error) => {
		reportFailure(error);
		process.exit(1);
	});
}
