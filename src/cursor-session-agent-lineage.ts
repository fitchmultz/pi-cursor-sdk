import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isCursorLocalAgentId } from "./cursor-session-agent-resume.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";
import { asRecord } from "./cursor-record-utils.js";

export const CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE = "cursor-sdk-agent-lineage";

const LINEAGE_ENTRY_VERSION = 1;

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !value) return false;
	const timestamp = Date.parse(value);
	return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

export interface CursorSessionAgentLineageEntryData {
	version: 1;
	runtime: "local";
	agentId: string;
	sessionId: string;
	sessionFile?: string;
	scopeKey: string;
	cwd: string;
	timestamp: string;
}

interface CursorSessionAgentLineageState {
	sessionId?: string;
	sessionFile?: string;
	scopeKey?: string;
	cwd?: string;
	pendingAgentIds: Set<string>;
	recordedAgentIds: Set<string>;
}

const state: CursorSessionAgentLineageState = {
	pendingAgentIds: new Set(),
	recordedAgentIds: new Set(),
};

export function parseCursorSessionAgentLineageEntryData(value: unknown): CursorSessionAgentLineageEntryData | undefined {
	const record = asRecord(value);
	if (
		record?.version !== LINEAGE_ENTRY_VERSION ||
		record.runtime !== "local" ||
		!isCursorLocalAgentId(record.agentId) ||
		typeof record.sessionId !== "string" || !record.sessionId ||
		typeof record.scopeKey !== "string" || !record.scopeKey ||
		typeof record.cwd !== "string" || !record.cwd ||
		!isIsoTimestamp(record.timestamp)
	) return undefined;
	if (record.sessionFile !== undefined && (typeof record.sessionFile !== "string" || !record.sessionFile)) return undefined;
	return {
		version: LINEAGE_ENTRY_VERSION,
		runtime: "local",
		agentId: record.agentId,
		sessionId: record.sessionId,
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		scopeKey: record.scopeKey,
		cwd: record.cwd,
		timestamp: record.timestamp,
	};
}

function readRecordedAgentIds(entries: readonly SessionEntry[], sessionId: string): Set<string> {
	return new Set(entries.flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE) return [];
		const data = parseCursorSessionAgentLineageEntryData(entry.data);
		return data?.sessionId === sessionId ? [data.agentId] : [];
	}));
}

export function queueCursorSessionAgentLineage(agentId: string): void {
	if (!state.sessionId || !isCursorLocalAgentId(agentId) || state.recordedAgentIds.has(agentId)) return;
	state.pendingAgentIds.add(agentId);
}

interface CursorSessionAgentLineageExtensionApi {
	appendEntry: ExtensionAPI["appendEntry"];
	on: ExtensionAPI["on"];
}

function flushPendingCursorSessionAgentLineage(pi: Pick<CursorSessionAgentLineageExtensionApi, "appendEntry">): void {
	const { sessionId, sessionFile, scopeKey, cwd } = state;
	const pendingAgentIds = [...state.pendingAgentIds];
	state.pendingAgentIds.clear();
	if (!sessionId || !scopeKey || !cwd) return;
	for (const agentId of pendingAgentIds) {
		if (state.recordedAgentIds.has(agentId)) continue;
		const data: CursorSessionAgentLineageEntryData = {
			version: LINEAGE_ENTRY_VERSION,
			runtime: "local",
			agentId,
			sessionId,
			...(sessionFile ? { sessionFile } : {}),
			scopeKey,
			cwd,
			timestamp: new Date().toISOString(),
		};
		try {
			pi.appendEntry<CursorSessionAgentLineageEntryData>(CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE, data);
			state.recordedAgentIds.add(agentId);
		} catch {
			// Lineage is forensic metadata; a failed stock pi append must not affect the session.
		}
	}
}

export function registerCursorSessionAgentLineage(pi: CursorSessionAgentLineageExtensionApi): void {
	pi.on("session_start", (_event, ctx) => {
		state.sessionId = ctx.sessionManager.getSessionId();
		state.sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
		state.scopeKey = getCursorSessionScopeKey();
		state.cwd = ctx.cwd;
		state.pendingAgentIds.clear();
		state.recordedAgentIds = readRecordedAgentIds(ctx.sessionManager.getEntries(), state.sessionId);
	});
	const flushPending = () => flushPendingCursorSessionAgentLineage(pi);
	pi.on("turn_end", flushPending);
	// Pi calls the provider directly for compaction and tree summaries, outside an agent turn.
	pi.on("session_compact", flushPending);
	pi.on("session_tree", flushPending);
	pi.on("session_shutdown", flushPending);
}

function resetStateForTests(): void {
	state.sessionId = undefined;
	state.sessionFile = undefined;
	state.scopeKey = undefined;
	state.cwd = undefined;
	state.pendingAgentIds.clear();
	state.recordedAgentIds.clear();
}

export const __testUtils = {
	reset: resetStateForTests,
	set: (next: Partial<CursorSessionAgentLineageState>): void => { Object.assign(state, next); },
	state,
};
