import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionCursorAgentSendState } from "./cursor-session-agent.js";
import { asRecord } from "./cursor-record-utils.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";
import type { CursorSessionStoreIdentity } from "./cursor-session-store.js";

export const CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE = "cursor-sdk-agent-resume";

const LEGACY_RESUME_ENTRY_VERSION = 1;
const RESUME_ENTRY_VERSION = 2;
const MAX_LOCAL_AGENT_ID_LENGTH = 256;
const EMPTY_BRANCH_HASH = hashParts(["cursor-sdk-agent-resume-branch", "v1"]);

// @cursor/sdk AgentOptions.agentId is a public custom string, so local resume narrows it without assuming UUIDs.
export function isCursorLocalAgentId(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_LOCAL_AGENT_ID_LENGTH && /^agent-[A-Za-z0-9_-]+$/.test(value);
}

export interface CursorSessionAgentResumeScope {
	scopeKey: string;
	sessionFile?: string;
	sessionId?: string;
	cwd: string;
	repoRoot?: string;
}

export interface CursorSessionAgentCleanupCandidate {
	agentId: string;
	storeIdentity?: CursorSessionStoreIdentity;
}

export interface CursorSessionAgentResumeEntryData {
	version: 1 | 2;
	runtime: "local";
	agentId: string;
	scopeKey: string;
	sessionFile?: string;
	sessionId?: string;
	cwd: string;
	repoRoot?: string;
	poolKey: string;
	branchPathHash: string;
	compactionGeneration: number;
	sendState: SessionCursorAgentSendState;
	createdAt: string;
	storeIdentity?: CursorSessionStoreIdentity;
	cleanupCandidateAgentIds?: string[];
	cleanupCandidates?: CursorSessionAgentCleanupCandidate[];
}

interface PendingCursorSessionAgentResumeHandle {
	runtime: "local";
	agentId: string;
	poolKey: string;
	sendState: SessionCursorAgentSendState;
	storeIdentity: CursorSessionStoreIdentity;
}

interface CursorSessionResumeState {
	appendEntry?: ExtensionAPI["appendEntry"];
	scopeKey: string;
	sessionFile?: string;
	sessionId?: string;
	cwd: string;
	repoRoot?: string;
	branchPathHash: string;
	compactionGeneration: number;
	activeHandle?: CursorSessionAgentResumeEntryData;
	lastBranchHandle?: CursorSessionAgentResumeEntryData;
	pendingHandle?: PendingCursorSessionAgentResumeHandle;
	unownedUserEntryIds: Set<string>;
}

const state: CursorSessionResumeState = {
	scopeKey: getCursorSessionScopeKey(),
	cwd: process.cwd(),
	branchPathHash: EMPTY_BRANCH_HASH,
	compactionGeneration: 0,
	unownedUserEntryIds: new Set(),
};

function hashParts(parts: readonly string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		hash.update(part);
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 32);
}

function hashBranchStep(previous: string, entry: SessionEntry): string {
	return hashParts([
		previous,
		entry.type,
		entry.id,
		entry.parentId ?? "",
		entry.type === "custom" ? entry.customType : "",
	]);
}

export function resolveCursorSessionRepoRoot(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		}).trim() || undefined;
	} catch {
		return undefined;
	}
}

function isSendState(value: unknown): value is SessionCursorAgentSendState {
	const record = asRecord(value);
	return typeof record?.bootstrapped === "boolean" &&
		typeof record.contextFingerprint === "string" &&
		typeof record.incrementalSendCount === "number";
}

function parseStoreIdentity(value: unknown): CursorSessionStoreIdentity | undefined {
	const record = asRecord(value);
	if (record?.version !== 1 || typeof record.stateRoot !== "string" || !record.stateRoot) return undefined;
	return { version: 1, stateRoot: record.stateRoot };
}

function parseCleanupCandidates(value: unknown): CursorSessionAgentCleanupCandidate[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const candidates = value.flatMap((item): CursorSessionAgentCleanupCandidate[] => {
		const record = asRecord(item);
		if (!isCursorLocalAgentId(record?.agentId)) return [];
		const storeIdentity = record.storeIdentity === undefined ? undefined : parseStoreIdentity(record.storeIdentity);
		if (record.storeIdentity !== undefined && !storeIdentity) return [];
		return [{ agentId: record.agentId, ...(storeIdentity ? { storeIdentity } : {}) }];
	});
	return candidates.length ? candidates : undefined;
}

export function parseCursorSessionAgentResumeEntryData(value: unknown): CursorSessionAgentResumeEntryData | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	if (
		(record.version !== LEGACY_RESUME_ENTRY_VERSION && record.version !== RESUME_ENTRY_VERSION) ||
		record.runtime !== "local"
	) return undefined;
	if (
		!isCursorLocalAgentId(record.agentId) ||
		typeof record.scopeKey !== "string" ||
		typeof record.cwd !== "string" ||
		typeof record.poolKey !== "string" ||
		typeof record.branchPathHash !== "string" ||
		typeof record.compactionGeneration !== "number" ||
		typeof record.createdAt !== "string" ||
		!isSendState(record.sendState)
	) return undefined;
	if (record.sessionFile !== undefined && typeof record.sessionFile !== "string") return undefined;
	if (record.sessionId !== undefined && typeof record.sessionId !== "string") return undefined;
	if (record.repoRoot !== undefined && typeof record.repoRoot !== "string") return undefined;
	const storeIdentity = parseStoreIdentity(record.storeIdentity);
	if (record.version === RESUME_ENTRY_VERSION && !storeIdentity) return undefined;
	const cleanupCandidateAgentIds = Array.isArray(record.cleanupCandidateAgentIds)
		? record.cleanupCandidateAgentIds.filter(isCursorLocalAgentId)
		: undefined;
	const cleanupCandidates = parseCleanupCandidates(record.cleanupCandidates);
	return {
		version: record.version,
		runtime: "local",
		agentId: record.agentId,
		scopeKey: record.scopeKey,
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		...(record.sessionId ? { sessionId: record.sessionId } : {}),
		cwd: record.cwd,
		...(record.repoRoot ? { repoRoot: record.repoRoot } : {}),
		poolKey: record.poolKey,
		branchPathHash: record.branchPathHash,
		compactionGeneration: record.compactionGeneration,
		sendState: {
			bootstrapped: record.sendState.bootstrapped,
			contextFingerprint: record.sendState.contextFingerprint,
			incrementalSendCount: record.sendState.incrementalSendCount,
		},
		createdAt: record.createdAt,
		...(storeIdentity ? { storeIdentity } : {}),
		...(cleanupCandidateAgentIds?.length ? { cleanupCandidateAgentIds: [...new Set(cleanupCandidateAgentIds)] } : {}),
		...(cleanupCandidates ? { cleanupCandidates } : {}),
	};
}

function matchesResumeScope(data: CursorSessionAgentResumeEntryData, scope: CursorSessionAgentResumeScope): boolean {
	return data.scopeKey === scope.scopeKey &&
		data.sessionFile === scope.sessionFile &&
		data.sessionId === scope.sessionId &&
		data.cwd === scope.cwd &&
		data.repoRoot === scope.repoRoot;
}

function matchesCurrentSession(
	data: CursorSessionAgentResumeEntryData,
	branchPathHash: string,
	compactionGeneration = state.compactionGeneration,
): boolean {
	return matchesResumeScope(data, state) &&
		data.compactionGeneration === compactionGeneration &&
		data.branchPathHash === branchPathHash;
}

function canResumeHandleSpanEntry(entry: SessionEntry): boolean {
	if (entry.type === "custom" || entry.type === "label" || entry.type === "session_info") return true;
	return entry.type === "message" && entry.message.role === "user";
}

function resumeAgentLineageKey(data: CursorSessionAgentResumeEntryData): string {
	return JSON.stringify([
		data.agentId,
		data.scopeKey,
		data.sessionFile,
		data.sessionId,
		data.cwd,
		data.repoRoot,
		data.poolKey,
	]);
}

function indexLatestResumeEntries(entries: readonly SessionEntry[]): {
	entryIds: Set<string>;
	latestEntryIdByLineage: Map<string, string>;
} {
	const entryIds = new Set<string>();
	const latestEntryIdByLineage = new Map<string, string>();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		entryIds.add(entry.id);
		if (entry.type !== "custom" || entry.customType !== CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE) continue;
		const data = parseCursorSessionAgentResumeEntryData(entry.data);
		if (!data) continue;
		const lineage = resumeAgentLineageKey(data);
		if (!latestEntryIdByLineage.has(lineage)) latestEntryIdByLineage.set(lineage, entry.id);
	}
	return { entryIds, latestEntryIdByLineage };
}

interface ResumeBranchFoldState {
	branchPathHash: string;
	compactionGeneration: number;
	activeHandle?: CursorSessionAgentResumeEntryData;
}

interface ResumeBranchFoldParams {
	matchesEntry: (data: CursorSessionAgentResumeEntryData, branchPathHash: string, compactionGeneration: number) => boolean;
	canSpanEntry: (entry: SessionEntry) => boolean;
}

/** One fold step shared by the tree-wide and single-branch resume-handle walks: advances
 * branchPathHash/compactionGeneration and adopts a matching, non-superseded resume handle. */
function advanceResumeBranchState(
	entry: SessionEntry,
	previous: ResumeBranchFoldState,
	resumeIndex: { entryIds: Set<string>; latestEntryIdByLineage: Map<string, string> },
	params: ResumeBranchFoldParams,
): ResumeBranchFoldState {
	if (entry.type === "custom" && entry.customType === CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE) {
		const data = parseCursorSessionAgentResumeEntryData(entry.data);
		const latestEntryId = data ? resumeIndex.latestEntryIdByLineage.get(resumeAgentLineageKey(data)) : undefined;
		const superseded = resumeIndex.entryIds.has(entry.id) && latestEntryId !== entry.id;
		if (data && params.matchesEntry(data, previous.branchPathHash, previous.compactionGeneration) && !superseded) {
			return { ...previous, activeHandle: data };
		}
		return previous;
	}
	return {
		branchPathHash: hashBranchStep(previous.branchPathHash, entry),
		compactionGeneration: entry.type === "compaction" ? previous.compactionGeneration + 1 : previous.compactionGeneration,
		activeHandle: previous.activeHandle && !params.canSpanEntry(entry) ? undefined : previous.activeHandle,
	};
}

export function readResumableCursorSessionAgentIds(
	entries: readonly SessionEntry[],
	scope: CursorSessionAgentResumeScope,
): string[] {
	const resumeIndex = indexLatestResumeEntries(entries);
	const states = new Map<string, ResumeBranchFoldState>();
	const parentIds = new Set<string>();
	let rootCount = 0;
	let completeTree = true;
	for (const entry of entries) {
		if (states.has(entry.id)) completeTree = false;
		if (entry.parentId === null) rootCount += 1;
		const parent = entry.parentId ? states.get(entry.parentId) : undefined;
		if (entry.parentId) {
			parentIds.add(entry.parentId);
			if (!parent) completeTree = false;
		}
		const previous: ResumeBranchFoldState = {
			branchPathHash: parent?.branchPathHash ?? EMPTY_BRANCH_HASH,
			compactionGeneration: parent?.compactionGeneration ?? 0,
			activeHandle: parent?.activeHandle,
		};
		states.set(entry.id, advanceResumeBranchState(entry, previous, resumeIndex, {
			matchesEntry: (data, branchPathHash, compactionGeneration) =>
				matchesResumeScope(data, scope) &&
				data.compactionGeneration === compactionGeneration &&
				data.branchPathHash === branchPathHash,
			canSpanEntry: canResumeHandleSpanEntry,
		}));
	}
	if (entries.length > 0 && rootCount !== 1) completeTree = false;
	if (!completeTree) {
		return [...new Set(entries.flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE) return [];
			const data = parseCursorSessionAgentResumeEntryData(entry.data);
			return data && matchesResumeScope(data, scope) ? [data.agentId] : [];
		}))].sort((a, b) => a.localeCompare(b));
	}
	const agentIds = new Set<string>();
	for (const [entryId, branchState] of states) {
		if (!parentIds.has(entryId) && branchState.activeHandle) agentIds.add(branchState.activeHandle.agentId);
	}
	return [...agentIds].sort((a, b) => a.localeCompare(b));
}

function canRestoreHandleSpanEntry(entry: SessionEntry): boolean {
	if (entry.type === "message" && entry.message.role === "user") return !state.unownedUserEntryIds.has(entry.id);
	return canResumeHandleSpanEntry(entry);
}

function restoreFromBranch(branch: readonly SessionEntry[], allEntries: readonly SessionEntry[] = branch): void {
	const resumeIndex = indexLatestResumeEntries(allEntries);
	let fold: ResumeBranchFoldState = { branchPathHash: EMPTY_BRANCH_HASH, compactionGeneration: 0 };
	let lastBranchHandle: CursorSessionAgentResumeEntryData | undefined;
	for (const entry of branch) {
		const next = advanceResumeBranchState(entry, fold, resumeIndex, {
			matchesEntry: matchesCurrentSession,
			canSpanEntry: canRestoreHandleSpanEntry,
		});
		if (next.activeHandle && next.activeHandle !== fold.activeHandle) lastBranchHandle = next.activeHandle;
		fold = next;
	}
	state.branchPathHash = fold.branchPathHash;
	state.compactionGeneration = fold.compactionGeneration;
	state.activeHandle = fold.activeHandle;
	state.lastBranchHandle = lastBranchHandle;
}

export function getMatchingCursorSessionAgentResumeHandle(poolKey: string): CursorSessionAgentResumeEntryData | undefined {
	const handle = state.activeHandle;
	if (!handle || !isCursorLocalAgentId(handle.agentId)) return undefined;
	if (handle.poolKey !== poolKey) return undefined;
	if (handle.scopeKey !== state.scopeKey) return undefined;
	if (handle.sessionFile !== state.sessionFile) return undefined;
	if (handle.sessionId !== state.sessionId) return undefined;
	if (handle.cwd !== state.cwd) return undefined;
	if (handle.repoRoot !== state.repoRoot) return undefined;
	if (handle.compactionGeneration !== state.compactionGeneration) return undefined;
	return {
		...handle,
		sendState: { ...handle.sendState },
	};
}

export function persistCursorSessionAgentResumeHandle(input: PendingCursorSessionAgentResumeHandle): void {
	if (!isCursorLocalAgentId(input.agentId)) return;
	state.pendingHandle = {
		runtime: input.runtime,
		agentId: input.agentId,
		poolKey: input.poolKey,
		sendState: { ...input.sendState },
		storeIdentity: { ...input.storeIdentity },
	};
}

function flushPendingCursorSessionAgentResumeHandle(branch: readonly SessionEntry[]): void {
	restoreFromBranch(branch);
	const pending = state.pendingHandle;
	state.pendingHandle = undefined;
	if (!pending || !state.appendEntry) return;
	const previousHandle = state.activeHandle ?? state.lastBranchHandle;
	const cleanupCandidates = state.sessionFile && previousHandle && previousHandle.agentId !== pending.agentId
		? [{
				agentId: previousHandle.agentId,
				...(previousHandle.storeIdentity ? { storeIdentity: { ...previousHandle.storeIdentity } } : {}),
			}]
		: undefined;
	const data: CursorSessionAgentResumeEntryData = {
		version: RESUME_ENTRY_VERSION,
		runtime: pending.runtime,
		agentId: pending.agentId,
		scopeKey: state.scopeKey,
		...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
		...(state.sessionId ? { sessionId: state.sessionId } : {}),
		cwd: state.cwd,
		...(state.repoRoot ? { repoRoot: state.repoRoot } : {}),
		poolKey: pending.poolKey,
		branchPathHash: state.branchPathHash,
		compactionGeneration: state.compactionGeneration,
		sendState: { ...pending.sendState },
		createdAt: new Date().toISOString(),
		storeIdentity: { ...pending.storeIdentity },
		...(cleanupCandidates ? { cleanupCandidates } : {}),
	};
	try {
		state.appendEntry<CursorSessionAgentResumeEntryData>(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, data);
		state.activeHandle = data;
	} catch {
		// Resume persistence is an optimization; a failed custom-entry append must not fail the completed turn.
	}
}

interface CursorSessionAgentResumeExtensionApi {
	appendEntry: ExtensionAPI["appendEntry"];
	on: ExtensionAPI["on"];
}

export function registerCursorSessionAgentResume(pi: CursorSessionAgentResumeExtensionApi): void {
	state.appendEntry = pi.appendEntry;
	const restoreFromSessionManager = (sessionManager: { getBranch(): SessionEntry[]; getEntries(): SessionEntry[] }): void => {
		const branch = sessionManager.getBranch();
		const entries = sessionManager.getEntries();
		restoreFromBranch(branch, entries.length > 0 ? entries : branch);
	};
	pi.on("session_start", (_event, ctx) => {
		state.scopeKey = getCursorSessionScopeKey();
		state.sessionFile = ctx.sessionManager.getSessionFile?.() ?? undefined;
		state.sessionId = ctx.sessionManager.getSessionId?.() ?? undefined;
		state.cwd = ctx.cwd;
		state.repoRoot = resolveCursorSessionRepoRoot(ctx.cwd);
		state.unownedUserEntryIds = new Set(ctx.sessionManager.getBranch().flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [entry.id] : []));
		restoreFromSessionManager(ctx.sessionManager);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		restoreFromSessionManager(ctx.sessionManager);
	});
	pi.on("turn_end", (_event, ctx) => {
		flushPendingCursorSessionAgentResumeHandle(ctx.sessionManager.getBranch());
	});
	pi.on("session_tree", (_event, ctx) => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user") state.unownedUserEntryIds.add(entry.id);
		}
		restoreFromSessionManager(ctx.sessionManager);
	});
	pi.on("session_compact", (event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		if (branch.length > 0) {
			restoreFromSessionManager(ctx.sessionManager);
			return;
		}
		state.activeHandle = undefined;
		state.lastBranchHandle = undefined;
		state.compactionGeneration += 1;
		state.branchPathHash = hashBranchStep(state.branchPathHash, event.compactionEntry);
	});
}

function setStateForTests(next: Partial<CursorSessionResumeState>): void {
	Object.assign(state, next);
}

function resetStateForTests(): void {
	state.appendEntry = undefined;
	state.scopeKey = getCursorSessionScopeKey();
	state.sessionFile = undefined;
	state.sessionId = undefined;
	state.cwd = process.cwd();
	state.repoRoot = undefined;
	state.branchPathHash = EMPTY_BRANCH_HASH;
	state.compactionGeneration = 0;
	state.activeHandle = undefined;
	state.lastBranchHandle = undefined;
	state.pendingHandle = undefined;
	state.unownedUserEntryIds = new Set();
}

export const __testUtils = {
	EMPTY_BRANCH_HASH,
	hashBranchStep,
	reset: resetStateForTests,
	set: setStateForTests,
	state,
};
