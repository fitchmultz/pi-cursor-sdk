import { describe, expect, it } from "vitest";
import {
	buildCursorToolManifestText,
	CURSOR_TOOL_MANIFEST_ENV,
	resolveCursorToolManifestEnabled,
} from "../src/cursor-tool-manifest.js";

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

	it("distinguishes disabled bridge from empty exposure", () => {
		const disabled = buildCursorToolManifestText({ piBridgeEnabled: false });
		const empty = buildCursorToolManifestText({ piBridgeEnabled: true, bridgeSnapshot: { tools: [], mcpToolNameToPiToolName: new Map(), piToolNameToMcpToolName: new Map() } });
		expect(disabled).toContain("Pi bridge: disabled");
		expect(disabled).not.toContain("SwitchMode");
		expect(empty).toContain("no pi__* tools exposed");
	});

	it("defaults manifest env to enabled", () => {
		expect(resolveCursorToolManifestEnabled({})).toBe(true);
		expect(resolveCursorToolManifestEnabled({ [CURSOR_TOOL_MANIFEST_ENV]: "0" })).toBe(false);
	});
});
