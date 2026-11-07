// A real local MCP server for Pi/Cursor bridge integration checks. No credentials or network.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new Server({ name: "pi-cursor-builtin-proof", version: "1" }, {
  capabilities: { tools: {}, resources: {} },
  instructions: "Local verification tools. Echo returns its input; fail returns a deliberate tool error.",
});
server.setRequestHandler("tools/list", async () => ({
  tools: ["echo", "fail", "direct", "deferred", "hidden"].map(name => ({
    name,
    description: `Local verification ${name} tool`,
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  })),
}));
server.setRequestHandler("tools/call", async request => ({
  content: [{ type: "text", text: request.params.name === "fail" ? "deliberate MCP failure" : request.params.arguments.value }],
  structuredContent: { tool: request.params.name, value: request.params.arguments.value },
  ...(request.params.name === "fail" ? { isError: true } : {}),
}));
server.setRequestHandler("resources/list", async () => ({
  resources: [{ uri: "proof://text", name: "Proof text", mimeType: "text/plain" }],
}));
server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [] }));
server.setRequestHandler("resources/read", async request => ({
  contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "MCP_RESOURCE_OK" }],
}));
await server.connect(new StdioServerTransport());
