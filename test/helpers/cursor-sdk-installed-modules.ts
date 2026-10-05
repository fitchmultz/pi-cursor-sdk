import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInThisContext } from "node:vm";
import ts from "@typescript/typescript6";
import { resolveInstalledPackageRoot } from "./installed-package.js";

// Test-only execution of installed SDK factories. No replacement SDK code is
// shipped; a missing module/loader seam fails the contract rather than guessing.
export async function installedCursorModules() {
	const root = resolveInstalledPackageRoot("@cursor/sdk");
	const entry = join(root, "dist/esm/index.js");
	const source = readFileSync(entry, "utf8");
	const ast = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	let table: Record<string, any> | undefined;
	function visit(node: ts.Node): void {
		if (ts.isObjectLiteralExpression(node) && node.properties.some((property) =>
			property.name && ts.isStringLiteral(property.name) && property.name.text === "./src/agent/store/sdk-state-root.ts")) {
			table = runInThisContext(`(${node.getText(ast)})`, { filename: entry });
			return;
		}
		if (!table) ts.forEachChild(node, visit);
	}
	visit(ast);
	if (!table) throw new Error("Installed SDK module table changed");
	// Discover chunks by their exported module tables, never numeric bundle IDs.
	for (const name of readdirSync(join(root, "dist/esm")).filter((name) => name.endsWith(".js") && name !== "index.js")) {
		if (!readFileSync(join(root, "dist/esm", name), "utf8").includes("__webpack_esm_modules__")) continue;
		const chunk = await import(pathToFileURL(join(root, "dist/esm", name)).href);
		Object.assign(table, chunk.__webpack_esm_modules__);
	}
	const require = createRequire(entry);
	const externals: Record<string, unknown> = {
		"@connectrpc/connect": await import("@connectrpc/connect"),
		"@bufbuild/protobuf": await import("@bufbuild/protobuf"),
	};
	const cache: Record<string, any> = {};
	const load = Object.assign((name: string): any => {
		if (name.startsWith("/")) {
			const matches = Object.keys(table!).filter((key) => key.endsWith(name));
			if (matches.length !== 1) throw new Error(`Installed SDK module suffix is ambiguous or absent: ${name}`);
			name = matches[0]!;
		}
		if (!name.startsWith(".")) return externals[name] ?? require(name.replace(/\?.*$/, ""));
		if (cache[name]) return cache[name];
		const factory = table![name];
		if (!factory) throw new Error(`Installed SDK module missing: ${name}`);
		const module = { exports: {} };
		cache[name] = module.exports;
		factory(module, module.exports, load);
		return cache[name] = module.exports;
	}, {
		r: (target: object) => Object.defineProperty(target, "__esModule", { value: true }),
		d: (target: object, getters: Record<string, () => unknown>) => {
			for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { enumerable: true, get });
		},
		n: (value: any) => value?.__esModule ? () => value.default : () => value,
		o: (target: object, key: string) => Object.hasOwn(target, key),
	});
	return load;
}
