import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { __testUtils, installCursorSdkOutputFilter, installCursorSdkProcessOutputFilter } from "../src/cursor-sdk-output-filter.js";
import { prepareInstalledBootstrapEmitters } from "./helpers/cursor-sdk-bootstrap.js";
import { installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";
import { readInstalledPackageVersion, resolveInstalledPackageRoot } from "./helpers/installed-package.js";
import { collectOutput } from "./helpers/process-output.js";

function descendants(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
	const found: ts.Node[] = [];
	function visit(child: ts.Node) {
		if (predicate(child)) found.push(child);
		ts.forEachChild(child, visit);
	}
	visit(node);
	return found;
}

describe("installed SDK background rules/skills lifecycle contract", () => {
	it("starts detached completion work, registers watchers and does not join loads on disposal", async () => {
		expect(readInstalledPackageVersion("@cursor/sdk")).toBe("1.0.37");
		const modules = await installedCursorModules();
		const source = modules.factorySource("./src/agent/local-executor.ts");
		const ast = ts.createSourceFile("local-executor.js", `(${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
		const classes = descendants(ast, ts.isClassDeclaration) as ts.ClassDeclaration[];
		const service = (message: string) => {
			const found = classes.filter(node => node.members.some(member => ts.isConstructorDeclaration(member) && member.getText(ast).includes(message)));
			expect(found).toHaveLength(1);
			return found[0]!;
		};
		const local = service("LocalCursorRulesService load completed");
		const skills = service("AgentSkillsCursorRulesService load completed");
		const plugins = service("CursorPluginsAgentSkillsService load completed");
		const constructor = (node: ts.ClassDeclaration) => node.members.find(ts.isConstructorDeclaration)!;
		const method = (node: ts.ClassDeclaration, name: string) => node.members.find(member => member.name?.getText(ast) === name)!;
		// All three completion callbacks are scheduled by synchronous constructors;
		// their disposers do not join the pending loads. Watchers are service-owned.
		for (const node of [local, skills, plugins]) {
			expect(descendants(constructor(node), ts.isAwaitExpression)).toHaveLength(0);
			expect(method(node, "dispose").getText(ast)).not.toMatch(/await|_rules|_loaded|_agentSkills/);
		}
		expect(constructor(local).getText(ast)).toMatch(/this\._rules=this\.load\([\w$,]+\)\.then\(/);
		expect(constructor(skills).getText(ast)).toMatch(/this\.loadAll\([\w$,]+\)\.then\(/);
		expect(constructor(plugins).getText(ast)).toContain("this.startLoad(");
		expect(method(plugins, "startLoad").getText(ast)).toMatch(/this\.loadAll\([\w$,]+\)\.catch\(/);
		expect(constructor(local).getText(ast)).toContain(".subscribe(");
		expect(method(skills, "setupWatchers").getText(ast)).toContain(".subscribe(");
		expect(method(local, "dispose").getText(ast)).toContain("this.unsubscribeWatcher()");
		expect(method(skills, "dispose").getText(ast)).toContain("this.watchersByFolder.clear()");
		const types = readFileSync(join(resolveInstalledPackageRoot("@cursor/sdk"), "dist/esm/agent.d.ts"), "utf8");
		expect(types).toContain("reload(): Promise<void>;");

		// Execute the installed local constructor/disposer unchanged. Only I/O and
		// prerequisite nested-service construction are injected; logging uses the
		// installed SDK printer. This proves late success survives watcher disposal.
		const ctor = constructor(local);
		const logger = (descendants(ctor, n => ts.isPropertyAccessExpression(n) && n.name.text === "info")[0] as ts.PropertyAccessExpression).expression.getText(ast);
		const home = (descendants(ctor, n => ts.isPropertyAccessExpression(n) && n.name.text === "homedir")[0] as ts.PropertyAccessExpression).expression.getText(ast);
		const nestedAssignment = descendants(ctor, n => ts.isBinaryExpression(n) && n.left.getText(ast) === "this.nestedExtensibilityService")[0] as ts.BinaryExpression;
		const nested = (nestedAssignment.right as ts.NewExpression).expression.getText(ast);
		const bindSdk = await prepareInstalledBootstrapEmitters();
		const output = collectOutput();
		let releaseTurn: (() => void) | undefined;
		try {
			const sdk = await bindSdk(false);
			const completed: string[] = [];
			const LocalRules = runInNewContext(`(class { ${ctor.getText(ast)} ${method(local, "dispose").getText(ast)} })`, {
				performance, [logger]: { info: (_ctx: unknown, message: string) => { completed.push(message); sdk.completion(message); } },
				[home]: { homedir: () => "/unused" }, [nested]: class {},
			}) as new (...args: unknown[]) => { _rules: Promise<unknown>; dispose(): void };
			let resolveLoad!: (rules: unknown[]) => void;
			const loaded = new Promise<unknown[]>(resolve => { resolveLoad = resolve; });
			Object.assign(LocalRules.prototype, { load: () => loaded });
			let subscribed = 0, unsubscribed = 0;
			const watcher = { subscribe: () => { subscribed++; return () => { unsubscribed++; }; } };
			installCursorSdkProcessOutputFilter();
			releaseTurn = installCursorSdkOutputFilter();
			const rules = new LocalRules({}, {}, "/unused", false, () => true, watcher, {});
			expect(subscribed).toBe(1);
			releaseTurn();
			rules.dispose();
			expect(unsubscribed).toBe(1);
			expect(output.stdout).toEqual([]);
			expect(completed).toEqual([]);
			resolveLoad([]);
			await rules._rules; // actual installed callback emits after turn/disposal
			expect(completed).toEqual(["LocalCursorRulesService load completed"]);
			expect(output.stdout).toEqual([]);
		} finally { releaseTurn?.(); __testUtils.resetProcessOutputFilter(); output.restore(); }
	}, 30_000);
});
