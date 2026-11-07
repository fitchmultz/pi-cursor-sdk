import { describe, expect, it } from "vitest";
import { scrubPiToolDisplay, scrubSensitiveText } from "../src/cursor-sensitive-text.js";

describe("cursor-sensitive-text", () => {
	it.each([
		["MCP connect failed: http://127.0.0.1:54321/cursor-pi-tool-bridge/secret-endpoint-token-abc123/mcp", "MCP connect failed: [redacted-bridge-endpoint]"],
		["route not found: /cursor-pi-tool-bridge/secret-endpoint-token-path/mcp", "route not found: [redacted-bridge-endpoint]"],
		["fetch failed for 127.0.0.1:8080/cursor-pi-tool-bridge/secret-endpoint-token-host/mcp", "fetch failed for [redacted-bridge-endpoint]"],
	])("redacts bridge endpoint references in %s", (input, expected) => {
		expect(scrubSensitiveText(input)).toBe(expected);
	});

	it("still redacts API keys, bearer tokens, and field-style secrets", () => {
		const apiKey = "super-secret-cursor-key-12345";
		const sample = `Bearer ${apiKey} api_key=${apiKey} http://127.0.0.1:1/cursor-pi-tool-bridge/bridge-token/mcp`;
		const scrubbed = scrubSensitiveText(sample, apiKey);

		expect(scrubbed).not.toContain(apiKey);
		expect(scrubbed).toContain("Bearer [redacted]");
		expect(scrubbed).toContain("api_key=[redacted]");
		expect(scrubbed).toContain("[redacted-bridge-endpoint]");
	});

	it("redacts URL and SCP-style userinfo", () => {
		const scrubbed = scrubSensitiveText(
			"clone https://repo-user:repo-p@ss@example.com/org/repo.git or repo-user:repo-p@ss@example.com:org/repo.git",
		);

		expect(scrubbed).not.toContain("repo-user");
		expect(scrubbed).not.toContain("repo-p");
		expect(scrubbed).not.toContain("@ss@");
		expect(scrubbed).toContain("https://[redacted]@example.com/org/repo.git");
		expect(scrubbed).toContain("[redacted]@example.com:org/repo.git");
	});

	it("scrubs bridge endpoint material from nested pi tool display values", () => {
		const endpointToken = "secret-endpoint-token-display";
		const display = scrubPiToolDisplay({
			toolName: "bridge",
			isError: false,
			args: { endpoint: `/cursor-pi-tool-bridge/${endpointToken}/mcp` },
			result: {
				content: [{ type: "text", text: `failed at http://127.0.0.1:9999/cursor-pi-tool-bridge/${endpointToken}/mcp` }],
			},
		});

		expect(JSON.stringify(display)).not.toContain(endpointToken);
		expect(JSON.stringify(display)).not.toContain("127.0.0.1");
		expect(JSON.stringify(display)).toContain("[redacted-bridge-endpoint]");
	});
});
