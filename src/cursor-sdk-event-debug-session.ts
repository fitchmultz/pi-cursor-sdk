import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	CURSOR_SDK_EVENT_DEBUG_RUN_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_SESSION_DIR_ENV,
	SESSION_MANIFEST,
	resolveCursorSdkEventDebugBaseDir,
} from "./cursor-sdk-event-debug-constants.js";
import { getCursorSessionFile, getCursorSessionScopeKey } from "./cursor-session-scope.js";

const ANONYMOUS_SESSION_SCOPE_KEY = "__anonymous__";

interface CursorSdkEventDebugSessionState {
	sessionKey: string;
	sessionDir: string;
	turnCounter: number;
}

interface CursorSdkEventDebugSessionManifest {
	sessionKey: string;
	sessionFile?: string;
	sessionDir: string;
	createdAt: string;
	updatedAt: string;
	turns: Array<{
		turn: number;
		artifactDir: string;
		startedAt: string;
		finalizedAt?: string;
		summary?: Record<string, unknown>;
	}>;
}

export interface CursorSdkEventDebugTurnAllocation {
	artifactDir: string;
	sessionDir?: string;
	turn?: number;
	sessionKey?: string;
	pinnedRun: boolean;
}

const sessionDebugStates = new Map<string, CursorSdkEventDebugSessionState>();

function sanitizePathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

export function slugSessionKey(scopeKey: string): string {
	if (scopeKey === ANONYMOUS_SESSION_SCOPE_KEY) {
		return `anonymous-${process.pid}`;
	}
	const fileBase = sanitizePathSegment(basename(scopeKey).replace(/\.jsonl?$/i, "") || "session");
	const hash = createHash("sha256").update(scopeKey).digest("hex").slice(0, 8);
	return `${fileBase}-${hash}`;
}

function resolvePinnedRunArtifactDir(runDirOverride: string | undefined): string | undefined {
	const trimmed = runDirOverride?.trim();
	if (!trimmed) return undefined;
	const dir = resolve(trimmed);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function readSessionManifest(sessionDir: string): CursorSdkEventDebugSessionManifest | undefined {
	try {
		return JSON.parse(readFileSync(join(sessionDir, SESSION_MANIFEST), "utf8")) as CursorSdkEventDebugSessionManifest;
	} catch {
		return undefined;
	}
}

function writeSessionManifest(sessionDir: string, manifest: CursorSdkEventDebugSessionManifest): void {
	writeFileSync(join(sessionDir, SESSION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

function maxTurnFromManifest(manifest: CursorSdkEventDebugSessionManifest | undefined): number {
	if (!manifest || manifest.turns.length === 0) return 0;
	return manifest.turns.reduce((max, entry) => Math.max(max, entry.turn), 0);
}

function resolveSessionDebugDir(
	cwd: string,
	env: Record<string, string | undefined>,
	scopeKey: string,
): string {
	const pinned = env[CURSOR_SDK_EVENT_DEBUG_SESSION_DIR_ENV]?.trim();
	if (pinned) return resolve(pinned);
	return join(resolveCursorSdkEventDebugBaseDir(cwd, env), "sessions", slugSessionKey(scopeKey));
}

export function allocateCursorSdkEventDebugTurn(
	cwd: string,
	env: Record<string, string | undefined>,
): CursorSdkEventDebugTurnAllocation {
	const pinnedRunDir = resolvePinnedRunArtifactDir(env[CURSOR_SDK_EVENT_DEBUG_RUN_DIR_ENV]);
	if (pinnedRunDir) {
		return { artifactDir: pinnedRunDir, pinnedRun: true };
	}

	const scopeKey = getCursorSessionScopeKey();
	const sessionDir = resolveSessionDebugDir(cwd, env, scopeKey);
	mkdirSync(sessionDir, { recursive: true });

	let state = sessionDebugStates.get(scopeKey);
	if (!state || state.sessionDir !== sessionDir) {
		const existing = readSessionManifest(sessionDir);
		state = { sessionKey: scopeKey, sessionDir, turnCounter: maxTurnFromManifest(existing) };
		sessionDebugStates.set(scopeKey, state);
	}

	state.turnCounter += 1;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const artifactDir = join(sessionDir, `turn-${String(state.turnCounter).padStart(3, "0")}-${stamp}`);
	mkdirSync(artifactDir, { recursive: true });

	const existing = readSessionManifest(sessionDir);
	const manifest: CursorSdkEventDebugSessionManifest = existing ?? {
		sessionKey: scopeKey,
		sessionFile: getCursorSessionFile(),
		sessionDir,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		turns: [],
	};
	manifest.sessionFile = getCursorSessionFile();
	manifest.updatedAt = new Date().toISOString();
	manifest.turns.push({
		turn: state.turnCounter,
		artifactDir,
		startedAt: new Date().toISOString(),
	});
	writeSessionManifest(sessionDir, manifest);

	return {
		artifactDir,
		sessionDir,
		turn: state.turnCounter,
		sessionKey: scopeKey,
		pinnedRun: false,
	};
}

export function updateCursorSdkEventDebugSessionManifest(
	sessionDir: string,
	artifactDir: string,
	summary: Record<string, unknown>,
): void {
	const manifest = readSessionManifest(sessionDir);
	if (!manifest) return;
	const turnEntry = manifest.turns.find((entry) => entry.artifactDir === artifactDir);
	if (!turnEntry) return;
	turnEntry.finalizedAt = new Date().toISOString();
	turnEntry.summary = summary;
	manifest.updatedAt = new Date().toISOString();
	manifest.sessionFile = getCursorSessionFile();
	writeSessionManifest(sessionDir, manifest);
}

export function resetCursorSdkEventDebugSessionStateForTests(): void {
	sessionDebugStates.clear();
}
