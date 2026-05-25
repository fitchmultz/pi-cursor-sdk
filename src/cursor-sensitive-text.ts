import type { CursorPiToolDisplay } from "./cursor-transcript-utils.js";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const BRIDGE_ENDPOINT_ROOT = "/cursor-pi-tool-bridge";
const BRIDGE_ENDPOINT_TOKEN_PATTERN = "[^/\\s\"'<>]+";
const BRIDGE_LOOPBACK_HOST_PATTERN = "127\\.0\\.0\\.1(?::\\d+)?";
const BRIDGE_ENDPOINT_PATH_PATTERN = `${escapeRegExp(BRIDGE_ENDPOINT_ROOT)}/${BRIDGE_ENDPOINT_TOKEN_PATTERN}/mcp`;

function scrubBridgeEndpointMaterial(text: string): string {
	return text
		.replace(
			new RegExp(`https?://${BRIDGE_LOOPBACK_HOST_PATTERN}${BRIDGE_ENDPOINT_PATH_PATTERN}`, "gi"),
			"[redacted-bridge-endpoint]",
		)
		.replace(
			new RegExp(`${BRIDGE_LOOPBACK_HOST_PATTERN}${BRIDGE_ENDPOINT_PATH_PATTERN}`, "gi"),
			"[redacted-bridge-endpoint]",
		)
		.replace(new RegExp(BRIDGE_ENDPOINT_PATH_PATTERN, "gi"), "[redacted-bridge-endpoint]");
}

export function scrubSensitiveText(text: string, apiKey?: string): string {
	let scrubbed = text;
	const trimmedKey = apiKey?.trim();
	if (trimmedKey) {
		scrubbed = scrubbed.replace(new RegExp(escapeRegExp(trimmedKey), "g"), "[redacted]");
	}
	return scrubBridgeEndpointMaterial(
		scrubbed
			.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
			.replace(/((?:^|[\s,{])cookie["']?\s*[:=]\s*["']?)[^\n]+/gi, "$1[redacted]")
			.replace(
				/((?:authorization|api[_-]?key|apiKey|token|session(?:[_-]?id)?)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
				"$1[redacted]",
			),
	);
}

function scrubDisplayValue(value: unknown, apiKey?: string): unknown {
	if (typeof value === "string") return scrubSensitiveText(value, apiKey);
	if (Array.isArray(value)) return value.map((entry) => scrubDisplayValue(entry, apiKey));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubDisplayValue(entry, apiKey)]));
	}
	return value;
}

export function scrubPiToolDisplay(display: CursorPiToolDisplay, apiKey?: string): CursorPiToolDisplay {
	return {
		...display,
		args: scrubDisplayValue(display.args, apiKey) as Record<string, unknown>,
		result: scrubDisplayValue(display.result, apiKey) as CursorPiToolDisplay["result"],
	};
}
