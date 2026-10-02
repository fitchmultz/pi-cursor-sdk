import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	CURSOR_SDK_EVENT_DEBUG_ENV,
	CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX,
	CURSOR_SDK_EVENT_DEBUG_STDERR_ENV,
	DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
	CursorSdkEventDebugSink,
	attachCursorSdkEventDebugPiStreamTap,
	hashCursorSdkCallId,
	recordDiscardedIncompleteStartedToolCall,
	resolveCursorSdkEventDebugBaseDir,
	resolveCursorSdkEventDebugEnabled,
	serializeDiscardedIncompleteStartedToolCall,
	__testUtils as sdkEventDebugTestUtils,
} from "../src/cursor-sdk-event-debug.js";
import { backfillPiSessionSnapshot, parseDebugProviderEventsArgs } from "../scripts/debug-provider-events.mjs";
import {
	resolveCursorSettingSources,
	serializeCursorSettingSources,
} from "../shared/cursor-setting-sources.mjs";

describe("cursor sdk event debug sink", () => {
	it("is disabled by default", () => {
		expect(resolveCursorSdkEventDebugEnabled({})).toBe(false);
		expect(resolveCursorSdkEventDebugEnabled({ PI_CURSOR_SDK_EVENT_DEBUG: "1" })).toBe(true);
	});

	it("defaults artifact base dir to .debug/cursor-sdk-events", () => {
		expect(resolveCursorSdkEventDebugBaseDir("/repo", {})).toBe(resolve("/repo", ".debug/cursor-sdk-events"));
		expect(resolveCursorSdkEventDebugBaseDir("/repo", { PI_CURSOR_SDK_EVENT_DEBUG_DIR: "tmp/events" })).toBe(
			resolve("/repo", "tmp/events"),
		);
	});

	it("records raw payloads to disk without stderr by default", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-event-debug-"));
		const stderrLines: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stderr.write;

		try {
			const sink = CursorSdkEventDebugSink.maybeCreate({
				cwd: "/repo",
				modelId: "composer-2.5",
				provider: "cursor",
				env: {
					PI_CURSOR_SDK_EVENT_DEBUG: "1",
					PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR: artifactDir,
				},
			});
			expect(sink?.artifactDir).toBe(artifactDir);
			sink?.recordSendMeta({
				mode: "bootstrap",
				reason: "initial",
				resetAgent: false,
				bootstrap: true,
				promptText: "hello",
				imageCount: 0,
				useNativeToolReplay: true,
				bridgeEnabled: false,
				nativeReplayId: "replay-1",
				promptInputTokens: 12,
				agentMode: "agent" as const,
			});
			sink?.recordSendPayload({ text: "hello" });
			sink?.recordPiStreamEvent({ type: "text_delta", delta: "Hi" });
			sink?.recordOnDelta({ type: "text-delta", text: "Hi" });
			sink?.recordOnStep({ type: "toolCall", message: { type: "read" } });
			sink?.recordRunMeta({ runId: "run-1", agentId: "agent-1", status: "running" });
			sink?.recordBridgeDiagnostic({
				event: "run_created",
				runId: "run-1",
				enabled: true,
				exposedToolCount: 1,
				pendingCount: 0,
			});
			sink?.recordDisplayDecision({
				action: "queue_replay",
				disposition: "queue_replay",
				toolName: "grep",
				replayToolId: "cursor-replay-1-tool-1",
			});
			sink?.recordCoordinatorEvent("task_progress", { label: "searching" });
			sink?.recordDrainEvent("turn_end", { outcome: "tool_use" });
			sink?.recordFinalPartial({ role: "assistant", stopReason: "toolUse" });
			sink?.recordWaitResult({ status: "finished", result: "Hi" });
			await sink?.finalize();

			const metadata = JSON.parse(readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.metadata), "utf8"));
			expect(metadata.send.promptText).toBe("hello");
			expect(readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.onDelta), "utf8")).toContain('"text-delta"');
			expect(readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.onStep), "utf8")).toContain('"toolCall"');
			expect(readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.piStreamEvents), "utf8")).toContain(
				'"text_delta"',
			);
			expect(JSON.parse(readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.waitResult), "utf8"))).toMatchObject({
				status: "finished",
			});
			expect(JSON.parse(readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.summary), "utf8"))).toMatchObject({
				artifactDir,
				counts: {
					bridge: { run_created: 1 },
					displayDecisions: { queue_replay: 1 },
					coordinator: { task_progress: 1 },
					drain: { turn_end: 1 },
				},
			});
			expect(readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.timeline), "utf8")).toContain('"layer":"display-decisions"');
			expect(readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.finalPartial), "utf8")).toContain('"toolUse"');
			expect(stderrLines.some((line) => line.includes(CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX))).toBe(false);
		} finally {
			process.stderr.write = originalWrite;
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});

	it("snapshots buffered pi stream and timeline records before later mutations", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-event-debug-snapshot-"));

		try {
			const sink = CursorSdkEventDebugSink.maybeCreate({
				cwd: "/repo",
				modelId: "composer-2.5",
				provider: "cursor",
				env: {
					PI_CURSOR_SDK_EVENT_DEBUG: "1",
					PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR: artifactDir,
				},
			});
			const partial = { role: "assistant" as const, content: [{ type: "text" as const, text: "before" }] };
			const event = { type: "text_delta", delta: "before", partial };

			sink?.recordPiStreamEvent(event);
			event.delta = "after";
			partial.content[0] = { type: "text", text: "after" };
			await sink?.finalize();

			const [piStreamEvent] = readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.piStreamEvents), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(piStreamEvent.event.delta).toBe("before");
			expect(piStreamEvent.event.partial.content[0].text).toBe("before");

			const timelineEvents = readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.timeline), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const piStreamTimelineEvent = timelineEvents.find((event) => event.layer === "pi-stream-events");
			expect(piStreamTimelineEvent.payload.delta).toBe("before");
			expect(piStreamTimelineEvent.payload.partial.content[0].text).toBe("before");
		} finally {
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});

	it("serializes circular and BigInt debug payloads without throwing", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-event-debug-nonthrowing-"));

		try {
			const sink = CursorSdkEventDebugSink.maybeCreate({
				cwd: "/repo",
				modelId: "composer-2.5",
				provider: "cursor",
				env: {
					PI_CURSOR_SDK_EVENT_DEBUG: "1",
					PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR: artifactDir,
				},
			});
			const circular: Record<string, unknown> = { value: 123n };
			circular.self = circular;

			expect(() => sink?.recordPiStreamEvent({ type: "text_delta", payload: circular } as never)).not.toThrow();
			await sink?.finalize();

			const artifact = readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.piStreamEvents), "utf8");
			expect(artifact).toContain('"value":"123"');
			expect(artifact).toContain('"self":"[Circular]"');
		} finally {
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});

	it("never blocks the pi stream when debug recording throws", () => {
		const originalDebug = process.env.PI_CURSOR_SDK_EVENT_DEBUG;
		process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
		try {
			const originalPush = vi.fn();
			const stream = { push: originalPush };
			const sink = { recordPiStreamEvent: () => { throw new Error("debug failed"); } };
			attachCursorSdkEventDebugPiStreamTap(stream as never, { current: sink as never });

			expect(() => stream.push({ type: "text_delta", delta: "still delivered" })).not.toThrow();
			expect(originalPush).toHaveBeenCalledWith({ type: "text_delta", delta: "still delivered" });
		} finally {
			if (originalDebug === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
			else process.env.PI_CURSOR_SDK_EVENT_DEBUG = originalDebug;
		}
	});

	it("bounds cumulative JSONL debug artifacts", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-event-debug-bounded-"));

		try {
			const sink = CursorSdkEventDebugSink.maybeCreate({
				cwd: "/repo",
				modelId: "composer-2.5",
				provider: "cursor",
				env: {
					PI_CURSOR_SDK_EVENT_DEBUG: "1",
					PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR: artifactDir,
				},
			});
			const partial = { role: "assistant", content: [{ type: "text", text: "x".repeat(1024 * 1024) }] };
			for (let index = 0; index < 3; index += 1) {
				sink?.recordPiStreamEvent({ type: "text_delta", delta: "x", partial });
			}
			await sink?.finalize();

			for (const fileName of [sdkEventDebugTestUtils.ARTIFACTS.piStreamEvents, sdkEventDebugTestUtils.ARTIFACTS.timeline]) {
				const path = join(artifactDir, fileName);
				expect(statSync(path).size).toBeLessThanOrEqual(sdkEventDebugTestUtils.MAX_CURSOR_SDK_EVENT_DEBUG_JSONL_BYTES);
				expect(readFileSync(path, "utf8")).toContain('"type":"artifact_truncated"');
			}
			const summary = JSON.parse(readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.summary), "utf8"));
			expect(summary.truncatedJsonlFiles).toEqual([
				sdkEventDebugTestUtils.ARTIFACTS.piStreamEvents,
				sdkEventDebugTestUtils.ARTIFACTS.timeline,
			]);
		} finally {
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});

	it("can opt in to stderr summary output", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-event-debug-"));
		const stderrLines: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stderr.write;

		try {
			const sink = CursorSdkEventDebugSink.maybeCreate({
				cwd: "/repo",
				modelId: "composer-2.5",
				provider: "cursor",
				env: {
					PI_CURSOR_SDK_EVENT_DEBUG: "1",
					PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR: artifactDir,
					PI_CURSOR_SDK_EVENT_DEBUG_STDERR: "1",
				},
			});
			await sink?.finalize();
			expect(stderrLines.some((line) => line.includes(CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX))).toBe(true);
		} finally {
			process.stderr.write = originalWrite;
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});
});

describe("cursor sdk event debug session grouping", () => {
	it("treats a missing pi session snapshot as optional debug data", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-event-debug-missing-session-"));
		const missingSessionFile = join(baseDir, "missing-session.jsonl");
		const { __testUtils: scopeTestUtils } = await import("../src/cursor-session-scope.js");

		sdkEventDebugTestUtils.resetSessionDebugState();
		scopeTestUtils.set(baseDir, missingSessionFile);

		try {
			const sink = CursorSdkEventDebugSink.maybeCreate({
				cwd: baseDir,
				modelId: "composer-2.5",
				provider: "cursor",
				env: {
					PI_CURSOR_SDK_EVENT_DEBUG: "1",
					PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR: join(baseDir, "run"),
				},
			});
			await sink?.finalize();

			const summary = JSON.parse(readFileSync(join(sink!.artifactDir, sdkEventDebugTestUtils.ARTIFACTS.summary), "utf8"));
			expect(summary.piSessionSnapshot).toMatchObject({
				copied: false,
				sessionFile: missingSessionFile,
				reason: "session file not found at debug finalization",
			});
			expect(summary.counts.errors).toBe(0);
		} finally {
			sdkEventDebugTestUtils.resetSessionDebugState();
			scopeTestUtils.reset();
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("groups multiple turns under one pi session directory", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-event-debug-session-"));
		const sessionFile = join(baseDir, "my-session.jsonl");
		const { __testUtils: scopeTestUtils } = await import("../src/cursor-session-scope.js");

		sdkEventDebugTestUtils.resetSessionDebugState();
		scopeTestUtils.set(baseDir, sessionFile);

		try {
			const env = {
				PI_CURSOR_SDK_EVENT_DEBUG: "1",
				PI_CURSOR_SDK_EVENT_DEBUG_DIR: join(baseDir, "events"),
			};
			const sink1 = CursorSdkEventDebugSink.maybeCreate({
				cwd: baseDir,
				modelId: "composer-2.5",
				provider: "cursor",
				env,
			});
			await sink1?.finalize();
			const sink2 = CursorSdkEventDebugSink.maybeCreate({
				cwd: baseDir,
				modelId: "composer-2.5",
				provider: "cursor",
				env,
			});
			await sink2?.finalize();

			expect(sink1?.turn).toBe(1);
			expect(sink2?.turn).toBe(2);
			expect(sink1?.sessionDir).toBe(sink2?.sessionDir);
			expect(sink1?.artifactDir).not.toBe(sink2?.artifactDir);

			const manifest = JSON.parse(
				readFileSync(join(sink1!.sessionDir!, sdkEventDebugTestUtils.SESSION_MANIFEST), "utf8"),
			);
			expect(manifest.turns).toHaveLength(2);
			expect(manifest.sessionFile).toBe(sessionFile);
			expect(manifest.turns[0].summary?.turn).toBe(1);
			expect(manifest.turns[1].summary?.turn).toBe(2);
		} finally {
			sdkEventDebugTestUtils.resetSessionDebugState();
			scopeTestUtils.reset();
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("finalizes the captured session file even if another session binds before finalization", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-debug-binding-"));
		const { __testUtils: scopeTestUtils } = await import("../src/cursor-session-scope.js");
		sdkEventDebugTestUtils.resetSessionDebugState();
		try {
			const sessionA = join(root, "parent.jsonl");
			const sessionB = join(root, "child.jsonl");
			writeFileSync(sessionA, "parent journal\n");
			writeFileSync(sessionB, "child journal\n");
			scopeTestUtils.set(root, sessionA);
			const sink = CursorSdkEventDebugSink.maybeCreate({ cwd: root, modelId: "gpt-5.5", provider: "cursor", env: { PI_CURSOR_SDK_EVENT_DEBUG: "1", PI_CURSOR_SDK_EVENT_DEBUG_DIR: join(root, "events") } });
			scopeTestUtils.set(root, sessionB);
			await sink!.finalize();
			expect(readFileSync(join(sink!.artifactDir, sdkEventDebugTestUtils.ARTIFACTS.piSessionSnapshot), "utf8")).toBe("parent journal\n");
			const manifest = JSON.parse(readFileSync(join(sink!.sessionDir!, sdkEventDebugTestUtils.SESSION_MANIFEST), "utf8"));
			expect(manifest.sessionFile).toBe(sessionA);
			expect(manifest.turns[0].summary.sessionFile).toBe(sessionA);
		} finally {
			sdkEventDebugTestUtils.resetSessionDebugState();
			scopeTestUtils.reset();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps pinned run dirs isolated from session grouping", () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-event-debug-pinned-"));
		sdkEventDebugTestUtils.resetSessionDebugState();
		try {
			const sink = CursorSdkEventDebugSink.maybeCreate({
				cwd: "/repo",
				modelId: "composer-2.5",
				provider: "cursor",
				env: {
					PI_CURSOR_SDK_EVENT_DEBUG: "1",
					PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR: artifactDir,
				},
			});
			expect(sink?.pinnedRun).toBe(true);
			expect(sink?.sessionDir).toBeUndefined();
			expect(sink?.turn).toBeUndefined();
		} finally {
			sdkEventDebugTestUtils.resetSessionDebugState();
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});

	it("continues turn numbering after process restart with an existing session manifest", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-event-debug-resume-"));
		const sessionFile = join(baseDir, "my-session.jsonl");
		const { __testUtils: scopeTestUtils } = await import("../src/cursor-session-scope.js");

		sdkEventDebugTestUtils.resetSessionDebugState();
		scopeTestUtils.set(baseDir, sessionFile);

		try {
			const env = {
				PI_CURSOR_SDK_EVENT_DEBUG: "1",
				PI_CURSOR_SDK_EVENT_DEBUG_DIR: join(baseDir, "events"),
			};
			const sink1 = CursorSdkEventDebugSink.maybeCreate({
				cwd: baseDir,
				modelId: "composer-2.5",
				provider: "cursor",
				env,
			});
			sink1?.recordSendMeta({
				mode: "bootstrap",
				reason: "initial",
				resetAgent: false,
				bootstrap: true,
				promptText: "turn-one",
				imageCount: 0,
				useNativeToolReplay: true,
				bridgeEnabled: false,
				nativeReplayId: "replay-1",
				promptInputTokens: 12,
				agentMode: "agent" as const,
			});
			await sink1?.finalize();

			sdkEventDebugTestUtils.resetSessionDebugState();

			const sink2 = CursorSdkEventDebugSink.maybeCreate({
				cwd: baseDir,
				modelId: "composer-2.5",
				provider: "cursor",
				env,
			});
			sink2?.recordSendMeta({
				mode: "incremental",
				reason: "follow-up",
				resetAgent: false,
				bootstrap: false,
				promptText: "turn-two",
				imageCount: 0,
				useNativeToolReplay: true,
				bridgeEnabled: false,
				nativeReplayId: "replay-2",
				promptInputTokens: 8,
				agentMode: "agent" as const,
			});
			await sink2?.finalize();

			expect(sink1?.turn).toBe(1);
			expect(sink2?.turn).toBe(2);
			expect(sink1?.artifactDir).not.toBe(sink2?.artifactDir);

			const manifest = JSON.parse(
				readFileSync(join(sink1!.sessionDir!, sdkEventDebugTestUtils.SESSION_MANIFEST), "utf8"),
			);
			expect(manifest.turns).toHaveLength(2);
			expect(manifest.turns[0]).toMatchObject({
				turn: 1,
				artifactDir: sink1?.artifactDir,
				summary: { turn: 1, artifactDir: sink1?.artifactDir },
			});
			expect(manifest.turns[1]).toMatchObject({
				turn: 2,
				artifactDir: sink2?.artifactDir,
				summary: { turn: 2, artifactDir: sink2?.artifactDir },
			});
			const turnOneMetadata = JSON.parse(
				readFileSync(join(sink1!.artifactDir, sdkEventDebugTestUtils.ARTIFACTS.metadata), "utf8"),
			);
			const turnTwoMetadata = JSON.parse(
				readFileSync(join(sink2!.artifactDir, sdkEventDebugTestUtils.ARTIFACTS.metadata), "utf8"),
			);
			expect(turnOneMetadata.send.promptText).toBe("turn-one");
			expect(turnTwoMetadata.send.promptText).toBe("turn-two");
		} finally {
			sdkEventDebugTestUtils.resetSessionDebugState();
			scopeTestUtils.reset();
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("clears stale artifacts when reusing a pinned run directory", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-event-debug-reuse-"));
		sdkEventDebugTestUtils.resetSessionDebugState();

		try {
			const env = {
				PI_CURSOR_SDK_EVENT_DEBUG: "1",
				PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR: artifactDir,
			};
			const sink1 = CursorSdkEventDebugSink.maybeCreate({
				cwd: "/repo",
				modelId: "composer-2.5",
				provider: "cursor",
				env,
			});
			sink1?.recordPiStreamEvent({ type: "text_delta", delta: "first-run" });
			await sink1?.finalize();
			expect(readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.piStreamEvents), "utf8")).toContain(
				"first-run",
			);

			const sink2 = CursorSdkEventDebugSink.maybeCreate({
				cwd: "/repo",
				modelId: "composer-2.5",
				provider: "cursor",
				env,
			});
			sink2?.recordPiStreamEvent({ type: "text_delta", delta: "second-run" });
			await sink2?.finalize();

			const piStreamEvents = readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.piStreamEvents), "utf8");
			expect(piStreamEvents).toContain("second-run");
			expect(piStreamEvents).not.toContain("first-run");
			expect(JSON.parse(readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.summary), "utf8"))).toMatchObject({
				counts: { piStream: { text_delta: 1 } },
			});
		} finally {
			sdkEventDebugTestUtils.resetSessionDebugState();
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});
});

describe("discarded incomplete started tool calls", () => {
	it("hashes call ids without exposing raw values", () => {
		expect(hashCursorSdkCallId("secret-call-id-123")).toMatch(/^[a-f0-9]{8}$/);
		expect(hashCursorSdkCallId("secret-call-id-123")).toBe(hashCursorSdkCallId("secret-call-id-123"));
		expect(hashCursorSdkCallId("secret-call-id-123")).not.toBe("secret-call-id-123");
	});

	it("serializes discarded incomplete started tool calls with bounded fields", () => {
		expect(
			serializeDiscardedIncompleteStartedToolCall({
				toolName: "read",
				callId: "call-abc",
			}),
		).toEqual({
			event: "discarded-incomplete-started-tool-call",
			toolName: "read",
			callIdHash: hashCursorSdkCallId("call-abc"),
			reason: DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
		});
	});

	it("records discarded incomplete started tool calls to coordinator-events.jsonl without stderr by default", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-discarded-debug-"));
		const stderrLines: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stderr.write;

		try {
			const sink = CursorSdkEventDebugSink.maybeCreate({
				cwd: "/repo",
				modelId: "composer-2.5",
				provider: "cursor",
				env: {
					PI_CURSOR_SDK_EVENT_DEBUG: "1",
					PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR: artifactDir,
				},
			});
			recordDiscardedIncompleteStartedToolCall(
				sink,
				{ [CURSOR_SDK_EVENT_DEBUG_ENV]: "1" },
				{ toolName: "read", callId: "call-abc" },
			);
			await sink?.finalize();

			const coordinatorEvents = readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.coordinatorEvents), "utf8");
			expect(coordinatorEvents).toContain('"phase":"discarded-incomplete-started-tool-call"');
			expect(coordinatorEvents).toContain('"toolName":"read"');
			expect(coordinatorEvents).toContain(`"callIdHash":"${hashCursorSdkCallId("call-abc")}"`);
			expect(coordinatorEvents).toContain(`"reason":"${DISCARDED_INCOMPLETE_TOOL_CALL_REASON}"`);
			expect(coordinatorEvents).not.toContain("call-abc");
			expect(stderrLines.some((line) => line.includes("discarded-incomplete-started-tool-call"))).toBe(false);
		} finally {
			process.stderr.write = originalWrite;
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});

	it("can opt in to stderr output for discarded incomplete started tool calls", () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			recordDiscardedIncompleteStartedToolCall(undefined, {}, { toolName: "read", callId: "call-abc" });
			expect(stderr).not.toHaveBeenCalled();

			recordDiscardedIncompleteStartedToolCall(
				undefined,
				{ [CURSOR_SDK_EVENT_DEBUG_ENV]: "1", [CURSOR_SDK_EVENT_DEBUG_STDERR_ENV]: "1" },
				{ toolName: "read", callId: "call-abc" },
			);
			expect(stderr).toHaveBeenCalledOnce();
			const line = String(stderr.mock.calls[0]?.[0]);
			expect(line.startsWith(`${CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX} `)).toBe(true);
			expect(line).toContain('"event":"discarded-incomplete-started-tool-call"');
			expect(line).toContain('"toolName":"read"');
			expect(line).toContain(`"callIdHash":"${hashCursorSdkCallId("call-abc")}"`);
			expect(line).toContain(`"reason":"${DISCARDED_INCOMPLETE_TOOL_CALL_REASON}"`);
			expect(line).not.toContain("call-abc");
		} finally {
			stderr.mockRestore();
		}
	});
});

describe("debug-provider-events maintainer probe", () => {
	it("backfills a missing pi session snapshot after pi exits", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-cursor-debug-provider-backfill-"));
		const artifactDir = join(baseDir, "artifacts");
		const sessionDir = join(baseDir, "session");
		const sessionFile = join(sessionDir, "session.jsonl");
		try {
			mkdirSync(artifactDir, { recursive: true });
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(sessionFile, '{"type":"session"}\n');
			const summary = {
				artifactDir,
				sessionFile,
				counts: { errors: 0 },
				piSessionSnapshot: {
					copied: false,
					sessionFile,
					reason: "session file not found at debug finalization",
				},
			};
			writeFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.summary), `${JSON.stringify(summary, null, 2)}\n`);

			const updated = backfillPiSessionSnapshot(summary, artifactDir, sessionDir);

			expect(updated).toBeDefined();
			expect(updated!.piSessionSnapshot).toMatchObject({
				copied: true,
				sessionFile,
				recoveredAfterChildExit: true,
			});
			expect(readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.piSessionSnapshot), "utf8")).toContain(
				'"type":"session"',
			);
			expect(readFileSync(join(sessionDir, "pi-session.jsonl"), "utf8")).toContain('"type":"session"');
			expect(JSON.parse(readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.summary), "utf8"))).toMatchObject({
				piSessionSnapshot: { copied: true, recoveredAfterChildExit: true },
			});
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("leaves missing pi session snapshots optional when the file never appears", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-cursor-debug-provider-backfill-missing-"));
		const artifactDir = join(baseDir, "artifacts");
		const sessionDir = join(baseDir, "session");
		const sessionFile = join(sessionDir, "missing.jsonl");
		try {
			const summary = {
				artifactDir,
				counts: { errors: 0 },
				piSessionSnapshot: {
					copied: false,
					sessionFile,
					reason: "session file not found at debug finalization",
				},
			};

			const updated = backfillPiSessionSnapshot(summary, artifactDir, sessionDir);

			expect(updated).toBe(summary);
			expect(existsSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.piSessionSnapshot))).toBe(false);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("parses args and prompt file overrides", () => {
		expect(
			parseDebugProviderEventsArgs(["--cwd", "/tmp/work", "--model", "cursor/composer-2.5", "--prompt", "hello"], {
				CURSOR_API_KEY: "key",
			}),
		).toMatchObject({
			cwd: resolve("/tmp/work"),
			model: "cursor/composer-2.5",
			prompt: "hello",
			apiKey: "key",
		});
	});

	it("forwards explicit --setting-sources none to child pi env", () => {
		const args = parseDebugProviderEventsArgs(
			["--prompt", "hello", "--setting-sources", "none"],
			{ CURSOR_API_KEY: "key" },
		);
		expect(args.settingSources).toBeUndefined();
		expect(serializeCursorSettingSources(args.settingSources)).toBe("none");
	});

	it("does not re-enable all when comma-only setting sources round-trip through child env", () => {
		const args = parseDebugProviderEventsArgs(
			["--prompt", "hello", "--setting-sources", "  ,  "],
			{ CURSOR_API_KEY: "key" },
		);
		expect(args.settingSources).toBeUndefined();
		const forwarded = serializeCursorSettingSources(args.settingSources);
		expect(forwarded).toBe("none");
		expect(resolveCursorSettingSources(forwarded)).toBeUndefined();
	});
});
