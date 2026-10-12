export const CURSOR_PI_BRIDGE_MCP_TOOL_PREFIX = "pi__";
export const CURSOR_PI_BRIDGE_PREFERENCE_TEXT =
	"When exposed, prefer pi__mcp for MCP work and pi__subagent for delegation; use Cursor-configured MCP or Cursor-native subagents only when the matching pi__ tool is not exposed or unavailable.";

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
