import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX,
	CursorSdkEventDebugSink,
	resolveCursorSdkEventDebugBaseDir,
	resolveCursorSdkEventDebugEnabled,
	__testUtils as sdkEventDebugTestUtils,
} from "../src/cursor-sdk-event-debug.js";
import { parseDebugProviderEventsArgs } from "../scripts/debug-provider-events.mjs";

describe("cursor sdk event debug sink", () => {
	it("is disabled by default", () => {
		expect(resolveCursorSdkEventDebugEnabled({})).toBe(false);
		expect(resolveCursorSdkEventDebugEnabled({ PI_CURSOR_SDK_EVENT_DEBUG: "1" })).toBe(true);
	});

	it("defaults artifact base dir to .debug/cursor-sdk-events", () => {
		expect(resolveCursorSdkEventDebugBaseDir("/repo", {})).toBe("/repo/.debug/cursor-sdk-events");
		expect(resolveCursorSdkEventDebugBaseDir("/repo", { PI_CURSOR_SDK_EVENT_DEBUG_DIR: "tmp/events" })).toBe(
			"/repo/tmp/events",
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

describe("debug-provider-events maintainer probe", () => {
	it("parses args and prompt file overrides", () => {
		expect(
			parseDebugProviderEventsArgs(["--cwd", "/tmp/work", "--model", "cursor/composer-2.5", "--prompt", "hello"], {
				CURSOR_API_KEY: "key",
			}),
		).toMatchObject({
			cwd: "/tmp/work",
			model: "cursor/composer-2.5",
			prompt: "hello",
			apiKey: "key",
		});
	});
});
