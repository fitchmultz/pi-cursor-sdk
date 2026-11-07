import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { isCursorLeanEnabled } from "./cursor-lean.js";

export const CURSOR_NATIVE_TOOLS_ENV = "PI_CURSOR_NATIVE_TOOLS";

/** Lean always disables native tools; the legacy opt-out selects an MCP-only main loop. */
export function resolveCursorNativeToolsEnabled(
	env: Record<string, string | undefined> = process.env,
	leanEnabled = isCursorLeanEnabled(env),
): boolean {
	return !leanEnabled && parseEnvBoolean(env[CURSOR_NATIVE_TOOLS_ENV], true);
}

export function assertCursorNativeToolsRuntime(
	runtime: "local" | "cloud",
	nativeToolsEnabled: boolean,
	leanEnabled = isCursorLeanEnabled(),
): void {
	if (runtime !== "cloud") return;
	if (leanEnabled) {
		throw new Error("PI_CURSOR_LEAN requires local runtime: Cursor SDK tool restrictions are not supported on Cloud.");
	}
	if (!nativeToolsEnabled) {
		throw new Error("PI_CURSOR_NATIVE_TOOLS=0 requires local runtime; Cursor Cloud does not support the SDK tools restriction. Select local runtime or remove the opt-out.");
	}
}
