import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

// Exercise the installed SDK's private vendor loader, not a reimplementation of its lookup.
export function loadInstalledCursorParsers(sdkEntry: string) {
	const require = createRequire(sdkEntry);
	const source = readFileSync(join(dirname(sdkEntry), "index.js"), "utf8");
	const names = ["./src/agent/native/vendored-tree-sitter.ts", "./src/agent/platform-package-locator.ts"];
	const end = source.indexOf(',"./src/agent/run-interaction-accumulator.ts"(');
	const start = source.indexOf(`"${names[0]}"(`);
	if (start < 0 || end <= start) throw new Error("Installed SDK vendor loader contract changed");
	const factories = runInNewContext(`({${source.slice(start, end)}})`, { process });
	const cache: Record<string, any> = {};
	const webpackRequire = Object.assign((name: string): any => {
		if (name.startsWith("node:")) return require(name);
		if (!cache[name]) {
			cache[name] = {};
			factories[name]({}, cache[name], webpackRequire);
		}
		return cache[name];
	}, {
		r: () => {},
		d: (target: object, getters: Record<string, () => unknown>) => {
			for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
		},
	});
	const vendor = webpackRequire(names[0]);
	return ["tree-sitter", "tree-sitter-bash"].map((packageName) => vendor.loadVendoredTreeSitterModule({ packageName, nativeRequire: require }));
}
