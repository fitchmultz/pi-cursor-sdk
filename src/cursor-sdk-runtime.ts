// Vendor env must initialize before the static @cursor/sdk import below so
// tree-sitter natives resolve when Pi lives outside this package's node_modules.
import "./cursor-sdk-vendor-env.js";
import * as CursorSdk from "@cursor/sdk";

export type CursorSdkModule = typeof CursorSdk;

/**
 * Load the Cursor SDK module.
 *
 * Uses a static import so Pi's compiled-Bun extension graph includes @cursor/sdk
 * (a runtime dynamic bare import is omitted from that graph; see #228).
 * `loadCursorSdk` remains async for call-site compatibility and so vendor-env
 * side effects (imported above) always run before callers receive the module.
 */
export async function loadCursorSdk(): Promise<CursorSdkModule> {
	return CursorSdk;
}
