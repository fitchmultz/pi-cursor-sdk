/** Canonical secret/bridge scrubbing (parity-tested by provider runtime and maintainer scripts). */

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const BRIDGE_ENDPOINT_ROOT = "/cursor-pi-tool-bridge";
const BRIDGE_ENDPOINT_TOKEN_PATTERN = "[^/\\s\"'<>]+";
const BRIDGE_LOOPBACK_HOST_PATTERN = "127\\.0\\.0\\.1(?::\\d+)?";
const BRIDGE_ENDPOINT_PATH_PATTERN = `${escapeRegExp(BRIDGE_ENDPOINT_ROOT)}/${BRIDGE_ENDPOINT_TOKEN_PATTERN}/mcp`;

/** Necessary markers only, not credential validation. Skip impossible regex
 * no-matches when either marker is absent; both-marker inputs remain unbounded. */
export function hasCredentialUrlMarkers(text) {
	return text.includes("@") && text.includes(":");
}

function scrubUrlUserInfo(text) {
	if (!hasCredentialUrlMarkers(text)) return text;
	return text
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@(?=[^\s/?#]+)/gi, "$1[redacted]@")
		.replace(/\b[^\s/:@]+:[^\s/]+@(?=[A-Za-z0-9.-]+(?::|\/|\s|$))/g, "[redacted]@");
}

function scrubBridgeEndpointMaterial(text) {
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

export function scrubSensitiveText(text, apiKey) {
	let scrubbed = text;
	const trimmedKey = apiKey?.trim();
	if (trimmedKey) {
		scrubbed = scrubbed.replace(new RegExp(escapeRegExp(trimmedKey), "g"), "[redacted]");
	}
	return scrubBridgeEndpointMaterial(
		scrubUrlUserInfo(scrubbed)
			.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
			.replace(/((?:^|[\s,{])cookie["']?\s*[:=]\s*["']?)[^\n]+/gi, "$1[redacted]")
			.replace(
				/((?:authorization|api[_-]?key|apiKey|token|session(?:[_-]?id)?)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
				"$1[redacted]",
			),
	);
}
