import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { scrubSensitiveText } from "../shared/cursor-sensitive-text.mjs";
const artifactSecretsModule = "../scripts/platform-smoke/artifact-secrets.mjs";
const { redactSecrets, scanForSecrets, SECRET_PATTERNS } = await import(artifactSecretsModule);

// Pin the pre-change artifact contract independently of the production registry.
const legacyArtifactCredentials: Array<[RegExp, string, string]> = [
	[/\b[a-z][a-z0-9+.-]*:\/\/(?!\[redacted\]@)[^\s/?#]*@[^\s/?#]+/gi, "credential-bearing URL", "[REDACTED_CREDENTIAL_URL]"],
	[/\b[^\s/:@]+:[^\s/]+@(?=[A-Za-z0-9.-]+(?::|\/|\s|$))/g, "credential-bearing SCP URL", "[REDACTED_CREDENTIAL_URL]"],
];

describe("credential userinfo scanning", () => {
	it.each(["artifact", "shared"])("bounds %s processing of long noncredential text without changing content", (owner) => {
		// Word boundaries inside an otherwise legal username/scheme character run
		// used to retry both URL regexes at every suffix (quadratic no-match).
		// A child deadline bounds that regression without hanging Vitest's worker.
		const script = `
			import assert from "node:assert/strict";
			import { scrubSensitiveText } from "./shared/cursor-sensitive-text.mjs";
			import { redactSecrets, scanForSecrets } from "./scripts/platform-smoke/artifact-secrets.mjs";
			const long = "a-".repeat(128 * 1024);
			for (const text of [long, long + ":", long + "@"]) {
				if (${JSON.stringify(owner)} === "shared") assert.equal(scrubSensitiveText(text), text);
				else {
					assert.deepEqual(scanForSecrets(text), []);
					assert.equal(redactSecrets(text), text);
				}
			}
			console.log("unchanged-and-no-findings");
		`;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: process.cwd(), encoding: "utf8", timeout: 4_000, killSignal: "SIGKILL",
			env: { ...process.env, CURSOR_API_KEY: "" },
		});
		expect(child.error?.message, child.stderr).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout.trim()).toBe("unchanged-and-no-findings");
	}, 10_000);

	it.each(["plain-text", "plain-text:", "plain-text@"])(
		"resets credential regex state when skipping impossible candidates: %s", (text) => {
			const patterns = SECRET_PATTERNS.filter(([, label]: [RegExp, string, string]) => label.startsWith("credential-bearing"));
			expect(patterns).toHaveLength(2);
			for (const operation of [scanForSecrets, redactSecrets]) {
				for (const [pattern] of patterns) pattern.lastIndex = 7;
				operation(text);
				for (const [pattern] of patterns) expect(pattern.lastIndex).toBe(0);
			}
		},
	);

	it("preserves excluded credential regex state for binary scans", () => {
		const patterns = SECRET_PATTERNS.filter(([, label]: [RegExp, string, string]) => label.startsWith("credential-bearing"));
		expect(patterns).toHaveLength(2);
		try {
			for (const [pattern] of patterns) pattern.lastIndex = 7;
			expect(scanForSecrets(Buffer.from([0, 65]))).toEqual([]);
			for (const [pattern] of patterns) expect(pattern.lastIndex).toBe(7);
		} finally {
			for (const [pattern] of patterns) pattern.lastIndex = 0;
		}
	});

	it.each([
		"https://user:password@example.com/repo",
		"https://username@example.com/repo",
		"git+ssh://user:password@example.com/repo",
		"repo-user:repo-p@ss@example.com:org/repo.git",
		"before https://repo-user:repo-p@ss@example.com/repo after",
		"email@example.com", "@scope/pkg", "a-b-c:", "a-b-c@", "https://example.com/repo",
	])("preserves legacy credential matching and redaction for %s", (text) => {
		// The original regexes remain the matching contract, not a new URL parser.
		const legacyShared = text
			.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@(?=[^\s/?#]+)/gi, "$1[redacted]@")
			.replace(/\b[^\s/:@]+:[^\s/]+@(?=[A-Za-z0-9.-]+(?::|\/|\s|$))/g, "[redacted]@");
		expect(scrubSensitiveText(text)).toBe(legacyShared);
		const expectedFindings: string[] = [];
		let expectedRedacted = legacyShared;
		for (const [pattern, label, replacement] of legacyArtifactCredentials) {
			pattern.lastIndex = 0;
			if (pattern.test(text)) expectedFindings.push(`potential ${label}`);
			expectedRedacted = expectedRedacted.replace(pattern, replacement);
		}
		expect(scanForSecrets(text)).toEqual(expectedFindings);
		expect(redactSecrets(text)).toBe(expectedRedacted);
	});
});
