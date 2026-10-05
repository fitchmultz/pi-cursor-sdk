import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveCursorSdkPlatformPackageDirectory } from "./cursor-ripgrep-path.js";

/**
 * Ensure CURSOR_TREE_SITTER_VENDOR_DIR is set before @cursor/sdk first loads.
 * Must run as a side effect of importing this module (before a static SDK import).
 */
export function ensureCursorTreeSitterVendorDir(): void {
	if (process.env.CURSOR_TREE_SITTER_VENDOR_DIR !== undefined) return;
	const packageDirectory = resolveCursorSdkPlatformPackageDirectory();
	if (!packageDirectory) return;
	const vendor = join(packageDirectory, "vendor");
	if (
		existsSync(join(vendor, "tree-sitter", "index.js")) &&
		existsSync(join(vendor, "tree-sitter-bash", "index.js"))
	) {
		process.env.CURSOR_TREE_SITTER_VENDOR_DIR = vendor;
	}
}

ensureCursorTreeSitterVendorDir();
