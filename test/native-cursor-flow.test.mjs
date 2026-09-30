import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { state } from "./fixtures/native-cursor-sdk.mjs";

// Only the external Cursor transport/storage is substituted. This is a real
// host loader, registered Cursor provider, agent scheduler and persisted session.
const fixtureUrl = new URL("./fixtures/native-cursor-sdk.mjs", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@cursor/sdk" || specifier === "@cursor/sdk/sqlite") return { url: fixtureUrl, shortCircuit: true };
  return nextResolve(specifier, context);
} });

test("registered Cursor provider preserves native bridge, replay, usage, queues, tree, compaction, abort and reload", { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-native-flow-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
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
    const queued = await session.steer("queued request boundary");
    assert.ok(queued);
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
    globalThis.fetch = originalFetch;
    hooks.deregister();
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    await rm(root, { recursive: true, force: true });
  }
});
