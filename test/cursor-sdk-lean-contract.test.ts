import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInstalledPackageRoot } from "./helpers/installed-package.js";

const sdkRoot = resolveInstalledPackageRoot("@cursor/sdk");

describe("installed SDK lean policy contract", () => {
	it("documents local-only allowlists that must be supplied again on resume", () => {
		const types = readFileSync(join(sdkRoot, "dist/esm/options.d.ts"), "utf8");
		expect(types).toContain("tools?: ToolName[];");
		expect(types).toContain('`"mcp"` grants the whole MCP tool family');
		expect(types).toContain("pass `tools` again on `Agent.resume`");
		expect(types).toContain("combining `tools` with `cloud` throws");
		expect(types).toContain("Ambient Cursor settings layers to load from the local filesystem.");
	});

	it("expands mcp to only the observed MCP proto family, excluding web, shell and subagents", () => {
		// SDK 1.0.27 bundles the public tools-option implementation in index.js.
		// Fail on packaging/vocabulary drift instead of accepting a guessed allowlist.
		const source = readFileSync(join(sdkRoot, "dist/esm/index.js"), "utf8");
		const module = source.split('"./src/agent/tools-option.ts"(e,t,n){')[1]?.split('},"./src/agent/transport.ts"')[0];
		expect(module).toBeDefined();
		expect(module).toContain('"x-cursor-agent-allowed-tools"');
		const group = module?.match(/mcp:(\[[^\]]+\])/);
		expect(JSON.parse(group?.[1] ?? "null")).toEqual([
			"mcp_tool_call", "get_mcp_tools_tool_call", "list_mcp_resources_tool_call",
			"read_mcp_resource_tool_call", "mcp_auth_tool_call",
		]);
	});
});
