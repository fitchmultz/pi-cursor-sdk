import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Walk from require.resolve(packageName) to the installed package root. */
export function resolveInstalledPackageRoot(packageName: string): string {
	let directory = dirname(require.resolve(packageName));
	for (let depth = 0; depth < 6; depth += 1) {
		const packageJsonPath = join(directory, "package.json");
		try {
			const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
			if (packageJson.name === packageName) return directory;
		} catch {
			// keep walking toward the package root
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(`could not resolve installed package root for ${packageName}`);
}

export function readInstalledPackageVersion(packageName: string): string {
	const packageJson = JSON.parse(readFileSync(join(resolveInstalledPackageRoot(packageName), "package.json"), "utf8")) as {
		version?: string;
	};
	if (typeof packageJson.version !== "string") {
		throw new Error(`could not resolve installed version for ${packageName}`);
	}
	return packageJson.version;
}

export function readInstalledPackageDistText(packageName: string): string {
	const packageRoot = resolveInstalledPackageRoot(packageName);
	return globSync("dist/**/*.{js,cjs,mjs}", { cwd: packageRoot })
		.sort()
		.map((path) => readFileSync(join(packageRoot, path), "utf8"))
		.join("\n");
}
