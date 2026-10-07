import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInThisContext } from "node:vm";
import ts from "@typescript/typescript6";
import { resolveInstalledPackageRoot } from "./installed-package.js";

// Test-only execution of installed SDK factories. No replacement SDK code is
// shipped; a missing module/loader seam fails the contract rather than guessing.
let installedFactories: ReturnType<typeof discoverInstalledCursorModules> | undefined;

export function installedCursorModuleDeclarations(source: string) {
	const ast = ts.createSourceFile("installed-module.js", `({${source}})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const statement = ast.statements[0];
	if (!statement || !ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression) ||
		!ts.isObjectLiteralExpression(statement.expression.expression)) throw new Error("Installed module factory changed");
	const factory = statement.expression.expression.properties[0];
	if (!factory || !ts.isMethodDeclaration(factory) || !factory.body) throw new Error("Installed module factory body changed");
	const declarations = new Map<string, ts.FunctionDeclaration | ts.ClassDeclaration>();
	for (const node of factory.body.statements) {
		if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) declarations.set(node.name.text, node);
	}
	return {
		declarations,
		execute<T>(declaration: ts.FunctionDeclaration | ts.ClassDeclaration): T {
			const selected = new Set<string>();
			const snippets: string[] = [];
			function include(node: ts.FunctionDeclaration | ts.ClassDeclaration) {
				const name = node.name!.text;
				if (selected.has(name)) return;
				selected.add(name);
				function references(child: ts.Node) {
					const expression = ts.isCallExpression(child) || ts.isNewExpression(child) ||
						(ts.isExpressionWithTypeArguments(child) && ts.isHeritageClause(child.parent)) ? child.expression : undefined;
					if (expression && ts.isIdentifier(expression)) {
						const dependency = declarations.get(expression.text);
						if (dependency) include(dependency);
					}
					ts.forEachChild(child, references);
				}
				references(node);
				snippets.push(node.getText(ast));
			}
			include(declaration);
			// Only the installed declarations run; VM coordinates are harness-relative.
			return runInThisContext(`(() => { ${snippets.join("\n")}; return ${declaration.name!.text}; })()`, {
				filename: join(resolveInstalledPackageRoot("@cursor/sdk"), "dist/esm/index.js"),
			}) as T;
		},
	};
}

export async function installedCursorModules() {
	return (await (installedFactories ??= discoverInstalledCursorModules()))();
}

async function discoverInstalledCursorModules() {
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
		"@connectrpc/connect": await import(pathToFileURL(require.resolve("@connectrpc/connect")).href),
		"@bufbuild/protobuf": await import(pathToFileURL(require.resolve("@bufbuild/protobuf")).href),
	};
	// Reuse only unbound installed factories. Every caller gets fresh exports:
	// logger evaluation captures console methods and color environment state.
	return () => {
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
			factorySource: (name: string): string => {
				const factory = table![name];
				if (!factory) throw new Error(`Installed SDK module missing: ${name}`);
				return factory.toString();
			},
		});
		return load;
	};
}
