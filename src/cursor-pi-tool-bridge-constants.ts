export const MCP_SERVER_NAME = "pi_tools";
export const MCP_ENDPOINT_ROOT = "/cursor-pi-tool-bridge";
export const CURSOR_PI_BRIDGE_TOOL_CALL_ID_MAX_LENGTH = 64;

const CURSOR_PI_BRIDGE_RUN_UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CURSOR_PI_BRIDGE_TOOL_CALL_ID_PATTERN = /^cursor-pi-bridge-[0-9a-f]{32}-t\d+$/i;
const LEGACY_CURSOR_PI_BRIDGE_TOOL_CALL_ID_PATTERN =
	/^cursor-pi-bridge-run-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-tool-\d+$/i;

/**
 * Build the provider-facing bridge ID while enforcing the 64-character
 * call_id limit used by OpenAI-compatible Responses backends.
 */
export function buildCursorPiBridgeToolCallId(runUuid: string, counter: number): string {
	if (!CURSOR_PI_BRIDGE_RUN_UUID_PATTERN.test(runUuid)) {
		throw new Error("Cursor pi bridge run UUID must be canonical");
	}
	if (!Number.isSafeInteger(counter) || counter <= 0) {
		throw new Error("Cursor pi bridge tool call counter must be a positive safe integer");
	}
	const toolCallId = `cursor-pi-bridge-${runUuid.replaceAll("-", "")}-t${counter}`;
	if (toolCallId.length > CURSOR_PI_BRIDGE_TOOL_CALL_ID_MAX_LENGTH) {
		throw new Error("Cursor pi bridge tool call ID limit exceeded");
	}
	return toolCallId;
}

export function isCursorPiBridgeToolCallId(toolCallId: string): boolean {
	return (
		(toolCallId.length <= CURSOR_PI_BRIDGE_TOOL_CALL_ID_MAX_LENGTH && CURSOR_PI_BRIDGE_TOOL_CALL_ID_PATTERN.test(toolCallId)) ||
		LEGACY_CURSOR_PI_BRIDGE_TOOL_CALL_ID_PATTERN.test(toolCallId)
	);
}
