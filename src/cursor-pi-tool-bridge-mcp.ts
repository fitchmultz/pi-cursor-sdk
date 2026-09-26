import { createHash } from "node:crypto";
import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { buildCursorPiBridgeMcpToolDescription, CURSOR_PI_BRIDGE_MCP_TOOL_PREFIX } from "./cursor-bridge-contract.js";
import type { CursorPiBridgeToolDefinition, CursorPiMcpInputSchema } from "./cursor-pi-tool-bridge-types.js";
import { asRecord, stringifyUnknown } from "./cursor-record-utils.js";

export function normalizeMcpInputSchema(schema: unknown): CursorPiMcpInputSchema {
	const record = asRecord(schema);
	if (record?.type === "object") return record as CursorPiMcpInputSchema;
	return { type: "object", properties: {} };
}

export function normalizeMcpArgs(args: unknown): Record<string, unknown> {
	const record = asRecord(args);
	return record ? { ...record } : {};
}

export function waitForProtocolFlush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function sanitizeMcpToolNameStem(toolName: string): string {
	const stem = toolName
		.trim()
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return stem || "tool";
}

export function stableNameHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function createMcpToolName(piToolName: string, usedMcpToolNames: Set<string>): string {
	const baseName = `${CURSOR_PI_BRIDGE_MCP_TOOL_PREFIX}${sanitizeMcpToolNameStem(piToolName)}`;
	if (!usedMcpToolNames.has(baseName)) {
		usedMcpToolNames.add(baseName);
		return baseName;
	}

	const hashedName = `${baseName}__${stableNameHash(piToolName)}`;
	if (!usedMcpToolNames.has(hashedName)) {
		usedMcpToolNames.add(hashedName);
		return hashedName;
	}

	let counter = 2;
	let candidate = `${hashedName}_${counter}`;
	while (usedMcpToolNames.has(candidate)) {
		counter += 1;
		candidate = `${hashedName}_${counter}`;
	}
	usedMcpToolNames.add(candidate);
	return candidate;
}

export function snapshotToolToMcpTool(tool: CursorPiBridgeToolDefinition): Tool {
	return {
		name: tool.mcpToolName,
		description: buildCursorPiBridgeMcpToolDescription({
			piToolName: tool.piToolName,
			mcpToolName: tool.mcpToolName,
			piToolDescription: tool.description,
			piToolPromptGuidelines: tool.promptGuidelines,
		}),
		inputSchema: tool.inputSchema,
		_meta: { piToolName: tool.piToolName },
	};
}

export function convertPiContentToMcpContent(content: unknown): CallToolResult["content"] {
	if (!Array.isArray(content)) {
		return [{ type: "text", text: stringifyUnknown(content) }];
	}

	const mcpContent: CallToolResult["content"] = [];
	for (const block of content) {
		const record = asRecord(block);
		if (record?.type === "text" && typeof record.text === "string") {
			mcpContent.push({ type: "text", text: record.text });
			continue;
		}
		if (record?.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
			mcpContent.push({ type: "image", data: record.data, mimeType: record.mimeType });
			continue;
		}
		mcpContent.push({ type: "text", text: stringifyUnknown(block) });
	}

	return mcpContent.length > 0 ? mcpContent : [{ type: "text", text: "" }];
}

export function asToolResultMessage(value: Context["messages"][number]): ToolResultMessage | undefined {
	return value.role === "toolResult" ? value : undefined;
}

export function containsKnownMcpToolName(value: unknown, knownMcpToolNames: ReadonlySet<string>, depth = 0): boolean {
	if (depth > 4) return false;
	if (Array.isArray(value)) return value.some((entry) => containsKnownMcpToolName(entry, knownMcpToolNames, depth + 1));
	const record = asRecord(value);
	if (!record) return false;

	for (const field of ["tool", "toolName", "name", "mcpToolName", "serverToolName"]) {
		const fieldValue = record[field];
		if (typeof fieldValue === "string" && knownMcpToolNames.has(fieldValue)) return true;
	}

	for (const nestedField of ["args", "arguments", "input"]) {
		if (containsKnownMcpToolName(record[nestedField], knownMcpToolNames, depth + 1)) return true;
	}

	return false;
}
