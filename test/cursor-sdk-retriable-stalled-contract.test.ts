import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInThisContext } from "node:vm";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { isCursorSdkConnectionStalledError, sanitizeCursorProviderError } from "../src/cursor-provider-errors.js";
import { installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";
import { readInstalledPackageVersion, resolveInstalledPackageRoot } from "./helpers/installed-package.js";

const fixture = JSON.parse(readFileSync(
	new URL("./fixtures/cursor-sdk-retriable-stalled-1.0.36.json", import.meta.url), "utf8",
)) as {
	provenance: { sdkPackage: string; sdkVersion: string };
	branches: Array<{
		transportErrorRetries: number | null;
		error: { name: string; kind: string; message: string; code: string; displayInfo: object };
	}>;
};

async function installedStallFactory() {
	const modules = await installedCursorModules();
	const source = modules.factorySource("./src/agent/local-executor.ts");
	// Retain the distinct synchronous stall-callback provenance guard, without
	// freezing minified names. This is a source contract, not a service recovery test.
	expect(source).toContain("reportStall(");
	expect(source).toContain("this.onStall?.()");
	expect(source).toMatch(/onStall:\(\)=>\{[\w$]+\("stall_detector",\{thresholdMs:[\w$]+,advisoryThresholdMs:[\w$]+\}\),[\w$]+\(\)\}/);
	const ast = ts.createSourceFile("local-executor.js", `({${source}})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const statement = ast.statements[0];
	if (!statement || !ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression) ||
		!ts.isObjectLiteralExpression(statement.expression.expression)) throw new Error("Installed module factory changed");
	const moduleFactory = statement.expression.expression.properties[0];
	if (!moduleFactory || !ts.isMethodDeclaration(moduleFactory) || !moduleFactory.body) {
		throw new Error("Installed module factory body changed");
	}
	const declarations = new Map<string, ts.FunctionDeclaration | ts.ClassDeclaration>();
	for (const node of moduleFactory.body.statements) {
		if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) declarations.set(node.name.text, node);
	}
	const factories = [...declarations.values()].filter((node) => ts.isFunctionDeclaration(node) &&
		node.getText(ast).includes('"Connection stalled repeatedly"'));
	if (factories.length !== 1) throw new Error("Installed stall factory changed");
	const factory = factories[0]!;
	// Follow calls, construction and class heritage among factory-body declarations,
	// not local bindings or property names. No executor/Agent or replacement code runs.
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
	include(factory);
	// VM coordinates describe extracted factory execution, not original bundle lines.
	return runInThisContext(`(() => { ${snippets.join("\n")}; return ${factory.name!.text}; })()`, {
		filename: join(resolveInstalledPackageRoot("@cursor/sdk"), "dist/esm/index.js"),
	}) as (options: { cause: Error; requestId: string; connectCode: number; transportErrorRetries?: number }) =>
		Error & { kind: string; code: string; displayInfo: object; requestId: string };
}

describe("installed Cursor SDK RetriableError connection-stalled contract", () => {
	it("executes installed stall/retry branches and preserves cause, request, display and classifier provenance", async () => {
		expect(fixture.provenance.sdkPackage).toBe("@cursor/sdk");
		expect(fixture.provenance.sdkVersion).toBe(readInstalledPackageVersion("@cursor/sdk"));
		const makeError = await installedStallFactory();
		const cause = new Error("offline stall cause");
		for (const branch of fixture.branches) {
			const error = makeError({ cause, requestId: "offline-request", connectCode: 1,
				transportErrorRetries: branch.transportErrorRetries ?? undefined });
			expect({ name: error.name, kind: error.kind, message: error.message, code: error.code, displayInfo: error.displayInfo }).toEqual(branch.error);
			expect(error.cause).toBe(cause);
			expect(error.requestId).toBe("offline-request");
			expect(error.stack).toMatch(/@cursor[\\/]sdk[\\/]dist[\\/]esm[\\/]/);
			expect(isCursorSdkConnectionStalledError(error)).toBe(true);
			const sanitized = sanitizeCursorProviderError(error, "test-key");
			expect(sanitized.toLowerCase()).toContain("network error");
			expect(sanitized).not.toMatch(/stalled(?: repeatedly)?/i);
		}
	});
});
