import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { concurrentFixture, retainNativeEvidence, SessionManager, setupNativeCursorHarness, state } from "./helpers/native-cursor-harness.mjs";

setupNativeCursorHarness();

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
    assert.equal(state.resumed.at(-1).options.local.store.stateRoot, handle.storeIdentity.stateRoot);
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
