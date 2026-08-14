#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	assertNotResumedFrom,
	assertTurnMetadata,
	assistantEntryContaining,
	buildLocalResumeSmokeEnv,
	cleanupArtifactRoot,
	compactionEntryCount,
	createRunContext,
	fail,
	getEntries,
	getState,
	latestResumeEntry,
	parseTimeout,
	promptAbortAndRead,
	promptAndRead,
	reportFailure,
	resumeEntries,
	scrubSmokeText,
	resumeEntryCount,
	rpcData,
	userEntryContaining,
	withRpc,
	writeTreeCommandExtension,
} from "./lib/local-resume-smoke-harness.mjs";
import { ensureBuilt } from "./lib/ensure-built.mjs";
import { runCleanupSmoke } from "./local-resume-cleanup-smoke.mjs";
import { writePlatformArtifactBundle } from "./platform-smoke/artifacts.mjs";
import { LOCAL_RESUME_SUITES } from "./platform-smoke/local-resume-suites.mjs";

export { buildLocalResumeSmokeEnv };

const argv = process.argv.slice(2);
const args = new Set(argv);

function printHelp() {
	const npmUsage = LOCAL_RESUME_SUITES.map((lane) => `  npm run ${lane.script}`).join("\n");
	const nodeUsage = LOCAL_RESUME_SUITES.map((lane) => `  node scripts/local-resume-smoke.mjs${lane.flag ? ` ${lane.flag}` : ""}`).join("\n");
	console.log(`Live local Cursor resume smoke for pi-cursor-sdk.

Usage:
${npmUsage}
${nodeUsage}

Environment:
  CURSOR_LOCAL_RESUME_SMOKE_MODEL          Cursor model id (default: cursor/composer-2-5:slow).
  CURSOR_LOCAL_RESUME_SMOKE_TIMEOUT_MS     Timeout in ms per model turn (default: 300000).
  CURSOR_LOCAL_RESUME_SMOKE_KEEP_ARTIFACTS Keep temp artifacts when set to 1.
  CURSOR_LOCAL_RESUME_SMOKE_EXTENSION_PATH Packed extension path override (platform runner only).
  CURSOR_LOCAL_RESUME_SMOKE_ARTIFACT_DIR   Fixed artifact root (platform runner only).

Exit codes:
  0  local resume proof passed
  1  auth/run/assertion failure
  2  invalid command-line usage`);
}

if (args.has("-h") || args.has("--help")) {
	printHelp();
	process.exit(0);
}

const laneFlags = new Set(LOCAL_RESUME_SUITES.flatMap((lane) => lane.flag ? [lane.flag] : []));
const unknownArgs = argv.filter((arg) => !laneFlags.has(arg));
const selectedLaneArgs = argv.filter((arg) => laneFlags.has(arg));
if (unknownArgs.length > 0 || selectedLaneArgs.length > 1) {
	const message = unknownArgs.length > 0
		? `unknown argument(s): ${unknownArgs.join(", ")}`
		: "only one smoke lane may be selected";
	console.error(scrubSmokeText(`[local-resume-smoke] usage error: ${message}\nRun with --help for usage.`));
	process.exit(2);
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

async function runSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-smoke-");
	const marker = `LOCAL_RESUME_${Date.now()}`;
	let first;
	let second;
	console.error(scrubSmokeText(`[local-resume-smoke] artifacts: ${artifactRoot}`));
	try {
		first = await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId }, (rpc) => promptAndRead({
			rpc,
			artifactDir: artifactRoot,
			message: `Remember exact marker ${marker}. You must repeat it from conversation memory on my next turn. Reply exactly FIRST_OK.`,
			timeoutMs,
			seenMetadata,
		}));
		assertTurnMetadata("first turn", first, { resumedAgent: false });

		second = await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId }, (rpc) => promptAndRead({
			rpc,
			artifactDir: artifactRoot,
			message: "Repeat the exact LOCAL_RESUME marker from my immediately previous message. Do not use tools or inspect files. Reply with only MARKER=<marker>.",
			timeoutMs,
			seenMetadata,
		}));
		if (!second.text.includes(`MARKER=${marker}`)) fail("second turn did not recall local resume marker", JSON.stringify({ expected: `MARKER=${marker}`, actual: second.text }, null, 2));
		assertTurnMetadata("second turn", second, { resumedAgent: true });
		if (first.metadata.run.agentId !== second.metadata.run.agentId) {
			fail("second turn did not reuse the first local SDK agent", JSON.stringify({ first: first.metadata.run.agentId, second: second.metadata.run.agentId }, null, 2));
		}
		console.log("local-resume-smoke-ok");
		console.error(scrubSmokeText(`[local-resume-smoke] agent ${second.metadata.run.agentId} resumed across restart`));
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runSafetySmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-safety-smoke-");
	const baseMarker = `LOCAL_BASE_${Date.now()}`;
	const futureMarker = `LOCAL_FUTURE_${Date.now()}`;
	let originalSessionFile;
	let originalAgentId;
	let futureEntryId;
	console.error(scrubSmokeText(`[local-resume-smoke] artifacts: ${artifactRoot}`));
	try {
		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId }, async (rpc) => {
			const first = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact base marker ${baseMarker}. Reply exactly BASE_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("base turn", first, { resumedAgent: false });
			const future = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact future-only marker ${futureMarker}. Reply exactly FUTURE_OK.`,
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
			futureEntryId = userEntryContaining(entries, futureMarker)?.id;
			if (!futureEntryId) fail("could not find future-marker user entry", originalSessionFile ?? "");
		});

		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId }, async (rpc) => {
			const same = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "From this conversation memory only, what exact LOCAL_FUTURE marker did I ask you to remember? Reply exactly MARKER=<marker> if known, otherwise NO_MARKER. Do not inspect environment variables or files.",
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
				message: "What exact LOCAL_FUTURE marker is visible in this cloned pi transcript? Reply exactly MARKER=<marker> if visible, otherwise NO_MARKER.",
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("clone session", cloneTurn, originalAgentId);

			await rpcData(rpc, "switch_session", { sessionPath: originalSessionFile }, 120000);
			const fork = await rpcData(rpc, "fork", { entryId: futureEntryId }, 120000);
			if (fork.cancelled === true) fail("fork was cancelled");
			const forkEntries = await getEntries(rpc);
			if (JSON.stringify(forkEntries).includes(futureMarker)) fail("fork branch already contained future marker before prompt", String(futureEntryId));
			const forkTurn = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "On this current forked earlier branch only, what exact LOCAL_FUTURE marker is visible? Reply exactly MARKER=<marker> only if the full marker is present on this active branch; otherwise reply exactly NO_MARKER. Do not use memory from other branches, environment variables, or files.",
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("fork before future", forkTurn, originalAgentId);
			if (forkTurn.text.includes(futureMarker)) fail("forked earlier branch leaked future marker", forkTurn.text);
		});
		console.log("local-resume-safety-smoke-ok");
		console.error(scrubSmokeText(`[local-resume-smoke] original ${originalAgentId} rejected for clone and fork-before-future`));
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
	const marker = `LOCAL_TOOL_SURFACE_${Date.now()}`;
	let originalAgentId;
	let originalPoolKey;
	console.error(scrubSmokeText(`[local-resume-smoke] artifacts: ${artifactRoot}`));
	try {
		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId }, async (rpc) => {
			const first = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact tool-surface marker ${marker}. Reply exactly TOOL_SURFACE_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("baseline tool surface", first, { resumedAgent: false });
			originalAgentId = first.metadata.run.agentId;
			originalPoolKey = latestResumeEntry(await getEntries(rpc))?.poolKey;
			if (!originalPoolKey) fail("baseline turn did not persist a resume pool key");
		});

		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId }, async (rpc) => {
			const sameSurface = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "From this conversation memory only, what exact LOCAL_TOOL_SURFACE marker did I ask you to remember? Reply exactly MARKER=<marker> if known, otherwise NO_MARKER. Do not inspect environment variables or files.",
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("same tool surface restart", sameSurface, { resumedAgent: true });
			if (sameSurface.metadata.run.agentId !== originalAgentId) fail("same tool surface restart did not resume original agent", JSON.stringify({ original: originalAgentId, actual: sameSurface.metadata.run.agentId }, null, 2));
		});

		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId, bridge: true, exposeBuiltinTools: true }, async (rpc) => {
			const changedSurface = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_TOOL_SURFACE marker is visible in this pi transcript? Reply exactly MARKER=<marker> if visible, otherwise NO_MARKER.",
				timeoutMs,
				seenMetadata,
			});
			if (!changedSurface.text.includes(`MARKER=${marker}`)) fail("changed tool surface did not bootstrap transcript marker", JSON.stringify({ expected: `MARKER=${marker}`, actual: changedSurface.text }, null, 2));
			assertNotResumedFrom("changed tool surface", changedSurface, originalAgentId);
			if (!changedSurface.metadata.providerMeta?.bridgeRunId) fail("changed tool surface did not start a bridge run", changedSurface.metadataPath);
			const changedHandle = latestResumeEntry(await getEntries(rpc));
			if (!changedHandle?.poolKey) fail("changed tool surface did not persist a resume pool key");
			if (changedHandle.agentId !== changedSurface.metadata.run.agentId) fail("changed tool surface persisted handle for a different agent", JSON.stringify({ handle: changedHandle.agentId, run: changedSurface.metadata.run.agentId }, null, 2));
			if (changedHandle.poolKey === originalPoolKey) fail("changed tool surface reused the original pool key");
		});
		console.log("local-resume-tool-surface-smoke-ok");
		console.error(scrubSmokeText(`[local-resume-smoke] original ${originalAgentId} rejected after bridge builtin tool surface change`));
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runAbortSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-abort-smoke-");
	const marker = `LOCAL_ABORT_${Date.now()}`;
	const markerDir = ".debug/local-resume-abort";
	const markerPath = join(artifactRoot, "workspace", markerDir, "started.txt");
	let originalAgentId;
	let resumeCountBeforeAbort;
	console.error(scrubSmokeText(`[local-resume-smoke] artifacts: ${artifactRoot}`));
	try {
		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId, bridge: true, exposeBuiltinTools: true }, async (rpc) => {
			const baseline = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact abort marker ${marker}. Reply exactly ABORT_BASELINE_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("abort baseline", baseline, { resumedAgent: false });
			if (!baseline.metadata.providerMeta?.bridgeRunId) fail("abort baseline did not start a bridge run", baseline.metadataPath);
			originalAgentId = baseline.metadata.run.agentId;
			resumeCountBeforeAbort = resumeEntryCount(await getEntries(rpc));
			if (resumeCountBeforeAbort < 1) fail("abort baseline did not persist a resume handle");
		});

		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId, bridge: true, exposeBuiltinTools: true }, async (rpc) => {
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
		});

		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId, bridge: true, exposeBuiltinTools: true }, async (rpc) => {
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
		});
		console.log("local-resume-abort-smoke-ok");
		console.error(scrubSmokeText(`[local-resume-smoke] original ${originalAgentId} not reused after aborted bridge turn`));
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runTreeSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-tree-smoke-");
	const baseMarker = `LOCAL_TREE_BASE_${Date.now()}`;
	const futureMarker = `LOCAL_TREE_FUTURE_${Date.now()}`;
	const extensionPath = writeTreeCommandExtension(artifactRoot);
	let originalAgentId;
	let baseAssistantId;
	let baseResumeEntryId;
	console.error(scrubSmokeText(`[local-resume-smoke] artifacts: ${artifactRoot}`));
	try {
		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId, extraExtensions: [extensionPath] }, async (rpc) => {
			const base = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact tree base marker ${baseMarker}. Reply exactly TREE_BASE_OK.`,
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
				message: `Remember exact tree future-only marker ${futureMarker}. Reply exactly TREE_FUTURE_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("tree future", future, { resumedAgent: false });
			if (future.metadata.run.agentId !== base.metadata.run.agentId) fail("tree setup did not keep one original local SDK agent", JSON.stringify({ base: base.metadata.run.agentId, future: future.metadata.run.agentId }, null, 2));
			originalAgentId = future.metadata.run.agentId;

			const question = "On this current earlier tree branch only, what exact LOCAL_TREE_FUTURE marker is visible? Reply exactly MARKER=<marker> only if the full marker is present on this active branch; otherwise reply exactly NO_MARKER. Do not use memory from other branches, environment variables, or files.";
			const assistantTarget = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `/local_resume_tree_go ${baseAssistantId} ${question}`,
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("tree assistant target", assistantTarget, originalAgentId);
			if (assistantTarget.text.includes(futureMarker)) fail("tree assistant target leaked future marker", assistantTarget.text);

			const resumeEntryTarget = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `/local_resume_tree_go ${baseResumeEntryId} ${question}`,
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("tree resume-entry target", resumeEntryTarget, originalAgentId);
			if (resumeEntryTarget.text.includes(futureMarker)) fail("tree resume-entry target leaked future marker", resumeEntryTarget.text);
		});
		console.log("local-resume-tree-smoke-ok");
		console.error(scrubSmokeText(`[local-resume-smoke] original ${originalAgentId} rejected for tree assistant and resume-entry targets`));
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runCopySwitchSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-copy-switch-smoke-");
	const marker = `LOCAL_COPY_SWITCH_${Date.now()}`;
	let originalAgentId;
	let originalSessionFile;
	console.error(scrubSmokeText(`[local-resume-smoke] artifacts: ${artifactRoot}`));
	try {
		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId }, async (rpc) => {
			const baseline = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact copy-switch marker ${marker}. Reply exactly COPY_SWITCH_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("copy-switch baseline", baseline, { resumedAgent: false });
			originalAgentId = baseline.metadata.run.agentId;
			originalSessionFile = (await getState(rpc)).sessionFile;
			if (!originalSessionFile) fail("copy-switch baseline did not persist a session file");
		});

		const copiedSessionFile = join(dirname(originalSessionFile), `copied-${Date.now()}.jsonl`);
		copyFileSync(originalSessionFile, copiedSessionFile);

		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId }, async (rpc) => {
			await rpcData(rpc, "switch_session", { sessionPath: copiedSessionFile }, 120000);
			const entries = await getEntries(rpc);
			if (resumeEntryCount(entries) < 1) fail("copied session did not carry a resume entry to reject", copiedSessionFile);
			const switched = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_COPY_SWITCH marker is visible in this copied session? Reply exactly MARKER=<marker> if visible, otherwise NO_MARKER.",
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("copied session switch", switched, originalAgentId);
			if (!switched.text.includes(`MARKER=${marker}`)) fail("copied session did not bootstrap marker from transcript", JSON.stringify({ expected: `MARKER=${marker}`, actual: switched.text }, null, 2));
		});
		console.log("local-resume-copy-switch-smoke-ok");
		console.error(scrubSmokeText(`[local-resume-smoke] original ${originalAgentId} rejected for copied session switch`));
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runFallbackSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-fallback-smoke-");
	const marker = `LOCAL_FALLBACK_${Date.now()}`;
	const bogusAgentId = `agent-missing-${Date.now()}`;
	let originalAgentId;
	let sessionFile;
	console.error(scrubSmokeText(`[local-resume-smoke] artifacts: ${artifactRoot}`));
	try {
		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId }, async (rpc) => {
			const baseline = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact fallback marker ${marker}. Reply exactly FALLBACK_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("fallback baseline", baseline, { resumedAgent: false });
			originalAgentId = baseline.metadata.run.agentId;
			sessionFile = (await getState(rpc)).sessionFile;
			if (!sessionFile) fail("fallback baseline did not persist a session file");
			if (resumeEntryCount(await getEntries(rpc)) < 1) fail("fallback baseline did not persist a resume handle");
		});

		rewriteResumeAgentIds(sessionFile, bogusAgentId);

		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId }, async (rpc) => {
			const fallback = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_FALLBACK marker is visible after the missing local agent fallback? Reply exactly MARKER=<marker> if visible, otherwise NO_MARKER.",
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("missing-agent fallback", fallback, originalAgentId);
			if (!fallback.text.includes(`MARKER=${marker}`)) fail("missing-agent fallback did not bootstrap marker from transcript", JSON.stringify({ expected: `MARKER=${marker}`, actual: fallback.text }, null, 2));
			const continuityNotice = fallback.events.some((event) =>
				event?.type === "message_update" &&
				event.assistantMessageEvent?.type === "thinking_delta" &&
				typeof event.assistantMessageEvent.delta === "string" &&
				event.assistantMessageEvent.delta.includes("Could not resume prior Cursor agent")
			);
			if (!continuityNotice) fail("missing-agent fallback did not emit resume continuity notice", fallback.metadataPath);
		});
		console.log("local-resume-fallback-smoke-ok");
		console.error(scrubSmokeText(`[local-resume-smoke] missing ${bogusAgentId} fell back from original ${originalAgentId}`));
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runCompactionSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-compaction-smoke-");
	const marker = `LOCAL_COMPACTION_${Date.now()}`;
	let preCompactionAgentId;
	let postCompactionAgentId;
	console.error(scrubSmokeText(`[local-resume-smoke] artifacts: ${artifactRoot}`));
	mkdirSync(join(artifactRoot, "agent"), { recursive: true });
	writeFileSync(join(artifactRoot, "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 16384 } }, null, 2));
	try {
		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId }, async (rpc) => {
			const baseline = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact compaction marker ${marker}. Reply exactly COMPACTION_BASELINE_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("compaction baseline", baseline, { resumedAgent: false });
			preCompactionAgentId = baseline.metadata.run.agentId;
			const result = await rpcData(rpc, "compact", { customInstructions: `Preserve the exact marker ${marker}.` }, timeoutMs);
			if (!result.summary || typeof result.tokensBefore !== "number") fail("manual compaction did not return a summary result", JSON.stringify(result, null, 2));
			const compactedEntries = await getEntries(rpc);
			if (compactionEntryCount(compactedEntries) < 1) fail("manual compaction did not append a compaction entry");

			const postCompaction = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_COMPACTION marker is visible after compaction? Reply exactly MARKER=<marker> if visible, otherwise NO_MARKER.",
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("post-compaction turn", postCompaction, preCompactionAgentId);
			if (!postCompaction.text.includes(`MARKER=${marker}`)) fail("post-compaction turn did not recall marker", JSON.stringify({ expected: `MARKER=${marker}`, actual: postCompaction.text }, null, 2));
			postCompactionAgentId = postCompaction.metadata.run.agentId;
			const postHandle = latestResumeEntry(await getEntries(rpc));
			if (postHandle?.agentId !== postCompactionAgentId) fail("post-compaction turn did not persist the new agent handle", JSON.stringify({ handle: postHandle?.agentId, run: postCompactionAgentId }, null, 2));
			if (postHandle.compactionGeneration !== 1) fail("post-compaction handle did not record compactionGeneration=1", JSON.stringify(postHandle, null, 2));
		});

		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId }, async (rpc) => {
			const restart = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_COMPACTION marker is visible after post-compaction restart? Reply exactly MARKER=<marker> if visible, otherwise NO_MARKER.",
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("post-compaction restart", restart, { resumedAgent: true });
			if (restart.metadata.run.agentId !== postCompactionAgentId) fail("post-compaction restart did not resume the post-compaction agent", JSON.stringify({ expected: postCompactionAgentId, actual: restart.metadata.run.agentId }, null, 2));
		});
		console.log("local-resume-compaction-smoke-ok");
		console.error(scrubSmokeText(`[local-resume-smoke] pre-compaction ${preCompactionAgentId} replaced by and resumed post-compaction ${postCompactionAgentId}`));
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}

async function runDefaultDryRunSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-default-dry-run-smoke-");
	const marker = `LOCAL_DEFAULT_DRY_RUN_${Date.now()}`;
	let defaultAgentId;
	console.error(scrubSmokeText(`[local-resume-smoke] artifacts: ${artifactRoot}`));
	try {
		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId, localResumeEnv: "unset" }, async (rpc) => {
			const baseline = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact default-dry-run marker ${marker}. Reply exactly DEFAULT_DRY_RUN_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("builtin default baseline", baseline, { resumedAgent: false });
			if (baseline.metadata.providerMeta?.localResume !== true) fail("builtin default baseline did not record localResume=true", baseline.metadataPath);
		});

		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId, localResumeEnv: "unset" }, async (rpc) => {
			const defaultRestart = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_DEFAULT_DRY_RUN marker did I ask you to remember? Reply exactly MARKER=<marker> if visible, otherwise NO_MARKER.",
				timeoutMs,
				seenMetadata,
			});
			if (!defaultRestart.text.includes(`MARKER=${marker}`)) fail("builtin default restart did not recall marker", JSON.stringify({ expected: `MARKER=${marker}`, actual: defaultRestart.text }, null, 2));
			assertTurnMetadata("builtin default restart", defaultRestart, { resumedAgent: true });
			defaultAgentId = defaultRestart.metadata.run.agentId;
		});

		await withRpc({
			artifactDir: artifactRoot,
			sessionDir,
			sessionId,
			localResumeEnv: "off",
		}, async (rpc) => {
			const optedOut = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "What exact LOCAL_DEFAULT_DRY_RUN marker did I ask you to remember? Reply exactly MARKER=<marker> if visible, otherwise NO_MARKER.",
				timeoutMs,
				seenMetadata,
			});
			if (!optedOut.text.includes(`MARKER=${marker}`)) fail("env opt-out run did not bootstrap marker from transcript", JSON.stringify({ expected: `MARKER=${marker}`, actual: optedOut.text }, null, 2));
			if (optedOut.metadata.providerMeta?.localResume !== false) fail("env opt-out run did not record localResume=false", optedOut.metadataPath);
			if (optedOut.metadata.providerMeta?.resumedAgent !== false) fail("env opt-out run unexpectedly resumed an agent", optedOut.metadataPath);
			if (optedOut.metadata.run?.agentId === defaultAgentId) fail("env opt-out run reused the default-resume agent", JSON.stringify({ configured: defaultAgentId, actual: optedOut.metadata.run?.agentId }, null, 2));
		});
		console.log("local-resume-default-dry-run-smoke-ok");
		console.error(scrubSmokeText(`[local-resume-smoke] built-in default resumed ${defaultAgentId}; env opt-out rejected it`));
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
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
	cleanup: runCleanupSmoke,
};

function selectedRun() {
	const lane = LOCAL_RESUME_SUITES.find((candidate) => candidate.flag && args.has(candidate.flag));
	return SMOKE_RUNNERS[lane?.key ?? "restart"];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	ensureBuilt();
	const run = selectedRun();
	run()
		.catch((error) => {
			reportFailure(error);
			process.exitCode = 1;
		})
		.finally(() => {
			const artifactRoot = process.env.CURSOR_LOCAL_RESUME_SMOKE_ARTIFACT_DIR;
			if (artifactRoot && process.env.CURSOR_LOCAL_RESUME_SMOKE_EMIT_BUNDLE === "1") {
				writePlatformArtifactBundle(artifactRoot, "local-resume-evidence");
			}
		});
}
