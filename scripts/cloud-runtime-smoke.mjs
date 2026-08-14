#!/usr/bin/env node
import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { terminateChild } from "./lib/cursor-child-process.mjs";
import { ensureBuilt } from "./lib/ensure-built.mjs";
import { buildCursorSmokeEnv } from "./lib/cursor-smoke-env.mjs";
import {
	checkpointCloudSmokeShutdown,
	createCloudSmokeShutdownController,
	installCloudSmokeSignalHandlers,
} from "./lib/cloud-smoke-shutdown.mjs";
import {
	assertAgentDeleted,
	assertCloudSmokeEvidenceSafe,
	buildCloudSmokeEvidenceProvenance,
	cleanupCloudAgent,
	coordinateCloudSmokeReleaseGate,
	listCloudSmokePackageSourcePaths,
	projectCloudSmokeMatrixEvidence,
	validateCloudSmokeMatrixEvidence,
} from "./lib/cloud-smoke-cleanup-evidence.mjs";
import {
	assertOwnedThrowawayRepositoryHandle,
	authenticatedGitArgs,
	cloudSmokeRepositoryDescription,
	createThrowawayRepository,
	deleteThrowawayRepository,
	normalizeCloudSmokeGitHubRepo,
	runTimedCommand,
	validatePrUrl,
} from "./lib/cloud-smoke-github.mjs";
import { CLOUD_AGENT_ID_PATTERN } from "../shared/cursor-cloud-lifecycle-constants.mjs";
import {
	cloudAgentIdsFromLifecycleArtifacts,
	cloudAgentIdsFromMetadata,
	cloudLifecycleRecords,
	readCloudRunReport,
	readCloudSmokeMetadata,
	readLatestCloudSmokeMetadata,
} from "./lib/cloud-smoke-artifacts.mjs";
import { createCloudSmokePiRunner } from "./lib/cloud-smoke-pi-runner.mjs";
import { scrubSensitiveText } from "../shared/cursor-sensitive-text.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_PATH = join(root, "docs", "evidence", "cursor-cloud-smoke-matrix-latest.json");
const MODEL = "cursor/composer-2-5";
const CLOUD_RUN_ID_PATTERN = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cloudSmokeShutdown = createCloudSmokeShutdownController((child) => terminateChild(child, { graceMs: 15_000 }));
const argv = process.argv.slice(2);
const args = new Set(argv);
const CLOUD_ENV_NAMES = [
	"PI_CURSOR_RUNTIME",
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

function scrubSmokeText(value) {
	return scrubSensitiveText(String(value), process.env.CURSOR_API_KEY);
}

class SmokeFailure extends Error {
	constructor(message, details = "") {
		super(message);
		this.details = details;
	}
}

function printHelp() {
	console.log(`Required live Cursor cloud release smoke for pi-cursor-sdk.

Usage:
  npm run smoke:cloud
  npm run smoke:cloud:context
  node scripts/cloud-runtime-smoke.mjs [--context-matrix]

The no-flag release gate creates and deletes one private throwaway GitHub repository and runs named lanes for cancel, explicit repo/startingRef branch reporting, direct push, missing branch failure, lifecycle delete, and account-conditional artifacts/raw usage. It requires current gh auth with private-repo create/push/delete access and Cursor Cloud access to that repository.

Environment:
  CURSOR_API_KEY                    Required for cloud runs and verified agent cleanup.
  CURSOR_CLOUD_SMOKE_TIMEOUT_MS     Timeout in ms per lane (default: 300000).
  CURSOR_CLOUD_SMOKE_ENV_TYPE       Optional context-matrix Cursor env type: cloud, pool, or machine.
  CURSOR_CLOUD_SMOKE_ENV_NAME       Optional context-matrix env name, used only with type.
  CURSOR_CLOUD_SMOKE_KEEP_ARTIFACTS Keep temp artifacts after success when set to 1.

Options:
  --context-matrix                  Optional sessionful fresh-vs-bootstrap context handoff proof.

Exit codes:
  0  every selected lane and destructive throwaway cleanup proof passed
  1  missing prerequisite, run/assertion failure, or cleanup verification failure
  2  invalid command-line usage`);
}

if (args.has("-h") || args.has("--help")) {
	printHelp();
	process.exit(0);
}

const unknownArgs = argv.filter((arg) => arg !== "--context-matrix");
const laneArgs = argv.filter((arg) => arg === "--context-matrix");
if (unknownArgs.length > 0 || laneArgs.length > 1) {
	const message = unknownArgs.length > 0
		? `unknown argument(s): ${unknownArgs.join(", ")}`
		: "only one smoke lane may be selected";
	console.error(scrubSmokeText(`[cloud-smoke] usage error: ${message}\nRun with --help for usage.`));
	process.exit(2);
}

function fail(message, details = "") {
	throw new SmokeFailure(message, details);
}

function reportFailure(error) {
	console.error(scrubSmokeText(`[cloud-smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`));
	if (error instanceof SmokeFailure && error.details) console.error(scrubSmokeText(error.details));
	else if (error?.details) console.error(scrubSmokeText(error.details));
}

function optionalSmokeValue(name) {
	const value = process.env[name]?.trim();
	return value || undefined;
}

export function buildCloudSmokeEnv(artifactDir, options = {}) {
	const agentDir = join(artifactDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const env = buildCursorSmokeEnv({ settingSources: "none", eventDebugDir: artifactDir });
	for (const name of CLOUD_ENV_NAMES) delete env[name];
	const smokeEnvType = options.repoUrl ? undefined : optionalSmokeValue("CURSOR_CLOUD_SMOKE_ENV_TYPE");
	const smokeEnvName = options.repoUrl ? undefined : optionalSmokeValue("CURSOR_CLOUD_SMOKE_ENV_NAME");
	Object.assign(env, {
		PI_CURSOR_RUNTIME: "cloud",
		PI_CURSOR_CLOUD_ACK: "1",
		PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE: "1",
		PI_CODING_AGENT_DIR: agentDir,
		PI_CURSOR_CLOUD_CONTEXT: options.contextHandoff ?? "fresh",
		...(options.repoUrl ? { PI_CURSOR_CLOUD_REPO: options.repoUrl } : {}),
		...(options.startingRef ? { PI_CURSOR_CLOUD_BRANCH: options.startingRef } : {}),
		...(options.directPush ? { PI_CURSOR_CLOUD_DIRECT_PUSH: "1" } : {}),
		...(smokeEnvType ? { PI_CURSOR_CLOUD_ENV_TYPE: smokeEnvType } : {}),
		...(smokeEnvType && smokeEnvName ? { PI_CURSOR_CLOUD_ENV_NAME: smokeEnvName } : {}),
	});
	delete env.PI_CURSOR_PI_TOOL_BRIDGE_DEBUG;
	return env;
}

export function buildCloudSmokeWorkspace(artifactDir) {
	const workspaceDir = join(artifactDir, "workspace");
	mkdirSync(workspaceDir, { recursive: true });
	return workspaceDir;
}

export {
	assertCloudSmokeEvidenceSafe,
	assertOwnedThrowawayRepositoryHandle,
	buildCloudSmokeEvidenceProvenance,
	cloudSmokeRepositoryDescription,
	cloudAgentIdsFromLifecycleArtifacts,
	coordinateCloudSmokeReleaseGate,
	listCloudSmokePackageSourcePaths,
	normalizeCloudSmokeGitHubRepo,
	projectCloudSmokeMatrixEvidence,
	validateCloudSmokeMatrixEvidence,
};

const { runPi, startRpc } = createCloudSmokePiRunner({
	root,
	model: MODEL,
	shutdown: cloudSmokeShutdown,
	buildEnv: buildCloudSmokeEnv,
	buildWorkspace: buildCloudSmokeWorkspace,
});

function command(commandName, commandArgs, options = {}) {
	try {
		return runTimedCommand(commandName, commandArgs, { cwd: options.cwd ?? root, ...options });
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), error?.details ?? "");
	}
}

async function runSuccessfulPrintLane({ artifactDir, envOptions, message, marker, sessionId, timeoutMs }) {
	const run = await runPi({ artifactDir, envOptions, message, sessionId, timeoutMs });
	if (run.code !== 0) fail(`pi cloud lane exited ${run.code}${run.signal ? ` (${run.signal})` : ""}`, `${run.stderr}\n${run.stdout}`.trim());
	if (!run.stdout.includes(marker)) fail(`cloud lane output missing ${marker}`, `${run.stderr}\n${run.stdout}`.trim());
	const latest = readLatestCloudSmokeMetadata(artifactDir);
	if (!latest) fail("cloud lane metadata missing", artifactDir);
	const report = assertCloudMetadata(latest.metadata, latest.metadataPath);
	const agentId = latest.metadata.run.agentId;
	const runId = latest.metadata.run.runId;
	assertLaneEvidence(artifactDir, agentId, runId);
	return { agentId, runId, report };
}

function assertCloudMetadata(metadata, metadataPath, options = {}) {
	if (metadata.providerMeta?.runtime !== "cloud") fail("provider metadata did not record cloud runtime", metadataPath);
	if (metadata.send?.bridgeEnabled !== false) fail("cloud send unexpectedly enabled pi bridge", metadataPath);
	if (metadata.send?.useNativeToolReplay !== false) fail("cloud send unexpectedly enabled native replay", metadataPath);
	if (metadata.send?.agentMode !== "agent") fail("cloud send did not use agent mode", metadataPath);
	if (!CLOUD_AGENT_ID_PATTERN.test(metadata.run?.agentId ?? "")) fail("cloud run did not return an exact cloud agent id", metadataPath);
	if (!CLOUD_RUN_ID_PATTERN.test(metadata.run?.runId ?? "")) fail("cloud run did not return an exact run id", metadataPath);
	const report = readCloudRunReport({ metadataPath, metadata });
	if (!report && options.requireReport === false) return undefined;
	if (!report) fail("cloud report was not retained after the print-mode lane exited", metadataPath);
	if (report.agentId !== metadata.run.agentId || report.runId !== metadata.run.runId) fail("cloud report IDs did not match run metadata", metadataPath);
	if (!Array.isArray(report.branches)) fail("cloud report branches were not an array", metadataPath);
	if (report.artifacts !== undefined) {
		if (!Array.isArray(report.artifacts) || report.artifacts.length > 10) fail("cloud report artifacts exceeded the bounded array contract", metadataPath);
		for (const artifact of report.artifacts) {
			if (typeof artifact?.path !== "string" || artifact.path.length === 0 || artifact.path.length > 240 || !Number.isFinite(artifact.sizeBytes) || artifact.sizeBytes < 0 || typeof artifact.updatedAt !== "string" || artifact.updatedAt.length > 240 || Number.isNaN(Date.parse(artifact.updatedAt))) {
				fail("cloud report artifact did not match the bounded known shape", metadataPath);
			}
		}
	}
	if (report.usage !== undefined) {
		if (!report.usage || typeof report.usage !== "object" || Array.isArray(report.usage)) fail("cloud report usage was not an object", metadataPath);
		for (const usage of [report.usage.totalUsage, report.usage.runUsage].filter(Boolean)) {
			for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"]) {
				if (!Number.isFinite(usage[key]) || usage[key] < 0) fail("cloud report usage did not match the known token shape", metadataPath);
			}
		}
	}
	return report;
}

function assertLaneEvidence(artifactDir, expectedAgentId, expectedRunId) {
	const metadataIds = cloudAgentIdsFromMetadata(artifactDir);
	const lifecycle = cloudLifecycleRecords(artifactDir);
	if (!metadataIds.includes(expectedAgentId)) fail("lane agent ID missing from metadata", expectedAgentId);
	if (!lifecycle.some(({ data }) => data.agentId === expectedAgentId)) fail("lane agent ID missing from canonical lifecycle JSONL/journal", expectedAgentId);
	if (expectedRunId && !lifecycle.some(({ data }) => data.agentId === expectedAgentId && data.runId === expectedRunId)) {
		fail("lane run ID missing from canonical lifecycle JSONL/journal", expectedRunId);
	}
}

async function waitFor(predicate, timeoutMs, errorMessage) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		cloudSmokeShutdown.throwIfRequested();
		const value = await predicate();
		if (value) return value;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	throw new Error(errorMessage);
}

async function waitForAgentSettled(rpc, fromIndex, timeoutMs) {
	await waitFor(
		() => {
			rpc.throwIfFailed();
			return rpc.events.slice(fromIndex).some((event) => event.type === "agent_settled");
		},
		timeoutMs,
		`timeout waiting for agent_settled. Stderr: ${rpc.stderr}`,
	);
}

async function readLastAssistantText(rpc) {
	const response = await rpc.send("get_last_assistant_text");
	if (!response.success) fail("failed to read last assistant text", response.error);
	return typeof response.data?.text === "string" ? response.data.text : "";
}

async function promptAndRead({ rpc, artifactDir, message, timeoutMs, expectedContextHandoff }) {
	const fromIndex = rpc.events.length;
	const response = await rpc.send("prompt", { message }, timeoutMs);
	if (!response.success) fail("cloud prompt was rejected", response.error);
	await waitForAgentSettled(rpc, fromIndex, timeoutMs);
	const text = await readLastAssistantText(rpc);
	const latest = readLatestCloudSmokeMetadata(artifactDir);
	if (!latest) fail("cloud smoke metadata missing", artifactDir);
	const report = assertCloudMetadata(latest.metadata, latest.metadataPath, { requireReport: !expectedContextHandoff });
	if (expectedContextHandoff && latest.metadata.providerMeta?.contextHandoff !== expectedContextHandoff) {
		fail("cloud metadata recorded wrong context handoff", JSON.stringify({ expected: expectedContextHandoff, actual: latest.metadata.providerMeta?.contextHandoff }));
	}
	const agentId = latest.metadata.run.agentId;
	const runId = latest.metadata.run.runId;
	assertLaneEvidence(artifactDir, agentId, runId);
	return { text, agentId, runId, report };
}

function lastNonEmptyLine(text) {
	return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

async function runContextScenario({ artifactRoot, contextHandoff, timeoutMs }) {
	const artifactDir = join(artifactRoot, `context-${contextHandoff}`);
	mkdirSync(artifactDir, { recursive: true });
	const marker = `CLOUD_CONTEXT_${contextHandoff}_${Date.now()}`;
	const rpc = await startRpc({ artifactDir, contextHandoff, sessionId: `cloud-context-${contextHandoff}-${Date.now()}` });
	try {
		const first = await promptAndRead({ rpc, artifactDir, message: `Remember exact marker ${marker}. Reply exactly FIRST_OK.`, timeoutMs, expectedContextHandoff: contextHandoff });
		if (lastNonEmptyLine(first.text) !== "FIRST_OK") fail(`cloud ${contextHandoff} setup turn did not return FIRST_OK`, first.text);
		const second = await promptAndRead({ rpc, artifactDir, message: "What exact CLOUD_CONTEXT marker did I ask you to remember earlier in this pi session? Reply exactly MARKER=<marker> if visible, otherwise NO_MARKER.", timeoutMs, expectedContextHandoff: contextHandoff });
		return { contextHandoff, marker, first, second };
	} finally {
		await rpc.stop();
	}
}

async function runContextMatrix({ artifactRoot, timeoutMs }) {
	const fresh = await runContextScenario({ artifactRoot, contextHandoff: "fresh", timeoutMs });
	if (fresh.second.text.includes(fresh.marker) || lastNonEmptyLine(fresh.second.text) !== "NO_MARKER") fail("fresh cloud context leaked prior context", fresh.second.text);
	const bootstrap = await runContextScenario({ artifactRoot, contextHandoff: "bootstrap", timeoutMs });
	if (lastNonEmptyLine(bootstrap.second.text) !== `MARKER=${bootstrap.marker}`) fail("bootstrap cloud context omitted prior context", bootstrap.second.text);
	return [fresh, bootstrap];
}

async function runBranchAndLifecycleLane({ artifactRoot, repo, timeoutMs, Agent }) {
	const artifactDir = join(artifactRoot, "lane-branch-lifecycle");
	const timestamp = Date.now();
	const marker = `BRANCH_PROOF_${timestamp}`;
	const branchName = `cursor/cloud-smoke-${timestamp}`;
	const sessionId = `cloud-branch-${timestamp}`;
	const envOptions = { repoUrl: repo.repoUrl, startingRef: "starting-ref" };
	const result = await runSuccessfulPrintLane({
		artifactDir,
		envOptions,
		message: `In this repository, create branch-proof.txt containing exactly ${marker} followed by a newline, commit it on a new branch named ${branchName}, push that branch, then reply exactly BRANCH_LANE_OK.`,
		marker: "BRANCH_LANE_OK",
		sessionId,
		timeoutMs,
	});
	for (const branch of result.report.branches) {
		if (normalizeCloudSmokeGitHubRepo(branch.repoUrl) !== repo.fullName.toLowerCase()) fail("branch lane reported a different repository", branch.repoUrl);
		if (branch.prUrl) {
			try {
				await validatePrUrl(repo, branch.prUrl, { cwd: root });
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error), error?.details ?? "");
			}
		}
	}
	command("git", ["check-ref-format", "--branch", branchName], { label: "validate cloud branch name" });
	const remoteRef = "refs/remotes/origin/cloud-smoke-branch-proof";
	command("git", authenticatedGitArgs(["fetch", "origin", `+refs/heads/${branchName}:${remoteRef}`]), { cwd: repo.seedDir, label: "fetch cloud branch proof" });
	const startingCommit = command("git", ["rev-parse", "refs/remotes/origin/starting-ref"], { cwd: repo.seedDir });
	const branchCommit = command("git", ["rev-parse", remoteRef], { cwd: repo.seedDir });
	if (startingCommit === branchCommit) fail("cloud working branch did not advance from startingRef");
	command("git", ["merge-base", "--is-ancestor", startingCommit, branchCommit], { cwd: repo.seedDir, label: "verify cloud branch startingRef ancestry" });
	const remoteContent = command("git", ["show", `${remoteRef}:branch-proof.txt`], { cwd: repo.seedDir, label: "read cloud branch proof" });
	if (remoteContent !== marker) fail("cloud branch proof content did not match marker", remoteContent);

	const rpc = await startRpc({ artifactDir, sessionId, envOptions });
	try {
		const commandResponse = await rpc.send("prompt", { message: `/cursor-cloud delete ${result.agentId} --yes` }, timeoutMs);
		if (!commandResponse.success) fail("lifecycle delete command failed", commandResponse.error);
	} finally {
		await rpc.stop();
	}
	try {
		await assertAgentDeleted(Agent, result.agentId);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), error?.details ?? "");
	}
	if (!cloudLifecycleRecords(artifactDir).some(({ data }) => data.agentId === result.agentId && data.action === "delete")) fail("lifecycle delete result missing from canonical journal/JSONL", result.agentId);
	return [
		{
			name: "explicit-https-repo-starting-ref-branch-pr-reporting",
			status: "passed",
			agentId: result.agentId,
			runId: result.runId,
			branchReportObserved: result.report.branches.some((branch) => Boolean(branch.branch)),
			startingRefAncestryVerified: true,
			remoteContentVerified: true,
			prUrlReturned: result.report.branches.some((branch) => Boolean(branch.prUrl)),
			report: result.report,
		},
		{
			name: "lifecycle-delete",
			status: "passed",
			agentId: result.agentId,
			runId: result.runId,
			lifecycleDeleteVerified: true,
		},
	];
}

async function runDirectPushLane({ artifactRoot, repo, timeoutMs }) {
	const artifactDir = join(artifactRoot, "lane-direct-push");
	const timestamp = Date.now();
	const marker = `DIRECT_PUSH_PROOF_${timestamp}`;
	const before = command("git", authenticatedGitArgs(["ls-remote", repo.repoUrl, "refs/heads/direct-push"]), { label: "read direct-push branch before lane" }).split(/\s+/)[0];
	const result = await runSuccessfulPrintLane({
		artifactDir,
		envOptions: { repoUrl: repo.repoUrl, startingRef: "direct-push", directPush: true },
		message: `Create direct-push-proof.txt containing exactly ${marker} followed by a newline, commit and push it to the current direct-push branch, then reply exactly DIRECT_PUSH_LANE_OK.`,
		marker: "DIRECT_PUSH_LANE_OK",
		sessionId: `cloud-direct-push-${timestamp}`,
		timeoutMs,
	});
	command("git", authenticatedGitArgs(["fetch", "origin", "+refs/heads/direct-push:refs/remotes/origin/direct-push"]), { cwd: repo.seedDir, label: "fetch direct-push proof" });
	const after = command("git", ["rev-parse", "refs/remotes/origin/direct-push"], { cwd: repo.seedDir });
	if (!before || before === after) fail("direct-push remote branch content did not change");
	const content = command("git", ["show", "refs/remotes/origin/direct-push:direct-push-proof.txt"], { cwd: repo.seedDir, label: "read direct-push proof" });
	if (content !== marker) fail("direct-push remote content did not match marker", content);
	return { name: "direct-push-opt-in", status: "passed", agentId: result.agentId, runId: result.runId, remoteContentChanged: true, report: result.report };
}

async function runCancelLane({ artifactRoot, repo, timeoutMs, Agent }) {
	const artifactDir = join(artifactRoot, "lane-cancel");
	const rpc = await startRpc({ artifactDir, sessionId: `cloud-cancel-${Date.now()}`, envOptions: { repoUrl: repo.repoUrl, startingRef: "starting-ref" } });
	const eventStart = rpc.events.length;
	try {
		const response = await rpc.send("prompt", { message: "Run the shell command `sleep 300`, wait for it, then reply CANCEL_LANE_UNEXPECTED_COMPLETION." }, timeoutMs);
		if (!response.success) fail("cancel lane prompt was rejected", response.error);
		let nextRunProbeAt = 0;
		const identity = await waitFor(async () => {
			rpc.throwIfFailed();
			const latest = readLatestCloudSmokeMetadata(artifactDir);
			const agentId = latest?.metadata.run?.agentId;
			if (!CLOUD_AGENT_ID_PATTERN.test(agentId ?? "")) return undefined;
			if (CLOUD_RUN_ID_PATTERN.test(latest.metadata.run?.runId ?? "")) {
				return { agentId, runId: latest.metadata.run.runId, runIdSource: "metadata" };
			}
			if (Date.now() < nextRunProbeAt) return undefined;
			nextRunProbeAt = Date.now() + 2_000;
			try {
				const page = await Agent.listRuns(agentId, { runtime: "cloud", apiKey: process.env.CURSOR_API_KEY, limit: 10 });
				const run = page.items.find((item) => CLOUD_RUN_ID_PATTERN.test(item.id ?? ""));
				return run ? { agentId, runId: run.id, runIdSource: "agent-list-runs" } : undefined;
			} catch {
				return undefined;
			}
		}, timeoutMs, "cancel lane did not capture exact agent and run IDs before abort");
		const { agentId, runId, runIdSource } = identity;
		const abortResponse = await rpc.send("abort", {}, 120000);
		if (!abortResponse.success) fail("cancel lane abort request failed", abortResponse.error);
		await waitForAgentSettled(rpc, eventStart, timeoutMs);
		await waitFor(() => {
			rpc.throwIfFailed();
			try {
				assertLaneEvidence(artifactDir, agentId, runId);
				return true;
			} catch {
				return false;
			}
		}, timeoutMs, "cancel lane did not retain exact agent/run lifecycle evidence after abort");
		const terminal = await waitFor(async () => {
			rpc.throwIfFailed();
			const run = await Agent.getRun(runId, { runtime: "cloud", agentId, apiKey: process.env.CURSOR_API_KEY });
			return run.status === "cancelled" ? run : run.status === "finished" || run.status === "error" ? fail(`cancel lane reached wrong terminal state ${run.status}`) : undefined;
		}, timeoutMs, "cancel lane SDK status did not reach cancelled");
		return { name: "cancel", status: "passed", agentId, runId, runIdSource, terminalStatus: terminal.status, idsCapturedBeforeAbort: true };
	} finally {
		await rpc.stop();
	}
}

async function runMissingBranchLane({ artifactRoot, repo, timeoutMs }) {
	const artifactDir = join(artifactRoot, "lane-missing-branch");
	const timestamp = Date.now();
	const missingRef = `missing-${timestamp}`;
	const run = await runPi({
		artifactDir,
		envOptions: { repoUrl: repo.repoUrl, startingRef: missingRef },
		message: "Reply MISSING_BRANCH_UNEXPECTED_SUCCESS.",
		sessionId: `cloud-missing-${timestamp}`,
		timeoutMs,
	});
	const failureOutput = `${run.stdout}\n${run.stderr}`;
	if (run.code === 0 || run.stdout.includes("MISSING_BRANCH_UNEXPECTED_SUCCESS") || !/(branch|ref).*(missing|not found|exist|invalid)|(missing|not found|exist|invalid).*(branch|ref)/i.test(failureOutput)) {
		fail("missing branch did not fail closed with branch/ref evidence", failureOutput);
	}
	const agentIds = new Set();
	for (const { metadataPath, metadata } of readCloudSmokeMetadata(artifactDir)) {
		const agentId = metadata.run?.agentId ?? metadata.providerMeta?.cloudAgentId;
		const runId = metadata.run?.runId;
		if (agentId) {
			if (!CLOUD_AGENT_ID_PATTERN.test(agentId)) fail("missing-branch path recorded malformed agent ID", metadataPath);
			agentIds.add(agentId);
			assertLaneEvidence(artifactDir, agentId, runId);
		}
	}
	return { name: "missing-branch-failure", status: "passed", expectedFailureObserved: true, agentIds: [...agentIds].sort() };
}

function accountConditionalLane(lanes) {
	const reports = lanes.map((lane) => lane.report).filter(Boolean);
	return {
		name: "passive-artifacts-and-raw-usage",
		status: "passed",
		artifactsObserved: reports.some((report) => Array.isArray(report.artifacts) && report.artifacts.length > 0),
		rawUsageObserved: reports.some((report) => report.usage && Object.keys(report.usage).length > 0),
		observationsValidated: true,
	};
}

function stageEvidenceSummary(summary) {
	const text = assertCloudSmokeEvidenceSafe(validateCloudSmokeMatrixEvidence(summary));
	mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
	const temporary = `${EVIDENCE_PATH}.tmp-${process.pid}`;
	writeFileSync(temporary, text, { mode: 0o644 });
	return temporary;
}

function commitEvidenceSummary(temporary) {
	try {
		renameSync(temporary, EVIDENCE_PATH);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

async function main() {
	if (!process.env.CURSOR_API_KEY) fail("CURSOR_API_KEY is required for cloud smoke and verified cleanup");
	const timeoutMs = Number(process.env.CURSOR_CLOUD_SMOKE_TIMEOUT_MS || 300000);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("CURSOR_CLOUD_SMOKE_TIMEOUT_MS must be a positive number");
	const artifactRoot = mkdtempSync(join(tmpdir(), "pi-cursor-cloud-smoke-"));
	installCloudSmokeSignalHandlers(cloudSmokeShutdown, process, () => { process.exitCode = 1; });
	let failure;
	console.error(scrubSmokeText(`[cloud-smoke] artifacts: ${artifactRoot}`));
	const { Agent } = await import("@cursor/sdk");
	const contextMatrix = args.has("--context-matrix");
	try {
		await coordinateCloudSmokeReleaseGate({
			throwIfInterrupted: () => cloudSmokeShutdown.throwIfRequested(),
			run: async (state) => {
				cloudSmokeShutdown.throwIfRequested();
				if (contextMatrix) {
					state.lanes = await runContextMatrix({ artifactRoot, timeoutMs });
					console.error("[cloud-smoke] context matrix passed");
					return;
				}
				try {
					state.repository = createThrowawayRepository(
						artifactRoot,
						(created) => { state.repository = created; },
						{ cwd: root },
					);
				} catch (error) {
					fail(error instanceof Error ? error.message : String(error), error?.details ?? "");
				}
				const repo = state.repository;
				state.lanes.push(await runCancelLane({ artifactRoot, repo, timeoutMs, Agent }));
				state.lanes.push(...await runBranchAndLifecycleLane({ artifactRoot, repo, timeoutMs, Agent }));
				state.lanes.push(await runDirectPushLane({ artifactRoot, repo, timeoutMs }));
				state.lanes.push(await runMissingBranchLane({ artifactRoot, repo, timeoutMs }));
				state.lanes.push(accountConditionalLane(state.lanes));
			},
			harvestAgentIds: (state) => {
				const allAgentIds = new Set([
					...cloudAgentIdsFromMetadata(artifactRoot),
					...cloudAgentIdsFromLifecycleArtifacts(artifactRoot),
				]);
				for (const lane of state.lanes) {
					if (CLOUD_AGENT_ID_PATTERN.test(lane.agentId ?? "")) allAgentIds.add(lane.agentId);
					for (const turn of [lane.first, lane.second]) {
						if (CLOUD_AGENT_ID_PATTERN.test(turn?.agentId ?? "")) allAgentIds.add(turn.agentId);
					}
				}
				return allAgentIds;
			},
			cleanupAgent: (agentId) => cleanupCloudAgent(Agent, agentId),
			onAgentCleanupError: (error, agentId) => {
				console.error(scrubSmokeText(`[cloud-smoke] cleanup failed for ${agentId}: ${error instanceof Error ? error.message : String(error)}`));
			},
			cleanupRepository: (repo) => deleteThrowawayRepository(repo, { cwd: root }),
			onRepositoryCleanupError: (error, repo) => {
				console.error(scrubSmokeText(`[cloud-smoke] repository cleanup failed for ${repo.fullName}: ${error instanceof Error ? error.message : String(error)}`));
			},
			writeEvidence: async ({ lanes, cleanup, throwawayRepository }) => {
				if (contextMatrix) return;
				const summary = projectCloudSmokeMatrixEvidence({
					model: MODEL,
					lanes,
					cleanup,
					throwawayRepository,
					provenance: buildCloudSmokeEvidenceProvenance({ root }),
				});
				const temporary = stageEvidenceSummary(summary);
				try {
					await checkpointCloudSmokeShutdown(cloudSmokeShutdown);
					commitEvidenceSummary(temporary);
				} catch (error) {
					rmSync(temporary, { force: true });
					throw error;
				}
			},
		});
		await checkpointCloudSmokeShutdown(cloudSmokeShutdown);
	} catch (error) {
		failure = error;
	}
	if (process.env.CURSOR_CLOUD_SMOKE_KEEP_ARTIFACTS !== "1" && !failure) rmSync(artifactRoot, { recursive: true, force: true });
	else console.error(scrubSmokeText(`[cloud-smoke] retained artifacts: ${artifactRoot}`));
	if (!failure) {
		try {
			await checkpointCloudSmokeShutdown(cloudSmokeShutdown);
		} catch (error) {
			failure = error;
		}
	}
	if (failure) throw failure;
	console.log(contextMatrix ? "cloud-context-smoke-ok" : "cloud-smoke-ok");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	ensureBuilt();
	main().catch((error) => {
		reportFailure(error);
		process.exit(1);
	});
}
