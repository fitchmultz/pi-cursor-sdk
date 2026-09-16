import { resolve } from "node:path";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionContext,
	ExtensionHandler,
	ProjectTrustHandler,
	SessionInfoChangedEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { truncateCursorDisplayLine } from "./cursor-display-text.js";

interface CursorSessionScopeExtensionApi {
	on(event: "project_trust", handler: ProjectTrustHandler): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): void;
}

const ANONYMOUS_SESSION_SCOPE_KEY = "__anonymous__";
const EPHEMERAL_SESSION_SCOPE_PREFIX = "__ephemeral__:";
export const MAX_CURSOR_SESSION_NAME_LENGTH = 100;

export interface CursorSessionScope {
	readonly cwd: string;
	readonly sessionFile?: string;
	readonly sessionId?: string;
	readonly sessionName?: string;
	readonly projectTrusted: boolean;
	readonly scopeKey: string;
	readonly generation: number;
}

type CursorSessionIdentityContext = {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
};

function buildCursorSessionScopeKey(sessionFile: string | undefined, sessionId: string | undefined): string {
	if (sessionFile) return sessionFile;
	if (sessionId) return `${EPHEMERAL_SESSION_SCOPE_PREFIX}${sessionId}`;
	return ANONYMOUS_SESSION_SCOPE_KEY;
}

function createCursorSessionScope(options: {
	cwd: string;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	projectTrusted?: boolean;
	generation: number;
}): CursorSessionScope {
	return Object.freeze({
		cwd: options.cwd,
		...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		...(options.sessionName ? { sessionName: options.sessionName } : {}),
		projectTrusted: options.projectTrusted === true,
		scopeKey: buildCursorSessionScopeKey(options.sessionFile, options.sessionId),
		generation: options.generation,
	});
}

const anonymousScope = createCursorSessionScope({ cwd: process.cwd(), generation: 0 });
let defaultScope = anonymousScope;
const scopesBySessionId = new Map<string, CursorSessionScope>();
const scopeGenerations = new Map<string, number>([[ANONYMOUS_SESSION_SCOPE_KEY, anonymousScope.generation]]);
let scopesBySignal = new WeakMap<AbortSignal, CursorSessionScope>();
let previousScopeKeysBySessionManager = new WeakMap<object, string>();
const projectTrustResolutionCwds = new Set<string>();
let nextSessionGeneration = 1;

export function getCursorSessionScope(): CursorSessionScope {
	return defaultScope;
}

export function resolveCursorSessionScope(options?: {
	sessionId?: string;
	signal?: AbortSignal;
}): CursorSessionScope {
	if (options?.sessionId) {
		const sessionScope = scopesBySessionId.get(options.sessionId);
		if (sessionScope) return sessionScope;
	}
	if (options?.signal) {
		const signalScope = scopesBySignal.get(options.signal);
		if (signalScope) return signalScope;
	}
	return defaultScope;
}

export function resolveCursorSessionScopeFromContext(
	ctx: CursorSessionIdentityContext,
): CursorSessionScope {
	const sessionId = ctx.sessionManager.getSessionId?.();
	return sessionId ? scopesBySessionId.get(sessionId) ?? defaultScope : defaultScope;
}

export function associateCursorSessionScopeSignal(
	signal: AbortSignal,
	ctx: CursorSessionIdentityContext,
): CursorSessionScope {
	const scope = resolveCursorSessionScopeFromContext(ctx);
	scopesBySignal.set(signal, scope);
	return scope;
}

/** Pi session file when known; used to scope reused Cursor SDK agents to one pi session. */
export function getCursorSessionFile(scope: CursorSessionScope = defaultScope): string | undefined {
	return scope.sessionFile;
}

/** Stable scope key for session-agent pooling. */
export function getCursorSessionScopeKey(scope: CursorSessionScope = defaultScope): string {
	return scope.scopeKey;
}

export function getCursorSessionScopeGeneration(scopeKey: string = defaultScope.scopeKey): number {
	return scopeGenerations.get(scopeKey) ?? 0;
}

/** Pi session cwd when known; falls back to process.cwd() before session_start. */
export function getCursorSessionCwd(scope: CursorSessionScope = defaultScope): string {
	return scope.cwd;
}

export function getCursorSessionProjectTrusted(scope: CursorSessionScope = defaultScope): boolean {
	return scope.projectTrusted;
}

export function getCursorSessionName(scope: CursorSessionScope = defaultScope): string | undefined {
	return scope.sessionName;
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
): CursorSessionScope {
	const scope = createCursorSessionScope({
		cwd,
		sessionFile,
		sessionId,
		sessionName: normalizeCursorSessionName(sessionName),
		projectTrusted,
		generation: nextSessionGeneration,
	});
	nextSessionGeneration += 1;
	defaultScope = scope;
	if (sessionId) scopesBySessionId.set(sessionId, scope);
	scopeGenerations.set(scope.scopeKey, scope.generation);
	return scope;
}

function recordProjectTrustResolution(cwd: string): void {
	projectTrustResolutionCwds.add(resolve(cwd));
}

function isCliProjectTrustApproved(args = process.argv.slice(2)): boolean {
	return parseArgs(args).projectTrustOverride === true;
}

function resetCursorSessionScope(): void {
	defaultScope = createCursorSessionScope({ cwd: process.cwd(), generation: 0 });
	nextSessionGeneration = 1;
	scopesBySessionId.clear();
	scopeGenerations.clear();
	scopeGenerations.set(ANONYMOUS_SESSION_SCOPE_KEY, defaultScope.generation);
	scopesBySignal = new WeakMap();
	previousScopeKeysBySessionManager = new WeakMap();
	projectTrustResolutionCwds.clear();
}

export function takePreviousCursorSessionScopeKey(
	ctx: CursorSessionIdentityContext,
): string | undefined {
	const previousScopeKey = previousScopeKeysBySessionManager.get(ctx.sessionManager);
	previousScopeKeysBySessionManager.delete(ctx.sessionManager);
	return previousScopeKey;
}

export function releaseCursorSessionScope(
	ctx: CursorSessionIdentityContext,
): CursorSessionScope {
	const scope = resolveCursorSessionScopeFromContext(ctx);
	if (scope.sessionId && scopesBySessionId.get(scope.sessionId) === scope) {
		scopesBySessionId.delete(scope.sessionId);
	}
	if (![...scopesBySessionId.values()].some((candidate) => candidate.scopeKey === scope.scopeKey)) {
		scopeGenerations.delete(scope.scopeKey);
	}
	if (defaultScope === scope) {
		defaultScope = [...scopesBySessionId.values()].at(-1) ?? anonymousScope;
	}
	return scope;
}

export function registerCursorSessionScope(pi: CursorSessionScopeExtensionApi): void {
	pi.on("project_trust", (event) => {
		recordProjectTrustResolution(event.cwd);
		return { trusted: "undecided" };
	});
	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager?.getSessionId?.() ?? undefined;
		const previousScope = sessionId ? scopesBySessionId.get(sessionId) : undefined;
		const scope = setCursorSessionScope(
			ctx.cwd,
			ctx.sessionManager?.getSessionFile?.() ?? undefined,
			sessionId,
			ctx.isProjectTrusted?.() === true
				&& (projectTrustResolutionCwds.has(resolve(ctx.cwd)) || isCliProjectTrustApproved()),
			ctx.sessionManager?.getSessionName?.() ?? undefined,
		);
		if (previousScope && previousScope.scopeKey !== scope.scopeKey) {
			previousScopeKeysBySessionManager.set(ctx.sessionManager, previousScope.scopeKey);
		}
	});
	pi.on("session_info_changed", (event, ctx) => {
		const previousScope = resolveCursorSessionScopeFromContext(ctx);
		const scope = createCursorSessionScope({
			cwd: previousScope.cwd,
			sessionFile: previousScope.sessionFile,
			sessionId: previousScope.sessionId,
			sessionName: normalizeCursorSessionName(event.name),
			projectTrusted: previousScope.projectTrusted,
			generation: previousScope.generation,
		});
		defaultScope = scope;
		if (scope.sessionId) scopesBySessionId.set(scope.sessionId, scope);
	});
}

export const __testUtils = {
	ANONYMOUS_SESSION_SCOPE_KEY,
	EPHEMERAL_SESSION_SCOPE_PREFIX,
	set: setCursorSessionScope,
	recordProjectTrustResolution,
	isCliProjectTrustApproved,
	reset: resetCursorSessionScope,
	resolve: resolveCursorSessionScope,
	resolveFromContext: resolveCursorSessionScopeFromContext,
};
