// Offline transport fixture matching installed @cursor/sdk 1.0.32's public
// SDKAgent/Run/AgentUsage contracts. Pi and the extension are not mocked.
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export const state = globalThis[Symbol.for("pi-cursor-native-fixture")] ??= {
  created: [], sends: [], disposed: [], cancelled: [], bridgeResults: [], stores: [],
};
export const Cursor = {
  configure() {},
  models: { list: async () => [{ id: "fixture", displayName: "Offline Cursor fixture" }] },
};
export const getDefaultSdkStateRoot = () => join(process.env.PI_CODING_AGENT_DIR, "cursor-state");
export const SqliteLocalAgentStore = {
  open: async (options) => {
    const store = { ...options, dispose: async () => { store.disposed = true; } };
    state.stores.push(store);
    return store;
  },
};
export const createAgentPlatform = async () => ({ checkpointStore: { loadLatest: async () => undefined } });
export const Agent = {
  messages: { list: async () => [] },
  create: async (options) => {
    const agentId = `agent-fixture-${state.created.length + 1}`;
    state.created.push({ agentId, options });
    const runs = [];
    return {
      agentId,
      model: options.model,
      listArtifacts: async () => [],
      getUsage: async () => ({ usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 15 }, runs }),
      [Symbol.asyncDispose]: async () => { state.disposed.push(agentId); },
      send: async (message, sendOptions) => {
        const index = state.sends.length + 1;
        state.sends.push({ agentId, message, mode: sendOptions.mode });
        const id = `run-fixture-${index}`;
        const request = [...message.text.matchAll(/(?:^|\n)User: ([^\n]*)/g)].at(-1)?.[1] ?? "";
        let status = "running";
        let settle;
        const completion = new Promise((resolve) => { settle = resolve; });
        const finish = (result) => {
          status = "finished";
          sendOptions.onDelta({ update: { type: "turn-ended", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 } } });
          runs.push({ runId: `usage-${index}`, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 15 } });
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
        if (request.includes("CANCEL_FIXTURE")) return run;
        setTimeout(async () => {
          try {
            if (request.includes("BRIDGE_FIXTURE")) {
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
            if (request.includes("REPLAY_FIXTURE")) {
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
