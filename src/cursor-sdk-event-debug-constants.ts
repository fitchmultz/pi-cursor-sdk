import { resolve } from "node:path";

export const CURSOR_SDK_EVENT_DEBUG_ENV = "PI_CURSOR_SDK_EVENT_DEBUG";
export const CURSOR_SDK_EVENT_DEBUG_DIR_ENV = "PI_CURSOR_SDK_EVENT_DEBUG_DIR";
export const CURSOR_SDK_EVENT_DEBUG_RUN_DIR_ENV = "PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR";
export const CURSOR_SDK_EVENT_DEBUG_SESSION_DIR_ENV = "PI_CURSOR_SDK_EVENT_DEBUG_SESSION_DIR";
export const CURSOR_SDK_EVENT_DEBUG_STDERR_ENV = "PI_CURSOR_SDK_EVENT_DEBUG_STDERR";
export const CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX = "[pi-cursor-sdk:sdk-events]";

export const SESSION_MANIFEST = "session.json";
export const SESSION_PI_SESSION_SNAPSHOT = "pi-session.jsonl";

export const ARTIFACTS = {
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

export function resolveCursorSdkEventDebugBaseDir(cwd: string, env: Record<string, string | undefined> = process.env): string {
	const raw = env[CURSOR_SDK_EVENT_DEBUG_DIR_ENV]?.trim();
	return resolve(cwd, raw || ".debug/cursor-sdk-events");
}
