import { isCursorLeanEnabled } from "./cursor-lean.js";

export const CURSOR_PI_BRIDGE_MCP_TOOL_PREFIX = "pi__";
export const CURSOR_PI_BRIDGE_PREFERENCE_TEXT =
	"When exposed, prefer pi__mcp for MCP work and pi__subagent for delegation; use Cursor-configured MCP or Cursor-native subagents only when the matching pi__ tool is not exposed or unavailable.";

const CURSOR_PI_BRIDGE_CONTRACT_LINES = [
	"Pi bridge contract:",
	`${CURSOR_PI_BRIDGE_MCP_TOOL_PREFIX}* names are live Cursor MCP bridge tool names only when exposed in the current run.`,
	`Call the ${CURSOR_PI_BRIDGE_MCP_TOOL_PREFIX}* MCP tool name, not the real pi tool name shown in pi history or transcripts.`,
	CURSOR_PI_BRIDGE_PREFERENCE_TEXT,
	"Bridged calls execute through normal pi tool flow, so pi shows the real pi tool name and returns a normal pi tool result.",
	"Replay IDs, replay labels, and transcript tool names are display-only/context-only, not callable tools.",
	"Cursor-native host tools, settings, plugins, and configured MCP servers are separate from the pi bridge.",
] as const;

export function getCursorPiBridgePreferenceText(): string {
	return isCursorLeanEnabled()
		? "Only exposed pi__* tools are callable. Cursor-native tools, subagents, web search, and ambient MCP are disabled."
		: CURSOR_PI_BRIDGE_PREFERENCE_TEXT;
}

export function getCursorPiBridgeContractText(): string {
	return CURSOR_PI_BRIDGE_CONTRACT_LINES.map((line) =>
		line === CURSOR_PI_BRIDGE_PREFERENCE_TEXT ? getCursorPiBridgePreferenceText() : line,
	).join("\n");
}

function formatPromptGuidelines(promptGuidelines: readonly string[] | undefined): string | undefined {
	const guidelines = promptGuidelines?.map((guideline) => guideline.trim()).filter(Boolean) ?? [];
	if (guidelines.length === 0) return undefined;
	return ["Pi tool prompt guidelines:", ...guidelines.map((guideline) => `- ${guideline}`)].join("\n");
}

export function buildCursorPiBridgeMcpToolDescription(options: {
	piToolName: string;
	mcpToolName: string;
	piToolDescription: string;
	piToolPromptGuidelines?: readonly string[];
}): string {
	return [
		options.piToolDescription,
		formatPromptGuidelines(options.piToolPromptGuidelines),
		`Call MCP name ${options.mcpToolName} (pi tool: ${options.piToolName}). Full tool-surface rules are in the session bootstrap prompt.`,
	].filter((line): line is string => line !== undefined).join("\n");
}
