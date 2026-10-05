import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { after } from "node:test";
import { Type } from "typebox";
import { state, Cursor } from "../fixtures/native-cursor-sdk.mjs";
import { writeRawTestEvidence } from "./raw-test-evidence.mjs";

export { state };
export const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(
  process.env.PI_CURSOR_TEST_HOST ?? "@earendil-works/pi-coding-agent"
);
// Resolve the public Agent export relative to the actual selected host.
const hostRequire = createRequire(import.meta.resolve(process.env.PI_CURSOR_TEST_HOST ?? "@earendil-works/pi-coding-agent"));
const corePackagePath = hostRequire.resolve("@earendil-works/pi-agent-core/package.json");
const corePackage = JSON.parse(await readFile(corePackagePath, "utf8"));
export const { Agent: PiAgent } = await import(pathToFileURL(join(dirname(corePackagePath), corePackage.exports["."].import)));

export function setupNativeCursorHarness() {
  // Only external Cursor transport/storage is substituted; Pi's loader,
  // registered provider, scheduler, persisted sessions and loopback MCP are real.
  const fixtureUrl = new URL("../fixtures/native-cursor-sdk.mjs", import.meta.url).href;
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === "@cursor/sdk" || specifier === "@cursor/sdk/sqlite") return { url: fixtureUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  } });
  after(() => hooks.deregister());
}

export async function seedOfflineCatalog(agentDir) {
  await writeFile(join(agentDir, "cursor-sdk-model-list.json"), JSON.stringify({
    version: 1, fetchedAt: Date.now(),
    keyFingerprint: createHash("sha256").update("offline-fixture-only").digest("hex").slice(0, 16),
    models: await Cursor.models.list(),
  }));
}

export async function concurrentFixture(t, run) {
  const root = await mkdtemp(join(tmpdir(), "cursor-native-owners-"));
  const previousEnv = { ...process.env };
  const sessions = [];
  const errors = [];
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    HOME: root, USERPROFILE: root,
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_CURSOR_SETTING_SOURCES: "none",
    CURSOR_API_KEY: "offline-fixture-only", PI_CURSOR_NATIVE_TOOL_DISPLAY: "1",
    PI_CURSOR_ASK_QUESTION: "0", PI_CURSOR_LOCAL_RESUME: "0", PI_CURSOR_SDK_EVENT_DEBUG: "1",
  });
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, "127.0.0.1", "offline native fixture must not access external services");
    return originalFetch(input, options);
  };
  async function create(name, { tool, runtime, manager: inheritedManager, bind = true, preferences = [], flags = {}, compaction = {}, beforeExtensions = [], afterExtensions = [] } = {}) {
    const cwd = join(root, name);
    await mkdir(cwd);
    const settingsManager = SettingsManager.inMemory({
      defaultTools: ["fixture_bridge"], compaction: { enabled: false, keepRecentTokens: 1, ...compaction }, retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [...beforeExtensions, fileURLToPath(new URL("../../", import.meta.url)), ...afterExtensions],
      systemPromptOverride: () => `OWNER_${name}`,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = inheritedManager ?? SessionManager.create(cwd, join(root, "sessions"));
    for (const [type, data] of preferences) manager.appendCustomEntry(type, data);
    const { session } = await createAgentSession({
      cwd, resourceLoader: loader, settingsManager, sessionManager: manager,
      ...(runtime ? { modelRuntime: runtime } : {}),
      customTools: [{ name: "fixture_bridge", label: "Fixture bridge", description: `Owned by ${name}`,
        parameters: Type.Object({ value: Type.String() }),
        execute: tool ?? (async () => ({ content: [{ type: "text", text: name }], details: {} })),
      }],
    });
    sessions.push(session);
    for (const [name, value] of Object.entries(flags)) session.extensionRunner.setFlagValue(name, value);
    if (bind) await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
    const model = session.modelRuntime.getModel("cursor", "fixture");
    assert.ok(model);
    await session.setModel(model);
    return { session, manager, cwd };
  }
  try {
    await mkdir(process.env.PI_CODING_AGENT_DIR);
    await seedOfflineCatalog(process.env.PI_CODING_AGENT_DIR);
    await run({ root, create });
    assert.deepEqual(errors, []);
  } finally {
    try {
      state.cloudMutationWait?.release.resolve();
      for (const session of sessions.reverse()) {
        try {
          await session.abort();
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally { session.dispose(); }
      }
    } finally {
      state.heldCwds.clear();
      state.failedCwds.clear();
      state.cloudMutationWait = undefined;
      state.usageByCwd.clear();
      state.outputByCwd.clear();
      state.waitOutputByCwd.clear();
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      await rm(root, { recursive: true, force: true });
    }
  }
}

export async function retainNativeEvidence(label, manager, cwd) {
  const directory = process.env.PI_CURSOR_TEST_EVIDENCE_DIR;
  if (!directory) return;
  writeRawTestEvidence(directory, `${label}.jsonl`, await readFile(manager.getSessionFile()));
  const metadata = [];
  for (const path of (await readdir(cwd, { recursive: true })).filter(path => path.endsWith("metadata.json"))) {
    metadata.push({ path, data: JSON.parse(await readFile(join(cwd, path), "utf8")) });
  }
  writeRawTestEvidence(directory, `${label}.json`, JSON.stringify({
    sessionFile: manager.getSessionFile(), sessionId: manager.getSessionId(),
    host: process.env.PI_CURSOR_TEST_HOST ?? "@earendil-works/pi-coding-agent",
    metadata,
    sends: state.sends.filter(send => state.created.some(agent => agent.agentId === send.agentId && agent.options.local?.cwd === cwd))
      .map(send => ({ agentId: send.agentId, runId: send.runId, cancelled: state.cancelled.includes(send.runId) })),
    agents: state.created.filter(agent => agent.options.local?.cwd === cwd).map(agent => ({
      agentId: agent.agentId, disposed: state.disposed.includes(agent.agentId),
      mode: agent.options.mode, tools: agent.options.tools,
      settingSources: agent.options.local.settingSources,
      storeRoot: agent.options.local.store?.stateRoot,
      mcpServers: Object.keys(agent.options.mcpServers ?? {}),
      subagentNames: Object.keys(agent.options.agents ?? {}),
    })),
  }, null, 2));
}
