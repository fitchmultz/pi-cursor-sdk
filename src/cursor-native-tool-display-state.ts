import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import type { CursorPiToolDisplay } from "./cursor-transcript-utils.js";
import { parseOptionalEnvBoolean } from "./cursor-env-boolean.js";

export interface CursorNativeToolDisplayItem extends CursorPiToolDisplay {
	id: string;
	terminate?: boolean;
}

export const NATIVE_CURSOR_TOOL_DISPLAY_ENV = "PI_CURSOR_NATIVE_TOOL_DISPLAY";
export const NATIVE_CURSOR_TOOL_REGISTRATION_ENV = "PI_CURSOR_REGISTER_NATIVE_TOOLS";

export const registeredNativeToolSources = new Map<string, SourceInfo>();
export const skippedNativeToolNames = new Set<string>();
export const nativeToolResults = new Map<string, CursorNativeToolDisplayItem>();

let nativeToolDisplayRuntimeRequested = false;

export function readBooleanEnv(name: string, env: Record<string, string | undefined> = process.env): boolean | undefined {
	return parseOptionalEnvBoolean(env[name]);
}

export function isCursorNativeToolDisplayRequested(mode?: string): boolean {
	const override = readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV);
	if (override !== undefined) return override;
	if (mode) return mode === "tui" || mode === "json" || mode === "rpc";
	return process.stdout.isTTY === true;
}

export function isCursorNativeToolRegistrationRequested(mode?: string): boolean {
	return mode !== "print" && readBooleanEnv(NATIVE_CURSOR_TOOL_REGISTRATION_ENV) !== false && isCursorNativeToolDisplayRequested(mode);
}

export function setCursorNativeToolDisplayRuntimeRequested(requested: boolean): void {
	nativeToolDisplayRuntimeRequested = requested;
}

export function isCursorNativeToolDisplayEnabled(): boolean {
	return registeredNativeToolSources.size > 0;
}

export function isCursorNativeToolDisplayRuntimeEnabled(): boolean {
	return nativeToolDisplayRuntimeRequested && readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV) !== false && registeredNativeToolSources.size > 0;
}

export function canRenderCursorToolNatively(toolName: string): boolean {
	return registeredNativeToolSources.has(toolName);
}

export function isRegisteredCursorNativeToolName(toolName: string): boolean {
	return registeredNativeToolSources.has(toolName);
}

export function recordCursorNativeToolDisplay(item: CursorNativeToolDisplayItem): boolean {
	if (!canRenderCursorToolNatively(item.toolName)) return false;
	nativeToolResults.set(item.id, item);
	return true;
}

export function deleteCursorNativeToolDisplay(id: string): void {
	nativeToolResults.delete(id);
}

export function consumeCursorNativeToolDisplay(id: string): CursorNativeToolDisplayItem | undefined {
	const item = nativeToolResults.get(id);
	if (item) nativeToolResults.delete(id);
	return item;
}

export function isCursorReplayToolCallId(toolCallId: string): boolean {
	return toolCallId.startsWith("cursor-replay-");
}

export function isCursorFileMutationToolName(toolName: string): toolName is "edit" | "write" {
	return toolName === "edit" || toolName === "write";
}

export const __testUtils = {
	nativeToolResultCount: () => nativeToolResults.size,
	registerNativeToolNameForTests(toolName: string): void {
		nativeToolDisplayRuntimeRequested = true;
		registeredNativeToolSources.set(toolName, { path: "test", source: "inline", scope: "temporary", origin: "top-level" });
	},
	reset(): void {
		nativeToolDisplayRuntimeRequested = false;
		registeredNativeToolSources.clear();
		skippedNativeToolNames.clear();
		nativeToolResults.clear();
	},
};
