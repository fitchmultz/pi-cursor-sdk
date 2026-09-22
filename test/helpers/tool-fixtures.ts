import { Type, type TSchema } from "typebox";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { RegisteredTool } from "./pi-harness-types.js";

export const DEFAULT_BUILTIN_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "edit", "write"] as const;
export const DEFAULT_ACTIVE_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

export function createBuiltinToolInfo(
	name: string,
	parameters: TSchema = Type.Object({}),
	description = "",
	promptGuidelines?: string[],
): ToolInfo & { id: string } {
	return {
		id: name,
		name,
		description,
		parameters,
		...(promptGuidelines ? { promptGuidelines } : {}),
		sourceInfo: { source: "builtin", path: `<builtin:${name}>`, scope: "temporary", origin: "top-level" },
	};
}

/** Generic test-scoped tool metadata (extension-registered tools, bridge MCP tools, etc.). */
export function createTestToolInfo(
	name: string,
	parameters: TSchema = Type.Object({}),
	description = `${name} tool`,
	promptGuidelines?: string[],
): ToolInfo & { id: string } {
	return {
		id: name,
		name,
		description,
		parameters,
		...(promptGuidelines ? { promptGuidelines } : {}),
		sourceInfo: { source: "test", path: `test:${name}`, scope: "temporary", origin: "top-level" },
	};
}

export function getHarnessRegisteredTool(tools: readonly RegisteredTool[], name: string): RegisteredTool {
	const tool = tools.find((entry) => entry.name === name);
	if (!tool) {
		throw new Error(`Tool not registered: ${name}`);
	}
	return tool;
}

/** HTTP MCP URL for a bridge run's `pi_tools` server (narrows SDK union config). */
export function getCursorPiBridgeMcpUrl(run: { mcpServers?: Record<string, unknown> }): string {
	const piTools = run.mcpServers?.pi_tools;
	if (!piTools || typeof piTools !== "object" || !("url" in piTools) || typeof piTools.url !== "string") {
		throw new Error("Bridge run has no pi_tools HTTP MCP URL");
	}
	return piTools.url;
}
