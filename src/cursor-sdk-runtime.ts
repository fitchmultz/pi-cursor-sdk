// Vendor env must initialize before @cursor/sdk first loads so tree-sitter natives
// resolve when Pi lives outside this package's node_modules.
import "./cursor-sdk-vendor-env.js";
// Compiled-Bun Pi can't resolve bare specifiers natively (#228). This host peer fails
// native import there, so Pi's loader (jiti) transpiles this module instead, and jiti
// resolves the import() below itself.
import "@earendil-works/pi-coding-agent";

export type CursorSdkModule = typeof import("@cursor/sdk");

let cursorSdk: Promise<CursorSdkModule> | undefined;

/**
 * Load the Cursor SDK on first use. Keep failures too: the host loader can cache
 * a partially evaluated module, so retrying this import is not necessarily safe.
 * Correct the underlying failure and restart the Pi process before trying again.
 */
export function loadCursorSdk(): Promise<CursorSdkModule> {
	return cursorSdk ??= import("@cursor/sdk");
}
