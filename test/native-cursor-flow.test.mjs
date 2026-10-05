import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { concurrentFixture, createAgentSession, DefaultResourceLoader, ModelRuntime, PiAgent, retainNativeEvidence, seedOfflineCatalog,
  SessionManager, SettingsManager, setupNativeCursorHarness } from "./helpers/native-cursor-harness.mjs";
import { Type } from "typebox";
import { state } from "./fixtures/native-cursor-sdk.mjs";
import { CLOUD_LIFECYCLE_ENTRY_TYPE, CLOUD_LIFECYCLE_JOURNAL_PREFIX } from "../shared/cursor-cloud-lifecycle-constants.mjs";

setupNativeCursorHarness();

test("registered Cursor provider preserves native bridge, replay, usage, queues, tree, compaction, abort and reload", { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-native-flow-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await seedOfflineCatalog(agentDir);
  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_CURSOR_SETTING_SOURCES: "none",
    CURSOR_API_KEY: "offline-fixture-only", PI_CURSOR_NATIVE_TOOL_DISPLAY: "1",
    PI_CURSOR_ASK_QUESTION: "0", PI_CURSOR_LOCAL_RESUME: "0",
  });
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["fixture_bridge"], compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
    systemPromptOverride: () => "NATIVE_CURSOR_FLOW_SYSTEM",
  });
  let session;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  // Allow only the extension-owned loopback MCP transport.
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, "127.0.0.1", "offline native flow must not access external services");
    fetchCalls++;
    return originalFetch(input, options);
  };
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(root, "models.json"), allowModelNetwork: false });
    // Binding installs the real extension's provider before selecting its model.
    const manager = SessionManager.create(root, join(root, "sessions"));
    let bridgeCalls = 0;
    ({ session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader,
      modelRuntime: runtime, sessionManager: manager, settingsManager,
      customTools: [{ name: "fixture_bridge", label: "Fixture bridge", description: "Offline bridge fixture",
        parameters: Type.Object({ value: Type.String() }),
        execute: async (_id, args) => { bridgeCalls++; return { content: [{ type: "text", text: args.value }], details: {} }; },
      }],
    }));
    const errors = [];
    await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
    const model = runtime.getModel("cursor", "fixture");
    assert.ok(model);
    await session.setModel(model);
    assert.deepEqual(errors, []);
    await session.prompt("BRIDGE_FIXTURE REPLAY_FIXTURE");
    assert.equal(bridgeCalls, 1, JSON.stringify({ errors, assistantMessages: session.messages.filter((message) => message.role === "assistant") }));
    assert.ok(fetchCalls > 0);
    assert.ok(state.bridgeCatalog.includes("pi__fixture_bridge"));
    assert.equal(state.bridgeResults[0].isError, undefined);
    assert.equal(state.created.length, 1, "bridge and native replay must drain the same Cursor agent/run");
    let entries = manager.getEntries();
    const results = entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").map((entry) => entry.message);
    assert.equal(state.bridgeResults.length, 1);
    assert.deepEqual(results.map((result) => result.toolName).sort(), ["fixture_bridge", "read"], "SDK bridge echoes must not create extra results or replay cards");
    assert.ok(results.some((result) => result.toolName === "fixture_bridge" && !result.isError));
    assert.ok(results.some((result) => result.toolName === "read" && !result.isError && result.content.some((block) => block.text?.includes("recorded offline read"))), JSON.stringify({ active: session.getActiveToolNames(), tools: session.getAllTools().map((tool) => tool.name), results, errors }));
    await assert.rejects(readFile(join(root, "never-read.txt")), { code: "ENOENT" });
    const firstSend = state.sends[0].message.text;
    assert.match(firstSend, /NATIVE_CURSOR_FLOW_SYSTEM/);
    await session.prompt("incremental followup");
    assert.equal(state.created.length, 1);
    assert.doesNotMatch(state.sends.at(-1).message.text, /NATIVE_CURSOR_FLOW_SYSTEM/);
    assert.match(state.sends.at(-1).message.text, /incremental followup/);
    entries = manager.getEntries();
    const usage = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1).message.usage;
    assert.equal(usage.input, 7);
    assert.equal(usage.cacheRead, 3);
    assert.equal(usage.output, 2);
    assert.equal(usage.totalTokens, 12);
    const branchTarget = entries.find((entry) => entry.type === "message" && entry.message.role === "user").id;
    await session.navigateTree(branchTarget, { summarize: false });
    await session.prompt("after tree");
    assert.equal(state.created.length, 2);
    await session.prompt("before compaction");
    const compaction = await session.compact();
    assert.ok(compaction.summary.includes("OFFLINE_CURSOR_DONE"));
    assert.ok(manager.getEntries().some((entry) => entry.type === "compaction"));
    await session.prompt("after compaction");
    assert.match(state.sends.at(-1).message.text, /NATIVE_CURSOR_FLOW_SYSTEM/);
    const running = session.prompt("CANCEL_FIXTURE");
    while (!state.sends.at(-1).message.text.includes("CANCEL_FIXTURE")) await delay(10, undefined, { signal: t.signal });
    await session.steer("queued request boundary");
    assert.deepEqual(session.getSteeringMessages(), ["queued request boundary"]);
    await session.abort();
    await running;
    assert.ok(state.cancelled.length > 0);
    // Preserve the queued input until the next ordinary request boundary.
    await session.prompt("resume after abort");
    assert.match(state.sends.at(-1).message.text, /queued request boundary/);
    const persisted = await readFile(manager.getSessionFile(), "utf8");
    assert.match(persisted, /cursor-sdk-agent-lineage/);
    assert.match(persisted, /"type":"compaction"/);
    assert.match(persisted, /queued request boundary/);
    const beforeReload = state.created.length;
    await session.reload();
    await session.prompt("after reload");
    assert.ok(state.created.length > beforeReload);
    assert.ok(state.disposed.length > 0);
    assert.deepEqual(errors, []);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(state.disposed.length, state.created.length);
    assert.ok(state.stores.every((store) => store.disposed));
  } finally {
    if (session) {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    state.heldCwds.clear();
    state.failedCwds.clear();
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    await rm(root, { recursive: true, force: true });
  }
});

test("native request receipts route bounded capability notices only to their owning persisted session", { timeout: 30000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    const a = await create("notice-owner"), b = await create("notice-sibling");
    const proof = process.env.PI_CURSOR_BOOTSTRAP_PROOF_DIR;
    const capture = proof && JSON.parse(await readFile(join(proof, "sdk-capture-ansi.json"), "utf8"));
    const plugin = capture?.plugin ?? "[local-plugins-bootstrap] loadUserLocalPlugin outside rejected: symlink target /outside is outside /local-root {}\n";
    const parser = capture?.parserWarning ?? "shell-parser: tree-sitter natives are unavailable in this artifact; shell command analysis degrades to parsingFailed";
    state.outputByCwd.set(a.cwd, [{ stream: "stderr", bytes: plugin + plugin + parser + "\n" }]);
    const stdout = process.stdout.write, stderr = process.stderr.write, retained = [];
    const collect = (bytes, encoding, callback) => { retained.push(Buffer.from(bytes).toString()); (typeof encoding === "function" ? encoding : callback)?.(); return true; };
    try {
      process.stdout.write = process.stderr.write = collect;
      await Promise.all([a.session.prompt("notice owner request"), b.session.prompt("notice sibling request")]);
    } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
    const persisted = await readFile(a.manager.getSessionFile(), "utf8");
    const notices = a.manager.getEntries().filter(e => e.type === "custom" && e.customType === "pi-cursor-sdk:capability-notice");
    assert.deepEqual(notices.map(e => e.data.kind), ["outsidePlugin", "parserUnavailable"]);
    assert.ok(notices.every(e => e.data.message.length < 200));
    assert.doesNotMatch(persisted, /symlink target|\/outside|local-root|managed_skills|natives are unavailable in this artifact/);
    assert.doesNotMatch(await readFile(b.manager.getSessionFile(), "utf8"), /capability-notice/);
    assert.match(retained.join(""), /Cursor skipped a local plugin/);
    assert.match(retained.join(""), /Cursor shell analysis is degraded/);
    assert.doesNotMatch(retained.join(""), /local-plugins-bootstrap|managed_skills|shell-parser:/);
    await a.session.prompt("after notices");
    assert.doesNotMatch(state.sends.at(-1).message.text, /Cursor skipped a local plugin|Cursor shell analysis is degraded/);
    await retainNativeEvidence("native-notice-owner", a.manager, a.cwd);
    await retainNativeEvidence("native-notice-sibling", b.manager, b.cwd);
  });
});

for (const runtime of ["local", "cloud"]) {
  test(`real ${runtime} fork inheriting a pending bridge result cannot drain, block or dispose its parent`, { timeout: 60000 }, async (t) => {
    await concurrentFixture(t, async ({ root, create }) => {
      const key = Symbol.for("cursor-native-fork-pause");
      const pause = join(root, "fork-pause.mjs");
      await writeFile(pause, `export default function(pi) { let paused = false;
        pi.on("before_provider_headers", async (_event, ctx) => {
          if (!paused && ctx.sessionManager.getBranch().some(e => e.type === "message" && e.message.role === "toolResult")) {
            paused = true; await globalThis[Symbol.for("cursor-native-fork-pause")]();
          }
        }); }`);
      let child;
      let duringChild;
      const parent = await create("fork-parent", { afterExtensions: [pause] });
      const before = { results: state.bridgeResults.length, cancelled: state.cancelled.length };
      globalThis[key] = async () => {
        const parentAgent = state.sends.at(-1).agentId;
        const manager = SessionManager.forkFrom(parent.manager.getSessionFile(), join(root, "fork-child"), join(root, "sessions"));
        child = await create("fork-child", { manager, flags: runtime === "cloud" ? {
          "cursor-runtime": "cloud", "cursor-cloud-ack": true, "cursor-cloud-context": "fresh", "cursor-cloud-allow-local-state": true,
        } : {} });
        assert.ok(manager.getBranch().some(e => e.type === "message" && e.message.role === "toolResult"), "fork carries the real parent's completed Pi tool result");
        await child.session.prompt("child fork continuation");
        duringChild = { parentAgent, results: state.bridgeResults.length, cancelled: state.cancelled.length, disposed: state.disposed.includes(parentAgent) };
      };
      try {
        await parent.session.prompt("BRIDGE_FIXTURE");
        assert.ok(duringChild, "native callback ran between Pi result and Cursor continuation");
        assert.equal(duringChild.results, before.results, "child must not resolve the parent's pending bridge call");
        assert.equal(duringChild.cancelled, before.cancelled);
        assert.equal(duringChild.disposed, false);
        assert.equal(child.session.messages.at(-1).stopReason, "stop", child.session.messages.at(-1).errorMessage);
        assert.equal(parent.session.messages.at(-1).stopReason, "stop");
        assert.equal(state.bridgeResults.length, before.results + 1, "parent itself resolves its pending result");
        await parent.session.prompt("parent keeps its original pool");
        assert.equal(state.sends.at(-1).agentId, duringChild.parentAgent);
        for (const owner of runtime === "local" ? [parent, child] : [parent]) {
          const agents = state.created.filter(e => e.options.local?.cwd === owner.cwd);
          assert.equal(agents.length, 1);
          assert.match(await readFile(owner.manager.getSessionFile(), "utf8"), new RegExp(agents[0].agentId));
        }
        if (runtime === "cloud") {
          const cloudSend = state.sends.findLast(e => e.agentId.startsWith("bc-"));
          const cloudAgent = state.created.find(e => e.agentId === cloudSend.agentId);
          assert.ok(cloudAgent.options.cloud);
          assert.match(await readFile(child.manager.getSessionFile(), "utf8"), new RegExp(cloudAgent.agentId));
          assert.ok((await cloudJournal(child.manager)).every(e => e.sessionFile === child.manager.getSessionFile()));
        }
      } finally { delete globalThis[key]; }
    });
  });
}

function modelToolStream(toolCall) {
  let sent = false;
  return (model) => {
    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: sent ? [{ type: "text", text: "adversary complete" }] : [toolCall],
      stopReason: sent ? "stop" : "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    sent = true;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end(message);
    return stream;
  };
}

for (const attack of ["foreign owner", "wrong tool"]) {
  test(`public Pi scheduler rejects ${attack} delivery of a real pending Cursor replay ID`, { timeout: 60000 }, async (t) => {
    await concurrentFixture(t, async ({ root, create }) => {
      const key = Symbol.for("cursor-native-replay-pause");
      const pause = join(root, "replay-pause.mjs");
      await writeFile(pause, `export default function(pi) {
        pi.on("tool_call", async event => {
          if (event.toolName === "read" && event.toolCallId.startsWith("cursor-replay-"))
            await globalThis[Symbol.for("cursor-native-replay-pause")](event.toolCallId);
        }); }`);
      const a = await create("replay-A", { afterExtensions: [pause] });
      const b = await create("replay-B");
      await writeFile(join(b.cwd, "native-fallback.txt"), "B filesystem must not be read");
      const marker = join(a.cwd, "wrong-tool-side-effect");
      let rejected;
      let actualId;
      globalThis[key] = async (id) => {
        actualId = id;
        if (attack === "foreign owner") {
          const originalStream = b.session.agent.streamFunction;
          b.session.agent.streamFunction = modelToolStream({ type: "toolCall", id, name: "read", arguments: { path: "native-fallback.txt" } });
          try {
            await b.session.prompt("untrusted model presents A replay id");
            rejected = b.session.messages.findLast(m => m.role === "toolResult" && m.toolCallId === id);
          } finally { b.session.agent.streamFunction = originalStream; }
        } else {
          const agent = new PiAgent({ initialState: { model: a.session.model, tools: a.session.agent.state.tools },
            streamFn: modelToolStream({ type: "toolCall", id, name: "bash", arguments: { command: "printf forbidden > wrong-tool-side-effect" } }) });
          await agent.prompt("untrusted model presents read replay id as bash");
          rejected = agent.state.messages.findLast(m => m.role === "toolResult" && m.toolCallId === id);
        }
      };
      try {
        await a.session.prompt("REPLAY_FIXTURE");
        assert.ok(actualId, "ID comes from A's SDK completion and actual Pi tool_call, not a fabricated receipt");
        assert.ok(rejected);
        assert.equal(rejected.isError, true, JSON.stringify(rejected));
        assert.doesNotMatch(JSON.stringify(rejected.content), /recorded offline read|B filesystem must not be read/);
        await assert.rejects(readFile(marker), { code: "ENOENT" });
        const rightful = a.manager.getEntries().find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === actualId)?.message;
        assert.ok(rightful && !rightful.isError, JSON.stringify(rightful));
        assert.match(JSON.stringify(rightful.content), /recorded offline read/, "denied delivery leaves A's result available");
        await assert.rejects(readFile(join(a.cwd, "never-read.txt")), { code: "ENOENT" });
        if (attack === "foreign owner") {
          const originalStream = b.session.agent.streamFunction;
          b.session.agent.streamFunction = modelToolStream({ type: "toolCall", id: "ordinary-native-read", name: "read", arguments: { path: "native-fallback.txt" } });
          try { await b.session.prompt("ordinary native read"); }
          finally { b.session.agent.streamFunction = originalStream; }
          const ordinary = b.session.messages.findLast(m => m.role === "toolResult" && m.toolCallId === "ordinary-native-read");
          assert.ok(ordinary && !ordinary.isError);
          assert.match(JSON.stringify(ordinary.content), /B filesystem must not be read/);
        }
      } finally { delete globalThis[key]; }
    });
  });
}

const offlineCloudAgent = "bc-00000000-0000-0000-0000-000000000234";
function appendCloudRecord(manager) {
  return manager.appendCustomEntry(CLOUD_LIFECYCLE_ENTRY_TYPE, { action: "record", runtime: "cloud", agentId: offlineCloudAgent, timestamp: new Date().toISOString() });
}
async function cloudJournal(manager) {
  const directory = dirname(manager.getSessionFile());
  const paths = (await readdir(directory)).filter(p => p.startsWith(CLOUD_LIFECYCLE_JOURNAL_PREFIX) && p.endsWith(".journal"));
  const entries = [];
  for (const path of paths) entries.push(...(await readFile(join(directory, path), "utf8")).trim().split("\n").map(line => JSON.parse(line)));
  return entries.filter(entry => entry.sessionId === manager.getSessionId());
}

test("owning public manager cannot acquire Cloud delete authority by switching branches during auth", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    const a = await create("cloud-auth");
    await a.session.prompt("persist original branch");
    const originalLeaf = a.manager.getLeafId();
    const targetLeaf = appendCloudRecord(a.manager);
    a.manager.branch(originalLeaf);
    const entered = Promise.withResolvers();
    const auth = Promise.withResolvers();
    const registry = a.session.extensionRunner.getModelRegistry();
    registry.getApiKeyForProvider = () => { entered.resolve(); return auth.promise; };
    const before = state.cloudMutations.length;
    const command = a.session.prompt(`/cursor-cloud delete ${offlineCloudAgent} --yes`);
    await entered.promise;
    a.manager.branch(targetLeaf);
    auth.resolve("offline-fixture-only");
    await command;
    assert.equal(state.cloudMutations.length, before, "unrecorded originating branch cannot borrow the newly selected branch's authority");
    assert.deepEqual(await cloudJournal(a.manager), [], "no destructive intent after authority changed");
  });
});

for (const transition of ["branch", "reload", "shutdown"]) {
  test(`Cloud SDK completion survives owning ${transition} in the original durable journal`, { timeout: 60000 }, async (t) => {
    await concurrentFixture(t, async ({ create }) => {
      const a = await create(`cloud-${transition}`);
      await a.session.prompt("persist cloud command owner");
      const originalLeaf = a.manager.getLeafId();
      const recordLeaf = appendCloudRecord(a.manager);
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      state.cloudMutationWait = { entered, release };
      const before = state.cloudMutations.length;
      const command = a.session.prompt(`/cursor-cloud delete ${offlineCloudAgent} --yes`);
      await entered.promise;
      const postStartLeaf = a.manager.getLeafId();
      const intent = (await cloudJournal(a.manager)).at(-1);
      assert.equal(intent.action, "delete_intent");
      assert.equal(intent.anchorEntryId, recordLeaf);
      if (transition === "branch") a.manager.branch(originalLeaf);
      else if (transition === "reload") await a.session.reload();
      else await a.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      const selectedLeaf = a.manager.getLeafId();
      release.resolve();
      await command;
      const journal = await cloudJournal(a.manager);
      assert.deepEqual(journal.map(e => e.action), ["delete_intent", "delete"]);
      assert.equal(journal.at(-1).anchorEntryId, postStartLeaf, "completion retains its original post-start anchor");
      assert.ok(journal.every(e => e.sessionFile === a.manager.getSessionFile()));
      assert.equal(state.cloudMutations.length, before + 1);
      assert.equal(a.manager.getLeafId(), selectedLeaf, "no mirror into the replacement/current branch");
    });
  });
}

test("real parent bridge tool launches a child before parent turn_end without journal/pool bleed", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    let parentTurnEnded = false;
    let child;
    let childResult;
    const parent = await create("parent", { tool: async () => {
      assert.equal(parentTurnEnded, false, "host tools execute inside the parent turn");
      child = await create("child");
      await child.session.prompt("child owned request");
      childResult = child.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1).message;
      return { content: [{ type: "text", text: "child complete" }], details: {} };
    } });
    parent.session.subscribe((event) => { if (event.type === "turn_end") parentTurnEnded = true; });
    await parent.session.prompt("BRIDGE_FIXTURE");
    assert.ok(child);
    assert.equal(childResult.stopReason, "stop", childResult.errorMessage);
    for (const owner of [parent, child]) {
      const lineage = owner.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "cursor-sdk-agent-lineage");
      assert.ok(lineage.length > 0);
      assert.ok(lineage.every((entry) => entry.data.scopeKey === owner.manager.getSessionFile() && entry.data.cwd === owner.cwd));
      const agents = state.created.filter((entry) => entry.options.local?.cwd === owner.cwd);
      assert.equal(agents.length, 1);
      assert.ok(state.stores.some((store) => store.workspaceRef === owner.cwd));
      assert.ok((await readFile(owner.manager.getSessionFile(), "utf8")).includes(agents[0].agentId));
    }
    await parent.session.prompt("parent followup");
    assert.equal(state.created.filter((entry) => entry.options.local?.cwd === parent.cwd).length, 1);
  });
});

async function shortIdleExtension(root) {
  const idle = join(root, "short-idle.mjs");
  await writeFile(idle, `import { __testUtils } from ${JSON.stringify(new URL("../dist/cursor-provider.js", import.meta.url).href)};
      export default function(pi) {
        __testUtils.setCursorNativeReplayIdleDisposeMs(20);
        pi.on("session_shutdown", () => __testUtils.resetCursorNativeReplayIdleDisposeMs());
      }`);
  return idle;
}

for (const cleanup of ["answer", "abort", "shutdown", "deadline"]) {
  const title = cleanup === "answer"
    ? "real deferred bridged question survives idle abandonment and resumes the same SDK run"
    : `real pending bridge work still cleans up exactly once on ${cleanup}`;
  test(title, { timeout: 60000 }, async (t) => {
    await concurrentFixture(t, async ({ root, create }) => {
      if (cleanup === "deadline") process.env.PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS = "500";
      const idle = await shortIdleExtension(root);
      const entered = Promise.withResolvers();
      const answer = Promise.withResolvers();
      let actualToolCallId;
      let executionAborts = 0;
      const owner = await create(`pending-${cleanup}`, { beforeExtensions: [idle], tool: async (id, _args, signal) => {
        actualToolCallId = id;
        const abort = () => { executionAborts++; answer.reject(new Error("owned execution aborted")); };
        signal.addEventListener("abort", abort, { once: true });
        entered.resolve();
        try { await answer.promise; }
        finally { signal.removeEventListener("abort", abort); }
        return { content: [{ type: "text", text: "delayed owned answer" }], details: {} };
      } });
      const before = { sends: state.sends.length, results: state.bridgeResults.length };
      const outputReady = Promise.withResolvers(), outputEmitted = Promise.withResolvers();
      const proof = process.env.PI_CURSOR_BOOTSTRAP_PROOF_DIR;
      const capture = proof && JSON.parse(await readFile(join(proof, "sdk-capture-ansi.json"), "utf8"));
      const plugin = capture?.plugin ?? "[local-plugins-bootstrap] loadUserLocalPlugin outside rejected: symlink target /outside is outside /local-root {}\n";
      const parser = capture?.parserWarning ?? "shell-parser: tree-sitter natives are unavailable in this artifact; shell command analysis degrades to parsingFailed";
      state.waitOutputByCwd.set(owner.cwd, { ready: outputReady.promise, emitted: outputEmitted.resolve,
        bytes: [{ stream: "stderr", bytes: plugin + plugin + parser + "\n" }, ...(capture ? [{ stream: "stdout", bytes: capture.inventory }] : [])] });
      const stdout = process.stdout.write, stderr = process.stderr.write, retained = [];
      const collect = (bytes, encoding, callback) => { retained.push(Buffer.from(bytes).toString()); (typeof encoding === "function" ? encoding : callback)?.(); return true; };
      process.stdout.write = process.stderr.write = collect;
      const running = owner.session.prompt("BRIDGE_FIXTURE");
      try {
        await entered.promise;
        const liveSink = process.stderr.write;
        assert.notEqual(liveSink, collect, "sink lease survives the actual Pi tool-use stream ending");
        outputReady.resolve();
        await outputEmitted.promise; // fixture run.wait is still deferred on the real pending bridge
        assert.equal(process.stderr.write, liveSink, "diagnostic uses the same lease, not a replacement");
        assert.doesNotMatch(retained.join(""), /local-plugins-bootstrap|managed_skills|shell-parser:/);
        assert.match(retained.join(""), /Cursor skipped a local plugin/);
        assert.match(retained.join(""), /Cursor shell analysis is degraded/);
        const send = state.sends[before.sends];
        await delay(80, undefined, { signal: t.signal });
        assert.equal(state.cancelled.includes(send.runId), false, "pending Pi execution is not idle abandonment");
        assert.equal(state.disposed.includes(send.agentId), false);
        assert.equal(state.bridgeResults.length, before.results);
        if (cleanup === "answer") answer.resolve();
        else if (cleanup === "abort") await owner.session.abort();
        else if (cleanup === "shutdown") await owner.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await running;
        assert.equal(state.sends.length, before.sends + 1, "no fresh SDK send for continuation or cleanup");
        if (cleanup === "answer") {
          assert.equal(executionAborts, 0);
          assert.equal(state.bridgeResults.length, before.results + 1);
          assert.deepEqual(state.bridgeResults.at(-1).content, [{ type: "text", text: "delayed owned answer" }]);
          assert.equal(owner.session.messages.at(-1).stopReason, "stop", owner.session.messages.at(-1).errorMessage);
          const persisted = (await readFile(owner.manager.getSessionFile(), "utf8")).trim().split("\n").map(line => JSON.parse(line));
          const calls = persisted.filter(e => e.type === "message" && e.message.role === "assistant")
            .flatMap(e => e.message.content.filter(c => c.type === "toolCall"));
          const results = persisted.filter(e => e.type === "message" && e.message.role === "toolResult").map(e => e.message);
          assert.equal(calls.length, 1);
          assert.equal(calls[0].id, actualToolCallId);
          assert.equal(results.length, 1);
          assert.equal(results[0].toolCallId, actualToolCallId);
          assert.equal(results[0].isError, false);
          assert.match(JSON.stringify(results[0].content), /delayed owned answer/);
          assert.equal(state.created.filter(e => e.options.local?.cwd === owner.cwd).length, 1);
          assert.ok(persisted.some(e => e.type === "custom" && e.customType === "cursor-sdk-agent-lineage" && e.data.agentId === send.agentId));
          const facts = persisted.filter(e => e.type === "custom" && e.customType === "pi-cursor-sdk:usage-v1").map(e => e.data);
          assert.ok(facts.some(fact => fact.kind === "run" && fact.runId === send.runId && fact.origin.sessionFile === owner.manager.getSessionFile()));
          assert.ok(facts.some(fact => fact.kind === "terminal" && fact.status === "success"));
        } else {
          // SDK/MCP completion and its existing fail-closed finalizer are asynchronous.
          while (!state.disposed.includes(send.agentId)) await delay(5, undefined, { signal: t.signal });
          assert.equal(executionAborts, 1);
          assert.equal(state.cancelled.filter(id => id === send.runId).length, 1);
          assert.equal(state.disposed.filter(id => id === send.agentId).length, 1);
          assert.ok(state.stores.filter(store => store.workspaceRef === owner.cwd).every(store => store.disposed));
        }
        await retainNativeEvidence(`pending-bridge-${cleanup === "answer" ? "idle" : cleanup}`, owner.manager, owner.cwd);
        assert.equal(process.stdout.write, collect, "completion/cancellation restores stdout");
        assert.equal(process.stderr.write, collect, "completion/cancellation restores stderr");
        const notices = owner.manager.getEntries().filter(e => e.type === "custom" && e.customType === "pi-cursor-sdk:capability-notice");
        assert.deepEqual(notices.map(e => e.data.kind), ["outsidePlugin", "parserUnavailable"]);
        assert.ok(notices.every(e => e.data.message.length < 200));
        assert.doesNotMatch(await readFile(owner.manager.getSessionFile(), "utf8"), /symlink target|natives are unavailable in this artifact/);
      } finally { outputReady.resolve(); answer.resolve(); await running; process.stdout.write = stdout; process.stderr.write = stderr; }
    });
  });
}

for (const operation of ["compact", "tree", "bugreport"]) {
  test(`idle A ${operation} after B binds retains A's direct-stream storage and persisted lineage`, { timeout: 60000 }, async (t) => {
    await concurrentFixture(t, async ({ root, create }) => {
      await writeFile(join(root, "agent", "cursor-sdk.json"), JSON.stringify({
        subagents: { reviewer: { description: "Review changes", prompt: "Review the work.", model: "inherit" } },
      }));
      const a = await create("A", { flags: { "cursor-mode": "plan" } });
      await a.session.prompt("first A");
      assert.deepEqual(Object.keys(state.created.find(agent => agent.agentId === state.sends.at(-1).agentId).options.agents), ["reviewer"]);
      const branchTarget = a.manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user").id;
      await a.session.prompt("second A");
      const b = await create("B");
      await b.session.prompt("B idle");
      const beforeB = await readFile(b.manager.getSessionFile(), "utf8");
      const before = state.sends.length;
      const storesBefore = state.stores.length;
      const derivationsBefore = state.defaultRootCwds.length;
      const lineageBefore = a.manager.getEntries().filter(e => e.type === "custom" && ["cursor-sdk-agent-lineage", "cursor-sdk-agent-resume"].includes(e.customType));
      const previousRoot = process.env.PI_CURSOR_SDK_STATE_ROOT;
      try {
        if (operation !== "bugreport") process.env.PI_CURSOR_SDK_STATE_ROOT = "unusable-relative-persistent-root";
        if (operation === "compact") await a.session.compact();
        else if (operation === "tree") await a.session.navigateTree(branchTarget, { summarize: true });
        else await a.session.summarizeForBugReport({ hint: "summarize A", signal: t.signal });
      } finally {
        if (previousRoot === undefined) delete process.env.PI_CURSOR_SDK_STATE_ROOT;
        else process.env.PI_CURSOR_SDK_STATE_ROOT = previousRoot;
      }
      assert.ok(state.sends.length > before, "real host issued a direct auxiliary stream");
      for (const send of state.sends.slice(before)) {
        const agent = state.created.find((entry) => entry.agentId === send.agentId);
        assert.equal(agent.options.local.cwd, a.cwd);
        if (operation !== "bugreport") assertIsolatedSummary(agent, send);
        else {
          assert.equal(agent.options.mode, "plan", "no public bug-report purpose hook: ordinary capabilities stay intact");
          assert.deepEqual(Object.keys(agent.options.agents), ["reviewer"]);
        }
      }
      if (operation !== "bugreport") {
        assert.equal(new Set(state.sends.slice(before).map(send => send.agentId)).size, state.sends.length - before, "each native summary gets a fresh agent");
        assert.deepEqual(a.manager.getEntries().filter(e => e.type === "custom" && ["cursor-sdk-agent-lineage", "cursor-sdk-agent-resume"].includes(e.customType)), lineageBefore);
        assert.equal(state.defaultRootCwds.length, derivationsBefore, "summaries never derive a persistent workspace root");
        const summaryStores = state.stores.slice(storesBefore);
        assert.equal(new Set(summaryStores.map(store => store.stateRoot)).size, summaryStores.length, "each invocation has a unique temporary store");
        await assertSummaryStoresRemoved(summaryStores);
      }
      assert.equal(await readFile(b.manager.getSessionFile(), "utf8"), beforeB);
      const metadataPaths = (await readdir(a.cwd, { recursive: true })).filter((path) => path.endsWith("metadata.json"));
      assert.ok(metadataPaths.length > 0);
      for (const path of metadataPaths) {
        const metadata = JSON.parse(await readFile(join(a.cwd, path), "utf8"));
        assert.equal(metadata.sessionFile, a.manager.getSessionFile());
      }
      assert.ok(a.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "cursor-sdk-agent-lineage").every((entry) => entry.data.scopeKey === a.manager.getSessionFile()));
      await a.session.prompt("A resumes after auxiliary");
      const resumed = state.created.find((entry) => entry.agentId === state.sends.at(-1).agentId);
      assert.equal(resumed.options.local.cwd, a.cwd);
      assert.equal(resumed.options.mode, "plan");
      assert.ok(resumed.options.mcpServers?.pi_tools, "ordinary bridge restored after summary");
      assert.deepEqual(Object.keys(resumed.options.agents), ["reviewer"]);
      await retainNativeEvidence(`auxiliary-${operation}`, a.manager, a.cwd);
    });
  });
}

test("real unstarted child reload cannot dispose or terminally close parent's pooled agent", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    const parent = await create("parent");
    await parent.session.prompt("parent alive");
    const parentAgent = state.sends.at(-1).agentId;
    const child = await create("unstarted", { bind: false });
    await child.session.reload();
    assert.equal(state.disposed.includes(parentAgent), false);
    await parent.session.prompt("parent still alive");
    assert.equal(state.sends.at(-1).agentId, parentAgent);
    assert.equal(parent.session.messages.at(-1).stopReason, "stop");
  });
});

for (const failure of ["cancel", "error"]) {
  test(`real compaction ${failure} releases only A and permits a resumed ordinary turn`, { timeout: 60000 }, async (t) => {
    await concurrentFixture(t, async ({ create }) => {
      process.env.PI_CURSOR_LOCAL_RESUME = "1";
      const a = await create("failure-A");
      await a.session.prompt("A first");
      await a.session.prompt("A second");
      const b = await create("failure-B");
      await b.session.prompt("B stays live");
      const bAgent = state.sends.at(-1).agentId;
      const beforeB = await readFile(b.manager.getSessionFile(), "utf8");
      if (failure === "cancel") state.heldCwds.add(a.cwd);
      else state.failedCwds.add(a.cwd);
      const before = state.sends.length;
      const storesBefore = state.stores.length;
      const compact = a.session.compact();
      const observed = assert.rejects(compact);
      while (state.sends.length === before) await delay(1, undefined, { signal: t.signal });
      if (failure === "cancel") a.session.abortCompaction();
      await observed;
      for (const send of state.sends.slice(before)) assertIsolatedSummary(state.created.find(e => e.agentId === send.agentId), send);
      await assertSummaryStoresRemoved(state.stores.slice(storesBefore));
      state.heldCwds.delete(a.cwd);
      assert.equal(state.disposed.includes(bAgent), false);
      assert.equal(await readFile(b.manager.getSessionFile(), "utf8"), beforeB);
      await a.session.prompt("A resumes after failed compact");
      assert.equal(a.session.messages.at(-1).stopReason, "stop");
      assert.ok(state.created.find(e => e.agentId === state.sends.at(-1).agentId).options.mcpServers?.pi_tools, "ordinary bridge remains available after failed/cancelled summary");
      const resume = a.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "cursor-sdk-agent-resume").at(-1);
      assert.ok(resume, "ordinary turn persists its own resume after unsuccessful compaction");
      assert.equal(resume.data.scopeKey, a.manager.getSessionFile());
      assert.equal(resume.data.agentId, state.sends.at(-1).agentId);
      await b.session.prompt("B unchanged pool");
      assert.equal(state.sends.at(-1).agentId, bAgent);
      await retainNativeEvidence(`summary-${failure}`, a.manager, a.cwd);
    });
  });
}

test("shared runtime requests require their actual session's registration and an active binding", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ create }) => {
    const a = await create("shared-A");
    await a.session.prompt("A before sharing");
    const b = await create("shared-B", { runtime: a.session.modelRuntime, bind: false });
    const staleStream = a.session.modelRuntime.getProvider("cursor").streamSimple;
    const beforeSends = state.sends.length;
    await a.session.prompt("cannot use unbound B closure");
    assert.match(a.session.messages.at(-1).errorMessage, /binding is not active/);
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
    assert.equal(state.created.find((entry) => entry.agentId === state.sends.at(-1).agentId).options.local.cwd, b.cwd);
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
    assert.equal(state.created.find((entry) => entry.agentId === state.sends.at(-1).agentId).options.local.cwd, a.cwd);
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

for (const scenario of ["context edit", "retained clock skew", "equal checkpoint clock", "quoted wrapper", "transformed request"]) {
  test(`registered provider without SDK occupancy respects native source chronology: ${scenario}`, { timeout: 60000 }, async (t) => {
    await concurrentFixture(t, async ({ root, create }) => {
      const cwd = join(root, "floor-owner");
      const manager = SessionManager.create(cwd, join(root, "sessions"));
      const measured = (tokens, timestamp = Date.now()) => ({
        role: "assistant", content: [{ type: "text", text: "historical answer" }], api: "cursor-sdk", provider: "cursor", model: "fixture",
        stopReason: "stop", timestamp, usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      const userId = manager.appendMessage({ role: "user", content: "prior request", timestamp: Date.now() });
      const retained = manager.appendMessage(measured(100000, scenario === "retained clock skew" ? Date.now() + 86400000 : Date.now()));
      if (scenario === "context edit") manager.appendContextEdit(userId, { content: "tiny" });
      if (["retained clock skew", "equal checkpoint clock"].includes(scenario)) {
        const checkpoint = manager.appendCompaction("short native checkpoint", retained, 100000);
        if (scenario === "equal checkpoint clock") manager.appendMessage(measured(1234, Date.parse(manager.getEntry(checkpoint).timestamp)));
      }
      if (scenario === "quoted wrapper") manager.appendMessage({ role: "user", timestamp: Date.now(), content:
        "The conversation history before this point was compacted into the following summary:\n\n<summary>\nQuoted text, not a real checkpoint\n</summary>" });
      const afterExtensions = [];
      if (scenario === "transformed request") {
        const transform = join(root, "transform.mjs");
        await writeFile(transform, `export default function(pi) { pi.on("context", event => ({ messages: event.messages.map(m => m.role === "assistant" ? { ...m, content: [{ type: "text", text: "short transformed content" }] } : m) })); }`);
        afterExtensions.push(transform);
      }
      const owner = await create("floor-owner", { manager, afterExtensions });
      state.usageByCwd.set(owner.cwd, { raw: undefined });
      await owner.session.prompt("short new request");
      const answer = owner.manager.getEntries().findLast(e => e.type === "message" && e.message.role === "assistant").message;
      assert.equal(answer.stopReason, "stop", answer.errorMessage);
      assert.equal(answer.usage.input + answer.usage.output + answer.usage.cacheRead + answer.usage.cacheWrite, answer.usage.totalTokens);
      if (scenario === "quoted wrapper") assert.ok(answer.usage.totalTokens >= 100000, "ordinary summary-looking text cannot invalidate a proven floor");
      else if (scenario === "equal checkpoint clock") assert.ok(answer.usage.totalTokens >= 1234 && answer.usage.totalTokens < 10000, "raw post-checkpoint chronology beats equal timestamps");
      else assert.ok(answer.usage.totalTokens < 10000, "invalidated or request-inapplicable historical floor must not leak through provider preparation");
    });
  });
}

function assertIsolatedSummary(agent, send) {
  assert.deepEqual(agent.options.tools, [], "summary disables SDK tools, not just Pi declarations");
  assert.equal(agent.options.mode, "agent");
  assert.deepEqual(agent.options.local.settingSources, []);
  assert.equal(agent.options.mcpServers, undefined);
  assert.equal(agent.options.agents, undefined, "summary has no configured native delegates");
  assert.equal(send.mode, "agent");
  assert.doesNotMatch(send.message.text, /Callable tool surfaces this run:|Cursor SDK mode is plan for this run/);
  assert.ok(state.disposed.includes(agent.agentId), "summary agent disposed before native operation completes");
}

async function assertSummaryStoresRemoved(stores) {
  assert.ok(stores.length > 0, "summary opens its own store");
  for (const store of stores) {
    assert.equal(store.disposed, true);
    await assert.rejects(readdir(store.stateRoot), { code: "ENOENT" }, `summary store root survives: ${store.stateRoot}`);
  }
}

for (const pressure of [false, true]) {
  test(`real registered provider ${pressure ? "genuine pressure auto-compacts" : "large cumulative bills never trigger false overflow"}`, { timeout: 60000 }, async (t) => {
    await concurrentFixture(t, async ({ create }) => {
      const owner = await create(`occupancy-${pressure}`, { compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 } });
      await owner.session.setModel({ ...owner.session.model, contextWindow: 128000 });
      // SDK turn-ended input includes cache. Public AgentUsage categories are
      // disjoint cumulative spend, not the current prompt's occupancy.
      state.usageByCwd.set(owner.cwd, {
        raw: { inputTokens: pressure ? 125000 : 25, outputTokens: 6, cacheReadTokens: 5, cacheWriteTokens: 0 },
        billed: { inputTokens: 150000, outputTokens: 40, cacheReadTokens: 150000, cacheWriteTokens: 0, totalTokens: 300040 },
      });
      for (let index = 0; index < (pressure ? 1 : 3); index++) await owner.session.prompt(`short occupancy turn ${index}`);
      const persisted = (await readFile(owner.manager.getSessionFile(), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const compactions = persisted.filter(e => e.type === "compaction");
      const ordinary = persisted.filter(e => e.type === "message" && e.message.role === "assistant").map(e => e.message);
      assert.equal(ordinary.length, pressure ? 1 : 3);
      for (const message of ordinary) {
        assert.equal(message.stopReason, "stop", message.errorMessage);
        const usage = message.usage;
        assert.equal(usage.input + usage.output + usage.cacheRead + usage.cacheWrite, usage.totalTokens);
        assert.equal(usage.totalTokens, pressure ? 125006 : 31);
      }
      assert.equal(compactions.length, pressure ? 1 : 0, "native scheduler honors current occupancy, not agent spend");
      if (!pressure) {
        const records = persisted.filter(e => e.type === "custom" && e.customType === "pi-cursor-sdk:usage-v1").map(e => e.data);
        const starts = records.filter(record => record.kind === "start" && record.data.purpose === "normal");
        assert.equal(starts.length, 3, "each native ordinary send has its own durable origin");
        const ordinaryTurns = new Set(starts.map(record => record.turnId));
        for (const record of records.filter(record => ordinaryTurns.has(record.turnId))) {
          assert.equal(record.origin.sessionFile, owner.manager.getSessionFile());
          assert.equal(record.origin.sessionId, owner.manager.getSessionId());
          const claim = persisted.find(entry => entry.id === record.origin.anchorId);
          assert.equal(claim.customType, "pi-cursor-sdk:usage-origin-v1");
          assert.equal(claim.data.turnId, record.turnId, "usage is anchored to its actual native claim, not the latest mutable leaf");
        }
        const raw = records.filter(record => record.kind === "raw" && ordinaryTurns.has(record.turnId));
        assert.equal(raw.length, 3);
        assert.ok(raw.every(record => record.reported.inputTokens === 25 && record.reported.totalTokens === 36 && record.corrected.inputTokens === 20 && record.corrected.totalTokens === 31), "raw SDK telemetry and corrected context partition remain separately persisted");
        const bills = records.filter(record => record.kind === "billing" && ordinaryTurns.has(record.turnId));
        assert.equal(bills.length, 3);
        assert.equal(bills.at(-1).observation.status, "observed-pending-settlement");
        assert.equal(bills.at(-1).observation.usage.totalTokens, 900120, "complete cumulative bills survive outside native occupancy");
        assert.deepEqual(bills.map(record => record.observation.upsertRuns.length), [1, 1, 1], "each compact revision persists only its new billing UUID, not the full history");
        assert.ok(bills.every(record => record.observation.deletedRunIds.length === 0));
        const result = await owner.session.compact();
        assert.match(result.summary, /OFFLINE_CURSOR_DONE/);
        const reopened = SessionManager.open(owner.manager.getSessionFile());
        assert.equal(reopened.getEntries().filter(e => e.type === "compaction").length, 1, "manual compaction remains persisted and functional");
        assert.equal(reopened.getEntries().filter(e => e.type === "custom" && e.customType === "pi-cursor-sdk:usage-v1" && e.data.kind === "raw" && ordinaryTurns.has(e.data.turnId)).length, 3, "ordinary origin/raw facts survive native compaction and reopen");
      }
      await retainNativeEvidence(`occupancy-${pressure ? "pressure" : "billing"}`, owner.manager, owner.cwd);
    });
  });
}
