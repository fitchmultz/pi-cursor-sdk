import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asMockCursorRun, asMockSdkAgent, collectEvents, createPiHarness, makeContext, makeModel, mockedCreate, resetCursorProviderTestState } from "./helpers/cursor-provider-harness.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";
import type { PiHarness } from "./helpers/pi-harness.js";
import { getCursorSessionScopeSnapshot, registerCursorSessionScope } from "../src/cursor-session-scope.js";
import { streamCursor } from "../src/cursor-provider.js";
import { registerCursorNativeToolDisplayState } from "../src/cursor-native-tool-display-state.js";
import { captureProviderTestOwnership } from "./helpers/cursor-provider-ownership.js";
import { acquireSessionCursorAgent } from "../src/cursor-session-agent.js";
import { registerCursorSessionAgentLifecycle } from "../src/cursor-session-agent-lifecycle.js";
import { registerCursorSessionAgentLineage } from "../src/cursor-session-agent-lineage.js";
import { registerCursorSessionAgentResume, persistCursorSessionAgentResumeHandle } from "../src/cursor-session-agent-resume.js";
import { captureCursorCloudLifecycleRecorder, registerCursorCloudLifecycleLedger } from "../src/cursor-cloud-lifecycle.js";
import { configureCursorSdkHttp1 } from "../src/cursor-http1.js";

const sessions: PiHarness[] = [];
const scopeA = { cwd: "/tmp/cursor-session-a", file: "/tmp/cursor-session-a.jsonl", id: "session-a", name: "Parent" };
const scopeB = { cwd: "/tmp/cursor-session-b", file: "/tmp/cursor-session-b.jsonl", id: "session-b", name: "Child" };
function binding() {
	const pi = createPiHarness();
	registerCursorSessionScope(pi);
	registerCursorNativeToolDisplayState(pi);
	registerCursorSessionAgentLifecycle(pi);
	registerCursorSessionAgentLineage(pi);
	registerCursorSessionAgentResume(pi);
	sessions.push(pi);
	return pi;
}
async function start(pi: PiHarness, scope = scopeA) {
	await pi.runSessionStart({ cwd: scope.cwd, sessionManager: { getSessionFile: () => scope.file, getSessionId: () => scope.id, getSessionName: () => scope.name } });
}
function agentParams(scope = scopeA) {
	return { apiKey: "test-key", agentMode: "agent" as const, cwd: scope.cwd, modelSelection: { id: "gpt-5.5" } };
}
function completedAgent() {
	return asMockSdkAgent({ send: vi.fn(async (_payload, options) => {
		options?.onDelta?.({ update: { type: "text-delta", text: "Session A" } });
		return asMockCursorRun({ id: "run-a", agentId: "agent-a", status: "finished", wait: vi.fn().mockResolvedValue({ status: "finished", result: "Session A" }) });
	}) });
}
beforeEach(resetCursorProviderTestState);
afterEach(async () => { for (const pi of sessions.splice(0)) await pi.runSessionShutdown({ reason: "quit" }); });

describe("owned session snapshots and cleanup", () => {
	it("keeps A's frozen snapshot when B binds and changes its name", async () => {
		const a = binding();
		await start(a);
		const snapshot = getCursorSessionScopeSnapshot(a);
		const b = binding();
		await start(b, scopeB);
		await b.invokeEvent("session_info_changed", { type: "session_info_changed", name: "Renamed child" });
		expect(snapshot).toMatchObject({ cwd: scopeA.cwd, scopeKey: scopeA.file, sessionId: scopeA.id, sessionName: scopeA.name });
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(getCursorSessionScopeSnapshot(a)).toEqual(snapshot);
		expect(getCursorSessionScopeSnapshot(b).sessionName).toBe("Renamed child");
	});

	it("threads A's entry snapshot through asynchronous create and persists lineage only to A", async () => {
		const a = binding();
		await start(a);
		const enteredCreate = Promise.withResolvers<void>();
		const releaseCreate = Promise.withResolvers<ReturnType<typeof completedAgent>>();
		mockedCreate.mockImplementationOnce(async () => { enteredCreate.resolve(); return releaseCreate.promise; });
		const { openedOptions } = installCursorSessionStoreMock();
		const eventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }, captureProviderTestOwnership(makeModel(), makeContext(), getCursorSessionScopeSnapshot(a), a)));
		await enteredCreate.promise;
		const b = binding();
		await start(b, scopeB);
		releaseCreate.resolve(completedAgent());
		const events = await eventsPromise;
		expect(events.at(-1)?.type).toBe("done");
		expect(mockedCreate.mock.calls[0]?.[0]?.local).toMatchObject({ cwd: scopeA.cwd });
		expect(openedOptions[0]?.workspaceRef).toBe(scopeA.cwd);
		expect(a.appendEntry).toHaveBeenCalledWith("cursor-sdk-agent-lineage", expect.objectContaining({ sessionId: scopeA.id, scopeKey: scopeA.file }));
		expect(b.appendEntry).not.toHaveBeenCalled();
	});

	it("isolates pooled-agent shutdown and clears process-global transport only for the last session", async () => {
		const a = binding(); const b = binding();
		await start(a); await start(b, scopeB);
		const disposeA = vi.fn().mockResolvedValue(undefined); const disposeB = vi.fn().mockResolvedValue(undefined);
		const leaseA = await acquireSessionCursorAgent({ ...agentParams(), scope: getCursorSessionScopeSnapshot(a), createAgent: vi.fn().mockResolvedValue(asMockSdkAgent({ send: vi.fn(), [Symbol.asyncDispose]: disposeA })) });
		await acquireSessionCursorAgent({ ...agentParams(scopeB), scope: getCursorSessionScopeSnapshot(b), createAgent: vi.fn().mockResolvedValue(asMockSdkAgent({ send: vi.fn(), [Symbol.asyncDispose]: disposeB })) });
		const configure = vi.fn();
		configureCursorSdkHttp1({ Cursor: { configure } }, { value: true, source: "user", trustLevel: "user" });
		await b.runSessionShutdown({ reason: "quit" });
		expect(disposeB).toHaveBeenCalledOnce(); expect(disposeA).not.toHaveBeenCalled(); expect(configure).toHaveBeenCalledTimes(1);
		const stillA = await acquireSessionCursorAgent({ ...agentParams(), scope: getCursorSessionScopeSnapshot(a) });
		expect(stillA.agent).toBe(leaseA.agent);
		await a.runSessionShutdown({ reason: "quit" });
		expect(disposeA).toHaveBeenCalledOnce();
		expect(configure).toHaveBeenLastCalledWith({ local: { useHttp1ForAgent: null } });
	});

	it("disposes only B's previous pool when B changes scope", async () => {
		const a = binding(); const b = binding();
		await start(a); await start(b, scopeB);
		const disposeA = vi.fn().mockResolvedValue(undefined); const disposeB = vi.fn().mockResolvedValue(undefined);
		await acquireSessionCursorAgent({ ...agentParams(), scope: getCursorSessionScopeSnapshot(a), createAgent: vi.fn().mockResolvedValue(asMockSdkAgent({ send: vi.fn(), [Symbol.asyncDispose]: disposeA })) });
		await acquireSessionCursorAgent({ ...agentParams(scopeB), scope: getCursorSessionScopeSnapshot(b), createAgent: vi.fn().mockResolvedValue(asMockSdkAgent({ send: vi.fn(), [Symbol.asyncDispose]: disposeB })) });
		await start(b, { ...scopeB, file: "/tmp/changed-child.jsonl" });
		expect(disposeB).toHaveBeenCalledOnce(); expect(disposeA).not.toHaveBeenCalled();
	});

	it("flushes each pending resume handle only to its own journal", async () => {
		const a = binding(); await start(a); const b = binding(); await start(b, scopeB);
		for (const [pi, scope] of [[a, scopeA], [b, scopeB]] as const) {
			persistCursorSessionAgentResumeHandle({ runtime: "local", agentId: `agent-${scope.id}`, poolKey: scope.id, sendState: { bootstrapped: true, contextFingerprint: "test", incrementalSendCount: 0 }, storeIdentity: { version: 1, stateRoot: `/tmp/${scope.id}` } }, scope.file);
			await pi.runTurnEnd();
			expect(pi.appendEntry).toHaveBeenCalledWith("cursor-sdk-agent-resume", expect.objectContaining({ scopeKey: scope.file, sessionId: scope.id, agentId: `agent-${scope.id}` }));
		}
	});

	it("keeps captured cloud creation and final telemetry in the parent's journal", async () => {
		const a = binding(); registerCursorCloudLifecycleLedger(a); await start(a);
		const recorder = captureCursorCloudLifecycleRecorder(a);
		const b = binding(); registerCursorCloudLifecycleLedger(b); await start(b, scopeB);
		const agentId = "bc-00000000-0000-0000-0000-000000000234";
		expect(recorder({ agentId }, "test-key")).toBe(true);
		expect(recorder({ agentId, runId: "run-parent", branches: [{ repoUrl: "https://github.com/example/repo", branch: "parent-branch" }] }, "test-key")).toBe(true);
		expect(a.appendEntry).toHaveBeenCalledTimes(2);
		expect(a.appendEntry).toHaveBeenLastCalledWith("cursor-cloud-lifecycle", expect.objectContaining({ agentId, runId: "run-parent", branches: [{ branch: "parent-branch" }] }));
		expect(b.appendEntry).not.toHaveBeenCalled();
	});
});
