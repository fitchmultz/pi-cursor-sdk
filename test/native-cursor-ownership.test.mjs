import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { concurrentFixture, retainNativeEvidence, SessionManager, setupNativeCursorHarness, state, storeRootOf } from "./helpers/native-cursor-harness.mjs";

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

test("separate extension graphs preserve live same-file agent claims and process-global transport cleanup", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create, copyExtension }) => {
    process.env.PI_CURSOR_LOCAL_RESUME = "1";
    process.env.PI_CURSOR_HTTP_1_1 = "1";
    const bootstrap = await create("bootstrap", { bind: false, extensionPath: await copyExtension("bootstrap") });
    const runtime = bootstrap.session.modelRuntime;
    const provider = runtime.getRegisteredNativeProvider("cursor");
    const registerNativeProvider = runtime.registerNativeProvider.bind(runtime);
    // A session-less host freezes this registration and ignores session registrations.
    runtime.registerNativeProvider = next => { if (next.id !== "cursor") registerNativeProvider(next); };
    const a = await create("shared-graph-A", {
      runtime, model: bootstrap.session.model, extensionPath: await copyExtension("owner-a"),
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
