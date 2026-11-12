import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	CURSOR_SDK_EVENT_DEBUG_ENV,
	CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX,
	CURSOR_SDK_EVENT_DEBUG_STDERR_ENV,
	DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
	CursorSdkEventDebugSink,
	attachCursorSdkEventDebugPiStreamTap,
	recordDiscardedIncompleteStartedToolCall,
	resolveCursorSdkEventDebugBaseDir,
	resolveCursorSdkEventDebugEnabled,
	__testUtils as sdkEventDebugTestUtils,
} from "../src/cursor-sdk-event-debug.js";
import { backfillPiSessionSnapshot, parseDebugProviderEventsArgs } from "../scripts/debug-provider-events.mjs";
import { DEFAULT_CHILD_SHUTDOWN_GRACE_MS } from "../scripts/lib/cursor-child-process.mjs";
import {
	resolveCursorSettingSources,
	serializeCursorSettingSources,
} from "../shared/cursor-setting-sources.mjs";

function createPinnedRunSink(prefix: string) {
	const artifactDir = mkdtempSync(join(tmpdir(), prefix));
	onTestFinished(() => rmSync(artifactDir, { recursive: true, force: true }));
	const sink = CursorSdkEventDebugSink.maybeCreate({
		cwd: "/repo",
		modelId: "composer-2.5",
		provider: "cursor",
		env: {
			PI_CURSOR_SDK_EVENT_DEBUG: "1",
			PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR: artifactDir,
		},
	})!;
	const artifactPath = (name: keyof typeof sdkEventDebugTestUtils.ARTIFACTS) =>
		join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS[name]);
	return { sink, artifactPath };
}

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

	it.each([false, true])("records raw payloads to disk with stderr summary enabled=%s", async (stderrEnabled) => {
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
					...(stderrEnabled ? { PI_CURSOR_SDK_EVENT_DEBUG_STDERR: "1" } : {}),
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
			expect(stderrLines.some((line) => line.includes(CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX))).toBe(stderrEnabled);
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

	it("reports a failed wait-result write without replacing it with a later fallback result", async () => {
		const { sink, artifactPath } = createPinnedRunSink("pi-cursor-sdk-event-debug-wait-result-");
		// A directory at the artifact path makes the real wait-result write fail.
		mkdirSync(artifactPath("waitResult"));
		sink.recordWaitResult({ status: "finished" });
		rmSync(artifactPath("waitResult"), { recursive: true });
		sink.recordWaitResult({ status: "error", error: "fallback after the finished result" });
		await sink.finalize();

		expect(existsSync(artifactPath("waitResult"))).toBe(false);
		expect(JSON.parse(readFileSync(artifactPath("summary"), "utf8"))).toMatchObject({
			waitResultRecorded: false,
			counts: { errors: 1, timeline: { "errors:wait_result": 1 } },
		});
		const [errorRecord] = readFileSync(artifactPath("errors"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(errorRecord.error.label).toBe("wait_result");
	});

	it("waits for its owned stream capture, then ignores records after finalization", async () => {
		const { sink, artifactPath } = createPinnedRunSink("pi-cursor-sdk-event-debug-cutoff-");
		let releaseLateStreamEvent!: () => void;
		const lateStreamEventReleased = new Promise<void>((resolve) => {
			releaseLateStreamEvent = resolve;
		});
		sink.attachRunStream({
			id: "run-owned-stream",
			stream: async function* () {
				yield { type: "assistant", text: "early" };
				await lateStreamEventReleased;
				yield { type: "assistant", text: "late" };
			},
		});

		const finalization = sink.finalize();
		sink.recordProviderEvent("while_finalizing", {});
		await new Promise((resolve) => setImmediate(resolve));
		expect(existsSync(artifactPath("summary"))).toBe(false);

		releaseLateStreamEvent();
		await finalization;
		const summary = readFileSync(artifactPath("summary"), "utf8");
		const providerEvents = readFileSync(artifactPath("providerEvents"), "utf8");
		expect(JSON.parse(summary)).toMatchObject({
			counts: { stream: { assistant: 2 }, provider: { while_finalizing: 1 } },
		});
		expect(readFileSync(artifactPath("streamEvents"), "utf8")).toContain('"late"');

		sink.recordProviderEvent("after_finalization", {});
		sink.recordWaitResult({ status: "finished" });
		sink.recordFinalPartial({ role: "assistant" });
		await sink.finalize();

		expect(readFileSync(artifactPath("summary"), "utf8")).toBe(summary);
		expect(readFileSync(artifactPath("providerEvents"), "utf8")).toBe(providerEvents);
		expect(existsSync(artifactPath("waitResult"))).toBe(false);
		expect(existsSync(artifactPath("finalPartial"))).toBe(false);
	});

	it("keeps a failed finalization rejected without retrying or writing later records", async () => {
		const { sink, artifactPath } = createPinnedRunSink("pi-cursor-sdk-event-debug-failed-finalize-");
		// A directory at the summary path makes the real summary write fail.
		mkdirSync(artifactPath("summary"));
		sink.recordPiStreamEvent({ type: "text_delta", delta: "before" });

		const failure = await sink.finalize().then(() => undefined, (error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		const flushedPiStreamEvents = readFileSync(artifactPath("piStreamEvents"), "utf8");
		expect(flushedPiStreamEvents).toContain('"before"');

		sink.recordPiStreamEvent({ type: "text_delta", delta: "after" });
		sink.recordWaitResult({ status: "finished" });
		sink.recordFinalPartial({ role: "assistant" });
		rmSync(artifactPath("summary"), { recursive: true });
		await expect(sink.finalize()).rejects.toBe(failure);

		expect(existsSync(artifactPath("summary"))).toBe(false);
		expect(readFileSync(artifactPath("piStreamEvents"), "utf8")).toBe(flushedPiStreamEvents);
		expect(existsSync(artifactPath("waitResult"))).toBe(false);
		expect(existsSync(artifactPath("finalPartial"))).toBe(false);
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
			expect(JSON.parse(coordinatorEvents.trim())).toMatchObject({
				phase: "discarded-incomplete-started-tool-call",
				payload: {
					event: "discarded-incomplete-started-tool-call",
					toolName: "read",
					callIdHash: "313d0c18",
					reason: DISCARDED_INCOMPLETE_TOOL_CALL_REASON,
				},
			});
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
			expect(line).toContain('"callIdHash":"313d0c18"');
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

	const isRunning = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	// Runs main() minus ensureBuilt() in its own process, because failures call process.exit(1),
	// with a fake Pi RPC child as `pi` on PATH. POSIX only: spawn("pi") cannot launch a script
	// shim on Windows without a shell.
	const startDebugProviderEventsRun = (env: NodeJS.ProcessEnv = {}) => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-cursor-debug-provider-held-output-"));
		const bin = join(baseDir, "bin");
		const out = join(baseDir, "artifacts");
		const launchesPath = join(baseDir, "pi-launches");
		const pidsPath = join(baseDir, "pids");
		const fakePi = join(baseDir, "fake-pi.cjs");
		mkdirSync(bin);
		// Pi RPC stand-in: settles the prompt with a complete capture and leaves a descendant on its
		// stdout/stderr. Like Pi's RPC mode, it disposes for a while after stdin EOF and exits 143 on
		// SIGTERM; here disposal outlasts the default termination grace.
		writeFileSync(fakePi, `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf("\\n"); index >= 0; index = buffer.indexOf("\\n")) {
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (command.type !== "prompt") continue;
    const runDir = process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
    writeFileSync(join(runDir, "summary.json"), JSON.stringify({ artifactDir: runDir, artifacts: {}, counts: { errors: 0 }, elapsedMs: 1, waitResultRecorded: true }));
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
    writeFileSync(${JSON.stringify(pidsPath)}, process.pid + " " + descendant.pid);
    process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), ${DEFAULT_CHILD_SHUTDOWN_GRACE_MS + 1_000}));
process.on("SIGTERM", () => process.exit(143));
`);
		const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		writeFileSync(join(bin, "pi"), `#!/bin/sh\necho launched >> ${shellQuote(launchesPath)}\nexec ${shellQuote(process.execPath)} ${shellQuote(fakePi)}\n`, { mode: 0o755 });
		const moduleUrl = pathToFileURL(resolve("scripts/debug-provider-events.mjs")).href;
		const driver = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { parseDebugProviderEventsArgs, runDebugProviderEvents } from ${JSON.stringify(moduleUrl)};
console.log(JSON.stringify(await runDebugProviderEvents(parseDebugProviderEventsArgs(process.argv.slice(1)))));`,
				"--",
				...["--cwd", baseDir, "--out", out, "--model", "cursor/test", "--prompt", "hello", "--api-key", "test-dummy-key"],
			],
			{ env: { PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: baseDir, ...env }, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		driver.stdout.setEncoding("utf8");
		driver.stderr.setEncoding("utf8");
		driver.stdout.on("data", (chunk: string) => { stdout += chunk; });
		driver.stderr.on("data", (chunk: string) => { stderr += chunk; });
		const closed = new Promise<number | null>((resolveClose) => driver.once("close", resolveClose));
		const piAndDescendantPids = () => (existsSync(pidsPath) ? readFileSync(pidsPath, "utf8").split(" ").map(Number) : []);
		return {
			out,
			exitCodeWithin: (ms: number) => Promise.race([closed, delay(ms, "still running")]),
			stdout: () => stdout,
			stderr: () => stderr,
			piLaunched: () => existsSync(launchesPath),
			piAndDescendantPids,
			async cleanup() {
				for (const pid of piAndDescendantPids()) if (isRunning(pid)) process.kill(pid, "SIGKILL");
				driver.kill("SIGKILL");
				await Promise.race([closed, delay(10_000)]);
				rmSync(baseDir, { recursive: true, force: true });
			},
		};
	};

	it.skipIf(process.platform === "win32")("returns the capture after pi's own shutdown and terminates a descendant still holding pi's output", async () => {
		const run = startDebugProviderEventsRun();
		try {
			expect(await run.exitCodeWithin(15_000)).toBe(0);
			expect(JSON.parse(run.stdout())).toMatchObject({ artifactDir: run.out, counts: { errors: 0 }, waitResultRecorded: true });
			expect(run.piAndDescendantPids().map(isRunning)).toEqual([false, false]);
		} finally {
			await run.cleanup();
		}
	}, 40_000);

	it.skipIf(process.platform === "win32")("waits for pi's own shutdown when PI_PROVIDER_EVENT_DEBUG_TIMEOUT_MS exceeds Node's timer limit", async () => {
		const run = startDebugProviderEventsRun({ PI_PROVIDER_EVENT_DEBUG_TIMEOUT_MS: String(2 ** 31) });
		try {
			expect(await run.exitCodeWithin(15_000)).toBe(0);
			expect(run.piAndDescendantPids().map(isRunning)).toEqual([false, false]);
		} finally {
			await run.cleanup();
		}
	}, 40_000);

	it.skipIf(process.platform === "win32")("rejects a non-finite PI_PROVIDER_EVENT_DEBUG_TIMEOUT_MS before creating artifacts or launching pi", async () => {
		const run = startDebugProviderEventsRun({ PI_PROVIDER_EVENT_DEBUG_TIMEOUT_MS: "10m" });
		try {
			expect(await run.exitCodeWithin(15_000)).toBe(1);
			expect(run.stderr()).toContain("PI_PROVIDER_EVENT_DEBUG_TIMEOUT_MS must be a finite number of milliseconds");
			// The run creates its artifact directory before spawning pi, so this is the ordering
			// proof; a pi launched just before process.exit(1) may not have written its marker yet.
			expect(existsSync(run.out)).toBe(false);
			expect(run.piLaunched()).toBe(false);
		} finally {
			await run.cleanup();
		}
	}, 40_000);

	it("parses provider probe prompt and option overrides", () => {
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

	it.each(["none", "  ,  "])("keeps disabled setting sources %j disabled through child env", (sources) => {
		const args = parseDebugProviderEventsArgs(
			["--prompt", "hello", "--setting-sources", sources],
			{ CURSOR_API_KEY: "key" },
		);
		expect(args.settingSources).toBeUndefined();
		const forwarded = serializeCursorSettingSources(args.settingSources);
		expect(forwarded).toBe("none");
		expect(resolveCursorSettingSources(forwarded)).toBeUndefined();
	});
});
