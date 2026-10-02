import type { ExtensionHandler, SessionShutdownEvent, SourceInfo } from "@earendil-works/pi-coding-agent";
import type { CursorPiToolDisplay } from "./cursor-transcript-utils.js";
import { parseOptionalEnvBoolean } from "./cursor-env-boolean.js";
import { normalizeCursorToolName } from "./cursor-tool-presentation-registry.js";

export interface CursorNativeToolDisplayItem extends CursorPiToolDisplay {
	id: string;
	terminate?: boolean;
}

export const NATIVE_CURSOR_TOOL_DISPLAY_ENV = "PI_CURSOR_NATIVE_TOOL_DISPLAY";
export const NATIVE_CURSOR_TOOL_REGISTRATION_ENV = "PI_CURSOR_REGISTER_NATIVE_TOOLS";

export interface CursorNativeToolDisplayState {
	registeredNativeToolSources: Map<string, SourceInfo>;
	skippedNativeToolNames: Set<string>;
	runtimeRequested: boolean;
	resultIds: Set<string>;
}

function createDisplayState(): CursorNativeToolDisplayState {
	return { registeredNativeToolSources: new Map(), skippedNativeToolNames: new Set(), runtimeRequested: false, resultIds: new Set() };
}

let lastDisplayState = createDisplayState();
const displayStates = new Map<object, CursorNativeToolDisplayState>();
// IDs index results; the owning display state and tool authorize consumption.
export const nativeToolResults = new Map<string, CursorNativeToolDisplayItem>();
const resultStates = new Map<string, CursorNativeToolDisplayState>();

export function getCursorNativeToolDisplayState(pi?: object): CursorNativeToolDisplayState {
	if (!pi) return lastDisplayState;
	const state = displayStates.get(pi);
	if (!state) throw new Error("Cursor native display binding is no longer active.");
	return state;
}

export function registerCursorNativeToolDisplayState(pi: { on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void }): void {
	const state = createDisplayState();
	displayStates.set(pi, state);
	lastDisplayState = state;
	pi.on("session_shutdown", () => {
		displayStates.delete(pi);
		for (const id of state.resultIds) {
			nativeToolResults.delete(id);
			resultStates.delete(id);
		}
		state.resultIds.clear();
	});
}

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

export function setCursorNativeToolDisplayRuntimeRequested(requested: boolean, pi?: object): void {
	getCursorNativeToolDisplayState(pi).runtimeRequested = requested;
}

export function isCursorNativeToolDisplayEnabled(): boolean {
	return getCursorNativeToolDisplayState().registeredNativeToolSources.size > 0;
}

export function isCursorNativeToolDisplayRuntimeEnabled(state = getCursorNativeToolDisplayState()): boolean {
	return state.runtimeRequested && readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV) !== false && state.registeredNativeToolSources.size > 0;
}

export function canRenderCursorToolNatively(toolName: string): boolean {
	return getCursorNativeToolDisplayState().registeredNativeToolSources.has(toolName);
}

export function isRegisteredCursorNativeToolName(toolName: string, pi?: object): boolean {
	return (pi ? displayStates.get(pi) : lastDisplayState)?.registeredNativeToolSources.has(toolName) === true;
}

export function recordCursorNativeToolDisplay(item: CursorNativeToolDisplayItem, state = getCursorNativeToolDisplayState()): boolean {
	if (!state.registeredNativeToolSources.has(item.toolName)) return false;
	nativeToolResults.set(item.id, item);
	resultStates.set(item.id, state);
	state.resultIds.add(item.id);
	return true;
}

export function deleteCursorNativeToolDisplay(id: string): void {
	nativeToolResults.delete(id);
	resultStates.get(id)?.resultIds.delete(id);
	resultStates.delete(id);
}

export function consumeCursorNativeToolDisplay(id: string, state: CursorNativeToolDisplayState, toolName: string): CursorNativeToolDisplayItem | undefined {
	const item = nativeToolResults.get(id);
	if (item) {
		if (resultStates.get(id) !== state || normalizeCursorToolName(item.toolName) !== normalizeCursorToolName(toolName)) {
			throw new Error(`No owned Cursor ${toolName} result was available. This replay-only call does not execute work.`);
		}
		deleteCursorNativeToolDisplay(id);
	}
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
	registerNativeToolNameForTests(toolName: string, pi?: object): void {
		const state = getCursorNativeToolDisplayState(pi);
		state.runtimeRequested = true;
		state.registeredNativeToolSources.set(toolName, { path: "test", source: "inline", scope: "temporary", origin: "top-level" });
	},
	reset(): void {
		lastDisplayState = createDisplayState();
		displayStates.clear();
		nativeToolResults.clear();
		resultStates.clear();
	},
};
