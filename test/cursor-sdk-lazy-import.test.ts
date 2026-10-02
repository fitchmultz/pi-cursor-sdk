import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ts from "@typescript/typescript6";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintApiKey, saveModelListCache } from "../src/model-list-cache.js";
import type { ModelListItem } from "@cursor/sdk";

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(?:[mc]?ts|tsx)$/.test(path) && !/\.d\.(?:[mc]?ts|tsx)$/.test(path) ? [path] : [];
	});
}

function scriptKind(path: string): ts.ScriptKind {
	if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
	if (/\.[mc]?ts$/.test(path)) return ts.ScriptKind.TS;
	return ts.ScriptKind.JS;
}

function moduleText(node: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined {
	return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
}

function isTypeOnlyExport(node: ts.ExportDeclaration, isJavaScript: boolean): boolean {
	if (node.isTypeOnly) return true;
	if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return false;
	return node.exportClause.elements.length === 0
		? !isJavaScript
		: node.exportClause.elements.every((element) => element.isTypeOnly);
}

const PI_HOST_PEER_PREFIXES = ["@earendil-works/pi-"] as const;
const PI_HOST_PEER_ROOTS = ["@sinclair/typebox", "typebox"] as const;

function isPiHostPeer(specifier: string): boolean {
	return (
		PI_HOST_PEER_PREFIXES.some((prefix) => specifier.startsWith(prefix))
		|| PI_HOST_PEER_ROOTS.some((root) => specifier === root || specifier.startsWith(`${root}/`))
	);
}

function importHasRuntimeBindings(node: ts.ImportDeclaration, isJavaScript: boolean): boolean {
	const clause = node.importClause;
	if (!clause) return true;
	if (clause.isTypeOnly) return false;
	if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true;
	return clause.namedBindings.elements.length === 0
		? isJavaScript
		: clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function isCursorSdkSpecifier(specifier: string): boolean {
	return specifier === "@cursor/sdk" || specifier.startsWith("@cursor/sdk/");
}

function isAllowedCursorSdkDynamicImport(relativePath: string, specifier: string): boolean {
	return (
		(relativePath.endsWith("src/cursor-sdk-runtime.ts") && specifier === "@cursor/sdk")
		|| (relativePath.endsWith("src/cursor-session-store.ts") && specifier === "@cursor/sdk/sqlite")
	);
}

function isMcpRuntimeSpecifier(specifier: string): boolean {
	return specifier.startsWith("@modelcontextprotocol/") || specifier === "@hono/node-server";
}

function isAllowedMcpRuntimeImport(relativePath: string, specifier: string): boolean {
	return (
		relativePath.endsWith("src/cursor-pi-tool-bridge-run.ts")
		&& specifier === "@modelcontextprotocol/server"
	) || (
		relativePath.endsWith("src/cursor-pi-tool-bridge-server.ts")
		&& (specifier === "@modelcontextprotocol/hono" || specifier === "@hono/node-server")
	);
}

function collectRuntimeSdkEdges(paths: string[] = sourceFiles(join(process.cwd(), "src"))): string[] {
	const offenders: string[] = [];
	for (const path of paths) {
		const relativePath = relative(process.cwd(), path).replace(/\\/g, "/");
		const source = ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true, scriptKind(path));
		const visit = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node) && importHasRuntimeBindings(node, false)) {
				const specifier = moduleText(node);
				if (specifier && isCursorSdkSpecifier(specifier)) {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime import ${specifier}`);
				}
				if (specifier && isMcpRuntimeSpecifier(specifier) && !isAllowedMcpRuntimeImport(relativePath, specifier)) {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime import ${specifier}`);
				}
				if (specifier === "./cursor-pi-tool-bridge-run.js") {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime import bridge run implementation`);
				}
			}
			if (ts.isExportDeclaration(node) && !isTypeOnlyExport(node, false)) {
				const specifier = moduleText(node);
				if (specifier && isCursorSdkSpecifier(specifier)) {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime export ${specifier}`);
				}
				if (specifier && isMcpRuntimeSpecifier(specifier)) {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime export ${specifier}`);
				}
			}
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				const argument = node.arguments[0];
				if (argument && ts.isStringLiteralLike(argument)) {
					const specifier = argument.text;
					if (isCursorSdkSpecifier(specifier) && !isAllowedCursorSdkDynamicImport(relativePath, specifier)) {
						offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: dynamic import ${specifier} outside runtime loader`);
					}
					if (isMcpRuntimeSpecifier(specifier) && !isAllowedMcpRuntimeImport(relativePath, specifier)) {
						offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: dynamic import ${specifier} outside bridge runtime`);
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return offenders;
}

type RuntimeModuleInfo = {
	path: string;
	relativePath: string;
	runtimeHostPeers: string[];
	staticRelativeSpecifiers: string[];
	dynamicImports: Array<{ line: number; specifier?: string }>;
	nativeHostPeerSpecifiers: Array<{ line: number; specifier: string }>;
	nativeLoaderOffenses: Array<{ line: number; message: string }>;
	runtimeImportEquals: Array<{ line: number; specifier: string }>;
	unsupportedRuntimeReason?: string;
};

function sharedRuntimeFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sharedRuntimeFiles(path);
		return /\.[cm]?js$/.test(path) ? [path] : [];
	});
}

function runtimeModuleFiles(
	srcDir: string = join(process.cwd(), "src"),
	sharedDir: string = join(process.cwd(), "shared"),
): string[] {
	return [...sourceFiles(srcDir), ...sharedRuntimeFiles(sharedDir)];
}

function resolveSourceSpecifier(importerPath: string, specifier: string, sourcePaths: ReadonlySet<string>): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const resolved = resolve(dirname(importerPath), specifier);
	const emittedSource = resolved.endsWith(".mjs")
		? [resolved.replace(/\.mjs$/, ".mts")]
		: resolved.endsWith(".cjs")
			? [resolved.replace(/\.cjs$/, ".cts")]
			: resolved.endsWith(".js")
				? [resolved.replace(/\.js$/, ".ts"), resolved.replace(/\.js$/, ".tsx")]
				: [];
	const candidates = [
		...emittedSource,
		resolved,
		...([".ts", ".tsx", ".mts", ".cts"].map((extension) => `${resolved}${extension}`)),
		...(["index.ts", "index.tsx", "index.mts", "index.cts"].map((entry) => join(resolved, entry))),
	];
	return candidates.find((candidate) => sourcePaths.has(candidate));
}

function isErasedStringLiteral(node: ts.StringLiteralLike, isJavaScript: boolean): boolean {
	const parent = node.parent;
	return (
		(ts.isImportDeclaration(parent) && parent.moduleSpecifier === node && !importHasRuntimeBindings(parent, isJavaScript))
		|| (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node && isTypeOnlyExport(parent, isJavaScript))
		|| ts.isLiteralTypeNode(parent)
		|| (ts.isExternalModuleReference(parent) && ts.isImportEqualsDeclaration(parent.parent) && parent.parent.isTypeOnly)
	);
}

function isInTypeQuery(node: ts.Node): boolean {
	return Boolean(ts.findAncestor(node.parent, ts.isTypeQueryNode));
}

function isAmbientModuleName(node: ts.StringLiteralLike): boolean {
	const parent = node.parent;
	return (
		ts.isModuleDeclaration(parent)
		&& parent.name === node
		&& Boolean(parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
	);
}

function isStaticOrErasedModuleSpecifier(node: ts.StringLiteralLike, isJavaScript: boolean): boolean {
	const parent = node.parent;
	return (
		isErasedStringLiteral(node, isJavaScript)
		|| (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node)
		|| (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node)
	);
}

function isCanonicalCreateRequireImport(node: ts.StringLiteralLike): boolean {
	const parent = node.parent;
	if (!ts.isImportDeclaration(parent) || parent.moduleSpecifier !== node || node.text !== "node:module") return false;
	const clause = parent.importClause;
	const bindings = clause?.namedBindings;
	return Boolean(
		clause
		&& !clause.isTypeOnly
		&& !clause.name
		&& !parent.attributes
		&& bindings
		&& ts.isNamedImports(bindings)
		&& bindings.elements.length === 1
		&& !bindings.elements[0].isTypeOnly
		&& !bindings.elements[0].propertyName
		&& bindings.elements[0].name.text === "createRequire",
	);
}

function collectUnsafeHostPeerLoads(
	paths: string[] = runtimeModuleFiles(),
	nativeModuleLoaderPath: string = join(process.cwd(), "src", "cursor-ripgrep-path.ts"),
): string[] {
	const sourcePaths = new Set(paths);
	const modules = new Map<string, RuntimeModuleInfo>();
	const canonicalNativeModulePath = resolve(nativeModuleLoaderPath);

	for (const path of paths) {
		const isCanonicalNativeModule = resolve(path) === canonicalNativeModulePath;
		const isJavaScriptSource = /\.[cm]?js$/.test(path);
		const source = ts.createSourceFile(
			path,
			readFileSync(path, "utf-8"),
			ts.ScriptTarget.Latest,
			true,
			scriptKind(path),
		);
		const nativeRequireNames = new Set<string>();
		if (isCanonicalNativeModule) {
			const collectNativeRequireNames = (node: ts.Node): void => {
				if (
					ts.isVariableDeclaration(node)
					&& ts.isIdentifier(node.name)
					&& node.initializer
					&& ts.isCallExpression(node.initializer)
					&& ts.isIdentifier(node.initializer.expression)
					&& node.initializer.expression.text === "createRequire"
				) {
					nativeRequireNames.add(node.name.text);
				}
				ts.forEachChild(node, collectNativeRequireNames);
			};
			collectNativeRequireNames(source);
		}
		const info: RuntimeModuleInfo = {
			path,
			relativePath: relative(process.cwd(), path).replace(/\\/g, "/"),
			runtimeHostPeers: [],
			staticRelativeSpecifiers: [],
			dynamicImports: [],
			nativeHostPeerSpecifiers: [],
			nativeLoaderOffenses: [],
			runtimeImportEquals: [],
			unsupportedRuntimeReason: path.endsWith(".cts")
				? "CommonJS .cts source is unsupported by the host-peer guard"
				: path.endsWith(".cjs")
					? "CommonJS .cjs shared runtime is unsupported by the host-peer guard"
					: undefined,
		};
		const visit = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node) && importHasRuntimeBindings(node, isJavaScriptSource)) {
				const specifier = moduleText(node);
				if (specifier && isPiHostPeer(specifier)) info.runtimeHostPeers.push(specifier);
				if (specifier?.startsWith(".")) info.staticRelativeSpecifiers.push(specifier);
			}
			if (ts.isExportDeclaration(node) && !isTypeOnlyExport(node, isJavaScriptSource)) {
				const specifier = moduleText(node);
				if (specifier && isPiHostPeer(specifier)) info.runtimeHostPeers.push(specifier);
				if (specifier?.startsWith(".")) info.staticRelativeSpecifiers.push(specifier);
			}
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				const argument = node.arguments[0];
				info.dynamicImports.push({
					line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
					specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : undefined,
				});
			}
			if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
				const expression = node.moduleReference.expression;
				info.runtimeImportEquals.push({
					line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
					specifier: expression && ts.isStringLiteralLike(expression) ? expression.text : "<non-literal>",
				});
			}
			if (
				ts.isStringLiteralLike(node)
				&& isPiHostPeer(node.text)
				&& !isStaticOrErasedModuleSpecifier(node, isJavaScriptSource)
				&& !isAmbientModuleName(node)
			) {
				info.nativeHostPeerSpecifiers.push({
					line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
					specifier: node.text,
				});
			}
			if (
				ts.isStringLiteralLike(node)
				&& (node.text === "node:module" || node.text === "module")
				&& !isErasedStringLiteral(node, isJavaScriptSource)
				&& !isAmbientModuleName(node)
			) {
				const message = !isCanonicalNativeModule
					? `native module loader ${node.text} outside src/cursor-ripgrep-path.ts`
					: !isCanonicalCreateRequireImport(node)
						? 'src/cursor-ripgrep-path.ts must use import { createRequire } from "node:module"'
						: undefined;
				if (message) {
					info.nativeLoaderOffenses.push({
						line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
						message,
					});
				}
			}
			if (isCanonicalNativeModule && ts.isIdentifier(node) && nativeRequireNames.has(node.text) && !isInTypeQuery(node)) {
				const parent = node.parent;
				const isDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
				const isResolveReceiver =
					ts.isPropertyAccessExpression(parent)
					&& parent.expression === node
					&& parent.name.text === "resolve";
				if (!isDeclaration && !isResolveReceiver) {
					info.nativeLoaderOffenses.push({
						line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
						message: `${node.text} created by createRequire may only be used via ${node.text}.resolve`,
					});
				}
			}
			if (isCanonicalNativeModule && ts.isIdentifier(node) && node.text === "createRequire" && !isInTypeQuery(node)) {
				const parent = node.parent;
				const call = ts.isCallExpression(parent) && parent.expression === node ? parent : undefined;
				const declaration = call?.parent;
				const isImportBinding = ts.isImportSpecifier(parent);
				const initializesNamedLoader =
					declaration
					&& ts.isVariableDeclaration(declaration)
					&& declaration.initializer === call
					&& ts.isIdentifier(declaration.name);
				if (!isImportBinding && !initializesNamedLoader) {
					info.nativeLoaderOffenses.push({
						line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
						message: "createRequire may only initialize a named resolve-only loader",
					});
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		modules.set(path, info);
	}

	const findHostPeer = (startPath: string): string | undefined => {
		const pending = [startPath];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const path = pending.pop()!;
			if (visited.has(path)) continue;
			visited.add(path);
			const info = modules.get(path);
			if (!info) continue;
			if (info.runtimeHostPeers.length > 0) return `${info.relativePath} -> ${info.runtimeHostPeers[0]}`;
			for (const specifier of info.staticRelativeSpecifiers) {
				const target = resolveSourceSpecifier(path, specifier, sourcePaths);
				if (!target) return `${info.relativePath} -> unresolved static import ${specifier}`;
				pending.push(target);
			}
		}
		return undefined;
	};

	const offenders: string[] = [];
	for (const info of modules.values()) {
		if (info.unsupportedRuntimeReason) offenders.push(`${info.relativePath}:1: ${info.unsupportedRuntimeReason}`);
		for (const load of info.nativeHostPeerSpecifiers) {
			offenders.push(`${info.relativePath}:${load.line}: native host-peer specifier ${load.specifier}`);
		}
		for (const load of info.nativeLoaderOffenses) {
			offenders.push(`${info.relativePath}:${load.line}: ${load.message}`);
		}
		for (const load of info.runtimeImportEquals) {
			offenders.push(`${info.relativePath}:${load.line}: runtime import-equals ${load.specifier}`);
		}
		for (const dynamicImport of info.dynamicImports) {
			if (!dynamicImport.specifier) {
				offenders.push(`${info.relativePath}:${dynamicImport.line}: non-literal dynamic import`);
				continue;
			}
			const target = resolveSourceSpecifier(info.path, dynamicImport.specifier, sourcePaths);
			if (!target) {
				if (dynamicImport.specifier.startsWith(".")) {
					offenders.push(`${info.relativePath}:${dynamicImport.line}: unresolved relative dynamic import ${dynamicImport.specifier}`);
				}
				continue;
			}
			const hostPeer = findHostPeer(target);
			if (hostPeer) {
				offenders.push(`${info.relativePath}:${dynamicImport.line}: ${dynamicImport.specifier} reaches ${hostPeer}`);
			}
		}
	}
	return offenders.sort();
}

describe("Cursor SDK lazy runtime imports", () => {
	const originalEnv = process.env;
	let tmpAgentDir: string | undefined;

	afterEach(() => {
		if (tmpAgentDir) rmSync(tmpAgentDir, { recursive: true, force: true });
		tmpAgentDir = undefined;
		process.env = originalEnv;
		vi.doUnmock("@cursor/sdk");
		vi.resetModules();
	});

	it("keeps heavy SDK value imports behind lazy runtime boundaries", () => {
		expect(collectRuntimeSdkEdges()).toEqual([]);
	});

	it("rejects static SDK subpaths and template SDK imports outside the runtime loaders", () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-sdk-edge-"));
		const fixturePath = join(tmpAgentDir, "sdk-edge.ts");
		writeFileSync(fixturePath, [
			'import { open } from "@cursor/sdk/sqlite";',
			"void import(`@cursor/sdk/experimental`);",
		].join("\n"));

		const findings = collectRuntimeSdkEdges([fixturePath]).join("\n");
		expect(findings).toContain("runtime import @cursor/sdk/sqlite");
		expect(findings).toContain("dynamic import @cursor/sdk/experimental outside runtime loader");
	});

	it("pins TypeScript import elision used by the graph", () => {
		const config = ts.getParsedCommandLineOfConfigFile(join(process.cwd(), "tsconfig.build.json"), {}, {
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
				throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
			},
		});
		expect(config).toBeDefined();
		expect(config?.options.verbatimModuleSyntax).not.toBe(true);
	});

	it("scans ESM and TSX sources and rejects CommonJS TypeScript", () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-source-extensions-"));
		const srcDir = join(tmpAgentDir, "src");
		mkdirSync(srcDir);
		writeFileSync(join(srcDir, "entry.mts"), 'void import("./target.mjs");\n');
		writeFileSync(join(srcDir, "target.mts"), 'import "@earendil-works/pi-mts";\n');
		writeFileSync(join(srcDir, "edge.tsx"), 'void import("@earendil-works/pi-tsx");\n');
		writeFileSync(join(srcDir, "edge.cts"), 'require("@earendil-works/pi-cts");\n');

		const findings = collectUnsafeHostPeerLoads(sourceFiles(srcDir)).join("\n");
		expect(findings).toContain("./target.mjs reaches");
		expect(findings).toContain("@earendil-works/pi-mts");
		expect(findings).toContain("native host-peer specifier @earendil-works/pi-tsx");
		expect(findings).toContain("CommonJS .cts source is unsupported by the host-peer guard");
	});

	it("scans shared JavaScript and rejects shared CommonJS", () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-shared-extensions-"));
		const srcDir = join(tmpAgentDir, "src");
		const sharedDir = join(tmpAgentDir, "shared");
		mkdirSync(srcDir);
		mkdirSync(sharedDir);
		writeFileSync(join(srcDir, "entry.ts"), 'import "../shared/edge.cjs";\n');
		writeFileSync(join(sharedDir, "edge.js"), 'void import("@earendil-works/pi-shared-js");\n');
		writeFileSync(join(sharedDir, "edge.cjs"), 'require("@earendil-works/pi-shared-cjs");\n');

		const findings = collectUnsafeHostPeerLoads(runtimeModuleFiles(srcDir, sharedDir)).join("\n");
		expect(findings).toContain("native host-peer specifier @earendil-works/pi-shared-js");
		expect(findings).toContain("native host-peer specifier @earendil-works/pi-shared-cjs");
		expect(findings).toContain("CommonJS .cjs shared runtime is unsupported by the host-peer guard");
	});

	it("keeps native loaders away from Pi host peers", () => {
		expect(collectUnsafeHostPeerLoads()).toEqual([]);
	});

	it("allows type-only import-equals for both Node module spellings", () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-type-import-equals-"));
		const fixturePath = join(tmpAgentDir, "type-import-equals.ts");
		writeFileSync(fixturePath, [
			'import type NodeModule = require("node:module");',
			'import type LegacyModule = require("module");',
			'import type LegacyPi = require("@earendil-works/pi-ai");',
			'type LoaderLiteral = "module";',
			'type PeerLiteral = "@earendil-works/pi-ai";',
		].join("\n"));

		expect(collectUnsafeHostPeerLoads([fixturePath])).toEqual([]);
	});

	it("rejects direct require use in the canonical resolve-only loader", () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-native-require-"));
		const srcDir = join(tmpAgentDir, "src");
		const sharedDir = join(tmpAgentDir, "shared");
		mkdirSync(srcDir);
		mkdirSync(sharedDir);
		const entryPath = join(srcDir, "cursor-ripgrep-path.ts");
		writeFileSync(entryPath, [
			'import { createRequire } from "node:module";',
			'const require = createRequire(import.meta.url);',
			'class NamedLoader extends require("../shared/helper.mjs").default {}',
			'class DirectLoader extends createRequire(import.meta.url)("../shared/helper.mjs").default {}',
		].join("\n"));
		writeFileSync(join(sharedDir, "helper.mjs"), 'import {} from "@earendil-works/pi-tui";\nexport default class Helper {}\n');

		const findings = collectUnsafeHostPeerLoads(runtimeModuleFiles(srcDir, sharedDir), entryPath).join("\n");
		expect(findings).toContain("require created by createRequire may only be used via require.resolve");
		expect(findings).toContain("createRequire may only initialize a named resolve-only loader");
	});

	it("rejects aliases of the canonical native loader", () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-native-require-alias-"));
		const entryPath = join(tmpAgentDir, "cursor-ripgrep-path.ts");
		writeFileSync(entryPath, [
			'import { createRequire } from "node:module";',
			'const require = createRequire(import.meta.url);',
			'const alias = require;',
			'alias("../shared/helper.mjs");',
		].join("\n"));

		const findings = collectUnsafeHostPeerLoads([entryPath], entryPath).join("\n");
		expect(findings).toContain("require created by createRequire may only be used via require.resolve");
	});

	it("allows canonical loader names in erased type queries", () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-native-loader-types-"));
		const entryPath = join(tmpAgentDir, "cursor-ripgrep-path.ts");
		writeFileSync(entryPath, [
			'import { createRequire } from "node:module";',
			'const require = createRequire(import.meta.url);',
			'type Factory = typeof createRequire;',
			'type NativeRequire = typeof require;',
			'require.resolve("@cursor/sdk");',
		].join("\n"));

		expect(collectUnsafeHostPeerLoads([entryPath], entryPath)).toEqual([]);
	});

	it("rejects noncanonical imports in the canonical native loader", () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-native-import-attributes-"));
		const entryPath = join(tmpAgentDir, "cursor-ripgrep-path.ts");
		writeFileSync(entryPath, [
			'import { createRequire } from "node:module" with {};',
			'const require = createRequire(import.meta.url);',
			'require.resolve("@cursor/sdk");',
		].join("\n"));

		const findings = collectUnsafeHostPeerLoads([entryPath], entryPath).join("\n");
		expect(findings).toContain('must use import { createRequire } from "node:module"');

		const aliasPath = join(tmpAgentDir, "cursor-ripgrep-alias.ts");
		writeFileSync(aliasPath, [
			'import { createRequire as makeRequire } from "node:module";',
			'const require = makeRequire(import.meta.url);',
			'require.resolve("@cursor/sdk");',
		].join("\n"));
		const aliasFindings = collectUnsafeHostPeerLoads([aliasPath], aliasPath).join("\n");
		expect(aliasFindings).toContain('must use import { createRequire } from "node:module"');
	});

	it("ignores declaration files and ambient module names", () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-declarations-"));
		const srcDir = join(tmpAgentDir, "src");
		mkdirSync(srcDir);
		const ambientPath = join(srcDir, "ambient.ts");
		writeFileSync(ambientPath, [
			'declare module "module" {}',
			'declare module "@earendil-works/pi-ambient" {}',
		].join("\n"));
		writeFileSync(join(srcDir, "types.d.ts"), 'import Runtime = require("node:module");\n');
		writeFileSync(join(srcDir, "types.d.mts"), 'import Runtime from "@earendil-works/pi-ai";\n');
		writeFileSync(join(srcDir, "types.d.cts"), 'import Runtime = require("module");\n');

		expect(sourceFiles(srcDir)).toEqual([ambientPath]);
		expect(collectUnsafeHostPeerLoads(sourceFiles(srcDir))).toEqual([]);
	});

	it("fails closed for Pi package prefixes, CommonJS loaders, nested shared modules, and unresolved edges", () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-import-graph-"));
		const srcDir = join(tmpAgentDir, "src");
		const sharedDir = join(tmpAgentDir, "shared");
		const nestedSharedDir = join(sharedDir, "nested");
		mkdirSync(srcDir);
		mkdirSync(nestedSharedDir, { recursive: true });
		const entryPath = join(srcDir, "entry.ts");
		writeFileSync(entryPath, [
			'import Module from "node:module";',
			'import LegacyModule from "module";',
			'import ImportEqualsHelper = require("../shared/import-equals-helper.mjs");',
			'const runtimeRequire = Module.createRequire(import.meta.url);',
			'runtimeRequire.resolve("@earendil-works/pi-default-create-require");',
			'const indirectPeer = "@earendil-works/pi-indirect-require";',
			'runtimeRequire(indirectPeer);',
			'void import("@earendil-works/pi-ai/compat");',
			'void import("@earendil-works/pi-tui/components");',
			'void import("@earendil-works/pi-future/runtime");',
			'void import("typebox");',
			'void import("@sinclair/typebox/value");',
			"void import(`../shared/peer.mjs`);",
			'void import("../shared/broken.mjs");',
			'void import("../shared/empty-import.mjs");',
			'void import("../shared/empty-export.mjs");',
			'void import("./empty-import.js");',
			'void import("./empty-export.js");',
			'const computed = "./safe.js";',
			"void import(computed);",
			'void import("./missing.js");',
		].join("\n"));
		writeFileSync(join(sharedDir, "peer.mjs"), 'export { Text } from "./nested/host.mjs";\n');
		writeFileSync(join(nestedSharedDir, "host.mjs"), 'import { Text } from "@earendil-works/pi-tui/components";\nexport { Text };\n');
		writeFileSync(join(sharedDir, "broken.mjs"), 'export { missing } from "./missing.mjs";\n');
		writeFileSync(join(sharedDir, "empty-import.mjs"), 'import {} from "@earendil-works/pi-empty-import";\n');
		writeFileSync(join(sharedDir, "empty-export.mjs"), 'export {} from "@earendil-works/pi-empty-export";\n');
		writeFileSync(join(sharedDir, "import-equals-helper.mjs"), 'import {} from "@earendil-works/pi-import-equals-helper";\n');
		writeFileSync(join(srcDir, "empty-import.ts"), 'import {} from "@earendil-works/pi-empty-ts-import";\n');
		writeFileSync(join(srcDir, "empty-export.ts"), 'export {} from "@earendil-works/pi-empty-ts-export";\n');

		const findings = collectUnsafeHostPeerLoads(runtimeModuleFiles(srcDir, sharedDir)).join("\n");
		expect(findings).toContain("native module loader node:module outside src/cursor-ripgrep-path.ts");
		expect(findings).toContain("native module loader module outside src/cursor-ripgrep-path.ts");
		expect(findings).toContain("runtime import-equals ../shared/import-equals-helper.mjs");
		expect(findings).toContain("native host-peer specifier @earendil-works/pi-default-create-require");
		expect(findings).toContain("native host-peer specifier @earendil-works/pi-indirect-require");
		expect(findings).toContain("native host-peer specifier @earendil-works/pi-ai/compat");
		expect(findings).toContain("native host-peer specifier @earendil-works/pi-tui/components");
		expect(findings).toContain("native host-peer specifier @earendil-works/pi-future/runtime");
		expect(findings).toContain("native host-peer specifier typebox");
		expect(findings).toContain("native host-peer specifier @sinclair/typebox/value");
		expect(findings).toContain("../shared/peer.mjs reaches");
		expect(findings).toContain("@earendil-works/pi-tui/components");
		expect(findings).toContain("../shared/broken.mjs reaches");
		expect(findings).toContain("unresolved static import ./missing.mjs");
		expect(findings).toContain("../shared/empty-import.mjs reaches");
		expect(findings).toContain("@earendil-works/pi-empty-import");
		expect(findings).toContain("../shared/empty-export.mjs reaches");
		expect(findings).toContain("@earendil-works/pi-empty-export");
		expect(findings).not.toContain("@earendil-works/pi-empty-ts-import");
		expect(findings).not.toContain("@earendil-works/pi-empty-ts-export");
		expect(findings).toContain("non-literal dynamic import");
		expect(findings).toContain("unresolved relative dynamic import ./missing.js");
	});

	it("serves a warm model catalog without evaluating @cursor/sdk", async () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-lazy-import-"));
		process.env = { ...originalEnv, PI_CODING_AGENT_DIR: tmpAgentDir, CURSOR_API_KEY: "warm-cache-key" };
		const model: ModelListItem = {
			id: "composer-2",
			displayName: "Composer 2",
			variants: [{ params: [], displayName: "Composer 2", isDefault: true }],
		};
		expect(saveModelListCache(fingerprintApiKey("warm-cache-key"), [model])).toBe(true);
		vi.doMock("@cursor/sdk", () => {
			throw new Error("@cursor/sdk should not be evaluated on a warm cached discovery path");
		});

		const { discoverModels } = await import("../src/model-discovery.js");
		const models = await discoverModels();

		expect(models.map((entry) => entry.id)).toEqual(["composer-2"]);
	});

	it("loads the installed SDK checkpoint store without the old root sqlite dependency", async () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-checkpoint-contract-"));
		const { loadCursorSdk } = await import("../src/cursor-sdk-runtime.js");
		const { createAgentPlatform } = await loadCursorSdk();

		const platform = await createAgentPlatform({ workspaceRef: tmpAgentDir, scopedWorkspaceRef: tmpAgentDir });
		const checkpoint = await platform.checkpointStore.loadLatest("pi-cursor-sdk-checkpoint-contract-test");

		expect(checkpoint).toBeNull();
	});
});
