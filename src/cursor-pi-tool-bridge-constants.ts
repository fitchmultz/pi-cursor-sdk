export const MCP_SERVER_NAME = "pi_tools";
export const MCP_ENDPOINT_ROOT = "/cursor-pi-tool-bridge";

/** Pi tool names that wait on interactive UI; they must not inherit MCP CallTool deadlines. */
const WAIT_FOR_USER_PI_TOOL_NAMES = new Set(["cursor_ask_question"]);

export function isCursorPiBridgeWaitForUserTool(piToolName: string): boolean {
	return WAIT_FOR_USER_PI_TOOL_NAMES.has(piToolName);
}

const CURSOR_PI_BRIDGE_TOOL_CALL_ID_PATTERN = /^cursor-pi-bridge-run-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-tool-\d+$/i;

export function isCursorPiBridgeToolCallId(toolCallId: string): boolean {
	return CURSOR_PI_BRIDGE_TOOL_CALL_ID_PATTERN.test(toolCallId);
}
