import { isCursorLeanEnabled } from "./cursor-lean.js";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import type { CursorPiToolBridgeSnapshot } from "./cursor-pi-tool-bridge-types.js";

export const CURSOR_TOOL_MANIFEST_ENV = "PI_CURSOR_TOOL_MANIFEST";

/**
 * Representative @cursor/sdk@1.0.27 local-agent ToolType values; actual exposure can vary by run.
 * See docs/cursor-native-tool-replay.md#sdk-tooltype-replay-matrix.
 */
export const CURSOR_HOST_TOOL_MANIFEST_SUMMARY =
	"read/shell/search/edit/write and other host tools when Cursor exposes them";

function buildCodeModeRoutingLines(snapshot: CursorPiToolBridgeSnapshot): string[] {
	const executeName = snapshot.piToolNameToMcpToolName.get("codemode_execute");
	if (!executeName) return [];
	// CodeMode's catalog, not Pi's inactive set, determines indirect availability.
	const lines = [
		`- CodeMode can expose Pi tools that have no direct pi__* name; call catalog tools inside ${executeName} as await tools[name](input), using their declared input schemas. A missing direct bash tool does not by itself mean shell access is unavailable.`,
	];
	const searchName = snapshot.piToolNameToMcpToolName.get("codemode_search");
	if (searchName) {
		lines.push(`- If shell access is needed and bash is not directly exposed, use ${searchName} with query "bash" to get its availability and schema, then execute it through ${executeName} if found. Use exact-name lookups for read/edit/write when needed; reuse schemas already provided instead of searching again.`);
	}
	lines.push("- Do not narrate routine tool discovery or speculate about missing tools. Start the task's relevant inspection; report a capability limitation only after checking the available routes.");
	return lines;
}

export function resolveCursorToolManifestEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return parseEnvBoolean(env[CURSOR_TOOL_MANIFEST_ENV], true);
}

export function buildCursorToolManifestText(options: {
	bridgeSnapshot?: CursorPiToolBridgeSnapshot;
	/** When false, bridge is off via PI_CURSOR_PI_TOOL_BRIDGE=0 (not merely empty). */
	piBridgeEnabled?: boolean;
	includePiBridgeGuidance?: boolean;
} = {}): string {
	const piBridgeEnabled = options.piBridgeEnabled ?? true;
	const includePiBridgeGuidance = options.includePiBridgeGuidance !== false;
	const lines = [
		"Callable tool surfaces this run:",
		...(isCursorLeanEnabled()
			? ["- Cursor native tools and ambient MCP: disabled. Only Pi's active tools are callable through the bridge."]
			: [
				`- Cursor host/MCP: ${CURSOR_HOST_TOOL_MANIFEST_SUMMARY}; configured MCP depends on Cursor settings.`,
				"- Pi tool toggles affect pi tools/bridge exposure only; they do not disable Cursor host/configured MCP tools.",
			]),
	];
	const bridgeTools = includePiBridgeGuidance ? options.bridgeSnapshot?.tools ?? [] : [];
	if (includePiBridgeGuidance) {
		if (!piBridgeEnabled) {
			lines.push("- Pi bridge: disabled (PI_CURSOR_PI_TOOL_BRIDGE=0).");
		} else if (bridgeTools.length === 0) {
			lines.push("- Pi bridge: no pi__* tools exposed this run.");
		} else {
			const names = [...bridgeTools.map((tool) => tool.mcpToolName)].sort().join(", ");
			lines.push(`- Pi bridge: call exposed pi__* MCP names (${names}); pi shows real pi names.`);
			if (options.bridgeSnapshot) lines.push(...buildCodeModeRoutingLines(options.bridgeSnapshot));
		}
	}
	lines.push("- Not callable: cursor-replay-* IDs, pi history names, transcript labels.");
	return lines.join("\n");
}
