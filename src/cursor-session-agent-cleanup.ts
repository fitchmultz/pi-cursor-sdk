import type { LocalAgentStore } from "@cursor/sdk";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { asRecord, getString } from "./cursor-record-utils.js";
import { fsyncExistingRegularFile } from "./cursor-durable-fs.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";
import {
	CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
	isCursorLocalAgentId,
	parseCursorSessionAgentResumeEntryData,
	readResumableCursorSessionAgentIds,
	resolveCursorSessionRepoRoot,
	type CursorSessionAgentCleanupCandidate,
	type CursorSessionAgentResumeEntryData,
	type CursorSessionAgentResumeScope,
} from "./cursor-session-agent-resume.js";
import {
	cursorSessionStoreIdentitiesEqual,
	getCursorSessionStoreIdentities,
	openCursorSessionStore,
} from "./cursor-session-store.js";

export const CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE = "cursor-sdk-agent-cleanup";

type CleanupAction = "dry-run" | "delete";
type CleanupPhase = "intent" | "result";

export interface CursorSessionAgentCleanupFailure {
	agentId: string;
	error: string;
	retryable?: boolean;
}

export interface CursorSessionAgentCleanupEntryData {
	action: CleanupAction;
	phase?: CleanupPhase;
	runtime: "local";
	timestamp: string;
	candidateAgentIds: string[];
	protectedAgentIds?: string[];
	deletedAgentIds?: string[];
	failedAgentIds?: CursorSessionAgentCleanupFailure[];
}

export interface CursorSessionAgentCleanupPlan {
	candidateAgentIds: string[];
	protectedAgentIds: string[];
}

export type CursorSessionAgentCleanupScope = CursorSessionAgentResumeScope;

type LocalResumeCleanupApi = Pick<ExtensionAPI, "appendEntry">;
type LocalResumeCleanupCommandContext = Pick<ExtensionCommandContext, "cwd"> & {
	sessionManager: Pick<ExtensionCommandContext["sessionManager"], "getEntries" | "getBranch" | "getSessionFile" | "getSessionId">;
	ui: Pick<ExtensionCommandContext["ui"], "notify">;
};
type LocalResumeCleanupSdkOperations = {
	delete(agentId: string, options?: { cwd?: string; store?: LocalAgentStore }): Promise<void>;
};

class InvalidCursorSessionStoreIdentityError extends Error {}

// ponytail: grows for the process lifetime, but its ceiling is the exact agent IDs this process
// attempted to delete (never global) — it only fills the gap until this process exits; the durable
// intent entry, not this Set, is the authority a restarted process relies on to block retries.
// Tests must call __testUtils.reset() between cases.
const nondurableCleanupResultAgentIds = new Set<string>();
let appendDurabilityForTests: ((data: CursorSessionAgentCleanupEntryData) => boolean) | undefined;
let sdkOperationsForTests: LocalResumeCleanupSdkOperations | undefined;

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function readResumeEntries(entries: readonly SessionEntry[]): CursorSessionAgentResumeEntryData[] {
	const records: CursorSessionAgentResumeEntryData[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE) continue;
		const data = parseCursorSessionAgentResumeEntryData(entry.data);
		if (data) records.push(data);
	}
	return records;
}

function resumeEntryMatchesCleanupScope(data: CursorSessionAgentResumeEntryData, scope: CursorSessionAgentCleanupScope): boolean {
	return data.scopeKey === scope.scopeKey &&
		data.sessionFile === scope.sessionFile &&
		data.sessionId === scope.sessionId &&
		data.cwd === scope.cwd &&
		data.repoRoot === scope.repoRoot;
}

function getCurrentCleanupScope(ctx: LocalResumeCleanupCommandContext): CursorSessionAgentCleanupScope {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const sessionId = ctx.sessionManager.getSessionId();
	const repoRoot = resolveCursorSessionRepoRoot(ctx.cwd);
	return {
		scopeKey: getCursorSessionScopeKey(),
		...(sessionFile ? { sessionFile } : {}),
		...(sessionId ? { sessionId } : {}),
		cwd: ctx.cwd,
		...(repoRoot ? { repoRoot } : {}),
	};
}

function parseCleanupEntryData(value: unknown): CursorSessionAgentCleanupEntryData | undefined {
	const record = asRecord(value);
	if (!record || (record.action !== "dry-run" && record.action !== "delete") || record.runtime !== "local") return undefined;
	if (typeof record.timestamp !== "string") return undefined;
	if (record.phase !== undefined && record.phase !== "intent" && record.phase !== "result") return undefined;
	if (record.action === "dry-run" && record.phase !== undefined) return undefined;
	const candidateAgentIds = Array.isArray(record.candidateAgentIds) ? record.candidateAgentIds.filter((id): id is string => typeof id === "string") : [];
	const protectedAgentIds = Array.isArray(record.protectedAgentIds) ? record.protectedAgentIds.filter((id): id is string => typeof id === "string") : undefined;
	const deletedAgentIds = Array.isArray(record.deletedAgentIds) ? record.deletedAgentIds.filter((id): id is string => typeof id === "string") : undefined;
	const failedAgentIds = Array.isArray(record.failedAgentIds)
		? record.failedAgentIds.flatMap((item): CursorSessionAgentCleanupFailure[] => {
			const failure = asRecord(item);
			return isCursorLocalAgentId(failure?.agentId) && typeof failure.error === "string"
				? [{ agentId: failure.agentId, error: failure.error, ...(failure.retryable === false ? { retryable: false } : {}) }]
				: [];
		})
		: undefined;
	return {
		action: record.action,
		...(record.phase ? { phase: record.phase } : {}),
		runtime: "local",
		timestamp: record.timestamp,
		candidateAgentIds: uniqueSorted(candidateAgentIds.filter(isCursorLocalAgentId)),
		...(protectedAgentIds?.length ? { protectedAgentIds: uniqueSorted(protectedAgentIds.filter(isCursorLocalAgentId)) } : {}),
		...(deletedAgentIds?.length ? { deletedAgentIds: uniqueSorted(deletedAgentIds.filter(isCursorLocalAgentId)) } : {}),
		...(failedAgentIds?.length ? { failedAgentIds } : {}),
	};
}

function readUnavailableAgentIds(entries: readonly SessionEntry[]): Set<string> {
	const deleted = new Set<string>();
	const pending = new Set<string>();
	const permanentlyFailed = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE) continue;
		const data = parseCleanupEntryData(entry.data);
		if (data?.action !== "delete") continue;
		if (data.phase === "intent") {
			for (const agentId of data.candidateAgentIds) {
				if (!deleted.has(agentId)) pending.add(agentId);
			}
			continue;
		}
		for (const agentId of data.deletedAgentIds ?? []) {
			deleted.add(agentId);
			pending.delete(agentId);
		}
		if (data.phase === "result") {
			for (const failure of data.failedAgentIds ?? []) {
				pending.delete(failure.agentId);
				if (failure.retryable === false) permanentlyFailed.add(failure.agentId);
			}
		}
	}
	return new Set([...deleted, ...pending, ...permanentlyFailed, ...nondurableCleanupResultAgentIds]);
}

function readLatestBranchAgentId(branch: readonly SessionEntry[], scope: CursorSessionAgentCleanupScope): string | undefined {
	return readResumeEntries(branch).filter((entry) => resumeEntryMatchesCleanupScope(entry, scope)).at(-1)?.agentId;
}

function readCursorSessionAgentCleanupPlanDetails(
	entries: readonly SessionEntry[],
	branch: readonly SessionEntry[],
	scope: CursorSessionAgentCleanupScope,
): CursorSessionAgentCleanupPlan & { candidates: CursorSessionAgentCleanupCandidate[] } {
	const unavailable = readUnavailableAgentIds(entries);
	const latestBranchAgentId = readLatestBranchAgentId(branch, scope);
	const protectedAgentIds = new Set(readResumableCursorSessionAgentIds(entries, scope));
	if (latestBranchAgentId && isCursorLocalAgentId(latestBranchAgentId)) protectedAgentIds.add(latestBranchAgentId);
	const candidates = new Map<string, CursorSessionAgentCleanupCandidate>();
	for (const resume of readResumeEntries(entries)) {
		if (!resumeEntryMatchesCleanupScope(resume, scope)) continue;
		const recordedCandidates: CursorSessionAgentCleanupCandidate[] = [
			...(resume.cleanupCandidateAgentIds ?? []).map((agentId) => ({ agentId })),
			...(resume.cleanupCandidates ?? []),
		];
		for (const candidate of recordedCandidates) {
			if (!isCursorLocalAgentId(candidate.agentId) || protectedAgentIds.has(candidate.agentId) || unavailable.has(candidate.agentId)) continue;
			const existing = candidates.get(candidate.agentId);
			if (!existing?.storeIdentity || candidate.storeIdentity) candidates.set(candidate.agentId, candidate);
		}
	}
	return {
		candidates: [...candidates.values()].sort((left, right) => left.agentId.localeCompare(right.agentId)),
		candidateAgentIds: uniqueSorted([...candidates.values()].map((candidate) => candidate.agentId)),
		protectedAgentIds: uniqueSorted(protectedAgentIds),
	};
}

export function readCursorSessionAgentCleanupPlan(
	entries: readonly SessionEntry[],
	branch: readonly SessionEntry[],
	scope: CursorSessionAgentCleanupScope,
): CursorSessionAgentCleanupPlan {
	const { candidates: _, ...plan } = readCursorSessionAgentCleanupPlanDetails(entries, branch, scope);
	return plan;
}

function formatCleanupPlan(plan: CursorSessionAgentCleanupPlan): string {
	if (plan.candidateAgentIds.length === 0) return "No recorded superseded local Cursor SDK agents are cleanup-eligible.";
	return [
		"Recorded superseded local Cursor SDK agents eligible for cleanup:",
		...plan.candidateAgentIds.map((agentId) => `- ${agentId}`),
		"Run /cursor-local-resume-cleanup --yes to delete exactly these recorded agent IDs.",
	].join("\n");
}

async function getSdkOperations(): Promise<LocalResumeCleanupSdkOperations> {
	if (sdkOperationsForTests) return sdkOperationsForTests;
	const { Agent } = await loadCursorSdk();
	return {
		delete: (agentId, options) => Agent.delete(agentId, options),
	};
}

function cleanupEntryVerificationKey(data: CursorSessionAgentCleanupEntryData): string {
	return JSON.stringify({
		action: data.action,
		phase: data.phase,
		runtime: data.runtime,
		timestamp: data.timestamp,
		candidateAgentIds: data.candidateAgentIds,
		protectedAgentIds: data.protectedAgentIds ?? [],
		deletedAgentIds: data.deletedAgentIds ?? [],
		failedAgentIds: data.failedAgentIds ?? [],
	});
}

function cleanupEntriesMatch(left: CursorSessionAgentCleanupEntryData, right: CursorSessionAgentCleanupEntryData): boolean {
	return cleanupEntryVerificationKey(left) === cleanupEntryVerificationKey(right);
}

function appendCleanupEntry(pi: LocalResumeCleanupApi, data: CursorSessionAgentCleanupEntryData): void {
	pi.appendEntry<CursorSessionAgentCleanupEntryData>(CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE, data);
}

function appendDurableCleanupEntry(
	pi: LocalResumeCleanupApi,
	ctx: LocalResumeCleanupCommandContext,
	data: CursorSessionAgentCleanupEntryData,
): boolean {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const previousEntryId = ctx.sessionManager.getBranch().at(-1)?.id;
	try {
		appendCleanupEntry(pi, data);
	} catch {
		return false;
	}
	if (appendDurabilityForTests) return appendDurabilityForTests(data);
	const anchor = ctx.sessionManager.getBranch().at(-1);
	const persisted = anchor?.type === "custom" &&
		anchor.customType === CURSOR_SESSION_AGENT_CLEANUP_ENTRY_TYPE &&
		anchor.id !== previousEntryId
		? parseCleanupEntryData(anchor.data)
		: undefined;
	if (!sessionFile || !persisted || !cleanupEntriesMatch(persisted, data)) return false;
	return fsyncExistingRegularFile(sessionFile);
}

export async function runCursorSessionAgentCleanupCommand(pi: LocalResumeCleanupApi, args: string, ctx: LocalResumeCleanupCommandContext): Promise<void> {
	const usage = "Usage: /cursor-local-resume-cleanup [--dry-run|--yes]";
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const dryRun = tokens.length === 0 || (tokens.length === 1 && tokens[0] === "--dry-run");
	const deleteNow = tokens.length === 1 && tokens[0] === "--yes";
	if (!dryRun && !deleteNow) {
		ctx.ui.notify(`Invalid Cursor local resume cleanup arguments. ${usage}`, "error");
		return;
	}

	const entries = ctx.sessionManager.getEntries();
	const branch = ctx.sessionManager.getBranch();
	const scope = getCurrentCleanupScope(ctx);
	const plan = readCursorSessionAgentCleanupPlanDetails(entries, branch, scope);
	const baseEntry = {
		runtime: "local" as const,
		timestamp: new Date().toISOString(),
		candidateAgentIds: plan.candidateAgentIds,
		...(plan.protectedAgentIds.length ? { protectedAgentIds: plan.protectedAgentIds } : {}),
	};
	if (dryRun) {
		appendCleanupEntry(pi, { action: "dry-run", ...baseEntry });
		ctx.ui.notify(formatCleanupPlan(plan), "info");
		return;
	}
	if (plan.candidateAgentIds.length === 0) {
		try {
			appendCleanupEntry(pi, { action: "delete", phase: "result", ...baseEntry, deletedAgentIds: [] });
			ctx.ui.notify("No recorded superseded local Cursor SDK agents to delete.", "info");
		} catch {
			ctx.ui.notify("No agents were deleted, but the no-op cleanup result could not be recorded.", "error");
		}
		return;
	}

	if (!appendDurableCleanupEntry(pi, ctx, { action: "delete", phase: "intent", ...baseEntry })) {
		ctx.ui.notify("Cleanup intent could not be durably recorded. No agents were deleted.", "error");
		return;
	}

	const deletedAgentIds: string[] = [];
	const failedAgentIds: CursorSessionAgentCleanupFailure[] = [];
	const openedStores = new Map<string, Awaited<ReturnType<typeof openCursorSessionStore>>>();
	try {
		const operations = await getSdkOperations();
		const identities = await getCursorSessionStoreIdentities(ctx.cwd, scope.scopeKey, scope.sessionFile !== undefined);
		for (const candidate of plan.candidates) {
			const { agentId } = candidate;
			try {
				const identity = candidate.storeIdentity ?? identities.defaultStore;
				if (
					!cursorSessionStoreIdentitiesEqual(identity, identities.defaultStore) &&
					!cursorSessionStoreIdentitiesEqual(identity, identities.sessionStore)
				) throw new InvalidCursorSessionStoreIdentityError("Recorded Cursor local store identity is not valid for this pi session");
				let openedStore = openedStores.get(identity.stateRoot);
				if (!openedStore) {
					openedStore = await openCursorSessionStore(ctx.cwd, identity);
					openedStores.set(identity.stateRoot, openedStore);
				}
				await operations.delete(agentId, { cwd: ctx.cwd, store: openedStore.store });
				deletedAgentIds.push(agentId);
			} catch (error) {
				failedAgentIds.push({
					agentId,
					error: scrubSensitiveText(getString(asRecord(error), "message") ?? String(error)),
					...(error instanceof InvalidCursorSessionStoreIdentityError ? { retryable: false } : {}),
				});
			}
		}
	} catch (error) {
		const message = scrubSensitiveText(getString(asRecord(error), "message") ?? String(error));
		failedAgentIds.push(...plan.candidateAgentIds.map((agentId) => ({ agentId, error: message })));
	} finally {
		await Promise.all([...openedStores.values()].map((store) => store.dispose().catch(() => undefined)));
	}
	if (!appendDurableCleanupEntry(pi, ctx, {
		action: "delete",
		phase: "result",
		...baseEntry,
		deletedAgentIds,
		...(failedAgentIds.length ? { failedAgentIds } : {}),
	})) {
		for (const agentId of plan.candidateAgentIds) nondurableCleanupResultAgentIds.add(agentId);
		ctx.ui.notify(
			`Deleted ${deletedAgentIds.length} recorded local Cursor SDK agent(s). The cleanup ledger is partial because its result could not be durably recorded; the durable intent blocks automatic retries.`,
			"error",
		);
		return;
	}
	if (failedAgentIds.length > 0) {
		ctx.ui.notify(
			`Deleted ${deletedAgentIds.length} recorded local Cursor SDK agent(s); ${failedAgentIds.length} failed.`,
			"error",
		);
		return;
	}
	ctx.ui.notify(`Deleted ${deletedAgentIds.length} recorded local Cursor SDK agent(s).`, "info");
}

export const __testUtils = {
	reset: () => {
		nondurableCleanupResultAgentIds.clear();
		appendDurabilityForTests = undefined;
		sdkOperationsForTests = undefined;
	},
	setAppendDurability: (appendDurability: ((data: CursorSessionAgentCleanupEntryData) => boolean) | undefined) => {
		appendDurabilityForTests = appendDurability;
	},
	setSdkOperations: (operations: LocalResumeCleanupSdkOperations | undefined) => {
		sdkOperationsForTests = operations;
	},
	parseCleanupEntryData,
};
