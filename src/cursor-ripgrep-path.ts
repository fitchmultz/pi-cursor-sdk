import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";

const RIPGREP_ENV = "CURSOR_RIPGREP_PATH";

export function resolveBundledCursorRipgrepPath(
	fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
	try {
		const require = createRequire(fromModuleUrl);
		const platformPackage = `@cursor/sdk-${process.platform}-${process.arch}`;
		const sdkEntry = require.resolve("@cursor/sdk");
		const packageDirectory = dirname(
			require.resolve(`${platformPackage}/package.json`, { paths: [dirname(sdkEntry)] }),
		);
		const ripgrepPath = join(packageDirectory, "bin", process.platform === "win32" ? "rg.exe" : "rg");
		accessSync(ripgrepPath, constants.X_OK);
		return ripgrepPath;
	} catch {
		return undefined;
	}
}

export function ensureCursorRipgrepPath(): string | undefined {
	const configuredPath = process.env[RIPGREP_ENV];
	if (configuredPath && isAbsolute(configuredPath)) return configuredPath;

	const bundledPath = resolveBundledCursorRipgrepPath();
	if (bundledPath) process.env[RIPGREP_ENV] = bundledPath;
	return bundledPath;
}
