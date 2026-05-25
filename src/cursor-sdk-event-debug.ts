import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { InteractionUpdate } from "@cursor/sdk";
import type { CursorPiToolBridgeDiagnosticEvent } from "./cursor-pi-tool-bridge-diagnostics.js";
import { serializeCursorPiToolBridgeDiagnostic } from "./cursor-pi-tool-bridge-diagnostics.js";
import type { CursorPiBridgeToolRequest } from "./cursor-pi-tool-bridge-types.js";
import type { CursorLiveQueuedEvent } from "./cursor-live-run-coordinator.js";
import { getCursorSessionFile, getCursorSessionScopeKey } from "./cursor-session-scope.js";
import { parseEnvBoolean } from "./cursor-env-boolean.js";

export const CURSOR_SDK_EVENT_DEBUG_ENV = "PI_CURSOR_SDK_EVENT_DEBUG";
export const CURSOR_SDK_EVENT_DEBUG_DIR_ENV = "PI_CURSOR_SDK_EVENT_DEBUG_DIR";
export const CURSOR_SDK_EVENT_DEBUG_RUN_DIR_ENV = "PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR";
export const CURSOR_SDK_EVENT_DEBUG_SESSION_DIR_ENV = "PI_CURSOR_SDK_EVENT_DEBUG_SESSION_DIR";
export const CURSOR_SDK_EVENT_DEBUG_STDERR_ENV = "PI_CURSOR_SDK_EVENT_DEBUG_STDERR";
export const CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX = "[pi-cursor-sdk:sdk-events]";

const SESSION_MANIFEST = "session.json";
const ANONYMOUS_SESSION_SCOPE_KEY = "__anonymous__";

const ARTIFACTS = {
	metadata: "metadata.json",
	sendPayload: "send-payload.json",
	contextSnapshot: "context-snapshot.json",
	onDelta: "on-delta.jsonl",
	onStep: "on-step.jsonl",
	streamEvents: "stream-events.jsonl",
	piStreamEvents: "pi-stream-events.jsonl",
	providerEvents: "provider-events.jsonl",
	liveRunEvents: "live-run-events.jsonl",
	bridgeEvents: "bridge-events.jsonl",
	bridgeRaw: "bridge-raw.jsonl",
	displayDecisions: "display-decisions.jsonl",
	coordinatorEvents: "coordinator-events.jsonl",
	drainEvents: "drain-events.jsonl",
	timeline: "timeline.jsonl",
	piSessionSnapshot: "pi-session-snapshot.jsonl",
	finalPartial: "final-partial.json",
	errors: "errors.jsonl",
	waitResult: "wait-result.json",
	conversation: "conversation.json",
	summary: "summary.json",
} as const;

const SESSION_PI_SESSION_SNAPSHOT = "pi-session.jsonl";

export type CursorSdkDisplayDecisionAction = "skip-duplicate" | "queue_replay" | "emit_trace" | "ignore-bridge";

export interface CursorSdkDisplayDecisionRecord {
	action: CursorSdkDisplayDecisionAction;
	disposition?: string;
	toolName: string;
	identity?: string;
	source?: "started" | "fallback" | "delta" | "step";
	transcript?: string;
	traceText?: string;
	replayToolId?: string;
	reason?: string;
}

export interface CursorSdkEventDebugSinkOptions {
	cwd: string;
	modelId: string;
	provider: string;
	env?: Record<string, string | undefined>;
}

export interface CursorSdkEventDebugSendMeta {
	mode: string;
	reason: string;
	resetAgent: boolean;
	bootstrap: boolean;
	promptText: string;
	imageCount: number;
	useNativeToolReplay: boolean;
	bridgeEnabled: boolean;
	nativeReplayId: string;
	promptInputTokens: number;
}

export interface CursorSdkEventDebugRunMeta {
	runId: string;
	agentId: string;
	status: string;
}

interface CursorSdkRunLike {
	id: string;
	agentId?: string;
	status?: string;
	stream?: () => AsyncIterable<unknown>;
	wait?: () => Promise<unknown>;
	supports?: (operation: never) => boolean;
	unsupportedReason?: (operation: never) => string | undefined;
	conversation?: () => Promise<unknown>;
}

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

let activeCursorSdkEventDebugSink: CursorSdkEventDebugSink | undefined;
const sessionDebugStates = new Map<string, CursorSdkEventDebugSessionState>();

function eventType(value: unknown): string {
	if (value && typeof value === "object") {
		if ("type" in value && typeof value.type === "string") return value.type;
		if ("event" in value && typeof value.event === "string") return value.event;
		if ("kind" in value && typeof value.kind === "string") return value.kind;
	}
	return "unknown";
}

function sanitizePathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function slugSessionKey(scopeKey: string): string {
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

function resolveSessionDebugDir(
	cwd: string,
	env: Record<string, string | undefined>,
	scopeKey: string,
): string {
	const pinned = env[CURSOR_SDK_EVENT_DEBUG_SESSION_DIR_ENV]?.trim();
	if (pinned) return resolve(pinned);
	return join(resolveCursorSdkEventDebugBaseDir(cwd, env), "sessions", slugSessionKey(scopeKey));
}

function allocateTurnArtifactDir(
	cwd: string,
	env: Record<string, string | undefined>,
): { artifactDir: string; sessionDir?: string; turn?: number; sessionKey?: string; pinnedRun: boolean } {
	const pinnedRunDir = resolvePinnedRunArtifactDir(env[CURSOR_SDK_EVENT_DEBUG_RUN_DIR_ENV]);
	if (pinnedRunDir) {
		return { artifactDir: pinnedRunDir, pinnedRun: true };
	}

	const scopeKey = getCursorSessionScopeKey();
	const sessionDir = resolveSessionDebugDir(cwd, env, scopeKey);
	mkdirSync(sessionDir, { recursive: true });

	let state = sessionDebugStates.get(scopeKey);
	if (!state || state.sessionDir !== sessionDir) {
		state = { sessionKey: scopeKey, sessionDir, turnCounter: 0 };
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

function resolveCursorSdkEventDebugStderrEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_SDK_EVENT_DEBUG_STDERR_ENV], false);
}

export function resolveCursorSdkEventDebugEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_SDK_EVENT_DEBUG_ENV], false);
}

export function resolveCursorSdkEventDebugBaseDir(cwd: string, env: Record<string, string | undefined> = process.env): string {
	const raw = env[CURSOR_SDK_EVENT_DEBUG_DIR_ENV]?.trim();
	return resolve(cwd, raw || ".debug/cursor-sdk-events");
}

export function setActiveCursorSdkEventDebugSink(sink: CursorSdkEventDebugSink | undefined): void {
	activeCursorSdkEventDebugSink = sink;
}

export function getActiveCursorSdkEventDebugSink(): CursorSdkEventDebugSink | undefined {
	return activeCursorSdkEventDebugSink;
}

export function recordActiveCursorSdkLiveRunEvent(event: CursorLiveQueuedEvent): void {
	activeCursorSdkEventDebugSink?.recordLiveRunEvent(event);
}

export function recordActiveCursorSdkBridgeDiagnostic(event: CursorPiToolBridgeDiagnosticEvent): void {
	activeCursorSdkEventDebugSink?.recordBridgeDiagnostic(event);
}

export function recordActiveCursorSdkBridgeRaw(payload: {
	kind: "queued" | "resolved" | "rejected";
	request: CursorPiBridgeToolRequest;
	result?: unknown;
	error?: unknown;
	rejectionKind?: string;
}): void {
	activeCursorSdkEventDebugSink?.recordBridgeRaw(payload);
}

export function recordActiveCursorSdkDisplayDecision(decision: CursorSdkDisplayDecisionRecord): void {
	activeCursorSdkEventDebugSink?.recordDisplayDecision(decision);
}

export function recordActiveCursorSdkCoordinatorEvent(phase: string, payload: unknown): void {
	activeCursorSdkEventDebugSink?.recordCoordinatorEvent(phase, payload);
}

export function recordActiveCursorSdkDrainEvent(phase: string, payload: unknown): void {
	activeCursorSdkEventDebugSink?.recordDrainEvent(phase, payload);
}

export function recordActiveCursorSdkFinalPartial(partial: unknown): void {
	activeCursorSdkEventDebugSink?.recordFinalPartial(partial);
}

export function attachCursorSdkEventDebugPiStreamTap(
	stream: AssistantMessageEventStream,
	sinkRef: { current?: CursorSdkEventDebugSink },
): void {
	if (!resolveCursorSdkEventDebugEnabled()) return;
	const originalPush = stream.push.bind(stream);
	stream.push = (event) => {
		sinkRef.current?.recordPiStreamEvent(event);
		return originalPush(event);
	};
}

export class CursorSdkEventDebugSink {
	readonly artifactDir: string;
	readonly sessionDir?: string;
	readonly turn?: number;
	readonly sessionKey?: string;
	readonly pinnedRun: boolean;
	private readonly env: Record<string, string | undefined>;
	private readonly startedAt = Date.now();
	private readonly counts = {
		onDelta: {} as Record<string, number>,
		onStep: {} as Record<string, number>,
		stream: {} as Record<string, number>,
		piStream: {} as Record<string, number>,
		provider: {} as Record<string, number>,
		liveRun: {} as Record<string, number>,
		bridge: {} as Record<string, number>,
		bridgeRaw: {} as Record<string, number>,
		displayDecisions: {} as Record<string, number>,
		coordinator: {} as Record<string, number>,
		drain: {} as Record<string, number>,
		timeline: {} as Record<string, number>,
		errors: 0,
	};
	private metadata: Record<string, unknown>;
	private finalized = false;
	private waitResultRecorded = false;
	private streamCapturePromise: Promise<void> | undefined;
	private readonly streamCaptureErrors: unknown[] = [];

	static maybeCreate(options: CursorSdkEventDebugSinkOptions): CursorSdkEventDebugSink | undefined {
		const env = options.env ?? process.env;
		if (!resolveCursorSdkEventDebugEnabled(env)) return undefined;
		const allocation = allocateTurnArtifactDir(options.cwd, env);
		return new CursorSdkEventDebugSink(allocation, options, env);
	}

	private constructor(
		allocation: {
			artifactDir: string;
			sessionDir?: string;
			turn?: number;
			sessionKey?: string;
			pinnedRun: boolean;
		},
		options: CursorSdkEventDebugSinkOptions,
		env: Record<string, string | undefined>,
	) {
		this.artifactDir = allocation.artifactDir;
		this.sessionDir = allocation.sessionDir;
		this.turn = allocation.turn;
		this.sessionKey = allocation.sessionKey;
		this.pinnedRun = allocation.pinnedRun;
		this.env = env;
		this.metadata = {
			capturedAt: new Date().toISOString(),
			modelId: options.modelId,
			provider: options.provider,
			cwd: options.cwd,
			sessionDir: allocation.sessionDir,
			sessionKey: allocation.sessionKey,
			sessionFile: getCursorSessionFile(),
			turn: allocation.turn,
			pinnedRun: allocation.pinnedRun,
			artifacts: ARTIFACTS,
			warnings: [
				"Raw artifact files may contain local paths, project text, tool args/results, or secrets from the workspace. Do not commit or share them.",
			],
		};
		writeFileSync(join(this.artifactDir, ARTIFACTS.metadata), `${JSON.stringify(this.metadata, null, 2)}\n`);
	}

	recordProviderMeta(meta: Record<string, unknown>): void {
		this.metadata = {
			...this.metadata,
			provider: meta,
		};
		writeFileSync(join(this.artifactDir, ARTIFACTS.metadata), `${JSON.stringify(this.metadata, null, 2)}\n`);
	}

	recordSendMeta(meta: CursorSdkEventDebugSendMeta): void {
		this.metadata = {
			...this.metadata,
			send: meta,
		};
		writeFileSync(join(this.artifactDir, ARTIFACTS.metadata), `${JSON.stringify(this.metadata, null, 2)}\n`);
	}

	recordSendPayload(payload: unknown): void {
		writeFileSync(join(this.artifactDir, ARTIFACTS.sendPayload), `${JSON.stringify(payload, null, 2)}\n`);
	}

	recordContextSnapshot(context: unknown): void {
		writeFileSync(join(this.artifactDir, ARTIFACTS.contextSnapshot), `${JSON.stringify(context, null, 2)}\n`);
	}

	recordRunMeta(meta: CursorSdkEventDebugRunMeta): void {
		this.metadata = {
			...this.metadata,
			run: meta,
		};
		writeFileSync(join(this.artifactDir, ARTIFACTS.metadata), `${JSON.stringify(this.metadata, null, 2)}\n`);
	}

	recordOnDelta(update: InteractionUpdate): void {
		this.appendJsonl(ARTIFACTS.onDelta, "update", update, this.counts.onDelta);
	}

	recordOnStep(step: unknown): void {
		this.appendJsonl(ARTIFACTS.onStep, "step", step, this.counts.onStep);
	}

	recordStreamEvent(event: unknown): void {
		this.appendJsonl(ARTIFACTS.streamEvents, "event", event, this.counts.stream);
	}

	recordPiStreamEvent(event: unknown): void {
		this.appendJsonl(ARTIFACTS.piStreamEvents, "event", event, this.counts.piStream);
	}

	recordProviderEvent(phase: string, payload: unknown): void {
		this.appendProviderJsonl(phase, payload);
	}

	recordLiveRunEvent(event: CursorLiveQueuedEvent): void {
		this.appendJsonl(ARTIFACTS.liveRunEvents, "event", event, this.counts.liveRun);
	}

	recordBridgeDiagnostic(event: CursorPiToolBridgeDiagnosticEvent): void {
		const serialized = serializeCursorPiToolBridgeDiagnostic(event);
		this.appendJsonl(ARTIFACTS.bridgeEvents, "event", serialized, this.counts.bridge, String(serialized.event));
	}

	recordBridgeRaw(payload: {
		kind: "queued" | "resolved" | "rejected";
		request: CursorPiBridgeToolRequest;
		result?: unknown;
		error?: unknown;
		rejectionKind?: string;
	}): void {
		this.appendJsonl(ARTIFACTS.bridgeRaw, "bridgeRaw", payload, this.counts.bridgeRaw, payload.kind);
	}

	recordDisplayDecision(decision: CursorSdkDisplayDecisionRecord): void {
		this.appendJsonl(ARTIFACTS.displayDecisions, "decision", decision, this.counts.displayDecisions, decision.action);
	}

	recordCoordinatorEvent(phase: string, payload: unknown): void {
		this.appendCoordinatorJsonl(phase, payload);
	}

	recordDrainEvent(phase: string, payload: unknown): void {
		this.appendDrainJsonl(phase, payload);
	}

	recordFinalPartial(partial: unknown): void {
		writeFileSync(join(this.artifactDir, ARTIFACTS.finalPartial), `${JSON.stringify(partial, null, 2)}\n`);
		this.recordTimeline("finalPartial", "snapshot", partial);
	}

	recordError(label: string, error: unknown): void {
		this.counts.errors += 1;
		const payload = {
			label,
			message: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			value: error,
		};
		this.appendJsonl(ARTIFACTS.errors, "error", payload, { [label]: 1 }, label);
	}

	attachRunStream(run: unknown): void {
		const sdkRun = run as CursorSdkRunLike;
		if (typeof sdkRun.stream !== "function") {
			this.recordProviderEvent("run_stream_unavailable", { runId: sdkRun.id });
			return;
		}
		this.streamCapturePromise = (async () => {
			try {
				for await (const event of sdkRun.stream!()) {
					this.recordStreamEvent(event);
				}
			} catch (error) {
				this.streamCaptureErrors.push(error);
				this.recordError("run_stream", error);
			}
		})();
	}

	async captureRunArtifacts(run: unknown): Promise<void> {
		const sdkRun = run as CursorSdkRunLike & {
			supports?: (operation: string) => boolean;
			unsupportedReason?: (operation: string) => string | undefined;
		};
		if (this.streamCapturePromise) {
			await this.streamCapturePromise.catch(() => undefined);
		}
		if (typeof sdkRun.conversation === "function" && sdkRun.supports?.("conversation")) {
			try {
				const conversation = await sdkRun.conversation();
				writeFileSync(join(this.artifactDir, ARTIFACTS.conversation), `${JSON.stringify(conversation, null, 2)}\n`);
				this.recordProviderEvent("conversation_captured", { supported: true });
			} catch (error) {
				this.recordError("conversation", error);
			}
		} else {
			writeFileSync(
				join(this.artifactDir, ARTIFACTS.conversation),
				`${JSON.stringify(
					{
						skipped: true,
						reason: sdkRun.unsupportedReason?.("conversation") ?? "conversation unsupported",
					},
					null,
					2,
				)}\n`,
			);
		}
	}

	recordWaitResult(result: unknown): void {
		if (this.waitResultRecorded) return;
		this.waitResultRecorded = true;
		writeFileSync(join(this.artifactDir, ARTIFACTS.waitResult), `${JSON.stringify(result, null, 2)}\n`);
	}

	private capturePiSessionSnapshot(): { copied: boolean; sessionFile?: string; reason?: string } {
		const sessionFile = getCursorSessionFile();
		if (!sessionFile) {
			return { copied: false, reason: "session file unknown" };
		}
		try {
			copyFileSync(sessionFile, join(this.artifactDir, ARTIFACTS.piSessionSnapshot));
			if (this.sessionDir) {
				copyFileSync(sessionFile, join(this.sessionDir, SESSION_PI_SESSION_SNAPSHOT));
			}
			this.recordTimeline("piSession", "snapshot", { sessionFile, artifact: ARTIFACTS.piSessionSnapshot });
			return { copied: true, sessionFile };
		} catch (error) {
			this.recordError("pi_session_snapshot", error);
			return {
				copied: false,
				sessionFile,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private updateSessionManifest(summary: Record<string, unknown>): void {
		if (this.pinnedRun || !this.sessionDir || this.turn === undefined) return;
		const manifest = readSessionManifest(this.sessionDir);
		if (!manifest) return;
		const turnEntry = manifest.turns.find((entry) => entry.turn === this.turn);
		if (!turnEntry) return;
		turnEntry.finalizedAt = new Date().toISOString();
		turnEntry.summary = summary;
		manifest.updatedAt = new Date().toISOString();
		manifest.sessionFile = getCursorSessionFile();
		writeSessionManifest(this.sessionDir, manifest);
	}

	async finalize(): Promise<void> {
		if (this.finalized) return;
		this.finalized = true;
		if (this.streamCapturePromise) {
			await this.streamCapturePromise.catch(() => undefined);
		}
		const piSessionSnapshot = this.capturePiSessionSnapshot();
		const summary = {
			artifactDir: this.artifactDir,
			sessionDir: this.sessionDir,
			sessionKey: this.sessionKey,
			sessionFile: getCursorSessionFile(),
			turn: this.turn,
			elapsedMs: Date.now() - this.startedAt,
			counts: {
				onDelta: { ...this.counts.onDelta },
				onStep: { ...this.counts.onStep },
				stream: { ...this.counts.stream },
				piStream: { ...this.counts.piStream },
				provider: { ...this.counts.provider },
				liveRun: { ...this.counts.liveRun },
				bridge: { ...this.counts.bridge },
				bridgeRaw: { ...this.counts.bridgeRaw },
				displayDecisions: { ...this.counts.displayDecisions },
				coordinator: { ...this.counts.coordinator },
				drain: { ...this.counts.drain },
				timeline: { ...this.counts.timeline },
				errors: this.counts.errors,
			},
			piSessionSnapshot,
			artifacts: Object.fromEntries(
				Object.entries(ARTIFACTS).map(([key, name]) => [key, join(this.artifactDir, name)]),
			),
			waitResultRecorded: this.waitResultRecorded,
			streamCaptureErrors: this.streamCaptureErrors.map((error) =>
				error instanceof Error ? error.message : String(error),
			),
		};
		writeFileSync(join(this.artifactDir, ARTIFACTS.summary), `${JSON.stringify(summary, null, 2)}\n`);
		this.updateSessionManifest(summary);
		if (resolveCursorSdkEventDebugStderrEnabled(this.env)) {
			process.stderr.write(`${CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX} ${JSON.stringify(summary)}\n`);
		}
	}

	private appendProviderJsonl(phase: string, payload: unknown): void {
		const elapsedMs = Date.now() - this.startedAt;
		const record = { ts: new Date().toISOString(), elapsedMs, turn: this.turn, phase, payload };
		appendFileSync(join(this.artifactDir, ARTIFACTS.providerEvents), `${JSON.stringify(record)}\n`);
		this.counts.provider[phase] = (this.counts.provider[phase] ?? 0) + 1;
		this.recordTimeline("provider", phase, payload);
	}

	private appendCoordinatorJsonl(phase: string, payload: unknown): void {
		const elapsedMs = Date.now() - this.startedAt;
		const record = { ts: new Date().toISOString(), elapsedMs, turn: this.turn, phase, payload };
		appendFileSync(join(this.artifactDir, ARTIFACTS.coordinatorEvents), `${JSON.stringify(record)}\n`);
		this.counts.coordinator[phase] = (this.counts.coordinator[phase] ?? 0) + 1;
		this.recordTimeline("coordinator", phase, payload);
	}

	private appendDrainJsonl(phase: string, payload: unknown): void {
		const elapsedMs = Date.now() - this.startedAt;
		const record = { ts: new Date().toISOString(), elapsedMs, turn: this.turn, phase, payload };
		appendFileSync(join(this.artifactDir, ARTIFACTS.drainEvents), `${JSON.stringify(record)}\n`);
		this.counts.drain[phase] = (this.counts.drain[phase] ?? 0) + 1;
		this.recordTimeline("drain", phase, payload);
	}

	private recordTimeline(layer: string, kind: string, payload: unknown): void {
		const elapsedMs = Date.now() - this.startedAt;
		const record = {
			ts: new Date().toISOString(),
			elapsedMs,
			turn: this.turn,
			layer,
			kind,
			payload,
		};
		appendFileSync(join(this.artifactDir, ARTIFACTS.timeline), `${JSON.stringify(record)}\n`);
		const timelineKey = `${layer}:${kind}`;
		this.counts.timeline[timelineKey] = (this.counts.timeline[timelineKey] ?? 0) + 1;
	}

	private appendJsonl(
		fileName: string,
		recordKey: string,
		value: unknown,
		counts: Record<string, number>,
		countKey?: string,
	): void {
		const elapsedMs = Date.now() - this.startedAt;
		const record = {
			ts: new Date().toISOString(),
			elapsedMs,
			turn: this.turn,
			[recordKey]: value,
		};
		appendFileSync(join(this.artifactDir, fileName), `${JSON.stringify(record)}\n`);
		const type = countKey ?? eventType(value);
		counts[type] = (counts[type] ?? 0) + 1;
		const layer = fileName.replace(/\.jsonl$/, "");
		this.recordTimeline(layer, type, value);
	}
}

export function resetCursorSdkEventDebugSessionStateForTests(): void {
	sessionDebugStates.clear();
}

export const __testUtils = {
	ARTIFACTS,
	SESSION_MANIFEST,
	slugSessionKey,
	resetSessionDebugState: resetCursorSdkEventDebugSessionStateForTests,
};
