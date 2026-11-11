import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { concurrentFixture, retainNativeEvidence, SessionManager, setupNativeCursorHarness, state, storeRootOf } from "./helpers/native-cursor-harness.mjs";

setupNativeCursorHarness();

async function sessionlessHost(create, copyExtension) {
  const bootstrap = await create("bootstrap", { bind: false, extensionPath: await copyExtension("bootstrap") });
  const runtime = bootstrap.session.modelRuntime;
  const registerNativeProvider = runtime.registerNativeProvider.bind(runtime);
  // A session-less host freezes this registration and ignores session registrations.
  runtime.registerNativeProvider = next => { if (next.id !== "cursor") registerNativeProvider(next); };
  return { runtime, model: bootstrap.session.model, provider: runtime.getRegisteredNativeProvider("cursor") };
}

test("independent native managers reopening one persisted file survive terminal sibling shutdown", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    const a = await create("same-file-A");
    await a.session.prompt("first owner turn");
    const agentId = state.sends.at(-1).agentId;
    const b = await create("same-file-B", { manager: SessionManager.open(a.manager.getSessionFile()) });
    assert.notEqual(a.manager, b.manager);
    assert.equal(a.manager.getSessionFile(), b.manager.getSessionFile());
    assert.equal(a.manager.getSessionId(), b.manager.getSessionId());
    const closedStream = b.session.modelRuntime.getProvider("cursor").streamSimple;
    await b.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await a.session.prompt("owner continues after sibling shutdown");
    assert.equal(a.session.messages.at(-1).stopReason, "stop", a.session.messages.at(-1).errorMessage);
    assert.equal(state.sends.at(-1).agentId, agentId);
    const persisted = SessionManager.open(a.manager.getSessionFile()).getBranch();
    const user = persisted.findLast(e => e.type === "message" && e.message.role === "user");
    assert.match(JSON.stringify(user.message.content), /owner continues after sibling shutdown/);
    assert.equal(persisted.findLast(e => e.type === "message" && e.message.role === "assistant").message.stopReason, "stop");
    const before = state.sends.length;
    const closed = await closedStream(b.session.model, { messages: [] }, { apiKey: "offline-fixture-only" }).result();
    assert.match(closed.errorMessage, /binding is not active/);
    assert.equal(state.sends.length, before);
    await retainNativeEvidence("native-same-file-shutdown", a.manager, a.cwd);
  });
});

test("separate extension graphs preserve live same-file agent claims and process-global transport cleanup", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create, copyExtension }) => {
    process.env.PI_CURSOR_LOCAL_RESUME = "1";
    process.env.PI_CURSOR_HTTP_1_1 = "1";
    const { runtime, model, provider } = await sessionlessHost(create, copyExtension);
    const a = await create("shared-graph-A", {
      runtime, model, extensionPath: await copyExtension("owner-a"),
    });
    await a.session.prompt("record owned durable handle");
    assert.equal(a.session.messages.at(-1).stopReason, "stop", a.session.messages.at(-1).errorMessage);
    const handle = a.manager.getEntries().findLast(e => e.type === "custom" && e.customType === "cursor-sdk-agent-resume").data;
    const reopen = {
      runtime, cwd: a.cwd, model: a.session.model,
      systemPrompt: "OWNER_shared-graph-A", toolDescription: "Owned by shared-graph-A",
    };
    const beforeResume = state.resumed.length;
    const b = await create("shared-graph-B", {
      ...reopen, manager: SessionManager.open(a.manager.getSessionFile()), extensionPath: await copyExtension("owner-b"),
    });
    assert.equal(runtime.getRegisteredNativeProvider("cursor"), provider);
    await b.session.prompt("same-file sibling cannot resume the live owner");
    assert.equal(b.session.messages.at(-1).stopReason, "stop", b.session.messages.at(-1).errorMessage);
    const agentB = state.sends.at(-1).agentId;
    assert.equal(state.resumed.length, beforeResume, "a live handle is never passed to Agent.resume across module copies");
    assert.notEqual(agentB, handle.agentId);
    const configuredBeforeShutdown = state.configured.length;
    await a.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.ok(state.disposed.includes(handle.agentId));
    assert.equal(state.disposed.includes(agentB), false);
    assert.equal(state.configured.length, configuredBeforeShutdown, "a sibling still owns the process-global HTTP override");
    await b.session.prompt("survive another module's shutdown");
    assert.equal(b.session.messages.at(-1).stopReason, "stop", b.session.messages.at(-1).errorMessage);
    assert.equal(state.sends.at(-1).agentId, agentB);
    await retainNativeEvidence("native-shared-graph-owner", b.manager, b.cwd);
    await b.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.deepEqual(state.configured.at(-1), { local: { useHttp1ForAgent: null } });
    const c = await create("shared-graph-C", {
      ...reopen, manager: SessionManager.open(b.manager.getSessionFile()), extensionPath: await copyExtension("owner-c"),
    });
    await c.session.prompt("a released handle remains resumable across module copies");
    assert.equal(c.session.messages.at(-1).stopReason, "stop", c.session.messages.at(-1).errorMessage);
    assert.equal(state.resumed.at(-1).agentId, agentB);
    await retainNativeEvidence("native-shared-graph-resumed", c.manager, c.cwd);
    const d = await create("disposed-graph-D", {
      runtime, model: c.session.model, extensionPath: await copyExtension("disposed-d"),
    });
    d.session.dispose();
    await c.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.deepEqual(state.configured.at(-1), { local: { useHttp1ForAgent: null } },
      "a directly disposed sibling cannot keep the process-global override alive");
  });
});

test("session-less bootstrap rejects a pending receipt whose owner was directly disposed", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ root, create, copyExtension }) => {
    const { runtime, model } = await sessionlessHost(create, copyExtension);
    const key = Symbol.for("cursor-native-park-headers");
    const park = join(root, "park-headers.mjs");
    // Loaded after Cursor, so Cursor has recorded the receipt before Pi dispatches it.
    await writeFile(park, `export default function(pi) {
      pi.on("before_provider_headers", () => globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})]?.());
    }`);
    try {
      const owner = await create("disposed-owner", {
        runtime, model, afterExtensions: [park], extensionPath: await copyExtension("disposed-owner"),
      });
      const sibling = await create("live-sibling", { runtime, model, extensionPath: await copyExtension("live-sibling") });
      await owner.session.prompt("bootstrap serves the live owner");
      assert.equal(owner.session.messages.at(-1).stopReason, "stop", owner.session.messages.at(-1).errorMessage);
      await retainNativeEvidence("native-disposed-receipt-owner", owner.manager, owner.cwd);
      const persisted = await readFile(owner.manager.getSessionFile());
      const parked = Promise.withResolvers(), release = Promise.withResolvers();
      globalThis[key] = () => { delete globalThis[key]; parked.resolve(); return release.promise; };
      const before = [state.sends.length, state.created.length, state.stores.length];
      // Disposal does not abort a bug-report summary's caller signal.
      const summary = owner.session.summarizeForBugReport({ hint: "disposed owner", signal: t.signal });
      await parked.promise;
      owner.session.dispose();
      release.resolve();
      await assert.rejects(summary, /binding is not active/);
      assert.deepEqual([state.sends.length, state.created.length, state.stores.length], before, "no SDK work starts for a disposed owner");
      assert.deepEqual(await readFile(owner.manager.getSessionFile()), persisted);
      await sibling.session.prompt("bootstrap still serves a live owner");
      assert.equal(sibling.session.messages.at(-1).stopReason, "stop", sibling.session.messages.at(-1).errorMessage);
      const siblingAgent = state.created.find(agent => agent.agentId === state.sends.at(-1).agentId);
      assert.ok(siblingAgent, "the live sibling send belongs to a created agent");
      assert.equal(siblingAgent.options.local.cwd, sibling.cwd);
      await retainNativeEvidence("native-disposed-receipt-sibling", sibling.manager, sibling.cwd);
    } finally { delete globalThis[key]; }
  });
});

test("same-file sibling reload, tree navigation and shutdown leave a pending native bridge owned by its runtime", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let aborted = false;
    const a = await create("same-workspace-A", { tool: async (_id, _args, signal) => {
      signal.addEventListener("abort", () => { aborted = true; release.resolve(); }, { once: true });
      entered.resolve();
      await release.promise;
      return { content: [{ type: "text", text: "surviving owned bridge" }], details: {} };
    } });
    await a.session.prompt("persist before concurrent bridge");
    const agentId = state.sends.at(-1).agentId;
    const running = a.session.prompt("BRIDGE_FIXTURE");
    await entered.promise;
    try {
      const b = await create("same-workspace-B", { cwd: a.cwd, manager: SessionManager.open(a.manager.getSessionFile()) });
      const before = state.bridgeResults.length;
      await b.session.prompt("independent same-file turn");
      assert.equal(b.session.messages.at(-1).stopReason, "stop", b.session.messages.at(-1).errorMessage);
      assert.notEqual(state.sends.at(-1).agentId, agentId);
      await b.session.reload();
      const target = b.manager.getEntries().find(e => e.type === "message" && e.message.role === "user").id;
      await b.session.navigateTree(target, { summarize: false });
      await b.session.prompt("sibling after reload and tree");
      assert.equal(b.session.messages.at(-1).stopReason, "stop", b.session.messages.at(-1).errorMessage);
      await b.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      assert.equal(aborted, false);
      assert.equal(state.disposed.includes(agentId), false);
      assert.equal(state.bridgeResults.length, before, "sibling cannot resolve A's pending MCP result");
    } finally { release.resolve(); }
    await running;
    assert.equal(a.session.messages.at(-1).stopReason, "stop", a.session.messages.at(-1).errorMessage);
    assert.equal(aborted, false);
    const result = SessionManager.open(a.manager.getSessionFile()).getEntries().findLast(e =>
      e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "fixture_bridge");
    assert.ok(result && !result.message.isError);
    assert.match(JSON.stringify(result.message.content), /surviving owned bridge/);
    await a.session.prompt("survivor keeps its live agent");
    assert.equal(state.sends.at(-1).agentId, agentId);
    assert.equal(a.session.messages.at(-1).stopReason, "stop");
    await retainNativeEvidence("native-same-file-pending", a.manager, a.cwd);
  });
});

test("same-file durable resume handles remain stable but cannot reattach a live sibling agent", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    process.env.PI_CURSOR_LOCAL_RESUME = "1";
    const a = await create("resume-file-A");
    await a.session.prompt("record durable handle");
    const handle = a.manager.getEntries().findLast(e => e.type === "custom" && e.customType === "cursor-sdk-agent-resume").data;
    assert.equal(handle.scopeKey, a.manager.getSessionFile());
    assert.equal(handle.poolKey.split("\0")[0], a.manager.getSessionFile());
    const before = state.resumed.length;
    const reopen = { cwd: a.cwd, model: a.session.model, toolDescription: "Owned by resume-file-A", systemPrompt: "OWNER_resume-file-A" };
    const b = await create("resume-file-B", { ...reopen, manager: SessionManager.open(a.manager.getSessionFile()) });
    await b.session.prompt("same handle but independent runtime");
    assert.equal(b.session.messages.at(-1).stopReason, "stop", b.session.messages.at(-1).errorMessage);
    assert.notEqual(state.sends.at(-1).agentId, handle.agentId);
    assert.equal(state.resumed.length, before, "occupied durable handle is not passed to Agent.resume");
    await b.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await a.session.reload();
    await a.session.prompt("reload releases and reattaches own handle");
    assert.equal(a.session.messages.at(-1).stopReason, "stop", a.session.messages.at(-1).errorMessage);
    assert.equal(state.resumed.at(-1).agentId, handle.agentId);
    const restored = a.manager.getEntries().findLast(e => e.type === "custom" && e.customType === "cursor-sdk-agent-resume").data;
    assert.equal(restored.scopeKey, handle.scopeKey);
    assert.equal(restored.poolKey, handle.poolKey);
    assert.deepEqual(restored.storeIdentity, handle.storeIdentity);
    await a.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    const c = await create("resume-file-C", { ...reopen, manager: SessionManager.open(a.manager.getSessionFile()) });
    const d = await create("resume-file-D", { ...reopen, manager: SessionManager.open(a.manager.getSessionFile()) });
    const resumeCount = state.resumed.length, sendCount = state.sends.length;
    await Promise.all([
      c.session.prompt("new manager restores after terminal shutdown"),
      d.session.prompt("concurrent reopen cannot share the restored handle"),
    ]);
    assert.equal(c.session.messages.at(-1).stopReason, "stop", c.session.messages.at(-1).errorMessage);
    assert.equal(d.session.messages.at(-1).stopReason, "stop", d.session.messages.at(-1).errorMessage);
    await retainNativeEvidence("native-same-file-resume", c.manager, c.cwd);
    assert.equal(state.resumed.length, resumeCount + 1);
    assert.equal(new Set(state.sends.slice(sendCount).map(send => send.agentId)).size, 2);
    assert.equal(state.resumed.at(-1).agentId, handle.agentId);

    const sdkStateRoot = storeRootOf(state.resumed.at(-1).options.local.store);
    assert.equal(sdkStateRoot, toNamespacedPath(handle.storeIdentity.stateRoot));
    assert.equal(await realpath(sdkStateRoot), await realpath(handle.storeIdentity.stateRoot));
  });
});

// The offline transport finishes right after its replayed read, so the SDK run completes inside the replay toolUse turn.
for (const { delivery, prompt, lastMessageRole } of [
  { delivery: "final answer", prompt: "REPLAY_FIXTURE answer after the read", lastMessageRole: "assistant" },
  { delivery: "terminating replay", prompt: "REPLAY_FIXTURE EMPTY_RESULT_FIXTURE", lastMessageRole: "toolResult" },
]) {
  test(`a native replay run publishes its resume handle where Pi receives its ${delivery}`, { timeout: 60000 }, async (t) => {
    await concurrentFixture(t, async ({ create }) => {
      process.env.PI_CURSOR_LOCAL_RESUME = "1";
      const name = `replay-resume-${lastMessageRole}`;
      const a = await create(name);
      await a.session.prompt(prompt);
      const branch = a.manager.getBranch();
      const lastMessage = branch.findLast(e => e.type === "message");
      assert.equal(lastMessage.message.role, lastMessageRole);
      const handleIndex = branch.findLastIndex(e => e.type === "custom" && e.customType === "cursor-sdk-agent-resume");
      assert.ok(handleIndex > branch.indexOf(lastMessage), "the handle follows every message its run delivered");
      const handle = branch[handleIndex].data;
      await a.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      const resumeCount = state.resumed.length;
      const b = await create(`${name}-restart`, {
        cwd: a.cwd, model: a.session.model, toolDescription: `Owned by ${name}`, systemPrompt: `OWNER_${name}`,
        manager: SessionManager.open(a.manager.getSessionFile()),
      });
      await b.session.prompt("continue after restart");
      assert.equal(b.session.messages.at(-1).stopReason, "stop", b.session.messages.at(-1).errorMessage);
      assert.equal(state.resumed.length, resumeCount + 1);
      assert.equal(state.resumed.at(-1).agentId, handle.agentId);
      await retainNativeEvidence(`native-replay-resume-${lastMessageRole}`, b.manager, b.cwd);
    });
  });
}

test("threshold compaction between a replay run's successful send and its final answer cancels that run's resume handle", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    process.env.PI_CURSOR_LOCAL_RESUME = "1";
    const a = await create("replay-compaction", { compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 } });
    await a.session.setModel({ ...a.session.model, contextWindow: 128000 });
    // Only the replay run reports pressure, so Pi compacts before requesting that run's final answer.
    state.usageByCwd.set(a.cwd, {
      raw: { inputTokens: 125000, outputTokens: 6, cacheReadTokens: 5, cacheWriteTokens: 0 },
      billed: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 15 },
    });
    const unsubscribe = a.session.subscribe((event) => {
      if (event.type === "tool_execution_start") state.usageByCwd.delete(a.cwd);
    });
    const sendCount = state.sends.length;
    await a.session.prompt("REPLAY_FIXTURE answer after the read");
    unsubscribe();
    const replay = state.sends[sendCount];
    const branch = a.manager.getBranch();
    const compactionIndex = branch.findIndex(e => e.type === "compaction");
    const lastMessageIndex = branch.findLastIndex(e => e.type === "message");
    assert.ok(compactionIndex > branch.findIndex(e => e.type === "message" && e.message.role === "toolResult"), "Pi compacted after the replay turn");
    assert.equal(branch[lastMessageIndex].message.stopReason, "stop");
    const handles = branch.flatMap((e, index) => e.type === "custom" && e.customType === "cursor-sdk-agent-resume" ? [{ index, data: e.data }] : []);
    assert.deepEqual(handles.filter(h => h.data.agentId === replay.agentId), []);
    assert.ok(handles.at(-1).index > lastMessageIndex && handles.at(-1).data.compactionGeneration === 1, "the post-compaction send publishes after its answer");
    await a.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    const resumeCount = state.resumed.length;
    const b = await create("replay-compaction-restart", {
      cwd: a.cwd, model: a.session.model, toolDescription: "Owned by replay-compaction", systemPrompt: "OWNER_replay-compaction",
      manager: SessionManager.open(a.manager.getSessionFile()),
    });
    await b.session.prompt("continue after restart");
    assert.equal(b.session.messages.at(-1).stopReason, "stop", b.session.messages.at(-1).errorMessage);
    assert.deepEqual(state.resumed.slice(resumeCount).map(r => r.agentId), [handles.at(-1).data.agentId]);
    await retainNativeEvidence("native-replay-compaction", b.manager, b.cwd);
  });
});

test("a replay run finished before an abort cannot publish its resume handle on a branch selected afterwards", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    process.env.PI_CURSOR_LOCAL_RESUME = "1";
    const a = await create("replay-abort-tree");
    await a.session.prompt("first request");
    let aborting;
    const unsubscribe = a.session.subscribe((event) => {
      if (event.type === "tool_execution_start") aborting ??= a.session.abort();
    });
    await a.session.prompt("REPLAY_FIXTURE interrupted request");
    await aborting;
    unsubscribe();
    // The offline run finished before Pi replayed its read, so its send succeeded before the abort.
    const interrupted = state.sends.at(-1);
    const firstUser = a.manager.getEntries().find(e => e.type === "message" && e.message.role === "user");
    await a.session.navigateTree(firstUser.id, { summarize: false });
    await a.session.prompt("after tree");
    const isResume = e => e.type === "custom" && e.customType === "cursor-sdk-agent-resume";
    assert.deepEqual(a.manager.getBranch().filter(e => isResume(e) && e.data.agentId === interrupted.agentId), []);
    await a.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    const resumeCount = state.resumed.length;
    const b = await create("replay-abort-tree-restart", {
      cwd: a.cwd, model: a.session.model, toolDescription: "Owned by replay-abort-tree", systemPrompt: "OWNER_replay-abort-tree",
      manager: SessionManager.open(a.manager.getSessionFile()),
    });
    await b.session.prompt("continue after restart");
    assert.equal(b.session.messages.at(-1).stopReason, "stop", b.session.messages.at(-1).errorMessage);
    assert.deepEqual(state.resumed.slice(resumeCount).map(r => r.agentId).filter(id => id === interrupted.agentId), []);
    await retainNativeEvidence("native-replay-abort-tree", b.manager, b.cwd);
  });
});

test("a replay run kept by a same-branch tree move replays without publishing its old-generation resume handle", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    process.env.PI_CURSOR_LOCAL_RESUME = "1";
    const a = await create("replay-abort-kept-tree");
    await a.session.prompt("first request");
    let aborting;
    const unsubscribe = a.session.subscribe((event) => {
      if (event.type === "tool_execution_start") aborting ??= a.session.abort();
    });
    await a.session.prompt("REPLAY_FIXTURE interrupted request");
    await aborting;
    unsubscribe();
    const interrupted = state.sends.at(-1);
    const abortError = a.manager.getBranch().findLast(e => e.type === "message");
    assert.ok(["aborted", "error"].includes(abortError.message.stopReason));
    // Naming the session appends under the error, so selecting the error is a real tree move that keeps the run's result.
    a.session.setSessionName("kept run");
    await a.session.navigateTree(abortError.id, { summarize: false });
    assert.equal(a.manager.getLeafId(), abortError.id);
    assert.equal(state.disposed.includes(interrupted.agentId), false, "the kept run keeps its agent");
    const sendCount = state.sends.length;
    await a.session.prompt("continue on the kept branch");
    assert.equal(state.sends.length, sendCount, "the kept run's queued answer is replayed, not sent again");
    const branch = a.manager.getBranch();
    const continued = branch.slice(branch.findLastIndex(e => e.type === "message" && e.message.role === "user"));
    assert.deepEqual(continued.filter(e => e.type === "custom" && e.customType === "cursor-sdk-agent-resume"), [],
      "a send issued before the tree move publishes no handle on the selected branch");
    await retainNativeEvidence("native-replay-abort-kept-tree", a.manager, a.cwd);
  });
});

test("tree navigation keeps a pending run when only its already-delivered bridge result remains on the branch", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    process.env.PI_CURSOR_LOCAL_RESUME = "1";
    const a = await create("bridge-delivered-kept-tree");
    await a.session.prompt("first request");
    const firstUser = a.manager.getEntries().find(e => e.type === "message" && e.message.role === "user");
    assert.ok(firstUser);

    const beforeResults = state.bridgeResults.length;
    let aborting;
    const unsubscribe = a.session.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolName !== "fixture_bridge") aborting ??= a.session.abort();
    });
    await a.session.prompt("BRIDGE_FIXTURE REPLAY_FIXTURE");
    await aborting;
    unsubscribe();
    assert.equal(state.bridgeResults.length, beforeResults + 1, "the bridge result was already delivered before the read replay aborted");

    const interrupted = state.sends.at(-1);
    const deliveredBridgeResult = a.manager.getBranch().findLast(
      e => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "fixture_bridge",
    );
    assert.ok(deliveredBridgeResult);
    await a.session.navigateTree(deliveredBridgeResult.id, { summarize: false });
    assert.equal(a.manager.getLeafId(), deliveredBridgeResult.id);
    assert.equal(state.disposed.includes(interrupted.agentId), false, "branch holding the run's delivered bridge result keeps the run and its agent");

    await a.session.navigateTree(firstUser.id, { summarize: false });
    assert.ok(state.disposed.includes(interrupted.agentId), "navigating off the delivered bridge result releases the kept run and its agent");
    await a.session.prompt("after off-branch release");
    assert.equal(a.session.messages.at(-1)?.stopReason, "stop");
    const isResume = e => e.type === "custom" && e.customType === "cursor-sdk-agent-resume";
    assert.deepEqual(a.manager.getBranch().filter(e => isResume(e) && e.data.agentId === interrupted.agentId), []);
    await retainNativeEvidence("native-bridge-delivered-kept-tree", a.manager, a.cwd);
  });
});

test("independent concurrent streams retain owned persisted lineage and sibling isolation", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    const a = await create("concurrent-A");
    const b = await create("concurrent-B");
    assert.notEqual(a.session.modelRuntime, b.session.modelRuntime, "SDK defaults create independent runtimes");
    state.heldCwds.add(a.cwd);
    const before = state.sends.length;
    const runningA = a.session.prompt("A held during B");
    while (state.sends.length === before) await delay(1, undefined, { signal: t.signal });
    await b.session.prompt("B overlaps A");
    assert.equal(b.session.messages.at(-1).stopReason, "stop");
    await a.session.abort();
    await runningA;
    state.heldCwds.delete(a.cwd);
    const beforeB = await readFile(b.manager.getSessionFile());
    for (let index = 0; index < 10; index++) await a.session.prompt(`A bounded request ${index}`);
    await a.session.prompt("/cursor-refresh-models");
    assert.deepEqual(await readFile(b.manager.getSessionFile()), beforeB, "A's repeated turns and refresh leave B's persisted session byte-identical");
    for (const owner of [a, b]) {
      const reopened = SessionManager.open(owner.manager.getSessionFile());
      const entries = reopened.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "cursor-sdk-agent-lineage");
      assert.ok(entries.length > 0);
      assert.ok(entries.every((entry) => entry.data.scopeKey === owner.manager.getSessionFile() && entry.data.cwd === owner.cwd));
      await retainNativeEvidence(owner === a ? "native-concurrent-owner" : "native-concurrent-sibling", owner.manager, owner.cwd);
    }
  });
});

test("MCP-only ordinary turns reach the real Pi tool_call block boundary without executing the tool", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ root, create }) => {
    process.env.PI_CURSOR_NATIVE_TOOLS = "0";
    const blocker = join(root, "block-fixture.mjs");
    await writeFile(blocker, `export default function(pi) {
      pi.on("tool_call", event => {
        if (event.toolName === "fixture_bridge") return { block: true, reason: "NATIVE_MCP_POLICY_DENIED" };
      });
    }`);
    let executions = 0;
    const fixture = await create("native-mcp-policy", { beforeExtensions: [blocker], tool: async () => {
      executions++;
      return { content: [{ type: "text", text: "must not execute" }], details: {} };
    } });
    const beforeResults = state.bridgeResults.length;
    await fixture.session.prompt("BRIDGE_FIXTURE");
    const created = state.created.findLast(agent => agent.options.local?.cwd === fixture.cwd);
    assert.deepEqual(created.options.tools, ["mcp"]);
    assert.equal(executions, 0);
    assert.equal(state.bridgeResults.length, beforeResults + 1);
    assert.equal(state.bridgeResults.at(-1).isError, true);
    assert.match(JSON.stringify(state.bridgeResults.at(-1).content), /NATIVE_MCP_POLICY_DENIED/);
    const result = SessionManager.open(fixture.manager.getSessionFile()).getBranch().findLast(entry =>
      entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "fixture_bridge");
    assert.ok(result?.message.isError);
    assert.match(JSON.stringify(result.message.content), /NATIVE_MCP_POLICY_DENIED/);
    // Summary agents are intentionally independent of the ordinary MCP-only policy.
    const compacted = await fixture.session.compact();
    assert.match(compacted.summary, /OFFLINE_CURSOR_DONE/);
    const summaryAgent = state.created.findLast(agent => agent.options.local?.cwd === fixture.cwd);
    assert.deepEqual(summaryAgent.options.tools, []);
    assert.deepEqual(summaryAgent.options.local.settingSources, []);
    assert.equal(summaryAgent.options.mcpServers, undefined);
    assert.ok(state.disposed.includes(summaryAgent.agentId));
    await fixture.session.prompt("ordinary after MCP-only compaction");
    const ordinary = state.created.findLast(agent => agent.options.local?.cwd === fixture.cwd);
    assert.deepEqual(ordinary.options.tools, ["mcp"]);
    assert.ok(ordinary.options.mcpServers?.pi_tools);
    await retainNativeEvidence("native-mcp-policy-blocked", fixture.manager, fixture.cwd);
  });
});

for (const nativeToolsEnabled of [true, false]) {
  test(`policy switch from nativeTools=${nativeToolsEnabled} preserves restore semantics and permits explicit cursor-abort recovery`, { timeout: 60000 }, async (t) => {
    await concurrentFixture(t, async ({ root, create }) => {
      process.env.PI_CURSOR_NATIVE_TOOLS = nativeToolsEnabled ? "1" : "0";
      const switcher = join(root, "switch-policy.mjs");
      await writeFile(switcher, `export default function(pi) { let handledResults = 0;
        pi.on("before_provider_headers", (_event, ctx) => {
          const count = ctx.sessionManager.getBranch().filter(e => e.type === "message" && e.message.role === "toolResult").length;
          if (count > handledResults) {
            handledResults = count; process.env.PI_CURSOR_NATIVE_TOOLS = ${JSON.stringify(nativeToolsEnabled ? "0" : "1")};
          }
        });
      }`);
      const siblingEntered = Promise.withResolvers(), siblingRelease = Promise.withResolvers();
      let siblingAborted = false;
      const sibling = await create("live-policy-sibling", { tool: async (_id, _args, signal) => {
        signal.addEventListener("abort", () => { siblingAborted = true; siblingRelease.resolve(); }, { once: true });
        siblingEntered.resolve();
        await siblingRelease.promise;
        return { content: [{ type: "text", text: "sibling pending call survived" }], details: {} };
      } });
      const siblingPrompt = sibling.session.prompt("BRIDGE_FIXTURE");
      await siblingEntered.promise;
      const siblingAgentId = state.sends.at(-1).agentId;
      const siblingRunId = state.sends.at(-1).runId;
      let executions = 0;
      const owner = await create("live-policy-switch", { afterExtensions: [switcher], tool: async () => {
        executions++;
        return { content: [{ type: "text", text: "Pi work completed before policy switch" }], details: {} };
      } });

      const sendsBeforeEmptyCommand = state.sends.length;
      await owner.session.prompt("/cursor-abort");
      assert.equal(state.sends.length, sendsBeforeEmptyCommand, "no-owned-run command does not send a model turn");
      assert.equal(state.cancelled.includes(siblingRunId), false, "no-owned-run command must not fall back to another scope");
      const resultsBefore = state.bridgeResults.length;
      await owner.session.prompt("BRIDGE_FIXTURE");
      assert.equal(executions, 1, "real Pi execution precedes continuation header hook");
      assert.equal(owner.session.messages.at(-1).stopReason, "error");
      const mismatchError = owner.session.messages.at(-1).errorMessage;
      assert.match(mismatchError, /native tool policy changed/i);
      const restorableRun = state.sends.at(-1);
      assert.equal(state.bridgeResults.length, resultsBefore, "opposite-policy continuation must not deliver Pi results to the SDK MCP waiter");
      assert.equal(state.cancelled.includes(restorableRun.runId), false, "ordinary rejection must not implicitly cancel the old run");
      assert.equal(state.disposed.includes(restorableRun.agentId), false);
      await retainNativeEvidence(`native-policy-mismatch-${nativeToolsEnabled}`, owner.manager, owner.cwd);
      process.env.PI_CURSOR_NATIVE_TOOLS = nativeToolsEnabled ? "1" : "0";
      await owner.session.prompt("restore the prior native policy and continue");
      assert.equal(owner.session.messages.at(-1).stopReason, "stop");
      assert.equal(state.sends.at(-1).agentId, restorableRun.agentId, "restoration keeps the original agent");
      assert.equal(state.bridgeResults.length, resultsBefore + 1, "only restoration delivers the prior Pi result");
      await retainNativeEvidence(`native-policy-restored-${nativeToolsEnabled}`, owner.manager, owner.cwd);

      // Create a second mismatch. Pi abort while already idle has no active
      // signal/event, so recovery must use the registered explicit command.
      await owner.session.prompt("BRIDGE_FIXTURE");
      const originalRun = state.sends.at(-1);
      assert.equal(owner.session.messages.at(-1).stopReason, "error");
      assert.equal(state.cancelled.includes(originalRun.runId), false);
      assert.equal(owner.session.isIdle, true);
      assert.equal(owner.session.agent.signal, undefined);
      const idleAbortEvents = [];
      const unsubscribe = owner.session.subscribe(event => { idleAbortEvents.push(event.type); });
      await owner.session.abort();
      unsubscribe();
      assert.deepEqual(idleAbortEvents, [], "idle Pi abort exposes no extension/provider abort event");
      assert.equal(state.cancelled.includes(originalRun.runId), false, "do not pretend idle Pi abort reached the old SDK run");
      // A tree move that keeps the run's Pi result on the selected branch leaves the run recoverable.
      const pendingResult = owner.manager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "toolResult");
      assert.notEqual(pendingResult.id, owner.manager.getLeafId());
      await owner.session.navigateTree(pendingResult.id, { summarize: false });
      assert.equal(owner.manager.getBranch().findLast(entry => entry.type === "message").id, pendingResult.id, "the mismatch error leaves the branch");
      assert.equal(state.cancelled.includes(originalRun.runId), false, "same-branch tree navigation must not cancel the recoverable run");
      assert.equal(state.disposed.includes(originalRun.agentId), false, "same-branch tree navigation must keep the recoverable run's agent");
      const sendsBeforeCommand = state.sends.length;
      await owner.session.prompt("/cursor-abort");
      await retainNativeEvidence(`native-policy-explicit-abort-${nativeToolsEnabled}`, owner.manager, owner.cwd);
      assert.equal(state.sends.length, sendsBeforeCommand, "registered command must not send a model turn");
      assert.ok(state.cancelled.includes(originalRun.runId), "explicit scoped command must cancel the owned SDK run");
      await owner.session.prompt("retry under the new native policy");
      const retry = owner.session.messages.at(-1);
      const retryRun = state.sends.at(-1);
      await retainNativeEvidence(`native-policy-retry-${nativeToolsEnabled}`, owner.manager, owner.cwd);
      assert.equal(retry.stopReason, "stop", retry.errorMessage);
      assert.match(mismatchError, /restore the prior policy.*\/cursor-abort/i);
      assert.ok(state.cancelled.includes(originalRun.runId), "owned SDK run is cancelled, not orphaned after mismatch");
      assert.ok(state.disposed.includes(originalRun.agentId), "owned agent is abandoned through the existing release path");
      assert.notEqual(retryRun.agentId, originalRun.agentId, "retry acquires a new-policy agent rather than resending into the old one");
      const replacement = state.created.find(agent => agent.agentId === retryRun.agentId);
      assert.deepEqual(replacement.options.tools, nativeToolsEnabled ? ["mcp"] : undefined);
      assert.equal(executions, 2, "retry must not rerun either completed Pi tool");
      assert.equal(state.bridgeResults.length, resultsBefore + 1, "explicit cancellation/retry must not deliver the second stale Pi result");
      const branch = SessionManager.open(owner.manager.getSessionFile()).getBranch();
      assert.ok(branch.some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "fixture_bridge"));
      assert.ok(branch.some(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"));
      assert.equal(branch.findLast(entry => entry.type === "message" && entry.message.role === "assistant").message.stopReason, "stop");

      assert.equal(state.disposed.includes(siblingAgentId), false, "owner release must not abandon the sibling agent");
      assert.equal(state.cancelled.includes(siblingRunId), false);
      assert.equal(siblingAborted, false, "owner release must not abort the sibling's pending Pi execution");
      process.env.PI_CURSOR_NATIVE_TOOLS = nativeToolsEnabled ? "1" : "0";
      siblingRelease.resolve();
      await siblingPrompt;
      assert.equal(sibling.session.messages.at(-1).stopReason, "stop");
      assert.equal(state.bridgeResults.length, resultsBefore + 2, "only restoration and the sibling deliver their own Pi results");
      await sibling.session.prompt("sibling continues with its unchanged policy");
      assert.equal(sibling.session.messages.at(-1).stopReason, "stop");
      assert.equal(state.sends.at(-1).agentId, siblingAgentId);
      await retainNativeEvidence(`native-policy-sibling-${nativeToolsEnabled}`, sibling.manager, sibling.cwd);
    });
  });
}

for (const nativeToolsEnabled of [true, false]) {
  test(`explicit active Pi abort before provider preparation releases the pending nativeTools=${nativeToolsEnabled} run`, { timeout: 60000 }, async (t) => {
    await concurrentFixture(t, async ({ root, create }) => {
      process.env.PI_CURSOR_NATIVE_TOOLS = nativeToolsEnabled ? "1" : "0";
      const aborter = join(root, "abort-before-prepare.mjs");
      await writeFile(aborter, `export default function(pi) { let switched = false;
        pi.on("before_provider_headers", (_event, ctx) => {
          const branch = ctx.sessionManager.getBranch();
          const latestUser = branch.findLast(e => e.type === "message" && e.message.role === "user");
          if (JSON.stringify(latestUser?.message.content).includes("ABORT_BEFORE_PROVIDER")) { ctx.abort(); return; }
          if (!switched && branch.some(e => e.type === "message" && e.message.role === "toolResult")) {
            switched = true; process.env.PI_CURSOR_NATIVE_TOOLS = ${JSON.stringify(nativeToolsEnabled ? "0" : "1")};
          }
        });
      }`);
      const owner = await create("active-abort-policy", { afterExtensions: [aborter] });
      const beforeResults = state.bridgeResults.length;
      await owner.session.prompt("BRIDGE_FIXTURE");
      assert.equal(owner.session.messages.at(-1).stopReason, "error");
      const originalRun = state.sends.at(-1);
      assert.equal(state.cancelled.includes(originalRun.runId), false, "mismatch alone preserves the old run");
      await owner.session.prompt("ABORT_BEFORE_PROVIDER");
      await retainNativeEvidence(`native-policy-active-abort-${nativeToolsEnabled}`, owner.manager, owner.cwd);
      assert.equal(owner.session.messages.at(-1).stopReason, "aborted");
      assert.ok(state.cancelled.includes(originalRun.runId), "explicit active abort must release an old run even before a new prepared turn exists");
      assert.ok(state.disposed.includes(originalRun.agentId));
      assert.equal(state.bridgeResults.length, beforeResults, "abort must not deliver the stale Pi result");
    });
  });
}

test("cursor-abort explicitly aborts an active owning Pi turn while releasing its held SDK run", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    const owner = await create("command-active-sdk");
    state.heldCwds.add(owner.cwd);
    const beforeSends = state.sends.length;
    const running = owner.session.prompt("hold the SDK run until explicit abort");
    const deadline = Date.now() + 5000;
    while (state.sends.length === beforeSends && Date.now() < deadline) await delay(5);
    assert.equal(state.sends.length, beforeSends + 1);
    const held = state.sends.at(-1);
    const activeSignal = owner.session.agent.signal;
    assert.ok(activeSignal && !activeSignal.aborted);
    await owner.session.prompt("/cursor-abort");
    await running;
    await retainNativeEvidence("native-command-active-sdk-abort", owner.manager, owner.cwd);
    assert.equal(activeSignal.aborted, true, "explicit command must also stop its active owning Pi loop");
    assert.ok(state.cancelled.includes(held.runId));
    assert.equal(state.sends.length, beforeSends + 1, "command must not continue into an automatic replacement send");
    assert.equal(owner.session.messages.at(-1).stopReason, "aborted");
  });
});

test("a failed journal append keeps saved global fast and HTTP authority owned by that session", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    const preferences = [["cursor-fast-state", { modelId: "fixture", fast: true }], ["cursor-http1-state", { enabled: true }]];
    const a = await create("authority-A", { preferences });
    const b = await create("authority-B", { preferences });
    await a.session.prompt("A journal exists before the failed append");
    const journal = a.manager.getSessionFile();
    // A directory at the journal path makes Pi's real appendEntry fail after the user config write.
    await rename(journal, `${journal}.held`);
    await mkdir(journal);
    try {
      await a.session.prompt("/cursor-fast");
      await a.session.prompt("/cursor-http off");
    } finally {
      await rm(journal, { recursive: true });
      await rename(`${journal}.held`, journal);
    }
    assert.deepEqual(JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR, "cursor-sdk.json"), "utf8")),
      { fastDefaults: { fixture: false }, local: { useHttp1ForAgent: false } });
    assert.doesNotMatch(await readFile(journal, "utf8"), /"fast":false|"enabled":false/);
    const lastSend = () => ({
      fast: state.created.find((entry) => entry.agentId === state.sends.at(-1).agentId).options.model.params.find((parameter) => parameter.id === "fast").value,
      transport: state.configured.at(-1),
    });
    await b.session.prompt("B keeps its own branch preferences");
    const sibling = lastSend();
    await create("authority-C");
    const firstRequest = a.manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user").id;
    await a.session.navigateTree(firstRequest, { summarize: false });
    await a.session.prompt("A keeps its saved global preferences after branch restore");
    assert.equal(a.session.messages.at(-1).stopReason, "stop", a.session.messages.at(-1).errorMessage);
    assert.deepEqual({ sibling, owner: lastSend() }, {
      sibling: { fast: "true", transport: { local: { useHttp1ForAgent: true } } },
      owner: { fast: "false", transport: { local: { useHttp1ForAgent: false } } },
    });
    await retainNativeEvidence("preference-authority-owner", a.manager, a.cwd);
  });
});

test("shared runtime requests require their actual session's registration once that registration has started", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    const a = await create("shared-A");
    await a.session.prompt("A before sharing");
    const b = await create("shared-B", { runtime: a.session.modelRuntime, bind: false });
    const staleStream = a.session.modelRuntime.getProvider("cursor").streamSimple;
    await a.session.prompt("unstarted B registration serves A's own receipt");
    assert.equal(a.session.messages.at(-1).stopReason, "stop", a.session.messages.at(-1).errorMessage);
    const delegatedAgent = state.created.find((entry) => entry.agentId === state.sends.at(-1).agentId);
    assert.equal(delegatedAgent?.options.local.cwd, a.cwd);
    const beforeSends = state.sends.length;
    await b.session.bindExtensions({ mode: "rpc" });
    await a.session.prompt("A cannot enter B registration");
    const ownershipError = a.session.messages.at(-1).errorMessage;
    assert.match(ownershipError, /request does not belong/);
    assert.match(ownershipError, /Reload this session's extensions/);
    assert.match(ownershipError, /use independent ModelRuntime instances for sibling sessions/);
    assert.doesNotMatch(ownershipError, /refresh Cursor models/);
    assert.equal(state.sends.length, beforeSends);
    await b.session.prompt("correct B receipt and registration");
    assert.equal(b.session.messages.at(-1).stopReason, "stop");
    const registeredAgent = state.created.find((entry) => entry.agentId === state.sends.at(-1).agentId);
    assert.equal(registeredAgent?.options.local.cwd, b.cwd);
    await b.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await a.session.prompt("closed B registration is not A");
    assert.match(a.session.messages.at(-1).errorMessage, /binding is not active/);
    const staleResult = await staleStream(a.session.model, { messages: [] }, { apiKey: "offline-fixture-only" }).result();
    assert.match(staleResult.errorMessage, /binding is not active/);
    await a.session.prompt("/cursor-refresh-models");
    assert.equal(a.session.modelRuntime.getProvider("cursor").streamSimple, staleStream, "catalog refresh cannot replace the sibling's native registration");
    await a.session.reload();
    assert.notEqual(a.session.modelRuntime.getProvider("cursor").streamSimple, staleStream);
    await a.session.prompt("A recovered with its own request receipt");
    assert.equal(a.session.messages.at(-1).stopReason, "stop");
    const reloadedAgent = state.created.find((entry) => entry.agentId === state.sends.at(-1).agentId);
    assert.equal(reloadedAgent?.options.local.cwd, a.cwd);
  });
});

for (const operation of ["ordinary", "bugreport"]) {
  test(`hidden unstarted shared B ${operation} cannot enter A after C overwrites B, shuts down and A refreshes`, { timeout: 60000 }, async (t) => {
    await concurrentFixture(t, async ({ create }) => {
      const a = await create("hidden-A");
      await a.session.prompt("A before sharing");
      const b = await create("hidden-B", { runtime: a.session.modelRuntime, bind: false });
      const c = await create("hidden-C", { runtime: a.session.modelRuntime, bind: false });
      await a.session.prompt("/cursor-refresh-models");
      await c.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await a.session.prompt("/cursor-refresh-models");
      await a.session.reload();
      const beforeA = await readFile(a.manager.getSessionFile(), "utf8");
      const beforeSends = state.sends.length;
      const beforeStores = state.stores.length;
      if (operation === "ordinary") {
        await b.session.prompt("unbound B must not enter A");
        assert.match(b.session.messages.at(-1).errorMessage, /request does not belong/);
      } else {
        await assert.rejects(b.session.summarizeForBugReport({ hint: "hidden B", signal: t.signal }), /request does not belong/);
      }
      assert.equal(state.sends.length, beforeSends);
      assert.equal(state.stores.length, beforeStores);
      assert.equal(await readFile(a.manager.getSessionFile(), "utf8"), beforeA);
      await b.session.bindExtensions({ mode: "rpc" });
      await b.session.prompt("bound B cannot enter A either");
      assert.match(b.session.messages.at(-1).errorMessage, /request does not belong/);
      await a.session.prompt("A with truthful receipt remains safe");
      assert.equal(a.session.messages.at(-1).stopReason, "stop");
    });
  });
}

test("catalog refresh awaiting auth cannot replace a sibling's native registration", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    const a = await create("refresh-A");
    const ownStream = a.session.modelRuntime.getProvider("cursor").streamSimple;
    const registry = a.session.extensionRunner.getModelRegistry();
    const enteredAuth = Promise.withResolvers();
    const auth = Promise.withResolvers();
    const getProviderAuth = registry.getProviderAuth.bind(registry);
    registry.getProviderAuth = async (...args) => { enteredAuth.resolve(); await auth.promise; return getProviderAuth(...args); };
    const refreshing = a.session.prompt("/cursor-refresh-models");
    await enteredAuth.promise;
    const b = await create("refresh-B", { runtime: a.session.modelRuntime });
    const before = state.sends.length;
    auth.resolve("offline-fixture-only");
    await refreshing;
    assert.notEqual(a.session.modelRuntime.getProvider("cursor").streamSimple, ownStream);
    await a.session.prompt("A cannot enter B after stale refresh");
    assert.match(a.session.messages.at(-1).errorMessage, /request does not belong/);
    assert.equal(state.sends.length, before);
    await b.session.prompt("B retains its native registration");
    assert.equal(b.session.messages.at(-1).stopReason, "stop");
    assert.equal(state.created.find((entry) => entry.agentId === state.sends.at(-1).agentId).options.local.cwd, b.cwd);
  });
});

test("native request headers retain identity and other handlers' mutations; missing or reused receipts fail closed", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ root, create }) => {
    const key = Symbol.for("cursor-native-header-probe");
    const observed = globalThis[key] = [];
    const before = join(root, "headers-before.mjs");
    const after = join(root, "headers-after.mjs");
    for (const [path, phase] of [[before, "before"], [after, "after"]]) {
      await writeFile(path, `export default function(pi) { pi.on("before_provider_headers", async (event) => {
        await Promise.resolve();
        event.headers["x-fixture-${phase}"] = "preserved";
        globalThis[Symbol.for("cursor-native-header-probe")].push({ phase: "${phase}", headers: event.headers });
      }); }`);
    }
    try {
      const a = await create("headers-A", { beforeExtensions: [before], afterExtensions: [after] });
      const config = a.session.modelRuntime.getProvider("cursor");
      const headers = [];
      a.session.extensionRunner.getModelRegistry().registerProvider({ ...config, streamSimple: (model, context, options) => {
        headers.push(options.headers);
        return config.streamSimple(model, context, options);
      } });
      await a.session.prompt("first headers");
      const target = a.manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user").id;
      await a.session.prompt("second headers");
      await a.session.navigateTree(target, { summarize: true });
      await a.session.prompt("third headers");
      await a.session.compact();
      await a.session.summarizeForBugReport({ hint: "headers retained", signal: t.signal });
      assert.ok(headers.length >= 6, "ordinary, tree, compaction and bug-report calls reached the registered provider");
      assert.equal(observed.length, headers.length * 2);
      for (const [index, value] of headers.entries()) {
        assert.equal(observed[index * 2].headers, value);
        assert.equal(observed[index * 2 + 1].headers, value);
        assert.equal(value["x-fixture-before"], "preserved");
        assert.equal(value["x-fixture-after"], "preserved");
      }
      const beforeSends = state.sends.length;
      for (const options of [{}, { headers: {} }, { headers: headers[0] }]) {
        const result = await config.streamSimple(a.session.model, { messages: [] }, { apiKey: "offline-fixture-only", ...options }).result();
        assert.match(result.errorMessage, /no native session request receipt/);
        assert.match(result.errorMessage, /owning AgentSession's stream path or an independent child AgentSession/);
      }
      assert.equal(state.sends.length, beforeSends);
    } finally { delete globalThis[key]; }
  });
});

test("native sibling CLI flags retain owned runtime, mode, fast and per-binding one-shot local force", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    const a = await create("cli-A", { flags: {
      "cursor-runtime": "local", "cursor-mode": "plan", "cursor-fast": true, "cursor-local-force": true,
    } });
    const b = await create("cli-B", { flags: {
      "cursor-runtime": "cloud", "cursor-cloud-env": "CLI_B_ENV", "cursor-cloud-env-type": "poll",
      "cursor-cloud-env-name": "B environment", "cursor-mode": "agent", "cursor-no-fast": true,
    } });
    const beforeB = b.manager.getEntries();
    await a.session.prompt("A CLI remains owned after cloud B binds");
    assert.equal(a.session.messages.at(-1).stopReason, "stop", a.session.messages.at(-1).errorMessage);
    const agent = state.created.find((entry) => entry.agentId === state.sends.at(-1).agentId);
    assert.equal(agent.options.local.cwd, a.cwd);
    assert.equal(agent.options.mode, "plan");
    assert.equal(agent.options.model.params.find((parameter) => parameter.id === "fast").value, "true");
    assert.equal(state.sends.at(-1).force, true);
    assert.deepEqual(b.manager.getEntries(), beforeB);
    const c = await create("cli-C", { flags: { "cursor-runtime": "local", "cursor-local-force": true } });
    await a.session.prompt("A force was already consumed");
    assert.equal(state.sends.at(-1).force, undefined);
    assert.equal(state.sends.at(-1).mode, "plan");
    await c.session.prompt("C has its own first force");
    assert.equal(state.sends.at(-1).force, true);
    await c.session.prompt("C force only once");
    assert.equal(state.sends.at(-1).force, undefined);
    await a.session.bindExtensions({ mode: "rpc" });
    const beforeReloadStream = a.session.modelRuntime.getProvider("cursor").streamSimple;
    await a.session.reload();
    assert.notEqual(a.session.modelRuntime.getProvider("cursor").streamSimple, beforeReloadStream, "reload replaces the provider closure");
    await a.session.prompt("A rebinding/reload does not reset its run's force");
    assert.equal(a.session.messages.at(-1).stopReason, "stop", a.session.messages.at(-1).errorMessage);
    assert.equal(state.sends.at(-1).force, undefined);
    assert.equal(state.sends.at(-1).mode, "plan");
  });
});

test("branch runtime, plan, fast and HTTP preferences remain owned by A after differently configured B binds", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    const a = await create("settings-A", { preferences: [
      ["cursor-runtime-state", { runtime: "local" }],
      ["cursor-mode-state", { mode: "plan" }],
      ["cursor-fast-state", { modelId: "fixture", fast: true }],
      ["cursor-http1-state", { enabled: true }],
    ] });
    const b = await create("settings-B", { preferences: [
      ["cursor-runtime-state", { runtime: "cloud", cloudAcknowledged: true }],
      ["cursor-mode-state", { mode: "agent" }],
      ["cursor-fast-state", { modelId: "fixture", fast: false }],
      ["cursor-http1-state", { enabled: false }],
    ] });
    const beforeB = b.manager.getEntries();
    await a.session.prompt("A owned configuration");
    assert.equal(a.session.messages.at(-1).stopReason, "stop");
    const agent = state.created.find((entry) => entry.agentId === state.sends.at(-1).agentId);
    assert.equal(agent.options.local.cwd, a.cwd);
    assert.equal(agent.options.mode, "plan");
    assert.equal(state.sends.at(-1).mode, "plan");
    assert.equal(agent.options.model.params.find((parameter) => parameter.id === "fast").value, "true");
    assert.deepEqual(state.configured.at(-1), { local: { useHttp1ForAgent: true } });
    assert.deepEqual(b.manager.getEntries(), beforeB);
  });
});
