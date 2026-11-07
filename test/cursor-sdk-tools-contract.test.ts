import { runInNewContext } from "node:vm";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";

// This is the installed SDK's allowlist/header boundary, not a simulated
// inference server or proof of OS isolation. No production SDK code is patched.
describe("installed SDK MCP-only main-loop contract", () => {
	it("expands only the MCP family, excludes task and all other main tools, and transmits the restriction", async () => {
		const modules = await installedCursorModules();
		const tools = modules("./src/agent/tools-option.ts");
		const resolveAllowed = tools.TX as (names?: string[]) => string[] | undefined;
		expect(resolveAllowed(undefined)).toBeUndefined();
		expect(resolveAllowed([])).toEqual([]);
		expect(resolveAllowed(["mcp"])).toEqual([
			"mcp_tool_call", "get_mcp_tools_tool_call", "list_mcp_resources_tool_call",
			"read_mcp_resource_tool_call", "mcp_auth_tool_call",
		]);
		expect(resolveAllowed(["task"])).toEqual(["task_tool_call"]);
		expect(resolveAllowed(["shell"])).toEqual(["shell_tool_call", "write_shell_stdin_tool_call"]);
		expect(() => resolveAllowed(["not-a-real-tool"])).toThrow(/Unknown tool name/);

		// Execute the actual installed header builder unchanged. Discover the
		// expression structurally rather than pinning minified variable names.
		const source = modules.factorySource("./src/agent/local-executor.ts");
		const ast = ts.createSourceFile("local-executor.js", `(${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
		const builders: ts.FunctionExpression[] = [];
		function referencesAllowedTools(node: ts.Node): boolean {
			return (ts.isPropertyAccessExpression(node) && node.name.text === "allowedTools") ||
				ts.forEachChild(node, child => referencesAllowedTools(child) || undefined) === true;
		}
		function visit(node: ts.Node): void {
			if (ts.isFunctionExpression(node) && node.parameters.length === 1 && node.body.statements.length === 1) {
				const statement = node.body.statements[0]!;
				if (ts.isReturnStatement(statement) && statement.expression && ts.isObjectLiteralExpression(statement.expression) &&
					statement.expression.properties.some(property => ts.isSpreadAssignment(property) &&
						referencesAllowedTools(property.expression))) builders.push(node);
			}
			ts.forEachChild(node, visit);
		}
		visit(ast);
		expect(builders).toHaveLength(1);
		const builder = builders[0]!;
		const dependencies = new Set<string>();
		function headerBindings(node: ts.Node): void {
			if (ts.isComputedPropertyName(node) && ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression)) dependencies.add(node.expression.expression.text);
			ts.forEachChild(node, headerBindings);
		}
		headerBindings(builder);
		expect(dependencies.size).toBe(1);
		const headers = runInNewContext(`(${builder.getText(ast)})`, Object.fromEntries([...dependencies].map(name => [name, tools]))) as
			(options: { allowedTools?: string[] }) => Record<string, string>;
		expect(headers({ allowedTools: resolveAllowed(["mcp"]) })).toEqual({
			"x-cursor-agent-allowed-tools": "mcp_tool_call,get_mcp_tools_tool_call,list_mcp_resources_tool_call,read_mcp_resource_tool_call,mcp_auth_tool_call",
		});
		expect(headers({ allowedTools: resolveAllowed([]) })).toEqual({ "x-cursor-agent-allowed-tools": "" });
		expect(headers({})).toEqual({});
	}, 30_000);
});
