export const CURSOR_REPLAY_ACTIVITY_TOOL_NAME = "cursor";

export const CURSOR_REPLAY_LEGACY_TOOL_NAMES = [
	"cursor_edit",
	"cursor_write",
	"cursor_read_lints",
	"cursor_delete",
	"cursor_update_todos",
	"cursor_task",
	"cursor_create_plan",
	"cursor_generate_image",
	"cursor_mcp",
	"cursor_sem_search",
	"cursor_record_screen",
] as const;

export type CursorReplayLegacyToolName = (typeof CURSOR_REPLAY_LEGACY_TOOL_NAMES)[number];
export type CursorReplayToolName = typeof CURSOR_REPLAY_ACTIVITY_TOOL_NAME | CursorReplayLegacyToolName;

const CURSOR_REPLAY_SOURCE_TOOL_NAMES = {
	cursor_edit: "edit",
	cursor_write: "write",
	cursor_read_lints: "readLints",
	cursor_delete: "delete",
	cursor_update_todos: "updateTodos",
	cursor_task: "task",
	cursor_create_plan: "createPlan",
	cursor_generate_image: "generateImage",
	cursor_mcp: "MCP",
	cursor_sem_search: "semSearch",
	cursor_record_screen: "recordScreen",
} as const satisfies Record<CursorReplayLegacyToolName, string>;

const CURSOR_REPLAY_PROMPT_LABELS = {
	cursor_edit: "Cursor edit",
	cursor_write: "Cursor write",
	cursor_read_lints: "Cursor diagnostics",
	cursor_delete: "Cursor delete",
	cursor_update_todos: "Cursor todos",
	cursor_task: "Cursor task",
	cursor_create_plan: "Cursor plan",
	cursor_generate_image: "Cursor image generation",
	cursor_mcp: "Cursor MCP",
	cursor_sem_search: "Cursor semantic search",
	cursor_record_screen: "Cursor screen recording",
} as const satisfies Record<CursorReplayLegacyToolName, string>;

export function isCursorReplayLegacyToolName(toolName: string): toolName is CursorReplayLegacyToolName {
	return CURSOR_REPLAY_LEGACY_TOOL_NAMES.some((legacyToolName) => legacyToolName === toolName);
}

export function isCursorReplayToolName(toolName: string): toolName is CursorReplayToolName {
	return toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME || isCursorReplayLegacyToolName(toolName);
}

export function isExcludedFromCursorBridgeExposure(toolName: string): boolean {
	return isCursorReplayLegacyToolName(toolName) || toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME;
}

export function getCursorReplaySourceToolName(toolName: CursorReplayLegacyToolName): string {
	return CURSOR_REPLAY_SOURCE_TOOL_NAMES[toolName];
}

export function getCursorReplayPromptLabel(toolName: string): string {
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME) return "Cursor activity";
	if (isCursorReplayLegacyToolName(toolName)) return CURSOR_REPLAY_PROMPT_LABELS[toolName];
	return toolName;
}

export function getCursorReplayDisplayLabel(toolName: CursorReplayToolName): string {
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME) return "Cursor activity";
	return CURSOR_REPLAY_PROMPT_LABELS[toolName];
}
