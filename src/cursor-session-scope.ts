import { resolve } from "node:path";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import type { ExtensionHandler, ProjectTrustHandler, SessionInfoChangedEvent, SessionStartEvent, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { truncateCursorDisplayLine } from "./cursor-display-text.js";

interface CursorSessionScopeExtensionApi {
	on(event: "project_trust", handler: ProjectTrustHandler): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
}

const ANONYMOUS_SESSION_SCOPE_KEY = "__anonymous__";
const EPHEMERAL_SESSION_SCOPE_PREFIX = "__ephemeral__:";
export const MAX_CURSOR_SESSION_NAME_LENGTH = 100;

type CursorSessionScopeChangeHandler = (previousScopeKey: string) => Promise<void> | void;

export interface CursorTurnScope {
	readonly cwd: string;
	readonly scopeKey: string;
	readonly sessionFile: string | undefined;
	readonly sessionId: string | undefined;
	readonly sessionName: string | undefined;
	readonly projectTrusted: boolean;
	readonly generation: number;
}

const state = {
	sessionCwd: process.cwd(),
	sessionFile: undefined as string | undefined,
	sessionId: undefined as string | undefined,
	sessionName: undefined as string | undefined,
	projectTrusted: false,
	sessionGeneration: 0,
};
type ScopeRecord = typeof state;
const scopes = new Map<object, ScopeRecord>();
const scopeChangeHandlers = new Map<object, CursorSessionScopeChangeHandler>();
const scopeGenerations = new Map<string, number>([[ANONYMOUS_SESSION_SCOPE_KEY, 0]]);
const projectTrustResolutionCwds = new Set<string>();
let nextSessionGeneration = 1;

function scopeKeyFor(record: ScopeRecord): string {
	if (record.sessionFile) return record.sessionFile;
	if (record.sessionId) return `${EPHEMERAL_SESSION_SCOPE_PREFIX}${record.sessionId}`;
	return ANONYMOUS_SESSION_SCOPE_KEY;
}

export function cursorSessionScopeKeyForManager(manager: {
	getSessionFile?(): string | undefined | null;
	getSessionId?(): string | undefined;
}): string {
	return manager.getSessionFile?.() ?? (manager.getSessionId?.()
		? `${EPHEMERAL_SESSION_SCOPE_PREFIX}${manager.getSessionId()}`
		: ANONYMOUS_SESSION_SCOPE_KEY);
}

export function getCursorSessionScopeSnapshot(pi?: object): CursorTurnScope {
	if (!pi && scopes.size > 1) throw new Error("Cursor provider ownership requires a session-bound provider closure when multiple extensions are loaded.");
	const record = pi ? scopes.get(pi) : state;
	if (!record) throw new Error("Cursor session binding is no longer active.");
	const scopeKey = scopeKeyFor(record);
	return Object.freeze({
		cwd: record.sessionCwd,
		scopeKey,
		sessionFile: record.sessionFile,
		sessionId: record.sessionId,
		sessionName: record.sessionName,
		projectTrusted: record.projectTrusted,
		generation: getCursorSessionScopeGeneration(scopeKey),
	});
}

export function hasLiveCursorSessions(): boolean {
	return scopes.size > 0;
}

export function getCursorSessionFile(): string | undefined {
	return state.sessionFile;
}

/** Stable pool key, with process-local anonymous fallback before session_start. */
export function getCursorSessionScopeKey(): string {
	return scopeKeyFor(state);
}

export function getCursorSessionScopeGeneration(scopeKey: string = getCursorSessionScopeKey()): number {
	return scopeGenerations.get(scopeKey) ?? 0;
}

export function getCursorSessionCwd(): string {
	return state.sessionCwd;
}

export function getCursorSessionProjectTrusted(pi?: object): boolean {
	return pi ? scopes.get(pi)?.projectTrusted === true : state.projectTrusted;
}

export function getCursorSessionName(): string | undefined {
	return state.sessionName;
}

function normalizeCursorSessionName(name: string | undefined): string | undefined {
	if (name === undefined) return undefined;
	return truncateCursorDisplayLine(name, MAX_CURSOR_SESSION_NAME_LENGTH) || undefined;
}

function setCursorSessionScope(
	cwd: string,
	sessionFile: string | undefined,
	sessionId?: string,
	projectTrusted = false,
	sessionName?: string,
): void {
	state.sessionCwd = cwd;
	state.sessionFile = sessionFile;
	state.sessionId = sessionId;
	state.sessionName = normalizeCursorSessionName(sessionName);
	state.projectTrusted = projectTrusted;
	state.sessionGeneration = nextSessionGeneration++;
	scopeGenerations.set(scopeKeyFor(state), state.sessionGeneration);
}

function recordProjectTrustResolution(cwd: string): void {
	projectTrustResolutionCwds.add(resolve(cwd));
}

function isCliProjectTrustApproved(args = process.argv.slice(2)): boolean {
	return parseArgs(args).projectTrustOverride === true;
}

function resetCursorSessionScope(): void {
	Object.assign(state, {
		sessionCwd: process.cwd(), sessionFile: undefined, sessionId: undefined,
		sessionName: undefined, projectTrusted: false, sessionGeneration: 0,
	});
	nextSessionGeneration = 1;
	scopeGenerations.clear();
	scopeGenerations.set(ANONYMOUS_SESSION_SCOPE_KEY, 0);
	projectTrustResolutionCwds.clear();
	scopes.clear();
	scopeChangeHandlers.clear();
}

export function onCursorSessionScopeKeyChange(pi: object, handler: CursorSessionScopeChangeHandler): void {
	scopeChangeHandlers.set(pi, handler);
}

export function registerCursorSessionScope(pi: CursorSessionScopeExtensionApi): void {
	// A fresh binding has no previous pooled scope to steal from the last-bound mirror.
	const record: ScopeRecord = {
		sessionCwd: process.cwd(), sessionFile: undefined, sessionId: undefined,
		sessionName: undefined, projectTrusted: false, sessionGeneration: 0,
	};
	scopes.set(pi, record);
	const trustedCwds = new Set<string>();
	pi.on("project_trust", (event) => {
		trustedCwds.add(resolve(event.cwd));
		return { trusted: "undecided" };
	});
	pi.on("session_start", async (_event, ctx) => {
		const previousScopeKey = scopeKeyFor(record);
		const wasBound = record.sessionGeneration > 0;
		setCursorSessionScope(
			ctx.cwd,
			ctx.sessionManager?.getSessionFile?.() ?? undefined,
			ctx.sessionManager?.getSessionId?.() ?? undefined,
			ctx.isProjectTrusted?.() === true
				&& (trustedCwds.has(resolve(ctx.cwd)) || projectTrustResolutionCwds.has(resolve(ctx.cwd)) || isCliProjectTrustApproved()),
			ctx.sessionManager?.getSessionName?.() ?? undefined,
		);
		Object.assign(record, state);
		scopes.set(pi, record);
		if (wasBound && previousScopeKey !== scopeKeyFor(record)) {
			await scopeChangeHandlers.get(pi)?.(previousScopeKey);
		}
	});
	pi.on("session_info_changed", (event) => {
		record.sessionName = normalizeCursorSessionName(event.name);
		Object.assign(state, record);
	});
	pi.on("session_shutdown", () => {
		scopes.delete(pi);
		scopeChangeHandlers.delete(pi);
	});
}

export const __testUtils = {
	ANONYMOUS_SESSION_SCOPE_KEY,
	EPHEMERAL_SESSION_SCOPE_PREFIX,
	set: setCursorSessionScope,
	recordProjectTrustResolution,
	isCliProjectTrustApproved,
	reset: resetCursorSessionScope,
};
