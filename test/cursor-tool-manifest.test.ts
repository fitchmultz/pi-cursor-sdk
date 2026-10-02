import { describe, expect, it } from "vitest";
import { buildCursorPrompt } from "../src/context.js";
import {
	buildCursorToolManifestText,
	CURSOR_TOOL_MANIFEST_ENV,
	resolveCursorToolManifestEnabled,
} from "../src/cursor-tool-manifest.js";

function bridgeTool(piToolName: string) {
	return {
		piToolName,
		mcpToolName: `pi__${piToolName}`,
		description: piToolName,
		inputSchema: { type: "object" as const },
		sourceInfo: { source: "extension", path: "test", scope: "temporary" as const, origin: "top-level" as const },
	};
}

function snapshotWith(piToolNames: string[]) {
	const tools = piToolNames.map(bridgeTool);
	return {
		tools,
		mcpToolNameToPiToolName: new Map(tools.map((tool) => [tool.mcpToolName, tool.piToolName])),
		piToolNameToMcpToolName: new Map(tools.map((tool) => [tool.piToolName, tool.mcpToolName])),
	};
}

describe("cursor-tool-manifest", () => {
	it("builds manifest with bridge tools and host summary", () => {
		const text = buildCursorToolManifestText({
			piBridgeEnabled: true,
			bridgeSnapshot: {
				tools: [
					{
						piToolName: "cursor_ask_question",
						mcpToolName: "pi__cursor_ask_question",
						description: "ask",
						inputSchema: { type: "object" },
						sourceInfo: { source: "extension", path: "test", scope: "temporary", origin: "top-level" },
					},
				],
				mcpToolNameToPiToolName: new Map([["pi__cursor_ask_question", "cursor_ask_question"]]),
				piToolNameToMcpToolName: new Map([["cursor_ask_question", "pi__cursor_ask_question"]]),
			},
		});

		expect(text).toContain("Callable tool surfaces this run:");
		expect(text).toContain("Cursor host/MCP");
		expect(text).toContain("Pi tool toggles affect pi tools/bridge exposure only");
		expect(text).toContain("pi__cursor_ask_question");
		expect(text).toContain("cursor-replay-*");
	});

	it("omits bridge lines when pi bridge guidance is disabled", () => {
		const text = buildCursorToolManifestText({
			includePiBridgeGuidance: false,
			piBridgeEnabled: true,
			bridgeSnapshot: {
				tools: [
					{
						piToolName: "cursor_ask_question",
						mcpToolName: "pi__cursor_ask_question",
						description: "ask",
						inputSchema: { type: "object" },
						sourceInfo: { source: "extension", path: "test", scope: "temporary", origin: "top-level" },
					},
				],
				mcpToolNameToPiToolName: new Map(),
				piToolNameToMcpToolName: new Map(),
			},
		});

		expect(text).toContain("Callable tool surfaces this run:");
		expect(text).toContain("Cursor host/MCP");
		expect(text).toContain("configured MCP depends on Cursor settings");
		expect(text).not.toContain("Pi bridge");
		expect(text).not.toContain("pi__cursor_ask_question");
	});

	it("notes disabled bridge", () => {
		const text = buildCursorToolManifestText({ piBridgeEnabled: false });
		expect(text).toContain("Pi bridge: disabled");
		expect(text).not.toContain("SwitchMode");
	});

	it("distinguishes disabled bridge from empty exposure", () => {
		const disabled = buildCursorToolManifestText({ piBridgeEnabled: false });
		const empty = buildCursorToolManifestText({ piBridgeEnabled: true, bridgeSnapshot: { tools: [], mcpToolNameToPiToolName: new Map(), piToolNameToMcpToolName: new Map() } });
		expect(disabled).toContain("disabled");
		expect(empty).toContain("no pi__* tools exposed");
	});

	it("explains CodeMode discovery without assuming hidden tools are available", () => {
		const text = buildCursorToolManifestText({
			piBridgeEnabled: true,
			bridgeSnapshot: snapshotWith(["read", "codemode_execute", "codemode_search"]),
		});
		expect(text).toContain("CodeMode can expose Pi tools that have no direct pi__* name");
		expect(text).toContain('pi__codemode_search with query "bash"');
		expect(text).toContain("inside pi__codemode_execute as await tools[name](input)");
		expect(text).toContain("Do not narrate routine tool discovery");
		expect(text).not.toContain("No search needed");
		expect(text).not.toContain("tools.edit({");
		const prompt = buildCursorPrompt(
			{ messages: [{ role: "user", content: "Inspect deployment", timestamp: 1 }] },
			{ toolManifest: text },
		);
		expect(prompt.text).toContain(text);
	});

	it("omits CodeMode routing when codemode_execute is not exposed", () => {
		const text = buildCursorToolManifestText({
			piBridgeEnabled: true,
			bridgeSnapshot: snapshotWith(["read", "codemode_search"]),
		});
		expect(text).not.toContain("CodeMode");
	});

	it("does not invent a search route when codemode_search is not exposed", () => {
		const text = buildCursorToolManifestText({
			piBridgeEnabled: true,
			bridgeSnapshot: snapshotWith(["codemode_execute"]),
		});
		expect(text).toContain("inside pi__codemode_execute as await tools[name](input)");
		expect(text).not.toContain('with query "bash"');
		expect(text).not.toContain("pi__codemode_search");
	});

	it("defaults manifest env to enabled", () => {
		expect(resolveCursorToolManifestEnabled({})).toBe(true);
		expect(resolveCursorToolManifestEnabled({ [CURSOR_TOOL_MANIFEST_ENV]: "0" })).toBe(false);
	});

	it("includes manifest in bootstrap prompts when provided", () => {
		const manifest = buildCursorToolManifestText();
		const prompt = buildCursorPrompt(
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ toolManifest: manifest },
		);
		expect(prompt.text).toContain("Callable tool surfaces this run:");
		expect(prompt.text).toContain("Cursor SDK tool boundary:");
		expect(prompt.text).toContain("See callable surfaces below.");
	});
});
