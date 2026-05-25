import { createHash } from "node:crypto";
import { copyFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { InteractionUpdate } from "@cursor/sdk";
import type { CursorPiToolBridgeDiagnosticEvent } from "./cursor-pi-tool-bridge-diagnostics.js";
import { serializeCursorPiToolBridgeDiagnostic } from "./cursor-pi-tool-bridge-diagnostics.js";
import type { CursorPiBridgeToolRequest } from "./cursor-pi-tool-bridge-types.js";
import type { CursorLiveQueuedEvent } from "./cursor-live-run-coordinator.js";
import { getCursorSessionFile } from "./cursor-session-scope.js";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import {
	ARTIFACTS,
	CURSOR_SDK_EVENT_DEBUG_ENV,
	CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX,
	CURSOR_SDK_EVENT_DEBUG_STDERR_ENV,
	SESSION_MANIFEST,
	SESSION_PI_SESSION_SNAPSHOT,
} from "./cursor-sdk-event-debug-constants.js";
import {
	allocateCursorSdkEventDebugTurn,
	resetCursorSdkEventDebugSessionStateForTests,
	slugSessionKey,
	updateCursorSdkEventDebugSessionManifest,
	type CursorSdkEventDebugTurnAllocation,
} from "./cursor-sdk-event-debug-session.js";

export {
	CURSOR_SDK_EVENT_DEBUG_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_ENV,
	CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX,
	CURSOR_SDK_EVENT_DEBUG_RUN_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_SESSION_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_STDERR_ENV,
	resolveCursorSdkEventDebugBaseDir,
} from "./cursor-sdk-event-debug-constants.js";

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

function eventType(value: unknown): string {
	if (value && typeof value === "object") {
		if ("type" in value && typeof value.type === "string") return value.type;
		if ("event" in value && typeof value.event === "string") return value.event;
		if ("kind" in value && typeof value.kind === "string") return value.kind;
	}
	return "unknown";
}

function resolveCursorSdkEventDebugStderrEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_SDK_EVENT_DEBUG_STDERR_ENV], false);
}

function snapshotCursorSdkEventDebugRecord(record: unknown): unknown {
	try {
		return structuredClone(record);
	} catch {
		try {
			return JSON.parse(JSON.stringify(record));
		} catch {
			return record;
		}
	}
}

export function resolveCursorSdkEventDebugEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_SDK_EVENT_DEBUG_ENV], false);
}

export interface CursorSdkEventDebugRecorder {
	recordLiveRunEvent(event: CursorLiveQueuedEvent): void;
	recordBridgeDiagnostic(event: CursorPiToolBridgeDiagnosticEvent): void;
	recordBridgeRaw(payload: {
		kind: "queued" | "resolved" | "rejected";
		request: CursorPiBridgeToolRequest;
		result?: unknown;
		error?: unknown;
		rejectionKind?: string;
	}): void;
	recordDisplayDecision(decision: CursorSdkDisplayDecisionRecord): void;
	recordCoordinatorEvent(phase: string, payload: unknown): void;
	recordDrainEvent(phase: string, payload: unknown): void;
	recordFinalPartial(partial: unknown): void;
	finalize(): Promise<void>;
}

export const DISCARDED_INCOMPLETE_TOOL_CALL_REASON = "no-completion-at-run-end";

export type DiscardedIncompleteStartedToolCallReason =
	| typeof DISCARDED_INCOMPLETE_TOOL_CALL_REASON
	| "abort"
	| "sdk-failure"
	| "run-drain";

export function hashCursorSdkCallId(callId: string): string {
	return createHash("sha256").update(callId).digest("hex").slice(0, 8);
}

export interface DiscardedIncompleteStartedToolCallRecord {
	event: "discarded-incomplete-started-tool-call";
	toolName: string;
	callIdHash: string;
	reason: DiscardedIncompleteStartedToolCallReason;
}

export function serializeDiscardedIncompleteStartedToolCall(record: {
	toolName: string;
	callId: string;
	reason?: DiscardedIncompleteStartedToolCallReason;
}): DiscardedIncompleteStartedToolCallRecord {
	return {
		event: "discarded-incomplete-started-tool-call",
		toolName: record.toolName,
		callIdHash: hashCursorSdkCallId(record.callId),
		reason: record.reason ?? DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
	};
}

export function recordDiscardedIncompleteStartedToolCall(
	recorder: CursorSdkEventDebugRecorder | undefined,
	env: Record<string, string | undefined>,
	record: { toolName: string; callId: string; reason?: DiscardedIncompleteStartedToolCallReason },
): void {
	if (!recorder && !resolveCursorSdkEventDebugEnabled(env)) return;
	try {
		const payload = serializeDiscardedIncompleteStartedToolCall(record);
		recorder?.recordCoordinatorEvent("discarded-incomplete-started-tool-call", payload);
		if (resolveCursorSdkEventDebugStderrEnabled(env) && resolveCursorSdkEventDebugEnabled(env)) {
			process.stderr.write(`${CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX} ${JSON.stringify(payload)}\n`);
		}
	} catch {
		// Debug logging must never affect provider execution.
	}
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
	private readonly jsonlBuffers = new Map<string, unknown[]>();
	private finalized = false;
	private finalizationPromise: Promise<void> | undefined;
	private waitResultRecorded = false;
	private streamCapturePromise: Promise<void> | undefined;
	private readonly streamCaptureErrors: unknown[] = [];

	static maybeCreate(options: CursorSdkEventDebugSinkOptions): CursorSdkEventDebugSink | undefined {
		const env = options.env ?? process.env;
		if (!resolveCursorSdkEventDebugEnabled(env)) return undefined;
		const allocation = allocateCursorSdkEventDebugTurn(options.cwd, env);
		return new CursorSdkEventDebugSink(allocation, options, env);
	}

	private constructor(
		allocation: CursorSdkEventDebugTurnAllocation,
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
		this.clearKnownArtifactFiles();
		writeFileSync(join(this.artifactDir, ARTIFACTS.metadata), `${JSON.stringify(this.metadata, null, 2)}\n`);
	}

	recordProviderMeta(meta: Record<string, unknown>): void {
		this.metadata = {
			...this.metadata,
			providerMeta: meta,
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
		updateCursorSdkEventDebugSessionManifest(this.sessionDir, this.artifactDir, summary);
	}

	private clearKnownArtifactFiles(): void {
		for (const fileName of Object.values(ARTIFACTS)) {
			try {
				unlinkSync(join(this.artifactDir, fileName));
			} catch {
				// Ignore missing prior artifacts when reusing a pinned run directory.
			}
		}
	}

	async finalize(): Promise<void> {
		this.finalizationPromise ??= this.finalizeOnce();
		await this.finalizationPromise;
	}

	private async finalizeOnce(): Promise<void> {
		if (this.finalized) return;
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
		this.flushJsonlBuffers();
		writeFileSync(join(this.artifactDir, ARTIFACTS.summary), `${JSON.stringify(summary, null, 2)}\n`);
		this.updateSessionManifest(summary);
		if (resolveCursorSdkEventDebugStderrEnabled(this.env)) {
			process.stderr.write(`${CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX} ${JSON.stringify(summary)}\n`);
		}
		this.finalized = true;
	}

	private appendProviderJsonl(phase: string, payload: unknown): void {
		const elapsedMs = Date.now() - this.startedAt;
		const record = { ts: new Date().toISOString(), elapsedMs, turn: this.turn, phase, payload };
		this.bufferJsonl(ARTIFACTS.providerEvents, record);
		this.counts.provider[phase] = (this.counts.provider[phase] ?? 0) + 1;
		this.recordTimeline("provider", phase, payload);
	}

	private appendCoordinatorJsonl(phase: string, payload: unknown): void {
		const elapsedMs = Date.now() - this.startedAt;
		const record = { ts: new Date().toISOString(), elapsedMs, turn: this.turn, phase, payload };
		this.bufferJsonl(ARTIFACTS.coordinatorEvents, record);
		this.counts.coordinator[phase] = (this.counts.coordinator[phase] ?? 0) + 1;
		this.recordTimeline("coordinator", phase, payload);
	}

	private appendDrainJsonl(phase: string, payload: unknown): void {
		const elapsedMs = Date.now() - this.startedAt;
		const record = { ts: new Date().toISOString(), elapsedMs, turn: this.turn, phase, payload };
		this.bufferJsonl(ARTIFACTS.drainEvents, record);
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
		this.bufferJsonl(ARTIFACTS.timeline, record);
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
		this.bufferJsonl(fileName, record);
		const type = countKey ?? eventType(value);
		counts[type] = (counts[type] ?? 0) + 1;
		const layer = fileName.replace(/\.jsonl$/, "");
		this.recordTimeline(layer, type, value);
	}

	private bufferJsonl(fileName: string, record: unknown): void {
		if (this.finalized) return;
		const records = this.jsonlBuffers.get(fileName) ?? [];
		records.push(snapshotCursorSdkEventDebugRecord(record));
		this.jsonlBuffers.set(fileName, records);
	}

	private flushJsonlBuffers(): void {
		for (const [fileName, records] of this.jsonlBuffers) {
			const lines = records.map((record) => `${JSON.stringify(record)}\n`).join("");
			writeFileSync(join(this.artifactDir, fileName), lines);
		}
		this.jsonlBuffers.clear();
	}
}

export const __testUtils = {
	ARTIFACTS,
	SESSION_MANIFEST,
	slugSessionKey,
	resetSessionDebugState: resetCursorSdkEventDebugSessionStateForTests,
};
