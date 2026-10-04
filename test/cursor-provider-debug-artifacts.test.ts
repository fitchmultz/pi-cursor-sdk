import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState,
	makeModel,
	makeContext,
	collectEvents,
	getDoneEvent,
	getErrorEvent,
	type CursorDeltaHandler,
	type RegisteredTool,
	mockCreatedAgent,
	asMockCursorRun,
	registerNativeToolDisplayForTest,
	createPiHarness,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { registerCursorRuntimeControls } from "../src/cursor-state.js";
import { registerCursorSessionScope } from "../src/cursor-session-scope.js";
import { CursorSdkEventDebugSink, __testUtils as sdkEventDebugTestUtils } from "../src/cursor-sdk-event-debug.js";
import type { SDKMessage } from "@cursor/sdk";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function setCursorModeForProviderDebugTest(mode: "agent" | "plan", existing?: ReturnType<typeof createPiHarness>) {
	const pi = existing ?? createPiHarness();
	if (!existing) {
		registerCursorSessionScope(pi);
		registerCursorRuntimeControls(pi);
	}
	pi.getFlag.mockImplementation((name) => name === "cursor-mode" ? mode : undefined);
	await pi.runSessionStart({ model: makeModel("gpt-5.5@1m") });
	return pi;
}

describe("streamCursor debug artifacts", () => {
	beforeEach(resetCursorProviderTestState);

		it("captures provider debug artifacts through streamCursor when enabled", async () => {
			const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-provider-debug-"));
			const previousDebug = process.env.PI_CURSOR_SDK_EVENT_DEBUG;
			const previousRunDir = process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
			process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
			process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = artifactDir;

			try {
				const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
					opts.onDelta({ update: { type: "text-delta", text: "debugged" } });
					return asMockCursorRun({
						id: "run-debug",
						requestId: "request-debug",
						agentId: "agent-debug",
						status: "finished",
						wait: vi.fn().mockResolvedValue({ id: "run-debug", requestId: "request-debug", status: "finished" }),
						cancel: vi.fn(),
						supports: () => false,
						unsupportedReason: () => "conversation unsupported",
						stream: async function* () {
							yield { type: "assistant", message: { content: [{ type: "text", text: "debugged" }] } } as SDKMessage;
						},
					});
				});
				mockCreatedAgent({
					send: mockSend,
					[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
				});

				await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));

				expect(readFileSync(join(artifactDir, "on-delta.jsonl"), "utf8")).toContain('"text-delta"');
				expect(readFileSync(join(artifactDir, "pi-stream-events.jsonl"), "utf8")).toContain('"text_delta"');
				expect(readFileSync(join(artifactDir, "stream-events.jsonl"), "utf8")).toContain('"assistant"');
				expect(JSON.parse(readFileSync(join(artifactDir, "metadata.json"), "utf8"))).toMatchObject({
					run: { runId: "run-debug", requestId: "request-debug" },
				});
				expect(readFileSync(join(artifactDir, "provider-events.jsonl"), "utf8")).toContain("request-debug");
				expect(JSON.parse(readFileSync(join(artifactDir, "summary.json"), "utf8"))).toMatchObject({
					artifactDir,
					waitResultRecorded: true,
				});
			} finally {
				if (previousDebug === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
				else process.env.PI_CURSOR_SDK_EVENT_DEBUG = previousDebug;
				if (previousRunDir === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
				else process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = previousRunDir;
				rmSync(artifactDir, { recursive: true, force: true });
			}
		});

		it("records Cursor agent mode in provider debug metadata", async () => {
			const firstSend = vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
			mockCreatedAgent({
				send: firstSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});
			const pi = await setCursorModeForProviderDebugTest("agent");
			await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

			const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-provider-mode-debug-"));
			const previousDebug = process.env.PI_CURSOR_SDK_EVENT_DEBUG;
			const previousRunDir = process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
			process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
			process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = artifactDir;
			try {
				await setCursorModeForProviderDebugTest("plan", pi);
				await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

				const metadata = JSON.parse(readFileSync(join(artifactDir, "metadata.json"), "utf8"));
				expect(metadata.providerMeta).toMatchObject({ agentMode: "plan" });
				expect(metadata.send).toMatchObject({ agentMode: "plan" });
			} finally {
				if (previousDebug === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
				else process.env.PI_CURSOR_SDK_EVENT_DEBUG = previousDebug;
				if (previousRunDir === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
				else process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = previousRunDir;
				rmSync(artifactDir, { recursive: true, force: true });
			}
		});

		it("records continuation drain artifacts on the next turn debug sink", async () => {
			const previousNativeDisplay = process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
			process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
			const registeredTools: RegisteredTool[] = [];
			await registerNativeToolDisplayForTest(registeredTools);

			const baseDir = mkdtempSync(join(tmpdir(), "pi-cursor-provider-debug-continuation-"));
			const sessionFile = join(baseDir, "session.jsonl");
			const eventsDir = join(baseDir, "events");
			const previousDebug = process.env.PI_CURSOR_SDK_EVENT_DEBUG;
			const previousDebugDir = process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR;
			const { __testUtils: scopeTestUtils } = await import("../src/cursor-session-scope.js");

			sdkEventDebugTestUtils.resetSessionDebugState();
			scopeTestUtils.set(baseDir, sessionFile);
			process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
			process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR = eventsDir;

			let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
			const runWait = vi.fn(
				() =>
					new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
						resolveRun = resolve;
					}),
			);
			let firstOnDelta: CursorDeltaHandler | undefined;
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				firstOnDelta = opts.onDelta;
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "c1" } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "bash",
							result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } },
						},
						callId: "c1",
					},
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "running",
					wait: runWait,
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				agentId: "agent-1",
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			try {
				const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
				expect(getDoneEvent(firstEvents).reason).toBe("toolUse");

				firstOnDelta?.({ update: { type: "text-delta", text: "Late scoped text." } });
				const secondEventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
				await Promise.resolve();
				resolveRun({ id: "run-1", status: "finished", result: "Late scoped final." });
				await secondEventsPromise;

				const sessionSlug = sdkEventDebugTestUtils.slugSessionKey(sessionFile);
				const manifest = JSON.parse(
					readFileSync(join(eventsDir, "sessions", sessionSlug, sdkEventDebugTestUtils.SESSION_MANIFEST), "utf8"),
				);
				expect(manifest.turns).toHaveLength(2);

				const parseDrainPhases = (artifactDir: string): string[] =>
					readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.drainEvents), "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line).phase as string);

				expect(parseDrainPhases(manifest.turns[0].artifactDir)).toContain("turn_end");
				expect(parseDrainPhases(manifest.turns[1].artifactDir)).toEqual(
					expect.arrayContaining(["pre_send_start", "turn_start", "turn_end", "pre_send_end"]),
				);
			} finally {
				sdkEventDebugTestUtils.resetSessionDebugState();
				scopeTestUtils.reset();
				if (previousDebug === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
				else process.env.PI_CURSOR_SDK_EVENT_DEBUG = previousDebug;
				if (previousDebugDir === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR;
				else process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR = previousDebugDir;
				if (previousNativeDisplay === undefined) delete process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
				else process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = previousNativeDisplay;
				rmSync(baseDir, { recursive: true, force: true });
			}
		});

		it("records turn_end and pre_send_end when aborting during live-run progress wait", async () => {
			const previousNativeDisplay = process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
			process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
			const registeredTools: RegisteredTool[] = [];
			await registerNativeToolDisplayForTest(registeredTools);

			const baseDir = mkdtempSync(join(tmpdir(), "pi-cursor-provider-debug-abort-"));
			const sessionFile = join(baseDir, "session.jsonl");
			const eventsDir = join(baseDir, "events");
			const previousDebug = process.env.PI_CURSOR_SDK_EVENT_DEBUG;
			const previousDebugDir = process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR;
			const { __testUtils: scopeTestUtils } = await import("../src/cursor-session-scope.js");

			sdkEventDebugTestUtils.resetSessionDebugState();
			scopeTestUtils.set(baseDir, sessionFile);
			process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
			process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR = eventsDir;

			const controller = new AbortController();
			let firstOnDelta: CursorDeltaHandler | undefined;
			const runWait = vi.fn(() => new Promise<{ id: string; status: "finished"; result: string }>(() => {}));
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				firstOnDelta = opts.onDelta;
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "c1" } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "bash",
							result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } },
						},
						callId: "c1",
					},
				});
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "running",
					wait: runWait,
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				agentId: "agent-1",
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const parseDrainEvents = (artifactDir: string): Array<{ phase: string; payload?: { outcome?: string; reason?: string } }> =>
				readFileSync(join(artifactDir, sdkEventDebugTestUtils.ARTIFACTS.drainEvents), "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));

			try {
				const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
				expect(getDoneEvent(firstEvents).reason).toBe("toolUse");

				firstOnDelta?.({ update: { type: "text-delta", text: "Late scoped text." } });
				const secondEventsPromise = collectEvents(
					streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal }),
				);
				await Promise.resolve();
				controller.abort();
				const secondEvents = await secondEventsPromise;
				expect(getErrorEvent(secondEvents).reason).toBe("aborted");

				const sessionSlug = sdkEventDebugTestUtils.slugSessionKey(sessionFile);
				const manifest = JSON.parse(
					readFileSync(join(eventsDir, "sessions", sessionSlug, sdkEventDebugTestUtils.SESSION_MANIFEST), "utf8"),
				);
				expect(manifest.turns).toHaveLength(2);

				const drainEvents = parseDrainEvents(manifest.turns[1].artifactDir);
				expect(drainEvents.map((event) => event.phase)).toEqual(
					expect.arrayContaining(["pre_send_start", "turn_start", "turn_end", "pre_send_end"]),
				);
				expect(drainEvents.find((event) => event.phase === "turn_end")?.payload).toMatchObject({ outcome: "aborted", reason: "signal_aborted" });
				expect(drainEvents.find((event) => event.phase === "pre_send_end")?.payload).toMatchObject({ outcome: "aborted", reason: "signal_aborted" });
			} finally {
				sdkEventDebugTestUtils.resetSessionDebugState();
				scopeTestUtils.reset();
				if (previousDebug === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
				else process.env.PI_CURSOR_SDK_EVENT_DEBUG = previousDebug;
				if (previousDebugDir === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR;
				else process.env.PI_CURSOR_SDK_EVENT_DEBUG_DIR = previousDebugDir;
				if (previousNativeDisplay === undefined) delete process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
				else process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = previousNativeDisplay;
				rmSync(baseDir, { recursive: true, force: true });
			}
		});

		it("keeps a returned cloud run owned when post-send debug writes throw", async () => {
			const artifactDir = mkdtempSync(join(tmpdir(), "pi-cursor-provider-debug-throw-"));
			const previousDebug = process.env.PI_CURSOR_SDK_EVENT_DEBUG;
			const previousRunDir = process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
			process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
			process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = artifactDir;
			process.env.PI_CURSOR_RUNTIME = "cloud";
			process.env.PI_CURSOR_CLOUD_ACK = "1";
			process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
			const wait = vi.fn().mockResolvedValue({ id: "run-cloud-debug", status: "finished", result: "done" });
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));
			const recordRunMetaSpy = vi.spyOn(CursorSdkEventDebugSink.prototype, "recordRunMeta").mockImplementation(() => {
				throw new Error("debug disk full");
			});
			try {
				mockCreatedAgent({
					agentId: "bc-00000000-0000-0000-0000-000000000001",
					send: vi.fn().mockResolvedValue(asMockCursorRun({
						id: "run-cloud-debug",
						agentId: "bc-00000000-0000-0000-0000-000000000001",
						status: "finished",
						wait,
					})),
				});

				const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));

				expect(getDoneEvent(events).message.stopReason).toBe("stop");
				expect(wait).toHaveBeenCalledTimes(1);
			} finally {
				recordRunMetaSpy.mockRestore();
				fetchSpy.mockRestore();
				if (previousDebug === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
				else process.env.PI_CURSOR_SDK_EVENT_DEBUG = previousDebug;
				if (previousRunDir === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
				else process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = previousRunDir;
				delete process.env.PI_CURSOR_RUNTIME;
				delete process.env.PI_CURSOR_CLOUD_ACK;
				delete process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE;
				rmSync(artifactDir, { recursive: true, force: true });
			}
		});
});
