// Offline transport fixture matching the installed @cursor/sdk public
// SDKAgent/Run/AgentUsage contracts (dist/esm/{agent,run,usage-types}.d.ts).
// Controlled failures use RunResult's documented error/cancelled statuses;
// heldCwds controls transport completion, not Pi scheduling or attribution.
// Pi and the extension are not mocked.
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export const state = globalThis[Symbol.for("pi-cursor-native-fixture")] ??= {
  created: [], sends: [], disposed: [], cancelled: [], bridgeResults: [], stores: [],
  heldCwds: new Set(), failedCwds: new Set(),
  configured: [], defaultRootCwds: [],
  usageByCwd: new Map(),
  cloudMutations: [],
};
export const Cursor = {
  configure(options) { state.configured.push(options); },
  models: { list: async () => [{
    id: "fixture", displayName: "Offline Cursor fixture",
    parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
    variants: [{ params: [{ id: "fast", value: "false" }], displayName: "Offline Cursor fixture", isDefault: true }],
  }] },
};
export const getDefaultSdkStateRoot = (cwd) => {
  state.defaultRootCwds.push(cwd);
  return join(process.env.PI_CODING_AGENT_DIR, "cursor-state");
};
export const SqliteLocalAgentStore = {
  open: async (options) => {
    // Materialize the controlled store root so cleanup assertions exercise
    // extension-owned filesystem removal, not an already absent directory.
    await mkdir(options.stateRoot, { recursive: true });
    const store = { ...options, dispose: async () => { store.disposed = true; } };
    state.stores.push(store);
    return store;
  },
};
export const createAgentPlatform = async () => ({ checkpointStore: { loadLatest: async () => undefined } });
export const Agent = {
  archive: async (agentId) => {
    state.cloudMutations.push({ action: "archive", agentId });
    state.cloudMutationWait?.entered.resolve();
    await state.cloudMutationWait?.release.promise;
  },
  delete: async (agentId) => {
    state.cloudMutations.push({ action: "delete", agentId });
    state.cloudMutationWait?.entered.resolve();
    await state.cloudMutationWait?.release.promise;
  },
  messages: { list: async () => [] },
  create: async (options) => {
    const index = state.created.length + 1;
    const agentId = options.cloud
      ? `bc-00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`
      : `agent-fixture-${index}`;
    state.created.push({ agentId, options });
    const runs = [];
    return {
      agentId,
      model: options.model,
      listArtifacts: async () => [],
      getUsage: async () => {
        const control = state.usageByCwd.get(options.local?.cwd);
        if (control && !control.billed) throw new Error("offline controlled usage unavailable");
        const bill = control?.billed ?? { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 15 };
        const usage = runs.reduce((sum, run) => Object.fromEntries(Object.keys(bill).map(key => [key, sum[key] + run.usage[key]])), Object.fromEntries(Object.keys(bill).map(key => [key, 0])));
        return { usage, runs };
      },
      [Symbol.asyncDispose]: async () => { state.disposed.push(agentId); },
      send: async (message, sendOptions) => {
        const index = state.sends.length + 1;
        state.sends.push({ agentId, message, mode: sendOptions.mode, force: sendOptions.local?.force });
        const id = `run-fixture-${index}`;
        const request = [...message.text.matchAll(/(?:^|\n)User: ([^\n]*)/g)].at(-1)?.[1] ?? "";
        let status = "running";
        let settle;
        const completion = new Promise((resolve) => { settle = resolve; });
        const finish = (result) => {
          status = "finished";
          const control = state.usageByCwd.get(options.local?.cwd);
          const raw = control ? control.raw : { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 };
          sendOptions.onDelta({ update: { type: "turn-ended", usage: raw } });
          runs.push({ runId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`, usage: control?.billed ?? { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 15 } });
          settle({ id, status, result });
        };
        const run = {
          id, agentId, get status() { return status; },
          supports: (operation) => operation !== "stream",
          unsupportedReason: () => "offline fixture",
          conversation: async () => [],
          onDidChangeStatus: () => () => {},
          wait: () => completion,
          cancel: async () => { status = "cancelled"; state.cancelled.push(id); settle({ id, status }); },
        };
        if (request.includes("CANCEL_FIXTURE") || state.heldCwds.has(options.local?.cwd)) return run;
        if (state.failedCwds.delete(options.local?.cwd)) {
          status = "error";
          settle({ id, status, error: { message: "offline controlled run failure" } });
          return run;
        }
        setTimeout(async () => {
          try {
            if (options.tools?.length !== 0 && request.includes("BRIDGE_FIXTURE")) {
              const client = new Client({ name: "offline-cursor", version: "1" });
              const transport = new StreamableHTTPClientTransport(new URL(options.mcpServers.pi_tools.url));
              try {
                await client.connect(transport);
                const catalog = await client.listTools();
                state.bridgeCatalog = catalog.tools.map((tool) => tool.name);
                const args = { providerIdentifier: "pi_tools", toolName: "pi__fixture_bridge", args: { value: "bridge value" } };
                const callId = `${id}-bridge`;
                const modelCallId = `${callId}-model`;
                sendOptions.onDelta({ update: { type: "tool-call-started", callId, modelCallId, toolCall: { type: "mcp", args } } });
                const result = await client.callTool({ name: args.toolName, arguments: args.args });
                state.bridgeResults.push(result);
                sendOptions.onDelta({ update: { type: "tool-call-completed", callId, modelCallId, toolCall: { type: "mcp", args,
                  result: { status: "success", value: { isError: result.isError === true, content: result.content.map((block) => ({ text: { text: block.text } })) } },
                } } });
              } finally {
                await client.close();
                await transport.close();
              }
            }
            if (options.tools?.length !== 0 && request.includes("REPLAY_FIXTURE")) {
              const args = { path: "never-read.txt" };
              const callId = `${id}-read`;
              const modelCallId = `${callId}-model`;
              const content = "recorded offline read";
              sendOptions.onDelta({ update: { type: "tool-call-started", callId, modelCallId, toolCall: { type: "read", args } } });
              sendOptions.onDelta({ update: { type: "tool-call-completed", callId, modelCallId, toolCall: { type: "read", args,
                result: { status: "success", value: { fileSize: Buffer.byteLength(content), content, totalLines: 1 } },
              } } });
            }
            finish(`OFFLINE_CURSOR_DONE_${index}`);
          } catch (error) {
            status = "error";
            settle({ id, status, error: { message: String(error) } });
          }
        }, 20);
        return run;
      },
    };
  },
};
