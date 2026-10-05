import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "@typescript/typescript6";
import { installedCursorModules } from "./cursor-sdk-installed-modules.js";

/** Execute the installed printer and the actual confinement branch, not Agent/send. */
export async function prepareInstalledBootstrapEmitters() {
	const modules = await installedCursorModules();
	const source = modules.factorySource("./src/agent/local-executor.ts");
	const ast = ts.createSourceFile("local-executor.js", `(${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	function find<T extends ts.Node>(guard: (node: ts.Node) => node is T, marker: string): T {
		const found: T[] = [];
		function visit(node: ts.Node) {
			if (guard(node) && node.getText(ast).includes(marker)) found.push(node);
			ts.forEachChild(node, visit);
		}
		visit(ast);
		found.sort((a, b) => a.getWidth(ast) - b.getWidth(ast));
		if (!found.length) throw new Error(`Installed bootstrap contract changed: ${marker}`);
		return found[0]!;
	}
	function descendants(node: ts.Node, guard: (node: ts.Node) => boolean): ts.Node[] {
		const found: ts.Node[] = [];
		function visit(n: ts.Node) { if (guard(n)) found.push(n); ts.forEachChild(n, visit); }
		visit(node);
		return found;
	}
	function callName(node: ts.Node, property: string): string {
		const call = descendants(node, n => ts.isPropertyAccessExpression(n) && n.name.text === property)[0] as ts.PropertyAccessExpression;
		if (!call || !ts.isIdentifier(call.expression)) throw new Error(`Installed call contract changed: ${property}`);
		return call.expression.text;
	}
	const inventory = find(ts.isFunctionExpression, '"managed_skills.startup_inventory"');
	const load = find(ts.isFunctionExpression, '"loadUserLocalPlugins: no home directory available, skipping"');
	const pluginLogger = find(ts.isObjectLiteralExpression, '"[local-plugins-bootstrap]"');
	const facadeName = callName(pluginLogger, "warn");
	const facade = find(ts.isVariableDeclaration, `warn(...`);
	// The facade delegates through the installed AsyncLocalStorage/default bound console.
	const facadeCall = descendants(facade, n => ts.isCallExpression(n) && ts.isIdentifier(n.expression))[0] as ts.CallExpression;
	const getSink = find(ts.isFunctionDeclaration, `${(facadeCall.expression as ts.Identifier).text}()`);
	const getSinkNames = descendants(getSink.body!, ts.isIdentifier).map(n => (n as ts.Identifier).text);
	const defaultSink = getSinkNames.find(name => {
		try { return find(ts.isVariableDeclaration, `${name}=`).getText(ast).includes("console.warn.bind(console)"); } catch { return false; }
	});
	if (!defaultSink) throw new Error("Installed bound console contract changed");
	const bound = find(ts.isVariableDeclaration, `${defaultSink}={warn:console.warn.bind(console)`);
	const storageName = callName(getSink, "getStore");
	const storage = find(ts.isVariableDeclaration, `${storageName}=new `);
	const asyncNamespace = (storage.initializer as ts.NewExpression).expression as ts.PropertyAccessExpression;
	const guardCall = descendants(load, n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) &&
		n.arguments.length === 2 && n.parent && ts.isExpressionStatement(n.parent))[0] as ts.CallExpression;
	const guard = find(ts.isFunctionDeclaration, `function ${(guardCall.expression as ts.Identifier).text}(`);
	const readerDecl = descendants(load, n => ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) &&
		n.initializer !== undefined && ts.isAwaitExpression(n.initializer))[0] as ts.VariableDeclaration;
	const reader = (readerDecl.initializer as ts.AwaitExpression).expression as ts.CallExpression;
	const paths = descendants(load, n => ts.isPropertyAccessExpression(n) && n.name.text === "join")[0] as ts.PropertyAccessExpression;
	const pathNamespace = descendants(paths.expression, ts.isIdentifier)[0] as ts.Identifier;
	const readDir = descendants(load, n => ts.isPropertyAccessExpression(n) && n.name.text === "readdir")[0] as ts.PropertyAccessExpression;
	const fsNamespace = descendants(readDir.expression, ts.isIdentifier)[0] as ts.Identifier;
	const pluginSource = `let ${bound.getText(ast)}; const ${storage.getText(ast)}; ${getSink.getText(ast)}
		const ${facadeName}=${facade.initializer!.getText(ast)}; ${guard.getText(ast)}
		({ load: (${load.getText(ast)}), logger: (${pluginLogger.getText(ast)}) })`;
	const inventoryLogger = callName(inventory, "info");
	const inventorySource = `(${inventory.getText(ast)})`;
	const completions = [
		"LocalCursorRulesService load completed",
		"AgentSkillsCursorRulesService load completed",
		"CursorPluginsAgentSkillsService load completed",
	].map(message => {
		const literal = find(ts.isStringLiteral, message);
		const call = literal.parent;
		if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) ||
			call.expression.name.text !== "info" || call.arguments[1] !== literal) {
			throw new Error(`Installed completion logger contract changed: ${message}`);
		}
		return literal.text;
	});
	// Execute the actual conversion and warning formatter without constructing
	// hook services. Dependencies are the installed literal tables/functions.
	const hooks = find(ts.isFunctionDeclaration, "trigger matcher");
	const toolMap = find(ts.isVariableDeclaration, "Glob:null");
	const unsupported = find(ts.isVariableDeclaration, '=["Glob"]');
	const hookDefinition = find(ts.isFunctionDeclaration, "loop_limit:null");
	const defaultLogger = find(ts.isVariableDeclaration, `${hooks.parameters[2]!.initializer!.getText(ast)}=`);
	const hookFormat = find(ts.isTemplateExpression, "[hooks] ${");
	const formatParameter = hookFormat.templateSpans[0]!.expression.getText(ast);
	const hookFormatSource = `(${formatParameter}) => ${hookFormat.getText(ast)}`;
	const hookSource = `const ${toolMap.getText(ast)}, ${unsupported.getText(ast)}, ${defaultLogger.getText(ast)};
		${hookDefinition.getText(ast)}; (${hooks.getText(ast)})`;
	const parserWarning = find(ts.isStringLiteral, "shell-parser: tree-sitter natives are unavailable").text;
	const asyncNamespaceName = asyncNamespace.expression.getText(ast);
	const pathNamespaceName = pathNamespace.text, fsNamespaceName = fsNamespace.text;
	const readerName = (reader.expression as ts.Identifier).text;

	// Discovery is complete before any process-output capture. Binding always
	// evaluates fresh exports/VM contexts, including the retained-console case.
	return async (useColors: boolean) => {
		const freshModules = await installedCursorModules();
		const previous = { force: process.env.FORCE_COLOR, no: process.env.NO_COLOR };
		delete process.env.NO_COLOR;
		process.env.FORCE_COLOR = useColors ? "1" : "0";
		let core: any, logger: any;
		try {
			core = freshModules("../context/dist/core.js");
			logger = freshModules("../context/dist/logger.js");
		} finally {
			if (previous.force === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = previous.force;
			if (previous.no === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous.no;
		}
		const contextFactory = Object.values(core).filter((value): value is () => any => typeof value === "function" && value.length === 0);
		const loggerFactory = Object.values(logger).filter((value): value is (name: string) => any => typeof value === "function");
		if (contextFactory.length !== 1 || loggerFactory.length !== 1) throw new Error("Installed context/logger exports changed");
		let readerCalls = 0;
		const plugin = runInNewContext(pluginSource, {
			console, process, performance, [asyncNamespaceName]: { AsyncLocalStorage },
			[pathNamespaceName]: path, [fsNamespaceName]: fs,
			[readerName]: () => { readerCalls++; throw new Error("Outside guard reached plugin reader"); },
		});
		const emitInventory = runInNewContext(inventorySource, {
			[pathNamespaceName]: path, [inventoryLogger]: loggerFactory[0]!("builtin-skills-sync"),
		});
		const formatHook = runInNewContext(hookFormatSource) as (message: string) => string;
		const convertHook = runInNewContext(hookSource);
		const hookNotices: string[] = [];
		for (const [event, matchers] of [
			["SessionStart", ["startup", "resume", "clear", "compact"]],
			["PreCompact", ["manual", "auto"]],
			["PreToolUse", ["Glob"]],
		] as const) {
			for (const matcher of matchers) {
				const warnings: string[] = [];
				convertHook({ matcher, hooks: [{ type: "command", command: "true" }] }, event, { warn: (message: string) => warnings.push(formatHook(message)) });
				// Glob also emits a meaningful all-tools-skipped warning: do not filter it.
				if (!warnings[0]) throw new Error(`Installed hook warning changed: ${event}/${matcher}`);
				hookNotices.push(warnings[0]);
			}
		}
		return {
			inventory: () => emitInventory(contextFactory[0]!().withName("syncBuiltinSkills"), "/unused", [], { skills: {} }),
			plugins: (home: string) => plugin.load({ userHomeDir: home, log: plugin.logger }),
			readerCalls: () => readerCalls,
			parserWarning,
			completions: [...completions],
			hookNotices,
			completion: (message: string) => loggerFactory[0]!("cursor-rules").info(contextFactory[0]!().withName("loadRules"), message),
		};
	};
}
