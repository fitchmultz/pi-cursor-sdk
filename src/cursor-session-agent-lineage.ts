import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isCursorLocalAgentId } from "./cursor-session-agent-resume.js";
import { getCursorSessionScopeSnapshot } from "./cursor-session-scope.js";
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
	appendEntry?: ExtensionAPI["appendEntry"];
	sessionId?: string;
	sessionFile?: string;
	scopeKey?: string;
	cwd?: string;
	recordedAgentIds: Set<string>;
}

let state: CursorSessionAgentLineageState = {
	recordedAgentIds: new Set(),
};

const statesByScope = new Map<string, CursorSessionAgentLineageState>();

export function parseCursorSessionAgentLineageEntryData(value: unknown): CursorSessionAgentLineageEntryData | undefined {
	const record = asRecord(value);
	if (
		record?.version !== LINEAGE_ENTRY_VERSION ||
		record.runtime !== "local" ||
		!isCursorLocalAgentId(record.agentId) ||
		typeof record.sessionId !== "string" ||
		!record.sessionId ||
		typeof record.scopeKey !== "string" ||
		!record.scopeKey ||
		typeof record.cwd !== "string" ||
		!record.cwd ||
		!isIsoTimestamp(record.timestamp)
	) {
		return undefined;
	}
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
	return new Set(
		entries.flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE) return [];
			const data = parseCursorSessionAgentLineageEntryData(entry.data);
			return data?.sessionId === sessionId ? [data.agentId] : [];
		}),
	);
}

/** Best-effort forensic lineage at the local Agent.send() boundary. Independent of resume. */
export function recordCursorSessionAgentLineage(agentId: string, turnScopeKey?: string): void {
	const sessionState = turnScopeKey === undefined
		? state
		: statesByScope.get(turnScopeKey) ?? (state.scopeKey === turnScopeKey ? state : undefined);
	if (!sessionState) return;
	const { appendEntry, sessionId, sessionFile, scopeKey, cwd } = sessionState;
	if (!appendEntry || !sessionId || !scopeKey || !cwd) return;
	if (!isCursorLocalAgentId(agentId) || sessionState.recordedAgentIds.has(agentId)) return;
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
		appendEntry<CursorSessionAgentLineageEntryData>(CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE, data);
		sessionState.recordedAgentIds.add(agentId);
	} catch {
		// Lineage is forensic metadata; a failed stock pi append must not affect the session.
	}
}

interface CursorSessionAgentLineageExtensionApi {
	appendEntry: ExtensionAPI["appendEntry"];
	on: ExtensionAPI["on"];
}

export function registerCursorSessionAgentLineage(pi: CursorSessionAgentLineageExtensionApi): void {
	const sessionState: CursorSessionAgentLineageState = { recordedAgentIds: new Set() };
	pi.on("session_start", (_event, ctx) => {
		state = sessionState;
		const record = sessionState;
		if (record.scopeKey && statesByScope.get(record.scopeKey) === record) statesByScope.delete(record.scopeKey);
		record.appendEntry = pi.appendEntry;
		record.sessionId = ctx.sessionManager.getSessionId();
		record.sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
		record.scopeKey = getCursorSessionScopeSnapshot(pi).scopeKey;
		statesByScope.set(record.scopeKey, record);
		record.cwd = ctx.cwd;
		record.recordedAgentIds = readRecordedAgentIds(ctx.sessionManager.getEntries(), record.sessionId);
	});
	pi.on("session_shutdown", () => {
		const state = sessionState;
		if (state.scopeKey && statesByScope.get(state.scopeKey) === state) statesByScope.delete(state.scopeKey);
		state.appendEntry = undefined;
		state.sessionId = undefined;
		state.sessionFile = undefined;
		state.scopeKey = undefined;
		state.cwd = undefined;
		state.recordedAgentIds = new Set();
	});
}

function resetStateForTests(): void {
	statesByScope.clear();
	state.appendEntry = undefined;
	state.sessionId = undefined;
	state.sessionFile = undefined;
	state.scopeKey = undefined;
	state.cwd = undefined;
	state.recordedAgentIds = new Set();
}

export const __testUtils = {
	reset: resetStateForTests,
};
