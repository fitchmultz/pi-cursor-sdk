import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { buildCursorPrompt } from "../dist/context.js";
import { resolveCursorPiContext } from "../dist/cursor-pi-context.js";
import { cursorLiveRuns, drainCursorLiveRunTurn } from "../dist/cursor-provider-live-run-drain.js";
import { __testUtils as replayState } from "../dist/cursor-native-tool-display-state.js";

test("native replay completes with the same JSON arguments as its streamed delta", { timeout: 30_000 }, async () => {
  const stream = createAssistantMessageEventStream();
  const model = { id: "fixture", provider: "cursor", api: "cursor-sdk", name: "fixture",
    baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const partial = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], stopReason: "pending", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  // The completed external operation is data only; no SDK agent is invoked by replay.
  const run = cursorLiveRuns.start({ id: "json-replay", agent: {}, promptInputTokens: 0 });
  replayState.registerNativeToolNameForTests("read");
  const args = { path: "README.md", offset: undefined, nested: { keep: false, omit: undefined } };
  cursorLiveRuns.queueEvent(run, { type: "tool", tool: { id: "json-replay-tool-1", toolName: "read", args,
    result: { content: [{ type: "text", text: "recorded result" }] } } });
  cursorLiveRuns.markFinished(run, "");
  try {
    assert.equal(await drainCursorLiveRunTurn(stream, partial, model,
      { messages: [], tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }] },
      run, 0, { mode: "emit" }), "tool_use");
    stream.end();
    const events = [];
    for await (const event of stream) events.push(event);
    const delta = events.find((event) => event.type === "toolcall_delta");
    const completed = events.find((event) => event.type === "toolcall_end").toolCall;
    assert.deepEqual(completed.arguments, { path: "README.md", nested: { keep: false } });
    assert.deepEqual(completed.arguments, JSON.parse(delta.delta));
    assert.notEqual(completed.arguments, args, "later external argument mutation must not alter the persisted call");
  } finally {
    await cursorLiveRuns.release(run);
    replayState.reset();
  }
});

// Exercise real Pi transcript construction, then the production Cursor prompt boundary.
// This deliberately stops before Cursor SDK execution: no Cursor credentials or service.
test("compiled provider registers and shapes native Pi transcript/tool transitions", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-native-provider-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const oldEnv = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  delete process.env.CURSOR_API_KEY;
  process.env.PI_CURSOR_SETTING_SOURCES = "none";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Native Cursor contract must not access the network"); };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await rm(root, { recursive: true, force: true });
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let filterContext = false;
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
    extensionFactories: [(pi) => {
      pi.on("context", (event) => {
        assert.ok(event.messages.every((message) => message.role !== "system"));
        if (filterContext) return { messages: event.messages.slice(-1) };
      });
    }],
    systemPromptOverride: () => "NATIVE_CURSOR_SYSTEM_SENTINEL",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 2);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
  });
  const requests = [];
  modelRuntime.registerProvider("native-contract", {
    api: "native-contract", apiKey: "fixture", baseUrl: "http://127.0.0.1",
    models: [{ id: "test", name: "Native contract", reasoning: false, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      requests.push({ context: structuredClone(context), resolved: resolveCursorPiContext(context), prompt: buildCursorPrompt(context) });
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: "fixture answer" }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
      return stream;
    },
  });
  const { session } = await createAgentSession({
    cwd: root, agentDir, modelRuntime, model: modelRuntime.getModel("native-contract", "test"),
    resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root),
    tools: ["contract_alpha", "contract_beta"],
    customTools: ["contract_alpha", "contract_beta"].map((name) => ({
      name, label: name, description: `${name} description`, parameters: Type.Object({ value: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
    })),
  });
  const errors = [];
  try {
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    assert.ok(modelRuntime.getProviders().some((provider) => provider.id === "cursor"));
    assert.ok(modelRuntime.getModels().some((model) => model.provider === "cursor" && model.api === "cursor-sdk"));
    session.setActiveToolsByName(["contract_alpha"]);
    // Real 1x1 PNG, also used in index-native-tools.test.ts: native hosts may decode/resize images.
    const image = { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", mimeType: "image/png" };
    await session.prompt("first native request", { images: [image] });
    session.setActiveToolsByName(["contract_beta"]);
    await session.prompt("second native request");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.context.systemPrompt, undefined, "Pi supplies messages-only context");
      assert.equal(request.context.tools, undefined);
      assert.ok(request.context.messages.some((message) => message.role === "system"));
      assert.match(request.prompt.text, /NATIVE_CURSOR_SYSTEM_SENTINEL/);
      assert.match(request.prompt.text, /Cursor SDK tool boundary:/);
    }
    assert.deepEqual(requests[0].resolved.tools.map((tool) => tool.name), ["contract_alpha"]);
    assert.deepEqual(requests[1].resolved.tools.map((tool) => tool.name), ["contract_beta"]);
    assert.deepEqual(requests[0].prompt.images, [{ data: image.data, mimeType: image.mimeType }]);
    assert.deepEqual(requests[1].prompt.images, [], "old user images must not be resent");
    assert.match(requests[1].prompt.text, /User: second native request/);
    assert.match(requests[1].prompt.text, /Assistant: fixture answer/);

    const original = session.sessionManager.getBranch().find((entry) =>
      entry.type === "message" && entry.message.role === "user");
    session.sessionManager.appendContextEdit(original.id, { content: "EDITED_NATIVE_INPUT" });
    session.refreshContext();
    await session.prompt("after context edit");
    assert.match(requests[2].prompt.text, /EDITED_NATIVE_INPUT/);
    assert.doesNotMatch(requests[2].prompt.text, /first native request/);
    assert.equal(original.message.content[0].text, "first native request", "raw history stays intact");

    filterContext = true;
    await session.prompt("filtered request");
    assert.equal(requests.length, 4);
    assert.match(requests[3].prompt.text, /NATIVE_CURSOR_SYSTEM_SENTINEL/);
    assert.match(requests[3].prompt.text, /User: filtered request/);
    assert.doesNotMatch(requests[3].prompt.text, /EDITED_NATIVE_INPUT|fixture answer/);
    assert.deepEqual(requests[3].resolved.tools.map((tool) => tool.name), ["contract_beta"]);
    session.setActiveToolsByName([]);
    await session.prompt("filtered request without tools");
    assert.equal(requests.length, 5);
    assert.match(requests[4].prompt.text, /NATIVE_CURSOR_SYSTEM_SENTINEL/);
    assert.deepEqual(requests[4].resolved.tools, [], "removed tools stay absent after context filtering");
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});
test("actual extension loader composes native Cursor auth and rejects a late installed-SDK catalog response", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-native-auth-loader-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const oldEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  process.env.PI_CURSOR_HIDE_MODELS_WHEN_LOGGED_OUT = "1";
  delete process.env.CURSOR_API_KEY;
  let catalogCalls = 0, enter, release, gate, transportSignal;
  // SDK 1.0.35's installed listCloudModels reads the HTTP /v1/models items
  // array. Only that external transport is stubbed, never Pi or registration.
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(String(url)).pathname, "/v1/models", "only catalog transport is authorized");
    catalogCalls++;
    transportSignal = options.signal;
    if (gate) { enter(); await gate; }
    return new Response(JSON.stringify({ items: [{ id: gate ? "late-catalog" : "live-catalog", displayName: "Fixture" }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(async () => {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await rm(root, { recursive: true, force: true });
  });
  const credentials = new InMemoryCredentialStore();
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath, allowModelNetwork: false });
  runtime.registerProvider("neutral-fixture", {
    api: "neutral-fixture", apiKey: "synthetic-neutral", baseUrl: "http://127.0.0.1",
    models: [{ id: "neutral", name: "Neutral", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple() { throw new Error("Model sends prohibited"); },
  });
  const settingsManager = SettingsManager.inMemory({ defaultTools: [], compaction: { enabled: false }, retry: { enabled: false } });
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "Offline catalog selection fixture; do not send.", timestamp: 1 });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: root, agentDir, modelRuntime: runtime, model: runtime.getModel("neutral-fixture", "neutral"),
    resourceLoader: loader, settingsManager, sessionManager: manager, tools: [],
  });
  const errors = [];
  try {
    await session.bindExtensions({ onError: error => errors.push(error) });
    assert.equal(catalogCalls, 0);
    assert.deepEqual(await runtime.getAvailable("cursor"), []);
    assert.equal(resolveCliModel({ cliProvider: "cursor", cliModel: "grok-4.6", modelRuntime: runtime }).model?.id, "grok-4.6");
    const key = "synthetic-native-loader";
    const cachePath = join(agentDir, "cursor-sdk-model-list.json");
    writeFileSync(cachePath, JSON.stringify({
      version: 1, fetchedAt: Date.now(), keyFingerprint: createHash("sha256").update(key).digest("hex").slice(0, 16),
      models: [{ id: "cached-catalog", displayName: "Cached" }],
    }));
    await runtime.login("cursor", "api_key", { prompt: async () => key, notify() {} });
    assert.deepEqual(runtime.getModels("cursor").map(m => m.id), ["cached-catalog"]);
    assert.equal(catalogCalls, 0);
    await session.setModel(runtime.getModel("cursor", "cached-catalog"));
    const bare = await runtime.streamSimple(runtime.getModel("cursor", "cached-catalog"), { messages: [] }).result();
    assert.equal(bare.stopReason, "error");
    assert.match(bare.errorMessage, /no native session request receipt/);
    assert.equal(catalogCalls, 0);
    writeFileSync(modelsPath, JSON.stringify({ providers: { cursor: { apiKey: "synthetic-config" } } }));
    await runtime.refresh({ providers: ["cursor"], allowNetwork: false });
    await runtime.logout("cursor");
    assert.equal((await runtime.getAuth("cursor")).auth.apiKey, "synthetic-config");
    assert.ok(existsSync(cachePath), "surviving config auth must not delete the prior catalog");
    await runtime.refresh({ providers: ["cursor"], allowNetwork: true, force: true });
    assert.deepEqual(runtime.getModels("cursor").map(m => m.id), ["live-catalog"]);
    const accepted = readFileSync(cachePath);
    const entered = new Promise(resolve => { enter = resolve; });
    gate = new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    const pending = runtime.refresh({ providers: ["cursor"], allowNetwork: true, force: true, signal: controller.signal });
    await entered;
    assert.equal(transportSignal, undefined, "SDK 1.0.35 catalog transport has no caller-abort option");
    controller.abort();
    assert.equal((await pending).aborted, true);
    release();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(runtime.getModels("cursor").map(m => m.id), ["live-catalog"]);
    assert.deepEqual(readFileSync(cachePath), accepted);
    const reopened = SessionManager.open(manager.getSessionFile());
    assert.ok(reopened.getBranch().some(entry => entry.type === "model_change" && entry.provider === "cursor" && entry.modelId === "cached-catalog"));
    if (process.env.PI_CURSOR_TEST_EVIDENCE_DIR) {
      await mkdir(process.env.PI_CURSOR_TEST_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.PI_CURSOR_TEST_EVIDENCE_DIR, "auth-native-model-selection.jsonl"), readFileSync(manager.getSessionFile()));
      writeFileSync(join(process.env.PI_CURSOR_TEST_EVIDENCE_DIR, "auth-native-accepted-cache.json"), accepted);
    }
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});
