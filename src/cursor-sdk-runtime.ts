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
 * Load the Cursor SDK on first use. Evaluating it costs up to a second on a cold
 * start, which would otherwise delay every Pi start.
 */
export function loadCursorSdk(): Promise<CursorSdkModule> {
	cursorSdk ??= import("@cursor/sdk").catch((error: unknown) => {
		cursorSdk = undefined;
		throw error;
	});
	return cursorSdk;
}
