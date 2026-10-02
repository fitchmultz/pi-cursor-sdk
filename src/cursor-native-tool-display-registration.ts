import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { arePiToolsDisabled } from "./cursor-active-tools.js";
import {
	CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES,
	isNativeCursorToolName,
	NATIVE_CURSOR_TOOL_NAMES,
	type NativeCursorToolName,
} from "./cursor-native-tool-names.js";
import { isCursorModel } from "./cursor-model.js";
import { registerCursorModelLifecycle, type CursorModelLifecycleExtensionApi } from "./cursor-model-lifecycle.js";
import {
	isCursorNativeToolDisplayRequested,
	isCursorNativeToolRegistrationRequested,
	NATIVE_CURSOR_TOOL_DISPLAY_ENV,
	readBooleanEnv,
	getCursorNativeToolDisplayState,
	registerCursorNativeToolDisplayState,
	setCursorNativeToolDisplayRuntimeRequested,
} from "./cursor-native-tool-display-state.js";
import { isCursorReplayToolName } from "./cursor-tool-presentation-registry.js";
import { registerNativeCursorTool } from "./cursor-native-tool-display-tools.js";

export const CURSOR_CORE_PI_REPLAY_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
const CORE_PI_TOOL_NAMES = new Set<string>(CURSOR_CORE_PI_REPLAY_TOOL_NAMES);

function isCursorCorePiReplayToolName(toolName: string): toolName is (typeof CURSOR_CORE_PI_REPLAY_TOOL_NAMES)[number] {
	return CORE_PI_TOOL_NAMES.has(toolName);
}

type CursorNativeToolActivationApi = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;
type CursorNativeToolRegistryApi = CursorNativeToolActivationApi & Pick<ExtensionAPI, "getAllTools" | "registerTool">;

export type CursorNativeToolDisplayExtensionApi = CursorNativeToolRegistryApi
	& CursorModelLifecycleExtensionApi & Parameters<typeof registerCursorNativeToolDisplayState>[0];

// Pi filters getAllTools even after registration; new/reloaded extensions receive a new API.
const filteredRegistrations = new WeakMap<CursorNativeToolRegistryApi, Set<NativeCursorToolName>>();

function hasNonBuiltinTool(pi: Pick<ExtensionAPI, "getAllTools">, toolName: NativeCursorToolName): boolean {
	const existingTool = pi.getAllTools().find((tool) => tool.name === toolName);
	return existingTool !== undefined && existingTool.sourceInfo.source !== "builtin";
}

type NativeRegistrationContext = Pick<ExtensionContext, "mode" | "model"> & {
	ui: Pick<ExtensionContext["ui"], "notify">;
};

function registerNativeCursorToolsFromSet(
	pi: CursorNativeToolRegistryApi,
	toolNames: readonly NativeCursorToolName[],
	getCwd: () => string,
): NativeCursorToolName[] {
	const state = getCursorNativeToolDisplayState(pi);
	const { registeredNativeToolSources, skippedNativeToolNames } = state;
	let filteredToolNames = filteredRegistrations.get(pi);
	if (!filteredToolNames) {
		filteredToolNames = new Set();
		filteredRegistrations.set(pi, filteredToolNames);
	}
	const newlySkippedToolNames: NativeCursorToolName[] = [];
	for (const toolName of toolNames) {
		if (registeredNativeToolSources.has(toolName) || filteredToolNames.has(toolName)) continue;
		if (hasNonBuiltinTool(pi, toolName)) {
			if (!skippedNativeToolNames.has(toolName)) {
				skippedNativeToolNames.add(toolName);
				newlySkippedToolNames.push(toolName);
			}
			continue;
		}
		registerNativeCursorTool(pi, toolName, getCwd, state);
		const registeredTool = pi.getAllTools().find((tool) => tool.name === toolName);
		if (registeredTool) registeredNativeToolSources.set(toolName, registeredTool.sourceInfo);
		else filteredToolNames.add(toolName);
	}
	return newlySkippedToolNames;
}

function notifySkippedNativeCursorToolsIfNeeded(ctx: NativeRegistrationContext, skippedToolNames: readonly NativeCursorToolName[]): void {
	if (skippedToolNames.length === 0 || readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV) !== true || ctx.mode !== "tui") return;
	ctx.ui.notify(
		`Cursor native tool replay skipped for ${skippedToolNames.join(", ")} because another extension already provides ${skippedToolNames.length === 1 ? "that tool" : "those tools"}. Cursor will use scrubbed activity transcripts for skipped tools.`,
		"warning",
	);
}

function removeRegisteredNonCoreNativeCursorTools(pi: CursorNativeToolActivationApi): void {
	const { registeredNativeToolSources } = getCursorNativeToolDisplayState(pi);
	if (registeredNativeToolSources.size === 0) return;
	const activeToolNames = new Set(pi.getActiveTools());
	let changed = false;
	for (const toolName of registeredNativeToolSources.keys()) {
		if (isCursorCorePiReplayToolName(toolName)) continue;
		if (!activeToolNames.delete(toolName)) continue;
		changed = true;
	}
	if (changed) pi.setActiveTools([...activeToolNames]);
}

export function syncRegisteredNativeCursorToolsForModel(
	pi: CursorNativeToolActivationApi,
	model: ExtensionContext["model"],
): void {
	const { registeredNativeToolSources } = getCursorNativeToolDisplayState(pi);
	if (registeredNativeToolSources.size === 0) return;
	if (!isCursorModel(model)) {
		removeRegisteredNonCoreNativeCursorTools(pi);
		return;
	}
	if (arePiToolsDisabled(pi)) return;
	const activeToolNames = new Set(pi.getActiveTools());
	let changed = false;
	for (const toolName of registeredNativeToolSources.keys()) {
		if (isCursorReplayToolName(toolName) && !CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES.some((activeReplayToolName) => activeReplayToolName === toolName)) continue;
		if (activeToolNames.has(toolName)) continue;
		activeToolNames.add(toolName);
		changed = true;
	}
	if (changed) pi.setActiveTools([...activeToolNames]);
}

function ensureNativeCursorToolsRegisteredForModel(pi: CursorNativeToolRegistryApi, ctx: NativeRegistrationContext, getCwd: () => string): void {
	if (!isCursorModel(ctx.model)) return;

	const nonCoreToolNames = NATIVE_CURSOR_TOOL_NAMES.filter((toolName) => !isCursorCorePiReplayToolName(toolName));
	const skippedToolNames = [
		...registerNativeCursorToolsFromSet(pi, nonCoreToolNames, getCwd),
		...registerNativeCursorToolsFromSet(pi, CURSOR_CORE_PI_REPLAY_TOOL_NAMES, getCwd),
	];
	notifySkippedNativeCursorToolsIfNeeded(ctx, skippedToolNames);
}

function ensureThenSyncNativeCursorToolsForModel(pi: CursorNativeToolRegistryApi, ctx: NativeRegistrationContext, getCwd: () => string): void {
	const { registeredNativeToolSources } = getCursorNativeToolDisplayState(pi);
	const currentTools = pi.getAllTools();
	for (const [toolName, sourceInfo] of registeredNativeToolSources) {
		if (!currentTools.some((tool) => tool.name === toolName && tool.sourceInfo === sourceInfo)) {
			registeredNativeToolSources.delete(toolName);
		}
	}
	const requested = isCursorNativeToolRegistrationRequested(ctx.mode);
	setCursorNativeToolDisplayRuntimeRequested(requested, pi);
	if (!requested) {
		removeRegisteredNonCoreNativeCursorTools(pi);
		return;
	}
	ensureNativeCursorToolsRegisteredForModel(pi, ctx, getCwd);
	syncRegisteredNativeCursorToolsForModel(pi, ctx.model);
}

export function registerCursorNativeToolDisplay(pi: CursorNativeToolDisplayExtensionApi): void {
	registerCursorNativeToolDisplayState(pi);
	let cwd = process.cwd();
	registerCursorModelLifecycle(pi, (ctx) => {
		cwd = ctx.cwd;
		ensureThenSyncNativeCursorToolsForModel(pi, ctx, () => cwd);
	});
}

export { isNativeCursorToolName, isCursorNativeToolDisplayRequested };
