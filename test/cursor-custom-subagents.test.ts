import type { AgentOptions, ModelSelection } from "@cursor/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { buildCursorCustomSubagentDefinitions } from "../src/cursor-custom-subagent-definitions.js";
import { __testUtils as discovery } from "../src/model-discovery.js";
import { installedCursorModules } from "./helpers/cursor-sdk-installed-modules.js";

describe("custom subagent model selections", () => {
	beforeEach(() => {
		discovery.registerModelItems([{
			id: "fixture", displayName: "Fixture", aliases: ["alias"],
			parameters: [
				{ id: "context", displayName: "Context", values: [{ value: "small" }, { value: "large" }] },
				{ id: "reasoning", displayName: "Reasoning", values: [{ value: "none" }, { value: "medium" }, { value: "high" }] },
				{ id: "fast", displayName: "Fast", values: [{ value: "true" }, { value: "false" }] },
			],
			variants: [{ params: [
				{ id: "context", value: "small" }, { id: "reasoning", value: "medium" }, { id: "fast", value: "true" },
			], displayName: "Fixture", isDefault: true }],
		}]);
	});

	it.each([
		["alias@large:slow", true, "high", "alias", "large", "high", "false"],
		["fixture@small:fast", false, "medium", "fixture", "small", "medium", "true"],
		["fixture@large", false, "off", "fixture", "large", "none", "false"],
		["fixture@small", undefined, "off", "fixture", "small", "none", "true"],
	] as const)("selects %s independently of parent controls", (model, fast, thinking, id, context, reasoning, speed) => {
		expect(buildCursorCustomSubagentDefinitions({ reviewer: { description: "D", prompt: "P", model, fast, thinking } })).toEqual({
			reviewer: { description: "D", prompt: "P", model: { id, params: [
				{ id: "context", value: context }, { id: "reasoning", value: reasoning }, { id: "fast", value: speed },
			] } },
		});
	});

	it("omits absent models, preserves inherit and forwards unknown IDs without fabricated params", () => {
		expect(buildCursorCustomSubagentDefinitions(undefined)).toBeUndefined();
		expect(buildCursorCustomSubagentDefinitions({})).toBeUndefined();
		expect(buildCursorCustomSubagentDefinitions({
			omitted: { description: "D", prompt: "P", thinking: "high", fast: true },
			inherited: { description: "D", prompt: "P", model: "inherit", thinking: "high", fast: false },
			unknown: { description: "D", prompt: "P", model: "unknown@large:fast", thinking: "high", fast: true },
		})).toEqual({
			omitted: { description: "D", prompt: "P" },
			inherited: { description: "D", prompt: "P", model: "inherit" },
			unknown: { description: "D", prompt: "P", model: { id: "unknown@large:fast" } },
		});
	});
});

it("executes the installed SDK converter: LOCAL id/inherit only, cloud full selection, no inline MCP", async () => {
	const load = await installedCursorModules();
	const { DB: local, SB: cloud } = load("./src/agent/subagent-conversion.ts");
	expect(local).toBeTypeOf("function");
	expect(cloud).toBeTypeOf("function");
	const selection: ModelSelection = { id: "fixture", params: [
		{ id: "context", value: "large" }, { id: "reasoning", value: "high" }, { id: "fast", value: "false" },
	] };
	const agents: AgentOptions["agents"] = {
		reviewer: { description: "D", prompt: "P", model: selection },
		omitted: { description: "D", prompt: "P" },
		inherited: { description: "D", prompt: "P", model: "inherit" },
	};
	expect(local(agents)).toEqual([
		{ name: "reviewer", description: "D", prompt: "P", model: "fixture" },
		{ name: "omitted", description: "D", prompt: "P", model: "inherit" },
		{ name: "inherited", description: "D", prompt: "P", model: "inherit" },
	]);
	expect(cloud(agents)).toEqual([
		{ name: "reviewer", description: "D", prompt: "P", model: selection },
		{ name: "omitted", description: "D", prompt: "P", model: "inherit" },
		{ name: "inherited", description: "D", prompt: "P", model: "inherit" },
	]);
	for (const converter of [local, cloud]) {
		expect(converter(undefined)).toBeUndefined();
		expect(converter({})).toBeUndefined();
		expect(() => converter({ bad: { description: "D", prompt: "P", mcpServers: [{ inline: { command: "node" } }] } })).toThrow(/inline McpServerConfig/);
	}
}, 30_000);
