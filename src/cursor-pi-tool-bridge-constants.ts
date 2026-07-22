export const MCP_SERVER_NAME = "pi_tools";
export const MCP_ENDPOINT_ROOT = "/cursor-pi-tool-bridge";

const CURSOR_PI_BRIDGE_TOOL_CALL_ID_PATTERN = /^cursor-pi-bridge-run-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-tool-\d+$/i;

export function isCursorPiBridgeToolCallId(toolCallId: string): boolean {
	return CURSOR_PI_BRIDGE_TOOL_CALL_ID_PATTERN.test(toolCallId);
}
