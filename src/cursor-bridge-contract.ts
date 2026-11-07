import { isCursorLeanEnabled } from "./cursor-lean.js";

export const CURSOR_PI_BRIDGE_MCP_TOOL_PREFIX = "pi__";
export const CURSOR_PI_BRIDGE_PREFERENCE_TEXT =
	"For MCP work and delegation, prefer matching exposed pi__* tools using their listed names, schemas, and prompt guidelines; use Cursor-configured MCP or Cursor-native subagents only when the matching pi tool is not exposed or unavailable.";

export function getCursorPiBridgePreferenceText(options: { leanEnabled?: boolean; nativeToolsEnabled?: boolean } = {}): string {
	if (options.leanEnabled ?? isCursorLeanEnabled()) {
		return "Only exposed pi__* tools are callable. Cursor-native tools, subagents, web search, and ambient MCP are disabled.";
	}
	return options.nativeToolsEnabled === false
		? "Use only exposed pi__* MCP names for Pi work; native task/subagents are disabled."
		: CURSOR_PI_BRIDGE_PREFERENCE_TEXT;
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
