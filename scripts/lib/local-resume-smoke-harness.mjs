import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CHILD_PROCESS_TREE_SPAWN_OPTIONS,
	terminateChild,
} from "./cursor-child-process.mjs";
import { buildCursorSmokeEnv } from "./cursor-smoke-env.mjs";
import { scrubSensitiveText } from "../../shared/cursor-sensitive-text.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLOUD_RUNTIME_ENV_NAMES = [
	"PI_CURSOR_CLOUD_ACK",
	"PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE",
	"PI_CURSOR_CLOUD_CONTEXT",
	"PI_CURSOR_CLOUD_REPO",
	"PI_CURSOR_CLOUD_BRANCH",
	"PI_CURSOR_CLOUD_DIRECT_PUSH",
	"PI_CURSOR_CLOUD_AUTO_CREATE_PR",
	"PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST",
	"PI_CURSOR_CLOUD_ENV",
	"PI_CURSOR_CLOUD_ENV_FROM_FILES",
	"PI_CURSOR_CLOUD_ENV_TYPE",
	"PI_CURSOR_CLOUD_ENV_NAME",
];

export function scrubSmokeText(value) {
	return scrubSensitiveText(String(value), process.env.CURSOR_API_KEY);
}

class SmokeFailure extends Error {
	constructor(message, details = "") {
		super(message);
		this.details = details;
	}
}

export function fail(message, details = "") {
	throw new SmokeFailure(message, details);
}

export function reportFailure(error) {
	console.error(
		scrubSmokeText(`[local-resume-smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`),
	);
	if (error instanceof SmokeFailure && error.details)
		console.error(scrubSmokeText(error.details));
}

export function assertExactStringArray(label, actual, expected) {
	const normalizedActual = [...(actual ?? [])].sort((a, b) =>
		a.localeCompare(b),
	);
	const normalizedExpected = [...expected].sort((a, b) => a.localeCompare(b));
	if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
		fail(
			`${label} mismatch`,
			JSON.stringify(
				{ expected: normalizedExpected, actual: normalizedActual },
				null,
				2,
			),
		);
	}
}

function findPiCommand() {
	const cli = join(
		root,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"cli.js",
	);
	if (existsSync(cli)) return { command: process.execPath, argsPrefix: [cli] };
	const local = join(
		root,
		"node_modules",
		".bin",
		process.platform === "win32" ? "pi.cmd" : "pi",
	);
	return {
		command: existsSync(local)
			? local
			: process.platform === "win32"
				? "pi.cmd"
				: "pi",
		argsPrefix: [],
	};
}

export function buildLocalResumeSmokeEnv(
	artifactDir,
	{
		baseEnv = process.env,
		bridge = false,
		exposeBuiltinTools = false,
		localResumeEnv = "on",
	} = {},
) {
	const agentDir = join(artifactDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const env = buildCursorSmokeEnv({
		baseEnv,
		settingSources: "none",
		bridge,
		nativeToolDisplay: false,
		registerNativeTools: false,
		exposeBuiltinTools,
		eventDebugDir: join(artifactDir, "debug"),
	});
	const resumeMode =
		localResumeEnv === true
			? "on"
			: localResumeEnv === false
				? "unset"
				: localResumeEnv;
	for (const name of CLOUD_RUNTIME_ENV_NAMES) delete env[name];
	delete env.PI_CURSOR_LOCAL_RESUME;
	if (resumeMode === "on") env.PI_CURSOR_LOCAL_RESUME = "1";
	else if (resumeMode === "off") env.PI_CURSOR_LOCAL_RESUME = "0";
	else if (resumeMode !== "unset")
		fail(`unknown localResumeEnv mode: ${String(localResumeEnv)}`);
	return {
		...env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CURSOR_RUNTIME: "local",
	};
}

export function startRpc({
	artifactDir,
	sessionDir,
	sessionId,
	bridge = false,
	exposeBuiltinTools = false,
	extraExtensions = [],
	localResumeEnv = "on",
	baseEnv = process.env,
}) {
	const model =
		process.env.CURSOR_LOCAL_RESUME_SMOKE_MODEL || "cursor/grok-4.6:slow";
	const workspaceDir = join(artifactDir, "workspace");
	mkdirSync(workspaceDir, { recursive: true });
	const pi = findPiCommand();
	const extensionPath = resolve(process.env.CURSOR_LOCAL_RESUME_SMOKE_EXTENSION_PATH || root);
	if (!existsSync(extensionPath)) fail(`local resume extension path does not exist: ${extensionPath}`);
	appendFileSync(join(artifactDir, "runtime-launches.jsonl"), `${JSON.stringify({
		command: pi.command,
		extensionPath,
		workspaceDir,
		sessionDir,
		sessionId,
	})}\n`);
	const child = spawn(
		pi.command,
		[
			...pi.argsPrefix,
			"--mode",
			"rpc",
			"-e",
			extensionPath,
			...extraExtensions.flatMap((path) => ["-e", path]),
			"--model",
			model,
			"--cursor-runtime",
			"local",
			"--approve",
			"--session-dir",
			sessionDir,
			"--session-id",
			sessionId,
		],
		{
			cwd: workspaceDir,
			env: buildLocalResumeSmokeEnv(artifactDir, {
				baseEnv,
				bridge,
				exposeBuiltinTools,
				localResumeEnv,
			}),
			stdio: ["pipe", "pipe", "pipe"],
			...CHILD_PROCESS_TREE_SPAWN_OPTIONS,
		},
	);
	let stdoutBuffer = "";
	let stderr = "";
	const events = [];
	const pending = new Map();
	let requestId = 0;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk;
		let newlineIndex = stdoutBuffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = stdoutBuffer.slice(0, newlineIndex);
			stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
			newlineIndex = stdoutBuffer.indexOf("\n");
			if (!line.trim()) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
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
	const send = (type, extra = {}, timeoutMs = 120000) =>
		new Promise((resolveRequest, rejectRequest) => {
			const id = `local_resume_smoke_${++requestId}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				rejectRequest(
					new Error(`timeout waiting for ${type}. Stderr: ${stderr}`),
				);
			}, timeoutMs);
			pending.set(id, {
				resolve: resolveRequest,
				reject: rejectRequest,
				timer,
			});
			child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
		});
	const stop = async () => {
		for (const request of pending.values()) clearTimeout(request.timer);
		pending.clear();
		await terminateChild(child, { graceMs: 15_000 });
	};
	return {
		events,
		send,
		stop,
		get stderr() {
			return stderr;
		},
	};
}

export async function withRpc(options, run) {
	const rpc = startRpc(options);
	try {
		return await run(rpc);
	} finally {
		await rpc.stop();
	}
}

async function waitForAgentSettled(rpc, fromIndex, timeoutMs) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (rpc.events.slice(fromIndex).some((event) => event.type === "agent_settled"))
			return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	throw new Error(`timeout waiting for agent_settled. Stderr: ${rpc.stderr}`);
}

async function waitForFile(path, timeoutMs, rpc) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (existsSync(path)) return;
		if (rpc?.events.some((event) => event.type === "agent_settled"))
			fail(`agent settled before ${path} existed`, rpc.stderr);
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
		.map((metadataPath) => ({
			metadataPath,
			metadata: JSON.parse(readFileSync(metadataPath, "utf8")),
		}));
}

async function readLastAssistantText(rpc) {
	const started = Date.now();
	let lastResponse;
	while (Date.now() - started < 10000) {
		lastResponse = await rpc.send("get_last_assistant_text", {}, 120000);
		if (!lastResponse.success)
			fail("failed to read last assistant text", lastResponse.error);
		const text =
			typeof lastResponse.data?.text === "string" ? lastResponse.data.text : "";
		if (text.trim().length > 0) return text;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	return typeof lastResponse?.data?.text === "string"
		? lastResponse.data.text
		: "";
}

export async function rpcData(rpc, type, extra = {}, timeoutMs = 120000) {
	const response = await rpc.send(type, extra, timeoutMs);
	if (!response.success)
		fail(`${type} RPC failed`, response.error ?? JSON.stringify(response));
	return response.data ?? {};
}

export async function getState(rpc) {
	return rpcData(rpc, "get_state");
}

export async function getEntries(rpc) {
	return rpcData(rpc, "get_entries");
}

export function resumeEntries(entries) {
	return (entries.entries ?? []).filter(
		(entry) =>
			entry?.type === "custom" &&
			entry.customType === "cursor-sdk-agent-resume",
	);
}

export function latestResumeEntry(entries) {
	return resumeEntries(entries).at(-1)?.data;
}

function cleanupEntries(entries) {
	return (entries.entries ?? []).filter(
		(entry) =>
			entry?.type === "custom" &&
			entry.customType === "cursor-sdk-agent-cleanup",
	);
}

export async function waitForCleanupEntryCount(rpc, count, timeoutMs) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const entries = await getEntries(rpc);
		const cleanups = cleanupEntries(entries);
		if (cleanups.length >= count) return cleanups;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	fail(`timeout waiting for ${count} cleanup entries`, rpc.stderr);
}

export function resumeEntryCount(entries) {
	return resumeEntries(entries).length;
}

export function compactionEntryCount(entries) {
	return (entries.entries ?? []).filter((entry) => entry?.type === "compaction")
		.length;
}

function entryText(entry) {
	const content = entry?.message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
			.join("\n");
	return "";
}

export function userEntryContaining(entries, text) {
	return (entries.entries ?? []).find(
		(entry) =>
			entry?.type === "message" &&
			entry.message?.role === "user" &&
			entryText(entry).includes(text),
	);
}

export function assistantEntryContaining(entries, text) {
	return (entries.entries ?? []).find(
		(entry) =>
			entry?.type === "message" &&
			entry.message?.role === "assistant" &&
			entryText(entry).includes(text),
	);
}

export function writeTreeCommandExtension(artifactRoot) {
	const extensionPath = join(artifactRoot, "local-resume-tree-extension.mjs");
	writeFileSync(
		extensionPath,
		`export default function(pi) {\n  pi.registerCommand("local_resume_tree_go", {\n    description: "local resume tree proof",\n    handler: async (args, ctx) => {\n      const text = String(args || "");\n      const split = text.indexOf(" ");\n      const targetId = split >= 0 ? text.slice(0, split) : text;\n      const message = split >= 0 ? text.slice(split + 1) : "";\n      await ctx.navigateTree(targetId, { summarize: false });\n      if (message) pi.sendUserMessage(message);\n    },\n  });\n}\n`,
	);
	return extensionPath;
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

export async function promptAndRead({
	rpc,
	artifactDir,
	message,
	timeoutMs,
	seenMetadata,
}) {
	const eventStart = rpc.events.length;
	await rpc.send("prompt", { message }, timeoutMs);
	await waitForAgentSettled(rpc, eventStart, timeoutMs);
	const text = await readLastAssistantText(rpc);
	return {
		text,
		events: rpc.events.slice(eventStart),
		...takeLatestMetadata(artifactDir, seenMetadata),
	};
}

export async function promptAbortAndRead({
	rpc,
	artifactDir,
	message,
	markerPath,
	timeoutMs,
	seenMetadata,
}) {
	const eventStart = rpc.events.length;
	await rpc.send("prompt", { message }, timeoutMs);
	await waitForFile(markerPath, timeoutMs, rpc);
	await rpcData(rpc, "abort", {}, 120000);
	await waitForAgentSettled(rpc, eventStart, timeoutMs);
	return takeLatestMetadata(artifactDir, seenMetadata);
}

export function assertTurnMetadata(label, turn, expected) {
	const meta = turn.metadata.providerMeta ?? {};
	if (meta.runtime === "cloud")
		fail(`${label} unexpectedly recorded cloud runtime`, turn.metadataPath);
	if (meta.localResume !== true)
		fail(`${label} did not record localResume=true`, turn.metadataPath);
	if (meta.resumedAgent !== expected.resumedAgent) {
		fail(
			`${label} resumedAgent mismatch`,
			JSON.stringify(
				{
					expected: expected.resumedAgent,
					actual: meta.resumedAgent,
					metadataPath: turn.metadataPath,
				},
				null,
				2,
			),
		);
	}
	if (!turn.metadata.run?.agentId?.startsWith?.("agent-"))
		fail(`${label} did not record local agent id`, turn.metadataPath);
}

export function assertNotResumedFrom(label, turn, agentId) {
	assertTurnMetadata(label, turn, { resumedAgent: false });
	if (turn.metadata.run.agentId === agentId)
		fail(
			`${label} reused original local SDK agent`,
			JSON.stringify(
				{ original: agentId, actual: turn.metadata.run.agentId },
				null,
				2,
			),
		);
}

export function createRunContext(prefix) {
	const configuredRoot = process.env.CURSOR_LOCAL_RESUME_SMOKE_ARTIFACT_DIR;
	const artifactRoot = configuredRoot ? resolve(configuredRoot) : mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(artifactRoot, { recursive: true });
	return {
		artifactRoot,
		sessionDir: join(artifactRoot, "sessions"),
		sessionId: `local-resume-${Date.now()}`,
		seenMetadata: new Set(),
	};
}

export function parseTimeout() {
	const timeoutMs = Number(
		process.env.CURSOR_LOCAL_RESUME_SMOKE_TIMEOUT_MS || 300000,
	);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		fail("CURSOR_LOCAL_RESUME_SMOKE_TIMEOUT_MS must be a positive number");
	return timeoutMs;
}

export function cleanupArtifactRoot(artifactRoot) {
	if (process.env.CURSOR_LOCAL_RESUME_SMOKE_KEEP_ARTIFACTS === "1") return;
	try {
		rmSync(artifactRoot, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 250,
		});
	} catch (error) {
		console.error(
			scrubSmokeText(`[local-resume-smoke] warning: failed to remove temp artifacts: ${error instanceof Error ? error.message : String(error)}`),
		);
	}
}
