import { EventEmitter } from "node:events";
import ts from "@typescript/typescript6";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUsage } from "@cursor/sdk";
import { loadCursorSdk } from "../src/cursor-sdk-runtime.js";
import { installedCursorModuleDeclarations, installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";

afterEach(() => vi.unstubAllGlobals());
describe("installed Cursor SDK getUsage contract", () => {
	it.each([
		{ label: "per-UUID rows", apiKey: "test-credential-not-real-per-uuid", runs: [{ id: "billing-uuid" }] },
		{ label: "aggregate-only empty rows", apiKey: "test-credential-not-real-aggregate", runs: [] },
	])("public getter preserves disjoint whole-agent token/cost snapshots with $label", async ({ apiKey, runs }) => {
		// Recorded LOCAL cache counts (SDK1.0.32, 2026-10-04); public endpoint contract:
		// https://cursor.com/docs/cloud-agent/api/endpoints#usage (four disjoint categories).
		const usage = { inputTokens: 136, outputTokens: 3, cacheReadTokens: 4096, cacheWriteTokens: 0, totalTokens: 4235 };
		const cost = { rawCostCents: 0.1, chargedCents: 0.2 };
		const transport = vi.fn(async (request: string | URL | Request, _init?: RequestInit) => {
			const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
			// Cold SDK privacy bootstrap tolerates a failed key exchange before fetching usage.
			if (path === "/auth/exchange_user_api_key") return new Response("", { status: 401 });
			if (path === "/v1/agents/agent-local-contract/usage") {
				return new Response(JSON.stringify({ totalUsage: usage, cost, runs: runs.map(row => ({ ...row, usage, cost })) }), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error(`Unexpected SDK request: ${path}`);
		});
		vi.stubGlobal("fetch", transport);
		const { Agent } = await loadCursorSdk();
		const result: AgentUsage = await Agent.getUsage("agent-local-contract", { apiKey });
		expect(result).toEqual({ usage, cost, runs: runs.map(row => ({ runId: row.id, usage, cost })) });
		expect(transport.mock.calls.map(([request, init]) => [
			new URL(request instanceof Request ? request.url : String(request)).pathname,
			init?.method ?? (request instanceof Request ? request.method : "GET"),
		])).toEqual([
			["/auth/exchange_user_api_key", "POST"],
			["/v1/agents/agent-local-contract/usage", "GET"],
		]);
	});
	it("rejects LOCAL client-minted run labels before auth/network instead of joining them to billing UUIDs", async () => {
		const { Agent } = await loadCursorSdk();
		await expect(Agent.getUsage("agent-local-contract", { runId: "run-client-label" })).rejects.toThrow("backend never receives it");
	});
	it("attaches a no-op error listener before local shell snapshot writes and end", async () => {
		const modules = await installedCursorModules();
		const { declarations, execute } = installedCursorModuleDeclarations(modules.factorySource("../shell-exec/dist/index.js"));
		const writers = [...declarations.values()].filter((node) => {
			if (!ts.isFunctionDeclaration(node) || node.parameters.length !== 2) return false;
			const stream = node.parameters[0]!.name.getText();
			const methods = new Set<string>();
			function visit(child: ts.Node) {
				if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) &&
					ts.isIdentifier(child.expression.expression) && child.expression.expression.text === stream) {
					methods.add(child.expression.name.text);
				}
				ts.forEachChild(child, visit);
			}
			visit(node);
			return methods.has("write") && methods.has("end");
		});
		expect(writers).toHaveLength(1);
		const write = execute<(stream: EventEmitter & { write(text: string): void; end(): void } | null | undefined, text: string) => void>(writers[0]!);
		const calls: string[] = [];
		const stream = Object.assign(new EventEmitter(), {
			write(this: EventEmitter, text: string) {
				calls.push(text);
				this.emit("error", new Error("offline write error"));
			},
			end(this: EventEmitter) {
				calls.push("end");
				this.emit("error", new Error("offline end error"));
			},
		});
		const on = vi.spyOn(stream, "on");
		expect(() => write(stream, "shell snapshot")).not.toThrow();
		expect(calls).toEqual(["shell snapshot", "end"]);
		expect(on).toHaveBeenCalledExactlyOnceWith("error", expect.any(Function));
		const listener = stream.listeners("error")[0]!;
		expect(listener(new Error("offline listener error"))).toBeUndefined();
		const listenerAst = ts.createSourceFile("listener.js", `(${listener.toString()})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
		const statement = listenerAst.statements[0];
		if (!statement || !ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression)) {
			throw new Error("Installed shell error listener changed");
		}
		const callback = statement.expression.expression;
		if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) throw new Error("Installed shell error listener changed");
		expect(ts.isBlock(callback.body) && callback.body.statements.length === 0).toBe(true);
		expect(() => write(undefined, "unused")).not.toThrow();
		expect(() => write(null, "unused")).not.toThrow();
	});
});
