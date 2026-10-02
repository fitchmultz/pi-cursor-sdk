import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveCursorSdkPlatformPackageDirectory } from "./cursor-ripgrep-path.js";

export type CursorSdkModule = typeof import("@cursor/sdk");

export async function loadCursorSdk(): Promise<CursorSdkModule> {
	// The SDK searches launcher ancestors, which miss Pi's separately installed extension packages.
	if (process.env.CURSOR_TREE_SITTER_VENDOR_DIR === undefined) {
		const packageDirectory = resolveCursorSdkPlatformPackageDirectory();
		if (packageDirectory) {
			const vendor = join(packageDirectory, "vendor");
			if (existsSync(join(vendor, "tree-sitter", "index.js")) && existsSync(join(vendor, "tree-sitter-bash", "index.js"))) {
				process.env.CURSOR_TREE_SITTER_VENDOR_DIR = vendor;
			}
		}
	}
	return import("@cursor/sdk");
}
