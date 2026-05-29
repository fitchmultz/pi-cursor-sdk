import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintApiKey, saveModelListCache } from "../src/model-list-cache.js";
import type { ModelListItem } from "@cursor/sdk";

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

function moduleText(node: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined {
	return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
	return node.isTypeOnly || Boolean(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every((element) => element.isTypeOnly));
}

function collectRuntimeSdkEdges(): string[] {
	const offenders: string[] = [];
	for (const path of sourceFiles(join(process.cwd(), "src"))) {
		const relativePath = relative(process.cwd(), path);
		const source = ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const visit = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node)) {
				const specifier = moduleText(node);
				if (specifier === "@cursor/sdk" && !node.importClause?.isTypeOnly && !relativePath.endsWith("src/cursor-sdk-runtime.ts")) {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime import @cursor/sdk`);
				}
				if (specifier?.startsWith("@modelcontextprotocol/sdk/") && !node.importClause?.isTypeOnly && !relativePath.endsWith("src/cursor-pi-tool-bridge-run.ts")) {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime import ${specifier}`);
				}
				if (specifier === "./cursor-pi-tool-bridge-run.js" && !node.importClause?.isTypeOnly) {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime import bridge run implementation`);
				}
			}
			if (ts.isExportDeclaration(node)) {
				const specifier = moduleText(node);
				if (specifier === "@cursor/sdk" && !isTypeOnlyExport(node)) {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime export @cursor/sdk`);
				}
				if (specifier?.startsWith("@modelcontextprotocol/sdk/") && !isTypeOnlyExport(node)) {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime export ${specifier}`);
				}
			}
			if (
				ts.isCallExpression(node) &&
				node.expression.kind === ts.SyntaxKind.ImportKeyword &&
				node.arguments.length === 1 &&
				ts.isStringLiteral(node.arguments[0]) &&
				node.arguments[0].text === "@cursor/sdk" &&
				!relativePath.endsWith("src/cursor-sdk-runtime.ts")
			) {
				offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: dynamic import @cursor/sdk outside runtime loader`);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return offenders;
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
});
