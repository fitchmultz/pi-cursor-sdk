import {
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
	scrubSmokeText,
	waitForCleanupEntryCount,
	withRpc,
	writeTreeCommandExtension,
} from "./lib/local-resume-smoke-harness.mjs";

export async function runCleanupSmoke() {
	const timeoutMs = parseTimeout();
	const { artifactRoot, sessionDir, sessionId, seenMetadata } = createRunContext("pi-cursor-local-resume-cleanup-smoke-");
	const marker = `LOCAL_CLEANUP_${Date.now()}`;
	const extensionPath = writeTreeCommandExtension(artifactRoot);
	let oldAgentId;
	let newAgentId;
	let oldResumeEntryId;
	let oldStoreIdentity;
	console.error(scrubSmokeText(`[local-resume-smoke] artifacts: ${artifactRoot}`));
	try {
		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId }, async (rpc) => {
			const baseline = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `Remember exact cleanup marker ${marker}. Reply exactly CLEANUP_BASELINE_OK.`,
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("cleanup baseline", baseline, { resumedAgent: false });
			oldAgentId = baseline.metadata.run.agentId;
			const baselineHandle = resumeEntries(await getEntries(rpc)).at(-1);
			oldResumeEntryId = baselineHandle?.id;
			oldStoreIdentity = baselineHandle?.data?.storeIdentity;
			if (!oldResumeEntryId) fail("cleanup baseline did not persist a resume entry");
			if (baselineHandle?.data?.version !== 2 || !oldStoreIdentity?.stateRoot?.includes("pi-sessions")) {
				fail("cleanup baseline did not persist a per-session store identity", JSON.stringify(baselineHandle?.data, null, 2));
			}
		});

		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId, bridge: true, exposeBuiltinTools: true }, async (rpc) => {
			const changedSurface = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "From this conversation memory only, what exact LOCAL_CLEANUP marker did I ask you to remember before the tool-surface change? Reply exactly MARKER=<marker> if known, otherwise NO_MARKER. Do not inspect environment variables or files.",
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("cleanup changed tool surface", changedSurface, oldAgentId);
			newAgentId = changedSurface.metadata.run.agentId;
			const changedHandle = latestResumeEntry(await getEntries(rpc));
			const cleanupCandidate = changedHandle?.cleanupCandidates?.find((candidate) => candidate.agentId === oldAgentId);
			if (!cleanupCandidate || JSON.stringify(cleanupCandidate.storeIdentity) !== JSON.stringify(oldStoreIdentity)) {
				fail("changed tool surface did not record old agent cleanup candidate with its store identity", JSON.stringify({ oldAgentId, oldStoreIdentity, changedHandle }, null, 2));
			}

			await rpcData(rpc, "prompt", { message: "/cursor-local-resume-cleanup --dry-run" }, timeoutMs);
			let latestCleanup = (await waitForCleanupEntryCount(rpc, 1, timeoutMs)).at(-1)?.data;
			if (latestCleanup?.action !== "dry-run" || latestCleanup.deletedAgentIds?.length || latestCleanup.failedAgentIds?.length) {
				fail("cleanup dry-run did not record a pure dry-run", JSON.stringify(latestCleanup, null, 2));
			}
			assertExactStringArray("cleanup dry-run candidates", latestCleanup.candidateAgentIds, [oldAgentId]);

			await rpcData(rpc, "prompt", { message: "/cursor-local-resume-cleanup --yes" }, timeoutMs);
			const deleteEntries = await waitForCleanupEntryCount(rpc, 3, timeoutMs);
			const intent = deleteEntries.at(-2)?.data;
			latestCleanup = deleteEntries.at(-1)?.data;
			if (intent?.action !== "delete" || intent.phase !== "intent" || intent.deletedAgentIds?.length || intent.failedAgentIds?.length) {
				fail("cleanup delete did not record intent before its result", JSON.stringify(intent, null, 2));
			}
			assertExactStringArray("cleanup intent candidates", intent.candidateAgentIds, [oldAgentId]);
			if (latestCleanup?.action !== "delete" || latestCleanup.phase !== "result" || latestCleanup.failedAgentIds?.length) {
				fail("cleanup delete did not record a clean result", JSON.stringify(latestCleanup, null, 2));
			}
			assertExactStringArray("cleanup result candidates", latestCleanup.candidateAgentIds, [oldAgentId]);
			assertExactStringArray("cleanup deleted agents", latestCleanup.deletedAgentIds, [oldAgentId]);
		});

		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId, bridge: true, exposeBuiltinTools: true }, async (rpc) => {
			const restart = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: "From this conversation memory only, what exact LOCAL_CLEANUP marker did I ask you to remember before cleanup? Reply exactly MARKER=<marker> if known, otherwise NO_MARKER. Do not inspect environment variables or files.",
				timeoutMs,
				seenMetadata,
			});
			assertTurnMetadata("cleanup preserved current agent", restart, { resumedAgent: true });
			if (restart.metadata.run.agentId !== newAgentId) fail("cleanup deleted or failed to resume the current recorded agent", JSON.stringify({ expected: newAgentId, actual: restart.metadata.run.agentId }, null, 2));
		});

		await withRpc({ artifactDir: artifactRoot, sessionDir, sessionId, extraExtensions: [extensionPath] }, async (rpc) => {
			const oldBranch = await promptAndRead({
				rpc,
				artifactDir: artifactRoot,
				message: `/local_resume_tree_go ${oldResumeEntryId} From this conversation memory only, what exact LOCAL_CLEANUP marker did I ask you to remember before old-agent cleanup? Reply exactly MARKER=<marker> if known, otherwise NO_MARKER. Do not inspect environment variables or files.`,
				timeoutMs,
				seenMetadata,
			});
			assertNotResumedFrom("cleanup deleted old agent", oldBranch, oldAgentId);
			if (!oldBranch.text.includes(`MARKER=${marker}`)) fail("cleanup old-branch fallback did not bootstrap marker", JSON.stringify({ expected: `MARKER=${marker}`, actual: oldBranch.text }, null, 2));
		});

		console.log("local-resume-cleanup-smoke-ok");
		console.error(scrubSmokeText(`[local-resume-smoke] cleanup deleted recorded old ${oldAgentId} and preserved current ${newAgentId}`));
	} finally {
		cleanupArtifactRoot(artifactRoot);
	}
}
