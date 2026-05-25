import { describe, expect, it } from "vitest";
import { scrubPiToolDisplay, scrubSensitiveText } from "../src/cursor-sensitive-text.js";

describe("cursor-sensitive-text", () => {
	it("redacts loopback bridge MCP endpoint URLs", () => {
		const endpointToken = "secret-endpoint-token-abc123";
		const fullUrl = `http://127.0.0.1:54321/cursor-pi-tool-bridge/${endpointToken}/mcp`;
		const scrubbed = scrubSensitiveText(`MCP connect failed: ${fullUrl}`);

		expect(scrubbed).toBe("MCP connect failed: [redacted-bridge-endpoint]");
		expect(scrubbed).not.toContain(endpointToken);
		expect(scrubbed).not.toContain("127.0.0.1");
		expect(scrubbed).not.toContain("/cursor-pi-tool-bridge/");
	});

	it("redacts bridge endpoint paths without a host", () => {
		const endpointToken = "secret-endpoint-token-path";
		const path = `/cursor-pi-tool-bridge/${endpointToken}/mcp`;
		const scrubbed = scrubSensitiveText(`route not found: ${path}`);

		expect(scrubbed).toBe("route not found: [redacted-bridge-endpoint]");
		expect(scrubbed).not.toContain(endpointToken);
	});

	it("redacts host-only bridge endpoint references", () => {
		const endpointToken = "secret-endpoint-token-host";
		const hostPath = `127.0.0.1:8080/cursor-pi-tool-bridge/${endpointToken}/mcp`;
		const scrubbed = scrubSensitiveText(`fetch failed for ${hostPath}`);

		expect(scrubbed).toBe("fetch failed for [redacted-bridge-endpoint]");
		expect(scrubbed).not.toContain(endpointToken);
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

	it("scrubs bridge endpoint material from nested pi tool display values", () => {
		const endpointToken = "secret-endpoint-token-display";
		const display = scrubPiToolDisplay({
			title: "Bridge tool",
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
