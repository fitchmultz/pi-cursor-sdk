import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { getCursorSessionCwd } from "./cursor-session-cwd.js";
import {
	CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
	CURSOR_REPLAY_LEGACY_TOOL_NAMES,
	isCursorReplayToolName,
} from "./cursor-tool-names.js";
import {
	asCursorReplayToolDetails,
	createCursorReplayOnlyToolDefinition,
	renderCursorReplayResult,
	renderNativeLookingCursorFileMutationCall,
	renderNativeLookingCursorReadReplayResult,
} from "./cursor-native-tool-display-replay.js";
import {
	consumeCursorNativeToolDisplay,
	isCursorFileMutationToolName,
	isCursorReplayToolCallId,
} from "./cursor-native-tool-display-state.js";

const CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES = [CURSOR_REPLAY_ACTIVITY_TOOL_NAME] as const;
const CURSOR_REPLAY_TOOL_NAMES = [CURSOR_REPLAY_ACTIVITY_TOOL_NAME, ...CURSOR_REPLAY_LEGACY_TOOL_NAMES] as const;
export const NATIVE_CURSOR_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", ...CURSOR_REPLAY_TOOL_NAMES] as const;
export type NativeCursorToolName = (typeof NATIVE_CURSOR_TOOL_NAMES)[number];

export function isNativeCursorToolName(toolName: string): toolName is NativeCursorToolName {
	return NATIVE_CURSOR_TOOL_NAMES.some((nativeToolName) => nativeToolName === toolName);
}

export function wrapNativeCursorTool<TParams extends TSchema, TDetails, TState>(
	definition: ToolDefinition<TParams, TDetails, TState>,
	getCurrentDefinition: () => ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	return {
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cursorDisplay = consumeCursorNativeToolDisplay(toolCallId);
			if (cursorDisplay) {
				if (cursorDisplay.isError) {
					const text = cursorDisplay.result.content
						.map((entry) => (entry.type === "text" ? entry.text : undefined))
						.filter((entry): entry is string => Boolean(entry))
						.join("\n");
					throw new Error(text || "Cursor tool replay failed");
				}
				return {
					content: cursorDisplay.result.content,
					details: cursorDisplay.result.details as TDetails,
					terminate: cursorDisplay.terminate ?? true,
				};
			}
			if (isCursorFileMutationToolName(definition.name) && isCursorReplayToolCallId(toolCallId)) {
				throw new Error(`No recorded Cursor ${definition.name} result was available. This replay-only call does not execute file mutations.`);
			}
			return getCurrentDefinition().execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			if (definition.name === "read" && isCursorReplayToolCallId(context.toolCallId)) {
				const currentRenderCall = getCurrentDefinition().renderCall;
				const rendered = currentRenderCall ? currentRenderCall(args, theme, context) : new Text("", 0, 0);
				if ((args as Record<string, unknown>).localReadPreview === true && !context.expanded) {
					const baseText = rendered.render(120).join("\n").trimEnd();
					const labeled = `${baseText}${theme.fg("muted", " · local file preview")}`;
					if (rendered instanceof Text) {
						rendered.setText(labeled);
						return rendered;
					}
					return new Text(labeled, 0, 0);
				}
				return rendered;
			}
			if (isCursorFileMutationToolName(definition.name) && isCursorReplayToolCallId(context.toolCallId)) {
				return renderNativeLookingCursorFileMutationCall(definition.name, args as Record<string, unknown>, theme, context.isPartial);
			}
			const currentRenderCall = getCurrentDefinition().renderCall;
			return currentRenderCall ? currentRenderCall(args, theme, context) : new Text("", 0, 0);
		},
		renderResult(result, options, theme, context) {
			const details = asCursorReplayToolDetails(result.details);
			if (isCursorFileMutationToolName(definition.name) && details?.cursorToolName === definition.name) {
				return renderCursorReplayResult(result, options, theme, context, context.isError);
			}
			if (definition.name === "read" && isCursorReplayToolCallId(context.toolCallId)) {
				return renderNativeLookingCursorReadReplayResult(result, options, theme, context, () =>
					getCurrentDefinition().renderResult?.(result, options, theme, context),
				);
			}
			const currentRenderResult = getCurrentDefinition().renderResult;
			return currentRenderResult ? currentRenderResult(result, options, theme, context) : new Text("", 0, 0);
		},
	};
}

export function createNativeCursorToolDefinition(toolName: NativeCursorToolName, cwd: string): ToolDefinition<TSchema, unknown, unknown> {
	if (toolName === "read") return createReadToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "bash") return createBashToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "edit") return createEditToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "write") return createWriteToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "grep") return createGrepToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "find") return createFindToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (toolName === "ls") return createLsToolDefinition(cwd) as ToolDefinition<TSchema, unknown, unknown>;
	if (isCursorReplayToolName(toolName)) return createCursorReplayOnlyToolDefinition(toolName) as ToolDefinition<TSchema, unknown, unknown>;
	throw new Error(`Unsupported Cursor native replay tool: ${toolName}`);
}

export function registerNativeCursorTool(pi: Pick<import("@earendil-works/pi-coding-agent").ExtensionAPI, "registerTool">, toolName: NativeCursorToolName): void {
	const definition = createNativeCursorToolDefinition(toolName, getCursorSessionCwd());
	pi.registerTool(wrapNativeCursorTool(definition, () => createNativeCursorToolDefinition(toolName, getCursorSessionCwd())));
}

export { CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES, CURSOR_REPLAY_TOOL_NAMES };
