import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveCursorSdkPlatformPackageDirectory } from "./cursor-ripgrep-path.js";

/**
 * Ensure CURSOR_TREE_SITTER_VENDOR_DIR is set before @cursor/sdk first loads.
 * Runs as an import side effect before the SDK is first loaded.
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
