import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

const artifactsModule = "../scripts/platform-smoke/artifacts.mjs";

function run(command: string, args: string[], env = process.env, cwd = process.cwd()) {
	return spawnSync(command, args, { cwd, encoding: "utf8", env, shell: process.platform === "win32" && command === "npm" });
}

function encodeBinaryText(value: string, encoding: "utf16le" | "utf16be" | "utf32le" | "utf32be") {
	if (encoding.startsWith("utf16")) {
		const result = Buffer.from(value, "utf16le");
		if (encoding === "utf16be") {
			for (let index = 0; index < result.length; index += 2) [result[index], result[index + 1]] = [result[index + 1]!, result[index]!];
		}
		return result;
	}
	const codePoints = [...value].map((character) => character.codePointAt(0)!);
	const result = Buffer.alloc(codePoints.length * 4);
	for (let index = 0; index < codePoints.length; index++) {
		if (encoding === "utf32le") result.writeUInt32LE(codePoints[index]!, index * 4);
		else result.writeUInt32BE(codePoints[index]!, index * 4);
	}
	return result;
}

describe("platform smoke artifact transport", () => {
	const duplicateSecret = "credential-free-review-secret-123456789";
	const duplicateCases = [
		{ name: "auth field", text: `{"apiKey":"${duplicateSecret}","apiKey":"placeholder"}`, violation: "potential auth/token assignment" },
		{ name: "escaped key and value", text: String.raw`{"api\u004bey":"credential-free-review-\u0073ecret-123456789","apiKey":"placeholder"}`, violation: "potential auth/token assignment" },
		{ name: "overwritten container", text: `{"nested":[{"apiKey":"${duplicateSecret}"}],"nested":{}}`, violation: "potential auth/token assignment" },
		{ name: "numeric token", text: '{"token":123456789012,"token":1}', violation: "potential auth/token assignment" },
		{ name: "numeric overflow", text: `{"token":${"7".repeat(400)},"token":1}`, violation: "potential auth/token assignment" },
		{ name: "bearer in array", text: `[{"text":"Bearer ${duplicateSecret}","text":null}]`, violation: "potential bearer token" },
		{ name: "credential URL", text: '{"url":"https://user:password@example.com/repo","url":"@scope/pkg"}', violation: "potential credential-bearing URL" },
		{ name: "literal escaped value", text: String.raw`{"value":"credential-free-review-\u0073ecret-123456789","value":false}`, violation: "CURSOR_API_KEY literal found" },
		{ name: "literal escaped key in overwritten object", text: String.raw`{"nested":{"credential-free-review-\u0073ecret-123456789":1},"nested":[]}`, violation: "CURSOR_API_KEY literal found" },
	].flatMap((fixture) => [false, true]
		.filter((withEnv) => withEnv || fixture.violation !== "CURSOR_API_KEY literal found")
		.map((withEnv) => ({ ...fixture, withEnv })));

	it.each(["metadata.json", "session.jsonl"])("never bundles overwritten secret members in %s", async (path) => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle } = await import(artifactsModule);
		for (const fixture of duplicateCases) {
			vi.stubEnv("CURSOR_API_KEY", fixture.withEnv ? duplicateSecret : undefined);
			const root = mkdtempSync(join(tmpdir(), "platform-duplicate-source-"));
			const out = mkdtempSync(join(tmpdir(), "platform-duplicate-out-"));
			try {
				writeFileSync(join(root, path), fixture.text + "\n");
				const bundle = buildPlatformArtifactBundle(root, "evidence");
				expect.soft(bundle.files.map((file: { path: string }) => file.path), fixture.name).toEqual(["evidence/bundle-redaction-violations.json"]);
				const result = extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(bundle));
				if (process.platform !== "win32") expect.soft(result.violations, fixture.name).toContainEqual({ file: path, violation: fixture.violation });
				expect.soft(existsSync(join(out, "evidence", path)), fixture.name).toBe(false);
			} finally {
				vi.unstubAllEnvs();
				rmSync(root, { recursive: true, force: true });
				rmSync(out, { recursive: true, force: true });
			}
		}
	});

	it.each(["metadata.json", "session.jsonl"])("rejects overwritten secrets during validation and forged-envelope extraction of %s", async (path) => {
		const { extractPlatformArtifactBundle, formatPlatformArtifactBundle, PLATFORM_ARTIFACT_BUNDLE_START, PLATFORM_ARTIFACT_BUNDLE_END } = await import(artifactsModule);
		for (const fixture of duplicateCases) {
			vi.stubEnv("CURSOR_API_KEY", fixture.withEnv ? duplicateSecret : undefined);
			const out = mkdtempSync(join(tmpdir(), "platform-duplicate-forged-"));
			try {
				const content = Buffer.from(fixture.text + "\n");
				const bundle = { files: [
					{ path: "evidence/first.txt", size: 4, contentBase64: Buffer.from("safe").toString("base64") },
					{ path: `evidence/${path}`, size: content.length, contentBase64: content.toString("base64") },
				] };
				// The formatter invokes bundle validation; bypass it to test the receiver independently.
				expect.soft(() => formatPlatformArtifactBundle(bundle), fixture.name).toThrow();
				const compressed = gzipSync(Buffer.from(JSON.stringify(bundle)));
				const envelope = `${PLATFORM_ARTIFACT_BUNDLE_START}\n${JSON.stringify({
					encoding: "gzip-base64", size: compressed.length,
					sha256: createHash("sha256").update(compressed).digest("hex"), contentBase64: compressed.toString("base64"),
				})}\n${PLATFORM_ARTIFACT_BUNDLE_END}\n`;
				expect.soft(extractPlatformArtifactBundle(out, envelope).ok, fixture.name).toBe(false);
				expect.soft(readdirSync(out), fixture.name).toEqual([]);
			} finally {
				vi.unstubAllEnvs();
				rmSync(out, { recursive: true, force: true });
			}
		}
	});

	it.each(["metadata.json", "session.jsonl"])("final-scans all overwritten members in retained %s", async (path) => {
		const { scanArtifacts } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-duplicate-scan-"));
		try {
			for (const fixture of duplicateCases) {
				vi.stubEnv("CURSOR_API_KEY", fixture.withEnv ? duplicateSecret : undefined);
				writeFileSync(join(root, path), fixture.text + "\n");
				expect.soft(scanArtifacts(root), fixture.name).toContainEqual({ file: path, violation: fixture.violation });
			}
		} finally {
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains benign duplicate members, scoped IDs and escaped docs byte-for-byte", async () => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle, scanArtifacts } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-benign-duplicate-"));
		const out = mkdtempSync(join(tmpdir(), "platform-benign-duplicate-out-"));
		// Container punctuation must end scalar auth context, not label array elements as tokens.
		const document = String.raw`{"apiKey":["ordinary-long-identifier"],"api\u004bey":{},"ownerToken":1,"ownerToken":2,"name":"@scope/first","name":"@scope/second","docs":"apiKey=\"placeholder\" CURSOR_API_KEY=\"your-key\"","nested":[{"id":"agent-first","id":"agent-second"}],"empty":null,"enabled":true,"count":-1.25e+2}`;
		const inputs = { "metadata.json": document + "\n", "session.jsonl": `${document}\r\n\r\n["@scope/pkg",null,false,42,{"apiKey":[],"id":"agent-fixture"}]\r\n` };
		try {
			for (const [path, content] of Object.entries(inputs)) writeFileSync(join(root, path), content);
			expect(scanArtifacts(root)).toEqual([]);
			const bundle = buildPlatformArtifactBundle(root, "evidence");
			expect(bundle.files).toHaveLength(2);
			const result = extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(bundle));
			expect(result.ok).toBe(process.platform !== "win32");
			if (process.platform !== "win32") {
				for (const [path, content] of Object.entries(inputs)) expect(readFileSync(join(out, "evidence", path))).toEqual(Buffer.from(content));
				expect(result.violations).toEqual([]);
				expect(scanArtifacts(out)).toEqual([]);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(out, { recursive: true, force: true });
		}
	});

	it("retains secret-scanned JSON/JSONL byte-for-byte without text-regex corruption", async () => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle, scanArtifacts } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-structured-"));
		const out = mkdtempSync(join(tmpdir(), "platform-structured-out-"));
		const record = { ownerToken: 1, packageName: "@scope/package", text: 'CURSOR_API_KEY="your-key" apiKey="placeholder"', usage: { input: 3 }, id: "agent-fixture" };
		const inputs = {
			"metadata.json": JSON.stringify(record, null, 2) + "\n",
			"session.jsonl": [record, { type: "compaction", summary: record.text }, { type: "message", message: { role: "assistant", content: [] } }].map(value => JSON.stringify(value)).join("\r\n") + "\r\n",
		};
		try {
			for (const [path, content] of Object.entries(inputs)) writeFileSync(join(root, path), content);
			const result = extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(buildPlatformArtifactBundle(root, "evidence")));
			expect(result.ok).toBe(process.platform !== "win32");
			if (process.platform !== "win32") {
				for (const [path, content] of Object.entries(inputs)) expect(readFileSync(join(out, "evidence", path), "utf8")).toBe(content);
				expect(JSON.parse(readFileSync(join(out, "evidence/metadata.json"), "utf8"))).toEqual(record);
				expect(scanArtifacts(out)).toEqual([]);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(out, { recursive: true, force: true });
		}
	});

	it("fails qualification on malformed structured artifacts without repairing or dropping rows", async () => {
		const { extractPlatformArtifactBundle, formatPlatformArtifactBundle, scanArtifacts } = await import(artifactsModule);
		const { finalizeSuiteArtifacts } = await import("../scripts/platform-smoke/target-runtime.mjs" as string);
		const root = mkdtempSync(join(tmpdir(), "platform-malformed-"));
		const inputs = { "metadata.json": '{"ownerToken":[redacted]}', "session.jsonl": '{"type":"session"}\n{"broken":\n{"type":"message"}\n' };
		try {
			const files = Object.entries(inputs).map(([path, text]) => ({ path, size: Buffer.byteLength(text), contentBase64: Buffer.from(text).toString("base64") }));
			const result = extractPlatformArtifactBundle(root, formatPlatformArtifactBundle({ files }));
			expect(result.ok).toBe(false);
			if (process.platform === "win32") return;
			for (const [path, content] of Object.entries(inputs)) expect(readFileSync(join(root, path), "utf8")).toBe(content);
			expect(scanArtifacts(root)).toContainEqual({ file: "metadata.json", violation: "invalid JSON" });
			expect(scanArtifacts(root)).toContainEqual({ file: "session.jsonl", violation: "invalid JSONL at line 2" });
			const finalized = finalizeSuiteArtifacts(root, [{ id: "scenario", fn: () => true }], {}, Object.keys(inputs));
			expect(finalized.assertions.ok).toBe(false);
			expect(finalized.assertions.checks).toContainEqual(expect.objectContaining({ id: "structured-artifacts-parseable", ok: false }));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("scans decoded JSON scalars and auth fields without classifying ordinary identifiers as credentials", async () => {
		const { scanArtifactSecrets } = await import("../scripts/platform-smoke/artifact-secrets.mjs" as string);
		const secret = "fixture-secret-123456789";
		vi.stubEnv("CURSOR_API_KEY", secret);
		try {
			for (const value of [
				{ apiKey: 'abcdefghijkl\\"mnopqrst' }, { accessToken: "abcdefghijklmnop" },
				{ cookie: "abcdefghijklmnop" }, { session: "abcdefghijklmnop" }, { token: 123456789012 },
				{ nested: [{ text: `Bearer ${secret}` }] }, { [secret]: "ordinary" },
				{ url: "https://user:password@example.com/repo" }, { url: "user:password@example.com:repo" },
			]) expect(scanArtifactSecrets("metadata.json", Buffer.from(JSON.stringify(value))).length).toBeGreaterThan(0);
			expect(scanArtifactSecrets("session.jsonl", '{"text":"fixture-\\u0073ecret-123456789"}\n')).toContain("CURSOR_API_KEY literal found");
			expect(scanArtifactSecrets("metadata.json", '{"ownerToken":1,"name":"@scope/pkg","id":"agent-fixture","enabled":true,"empty":null}')).toEqual([]);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("still redacts log secrets and rejects secret-bearing structured transport before writing", async () => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle, redactSecrets, scanForSecrets } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-structured-secret-"));
		const out = mkdtempSync(join(tmpdir(), "platform-structured-secret-out-"));
		try {
			const secret = "credential-free-token-123456789";
			const text = `Authorization: Bearer ${secret}`;
			expect(redactSecrets(text)).not.toContain(secret);
			expect(scanForSecrets(redactSecrets(text))).toEqual([]);
			for (const name of ["metadata.json", "session.jsonl"]) writeFileSync(join(root, name), JSON.stringify({ apiKey: secret }) + "\n");
			const bundle = buildPlatformArtifactBundle(root, "evidence");
			expect(bundle.files.map((file: { path: string }) => file.path)).toEqual(["evidence/bundle-redaction-violations.json"]);
			const result = extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(bundle));
			if (process.platform !== "win32") expect(result.violations.length).toBeGreaterThan(0);
			expect(existsSync(join(out, "evidence/metadata.json"))).toBe(false);
			expect(existsSync(join(out, "evidence/session.jsonl"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(out, { recursive: true, force: true });
		}
	});

	it("detects a Cursor key in binary artifacts and never transports or extracts the binary", async () => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle, scanArtifacts } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-binary-secret-"));
		const out = mkdtempSync(join(tmpdir(), "platform-binary-secret-out-"));
		const previousKey = process.env.CURSOR_API_KEY;
		process.env.CURSOR_API_KEY = "cursor-binary-secret-123456789";
		try {
			writeFileSync(join(root, "leak.bin"), Buffer.concat([Buffer.from([0, 255, 0]), Buffer.from(process.env.CURSOR_API_KEY), Buffer.from([0])]));
			const findings = scanArtifacts(root);
			const bundle = buildPlatformArtifactBundle(root, "evidence");
			const extracted = extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(bundle));

			expect(findings).toContainEqual({ file: "leak.bin", violation: "CURSOR_API_KEY literal found" });
			expect(bundle.files).toHaveLength(1);
			expect(bundle.files[0]!.path).toBe("evidence/bundle-redaction-violations.json");
			expect(extracted.ok).toBe(process.platform !== "win32");
			if (process.platform !== "win32") {
				expect(extracted.violations).toContainEqual({ file: "leak.bin", violation: "CURSOR_API_KEY literal found" });
			}
			expect(existsSync(join(out, "evidence", "leak.bin"))).toBe(false);
		} finally {
			if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
			else process.env.CURSOR_API_KEY = previousKey;
			rmSync(root, { recursive: true, force: true });
			rmSync(out, { recursive: true, force: true });
		}
	});

	it("detects exact and structured secrets in UTF-16 and UTF-32 binary artifacts", async () => {
		const { buildPlatformArtifactBundle, scanArtifacts, scanForSecrets } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-encoded-binary-secret-"));
		const previousKey = process.env.CURSOR_API_KEY;
		process.env.CURSOR_API_KEY = "cursor-encoded-secret-123456789";
		const encodings = ["utf16le", "utf16be", "utf32le", "utf32be"] as const;
		try {
			for (const encoding of encodings) {
				writeFileSync(join(root, `leak-${encoding}.bin`), encodeBinaryText(process.env.CURSOR_API_KEY!, encoding));
				const embeddedBearer = Buffer.concat([
					Buffer.alloc(70_003, 65),
					encodeBinaryText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz", encoding),
					Buffer.from([4, 5]),
				]);
				expect(scanForSecrets(embeddedBearer)).toContain("potential Authorization header");
			}
			const findings = scanArtifacts(root);
			for (const encoding of encodings) {
				expect(findings).toContainEqual({ file: `leak-${encoding}.bin`, violation: "CURSOR_API_KEY literal found" });
			}
			const bundle = buildPlatformArtifactBundle(root, "evidence");
			expect(bundle.files.map((file: { path: string }) => file.path)).toEqual(["evidence/bundle-redaction-violations.json"]);
		} finally {
			if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
			else process.env.CURSOR_API_KEY = previousKey;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags generic auth assignments before redaction or transport", async () => {
		const { buildPlatformArtifactBundle, redactSecrets, scanArtifacts, scanForSecrets } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-auth-assignment-"));
		const secret = "abcdefghijklmnopqrstuvwxyz123456";
		const content = `api_key=${secret}`;
		try {
			writeFileSync(join(root, "evidence.txt"), content);
			expect(redactSecrets(content)).not.toContain(secret);
			expect(scanForSecrets(content)).toContain("potential auth/token assignment");
			for (const literal of [
				`apiKey="${"a".repeat(24)}"`,
				`apiKey='abc"abcdefghijklmnop'`,
				`apiKey="abc'abcdefghijklmnop"`,
				`api_key=\`${secret}\``,
				"api_key=`abcdefghijkl${value}`",
				`api_key='${secret}`,
				...['&', ')', ']', '#'].map((delimiter) => `api_key=${secret}${delimiter}`),
			]) {
				expect(scanForSecrets(literal), literal).toContain("potential auth/token assignment");
				expect(redactSecrets(literal), literal).not.toContain("abcdefghijklmnop");
			}
			for (const escapedLiteral of [
				String.raw`apiKey="AAAAAAAAAAAA\"BBBBBBBBBBBB"`,
				String.raw`apiKey='AAAAAAAAAAAA\'BBBBBBBBBBBB'`,
			]) {
				expect(scanForSecrets(escapedLiteral), escapedLiteral).toContain("potential auth/token assignment");
				const redacted = redactSecrets(escapedLiteral);
				expect(redacted).not.toMatch(/[AB]{12}/);
				expect(scanForSecrets(redacted)).toEqual([]);
			}
			for (const sourceExpression of [
				"apiKey = resolveCursorApiKey(await", "apiKey = params.apiKey", "Token = options.charsPerToken",
				"Authorization: `Bearer ${options.apiKey}`",
				"charsPerToken=123456789012", "myApiKey=123456789012", "notauthorization=123456789012",
			]) {
				expect(scanForSecrets(sourceExpression), sourceExpression).toEqual([]);
			}
			expect(scanForSecrets("apiKey=abcdefghijklmnopqrst ".repeat(20_000))).toEqual([]);
			expect(scanArtifacts(root)).toContainEqual({ file: "evidence.txt", violation: "potential auth/token assignment" });
			const bundle = buildPlatformArtifactBundle(root, "evidence");
			expect(bundle.files.map((file: { path: string }) => file.path)).toEqual(["evidence/bundle-redaction-violations.json"]);
			expect(JSON.stringify(bundle)).not.toContain(secret);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("redacts secret-bearing paths and rejects secret bundle metadata", async () => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle, scanArtifacts } = await import(artifactsModule);
		const previousKey = process.env.CURSOR_API_KEY;
		const key = "cursor-path-secret-123456789";
		process.env.CURSOR_API_KEY = key;
		const root = mkdtempSync(join(tmpdir(), `platform-${key}-`));
		const out = mkdtempSync(join(tmpdir(), "platform-path-secret-out-"));
		try {
			writeFileSync(join(root, `${key}.txt`), "safe");
			const findings = scanArtifacts(root);
			const bundle = buildPlatformArtifactBundle(root, "evidence");
			const serialized = JSON.stringify(bundle);
			expect(findings).toContainEqual({ file: "[redacted].txt", violation: "CURSOR_API_KEY literal found" });
			expect(Object.hasOwn(bundle, "root")).toBe(false);
			expect(serialized).not.toContain(key);
			expect(extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(bundle)).ok).toBe(process.platform !== "win32");
			expect(JSON.stringify(readdirSync(out, { recursive: true }))).not.toContain(key);

			const pathContent = Buffer.from("safe");
			expect(() => formatPlatformArtifactBundle({ files: [{
				path: `evidence/${key}.txt`, contentBase64: pathContent.toString("base64"), size: pathContent.length,
			}] })).toThrow();
			const secretContent = Buffer.from(key);
			expect(() => formatPlatformArtifactBundle({ files: [{
				path: "evidence/safe.txt", contentBase64: secretContent.toString("base64"), size: secretContent.length,
			}] })).toThrow();
			expect(() => formatPlatformArtifactBundle({ root: key, files: [] })).toThrow();
			expect(() => formatPlatformArtifactBundle({ files: [{
				path: "evidence/safe.txt", contentBase64: pathContent.toString("base64"), size: pathContent.length, metadata: key,
			}] })).toThrow();
		} finally {
			if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
			else process.env.CURSOR_API_KEY = previousKey;
			rmSync(root, { recursive: true, force: true });
			rmSync(out, { recursive: true, force: true });
		}
	});

	it("scans then ignores benign binary files with unknown extensions", async () => {
		const { buildPlatformArtifactBundle, scanArtifacts } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-benign-binary-"));
		try {
			writeFileSync(join(root, "rg.bin"), Buffer.from([0, 255, 0, 1, 2, 3]));
			expect(scanArtifacts(root)).toEqual([]);
			expect(buildPlatformArtifactBundle(root, "evidence").files).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("scans a secret-bearing .env but transports only violation evidence", async () => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle, scanArtifacts } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-env-secret-"));
		const out = mkdtempSync(join(tmpdir(), "platform-env-secret-out-"));
		const previousKey = process.env.CURSOR_API_KEY;
		process.env.CURSOR_API_KEY = "cursor-env-secret-123456789";
		try {
			writeFileSync(join(root, ".env.local"), `CURSOR_API_KEY=${process.env.CURSOR_API_KEY}\n`);
			const findings = scanArtifacts(root);
			const bundle = buildPlatformArtifactBundle(root, "evidence");
			const extracted = extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(bundle));

			expect(findings).toContainEqual({ file: ".env.local", violation: "CURSOR_API_KEY literal found" });
			expect(bundle.files.map((file: { path: string }) => file.path)).toEqual(["evidence/bundle-redaction-violations.json"]);
			if (process.platform !== "win32") {
				expect(extracted.violations).toContainEqual({ file: ".env.local", violation: "CURSOR_API_KEY literal found" });
			} else {
				expect(extracted.ok).toBe(false);
			}
			expect(existsSync(join(out, "evidence", ".env.local"))).toBe(false);
		} finally {
			if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
			else process.env.CURSOR_API_KEY = previousKey;
			rmSync(root, { recursive: true, force: true });
			rmSync(out, { recursive: true, force: true });
		}
	});

	it("does not apply broad credential URL heuristics to binary bytes", async () => {
		const { scanForSecrets } = await import(artifactsModule);
		const urlLike = "https://repo-user:repo-password@example.com/repo.git";
		const scpLike = "repo-user:repo-password@example.com:org/repo.git";

		for (const value of [urlLike, scpLike]) {
			expect(scanForSecrets(Buffer.concat([Buffer.from([0, 255]), Buffer.from(value), Buffer.from([0])]))).toEqual([]);
		}
		expect(scanForSecrets(urlLike)).toContain("potential credential-bearing URL");
		expect(scanForSecrets(scpLike)).toContain("potential credential-bearing SCP URL");
	});

	it("rejects binary content under an allowlisted text extension before transport or extraction", async () => {
		const {
			buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle,
			PLATFORM_ARTIFACT_BUNDLE_END, PLATFORM_ARTIFACT_BUNDLE_START,
		} = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-binary-text-extension-"));
		const out = mkdtempSync(join(tmpdir(), "platform-binary-text-extension-out-"));
		try {
			mkdirSync(join(root, "artifacts"));
			const content = Buffer.concat([
				Buffer.from([0, 255]),
				Buffer.from("https://repo-user:repo-password@example.com/repo.git"),
				Buffer.from([0]),
			]);
			writeFileSync(join(root, "artifacts", "terminal.ansi"), content);
			const bundle = buildPlatformArtifactBundle(root);
			const evidence = JSON.parse(Buffer.from(bundle.files[0]!.contentBase64, "base64").toString("utf8"));
			expect(bundle.files.map((file: { path: string }) => file.path)).toEqual(["artifacts/bundle-limit-exceeded.json"]);
			expect(evidence.reasons).toEqual(["binary-content"]);
			expect(JSON.stringify(bundle)).not.toContain("repo-password");

			const rawBundle = { files: [{ path: "artifacts/terminal.ansi", contentBase64: content.toString("base64"), size: content.length }] };
			expect(() => formatPlatformArtifactBundle(rawBundle)).toThrow();
			const compressed = gzipSync(Buffer.from(JSON.stringify(rawBundle)));
			const stdout = `${PLATFORM_ARTIFACT_BUNDLE_START}\n${JSON.stringify({
				encoding: "gzip-base64",
				size: compressed.length,
				sha256: createHash("sha256").update(compressed).digest("hex"),
				contentBase64: compressed.toString("base64"),
			})}\n${PLATFORM_ARTIFACT_BUNDLE_END}\n`;
			expect(extractPlatformArtifactBundle(out, stdout).ok).toBe(false);
			expect(readdirSync(out)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(out, { recursive: true, force: true });
		}
	});

	it("rejects unknown binary extensions from canonical bundles", async () => {
		const {
			extractPlatformArtifactBundle, formatPlatformArtifactBundle,
			PLATFORM_ARTIFACT_BUNDLE_END, PLATFORM_ARTIFACT_BUNDLE_START,
		} = await import(artifactsModule);
		const content = Buffer.from("safe");
		const bundle = { files: [{ path: "evidence/file.bin", contentBase64: content.toString("base64"), size: content.length }] };
		expect(() => formatPlatformArtifactBundle(bundle)).toThrow();
		const compressed = gzipSync(Buffer.from(JSON.stringify(bundle)));
		const stdout = `${PLATFORM_ARTIFACT_BUNDLE_START}\n${JSON.stringify({
			encoding: "gzip-base64",
			size: compressed.length,
			sha256: createHash("sha256").update(compressed).digest("hex"),
			contentBase64: compressed.toString("base64"),
		})}\n${PLATFORM_ARTIFACT_BUNDLE_END}\n`;
		const out = mkdtempSync(join(tmpdir(), "platform-binary-bundle-out-"));
		try {
			expect(extractPlatformArtifactBundle(out, stdout).ok).toBe(false);
			expect(existsSync(join(out, "evidence", "file.bin"))).toBe(false);
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	});

	it("reports oversized sparse artifacts without reading or transporting their content", async () => {
		const { buildPlatformArtifactBundle, MAX_BUNDLE_FILE_BYTES, scanArtifacts } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-sparse-artifact-"));
		try {
			const sparse = join(root, "oversized.txt");
			writeFileSync(sparse, "");
			truncateSync(sparse, MAX_BUNDLE_FILE_BYTES + 1);
			const bundle = buildPlatformArtifactBundle(root, "evidence");
			const evidence = Buffer.from(bundle.files[0]!.contentBase64, "base64").toString("utf8");

			expect(bundle.files).toHaveLength(1);
			expect(bundle.files[0]!.path).toBe("evidence/bundle-limit-exceeded.json");
			expect(bundle.files[0]!.size).toBeLessThan(2_000);
			expect(JSON.parse(evidence).reasons).toContain("file-size");
			expect(scanArtifacts(root)).toContainEqual({ file: "oversized.txt", violation: "artifact scan file-size" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when a regular file changes in place without changing identity or size", async () => {
		const { buildPlatformArtifactBundle, MAX_BUNDLE_FILE_BYTES } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-same-size-race-"));
		const path = join(root, "evidence.txt");
		writeFileSync(path, Buffer.alloc(MAX_BUNDLE_FILE_BYTES, 65));
		const writer = spawn(process.execPath, ["--input-type=module", "-e", String.raw`
import { openSync, writeSync } from "node:fs";
const [path, sizeText] = process.argv.slice(1);
const size = Number(sizeText);
const fd = openSync(path, "r+");
const first = Buffer.alloc(size, 65);
const second = Buffer.alloc(size, 66);
process.stdout.write("ready\n");
while (true) {
  writeSync(fd, first, 0, first.length, 0);
  writeSync(fd, second, 0, second.length, 0);
}
`, path, String(MAX_BUNDLE_FILE_BYTES)], { stdio: ["ignore", "pipe", "ignore"] });
		try {
			await new Promise<void>((resolveReady, reject) => {
				const timer = setTimeout(() => reject(new Error("same-size writer did not start")), 2_000);
				writer.stdout.once("data", () => { clearTimeout(timer); resolveReady(); });
				writer.once("error", reject);
			});
			let detected = false;
			for (let attempt = 0; attempt < 30 && !detected; attempt++) {
				const bundle = buildPlatformArtifactBundle(root, "evidence");
				if (bundle.files[0]?.path === "evidence/bundle-limit-exceeded.json") {
					const reasons = JSON.parse(Buffer.from(bundle.files[0].contentBase64, "base64").toString("utf8")).reasons;
					detected = reasons.includes("file-changed");
				}
			}
			expect(detected).toBe(true);
		} finally {
			if (writer.exitCode === null) {
				writer.kill();
				await new Promise((resolveExit) => writer.once("exit", resolveExit));
			}
			rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	it.skipIf(process.platform === "win32")("round-trips local-resume session, debug, and runtime evidence through the canonical bundle", () => {
		const code = String.raw`
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle } from "./scripts/platform-smoke/artifacts.mjs";
const root = mkdtempSync(join(tmpdir(), "local-resume-bundle-source-"));
const out = mkdtempSync(join(tmpdir(), "local-resume-bundle-out-"));
try {
  mkdirSync(join(root, "sessions"), { recursive: true });
  mkdirSync(join(root, "debug", "sessions", "s1"), { recursive: true });
  writeFileSync(join(root, "sessions", "session.jsonl"), "{}\n");
  writeFileSync(join(root, "debug", "sessions", "s1", "session.json"), JSON.stringify({ payload: "x".repeat(100_000) }) + "\n");
  writeFileSync(join(root, "runtime-launches.jsonl"), JSON.stringify({ extensionPath: "/packed/node_modules/pi-cursor-sdk" }) + "\n");
  const payload = buildPlatformArtifactBundle(root, "local-resume-evidence");
  const stdout = formatPlatformArtifactBundle(payload);
  const extracted = extractPlatformArtifactBundle(out, stdout);
  const runtime = readFileSync(join(out, "local-resume-evidence", "runtime-launches.jsonl"), "utf8");
  const result = {
    ok: extracted.ok,
    session: readFileSync(join(out, "local-resume-evidence", "sessions", "session.jsonl"), "utf8") === "{}\n",
    debug: JSON.parse(readFileSync(join(out, "local-resume-evidence", "debug", "sessions", "s1", "session.json"), "utf8")).payload.length === 100_000,
    packed: runtime.includes("/packed/node_modules/pi-cursor-sdk"),
    boundedLines: Math.max(...stdout.split("\n").map((line) => line.length)) < 32768,
  };
  console.log(JSON.stringify(result));
  if (!Object.values(result).every(Boolean)) process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
}
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"packed":true');
	});

	it("fails closed when the artifact writer exceeds count, aggregate, or compressed limits", async () => {
		const artifactsModule = "../scripts/platform-smoke/artifacts.mjs";
		const {
			buildPlatformArtifactBundle,
			extractPlatformArtifactBundle,
			MAX_BUNDLE_AGGREGATE_BYTES,
			MAX_BUNDLE_FILE_BYTES,
			MAX_BUNDLE_FILE_COUNT,
			writePlatformArtifactBundle,
		} = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "bundle-writer-limits-"));
		const out = mkdtempSync(join(tmpdir(), "bundle-writer-limits-out-"));
		const readLimitReasons = (bundle: { files: Array<{ contentBase64: string }> }) => JSON.parse(Buffer.from(bundle.files[0]!.contentBase64, "base64").toString("utf8")).reasons as string[];
		try {
			for (let index = 0; index <= MAX_BUNDLE_FILE_COUNT; index++) writeFileSync(join(root, `${index}.txt`), "x");
			expect(readLimitReasons(buildPlatformArtifactBundle(root, "evidence"))).toContain("file-count");

			rmSync(root, { recursive: true, force: true });
			mkdirSync(root, { recursive: true });
			const content = Buffer.alloc(MAX_BUNDLE_FILE_BYTES, 65);
			for (let index = 0; index <= MAX_BUNDLE_AGGREGATE_BYTES / MAX_BUNDLE_FILE_BYTES; index++) writeFileSync(join(root, `${index}.txt`), content);
			expect(readLimitReasons(buildPlatformArtifactBundle(root, "evidence"))).toContain("aggregate-bytes");

			rmSync(root, { recursive: true, force: true });
			mkdirSync(root, { recursive: true });
			for (let index = 0; index < 8; index++) {
				const incompressibleText = randomBytes(3_375_000).toString("base64");
				writeFileSync(join(root, `${index}.ansi`), incompressibleText);
			}
			let stdoutText = "";
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
				stdoutText += chunk.toString();
				return true;
			}) as typeof process.stdout.write);
			let bundle;
			try {
				bundle = writePlatformArtifactBundle(root, "evidence");
			} finally {
				stdout.mockRestore();
			}
			expect(readLimitReasons(bundle)).toContain("platform artifact bundle exceeds compressed limit");
			expect(extractPlatformArtifactBundle(out, stdoutText).ok).toBe(process.platform !== "win32");
			expect(existsSync(join(out, "evidence", "bundle-limit-exceeded.json"))).toBe(process.platform !== "win32");
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(out, { recursive: true, force: true });
		}
	}, 20_000);

	it("rejects inflated, over-count, over-aggregate, and corrupt bundles before writing files", async () => {
		const artifactsModule = "../scripts/platform-smoke/artifacts.mjs";
		const {
			extractPlatformArtifactBundle,
			MAX_BUNDLE_AGGREGATE_BYTES,
			MAX_BUNDLE_FILE_BYTES,
			MAX_BUNDLE_FILE_COUNT,
			MAX_INFLATED_BUNDLE_JSON_BYTES,
			PLATFORM_ARTIFACT_BUNDLE_END,
			PLATFORM_ARTIFACT_BUNDLE_START,
		} = await import(artifactsModule);
		const out = mkdtempSync(join(tmpdir(), "bundle-extract-limits-"));
		const envelope = (value: unknown) => {
			const compressed = gzipSync(Buffer.from(JSON.stringify(value)));
			return `${PLATFORM_ARTIFACT_BUNDLE_START}\n${JSON.stringify({
				encoding: "gzip-base64",
				size: compressed.length,
				sha256: createHash("sha256").update(compressed).digest("hex"),
				contentBase64: compressed.toString("base64"),
			})}\n${PLATFORM_ARTIFACT_BUNDLE_END}\n`;
		};
		try {
			expect(extractPlatformArtifactBundle(out, envelope({ files: [], padding: "x".repeat(MAX_INFLATED_BUNDLE_JSON_BYTES) })).ok).toBe(false);
			expect(extractPlatformArtifactBundle(out, envelope({
				files: Array.from({ length: MAX_BUNDLE_FILE_COUNT + 1 }, (_, index) => ({
					path: `count/${index}.txt`, contentBase64: "", size: 0,
				})),
			})).ok).toBe(false);
			expect(extractPlatformArtifactBundle(out, envelope({
				files: Array.from({ length: Math.floor(MAX_BUNDLE_AGGREGATE_BYTES / MAX_BUNDLE_FILE_BYTES) + 1 }, (_, index) => ({
					path: `aggregate/${index}.bin`, contentBase64: "", size: MAX_BUNDLE_FILE_BYTES,
				})),
			})).ok).toBe(false);
			expect(extractPlatformArtifactBundle(out, envelope({ files: [
				{ path: "partial/first.txt", contentBase64: Buffer.from("first").toString("base64"), size: 5 },
				{ path: "partial/second.txt", contentBase64: "not-base64", size: 3 },
			] })).ok).toBe(false);
			expect(existsSync(join(out, "partial", "first.txt"))).toBe(false);
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("accepts only the exact root bundle path and rejects static and racing final symlinks", async () => {
		const root = mkdtempSync(join(tmpdir(), "bundle-nofollow-test-"));
		const outside = mkdtempSync(join(tmpdir(), "bundle-nofollow-outside-"));
		const chunkScript = resolve("scripts/platform-smoke/artifact-bundle-chunk.mjs");
		const bundlePath = join(root, ".platform-artifact-bundle.gz");
		const sentinelPath = join(outside, "sentinel.gz");
		const sentinel = "outside-sentinel-must-not-transport";
		let toggler: ReturnType<typeof spawn> | undefined;
		try {
			writeFileSync(sentinelPath, sentinel);
			symlinkSync(outside, join(root, "parent"), "dir");
			const nestedResult = run(process.execPath, [
				chunkScript, "--path", "parent/.platform-artifact-bundle.gz", "--offset", "0", "--length", "32",
			], process.env, root);
			expect(nestedResult.status).toBe(2);

			symlinkSync(sentinelPath, bundlePath);
			const staticResult = run(process.execPath, [
				chunkScript, "--path", ".platform-artifact-bundle.gz", "--offset", "0", "--length", "32",
			], process.env, root);
			expect(staticResult.status).toBe(2);
			expect(staticResult.stdout).toBe("");
			expect(staticResult.stdout + staticResult.stderr).not.toContain(sentinel);

			rmSync(bundlePath);
			writeFileSync(bundlePath, "safe-bundle");
			const runningToggler = spawn(process.execPath, ["--input-type=module", "-e", String.raw`
import { renameSync, symlinkSync } from "node:fs";
const [path, sentinel] = process.argv.slice(1);
const safe = path + ".safe";
const link = path + ".link";
symlinkSync(sentinel, link);
const wait = new Int32Array(new SharedArrayBuffer(4));
const end = Date.now() + 5000;
let ready = false;
while (Date.now() < end) {
  renameSync(path, safe);
  renameSync(link, path);
  if (!ready) { process.stdout.write("ready\n"); ready = true; }
  Atomics.wait(wait, 0, 0, 4);
  renameSync(path, link);
  renameSync(safe, path);
  Atomics.wait(wait, 0, 0, 1);
}
`, bundlePath, sentinelPath], { stdio: ["ignore", "pipe", "pipe"] });
			toggler = runningToggler;
			await new Promise<void>((resolveReady, reject) => {
				const timer = setTimeout(() => reject(new Error("symlink toggler did not start")), 2_000);
				runningToggler.stdout!.once("data", () => { clearTimeout(timer); resolveReady(); });
				runningToggler.once("error", reject);
			});
			let successfulReads = 0;
			for (let index = 0; index < 30; index++) {
				const result = run(process.execPath, [
					chunkScript, "--path", ".platform-artifact-bundle.gz", "--offset", "0", "--length", "32",
				], process.env, root);
				expect([0, 2]).toContain(result.status);
				expect(result.stdout + result.stderr).not.toContain(Buffer.from(sentinel).toString("base64"));
				if (result.status === 0) {
					successfulReads += 1;
					const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("=") + 1));
					expect(Buffer.from(payload.contentBase64, "base64").toString()).toBe("safe-bundle");
				}
			}
			expect(successfulReads).toBeGreaterThan(0);
		} finally {
			if (toggler?.exitCode === null) {
				toggler.kill();
				await new Promise((resolveExit) => toggler!.once("exit", resolveExit));
			}
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("spills, chunks, validates, and extracts large platform bundles without changing scenario exit", async () => {
		const artifactsModule = "../scripts/platform-smoke/artifacts.mjs";
		const runtimeModule = "../scripts/platform-smoke/target-runtime.mjs";
		const {
			extractPlatformArtifactBundle,
			PLATFORM_ARTIFACT_BUNDLE_END,
			PLATFORM_ARTIFACT_BUNDLE_FILE_MARKER,
			PLATFORM_ARTIFACT_BUNDLE_START,
			writePlatformArtifactBundle,
		} = await import(artifactsModule);
		const { fetchPlatformArtifactBundle } = await import(runtimeModule);
		const root = mkdtempSync(join(tmpdir(), "bundle-spill-test-"));
		const out = mkdtempSync(join(tmpdir(), "bundle-spill-out-"));
		const outside = mkdtempSync(join(tmpdir(), "bundle-spill-writer-outside-"));
		const chunkRoot = mkdtempSync(join(tmpdir(), "bundle-spill-chunk-"));
		const outsideSentinel = join(outside, "sentinel.gz");
		try {
			writeFileSync(outsideSentinel, "outside-writer-sentinel");
			if (process.platform !== "win32") symlinkSync(outsideSentinel, ".platform-artifact-bundle.gz");
			const artifacts = join(root, "artifacts");
			mkdirSync(artifacts, { recursive: true });
			const terminal = randomBytes(150_000).toString("hex");
			writeFileSync(join(artifacts, "terminal.ansi"), terminal);
			let marker = "";
			let preservedExitCode;
			const originalExitCode = process.exitCode;
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
				marker += chunk.toString();
				return true;
			}) as typeof process.stdout.write);
			try {
				process.exitCode = 7;
				writePlatformArtifactBundle(root);
				preservedExitCode = process.exitCode;
			} finally {
				process.exitCode = originalExitCode;
				stdout.mockRestore();
			}
			expect(preservedExitCode).toBe(7);
			expect(marker).toContain(PLATFORM_ARTIFACT_BUNDLE_FILE_MARKER);
			const metadata = JSON.parse(marker.slice(marker.indexOf(PLATFORM_ARTIFACT_BUNDLE_FILE_MARKER) + PLATFORM_ARTIFACT_BUNDLE_FILE_MARKER.length));
			expect(metadata.path).toBe(".platform-artifact-bundle.gz");
			expect(readFileSync(outsideSentinel, "utf8")).toBe("outside-writer-sentinel");
			const compressed = readFileSync(resolve(metadata.path));
			const offsets: number[] = [];
			const chunkRun = (mutate?: (chunk: { offset: number; total: number; bytes: number; contentBase64: string }) => void) =>
				async (_target: string, _lease: string, command: string[]) => {
					const option = (name: string) => command[command.indexOf(name) + 1]!;
					const offset = Number(option("--offset"));
					const length = Number(option("--length"));
					offsets.push(offset);
					const content = compressed.subarray(offset, offset + length);
					const chunk = { offset, total: compressed.length, bytes: content.length, contentBase64: content.toString("base64") };
					mutate?.(chunk);
					return { code: 0, signal: null, stderr: "", stdout: `PLATFORM_BUNDLE_CHUNK_JSON=${JSON.stringify(chunk)}\n` };
				};
			const fetched = await fetchPlatformArtifactBundle("macos", "lease", marker, {}, chunkRun());
			expect(fetched.ok).toBe(true);
			expect(offsets).toEqual(Array.from({ length: Math.ceil(compressed.length / (32 * 1024)) }, (_, index) => index * 32 * 1024));
			expect(extractPlatformArtifactBundle(out, fetched.stdout).ok).toBe(process.platform !== "win32");
			if (process.platform !== "win32") expect(readFileSync(join(out, "artifacts", "terminal.ansi"), "utf8")).toBe(terminal);

			writeFileSync(join(chunkRoot, metadata.path), compressed);
			const chunkCli = run(process.execPath, [
				resolve("scripts/platform-smoke/artifact-bundle-chunk.mjs"),
				"--path", metadata.path,
				"--offset", "0",
				"--length", String(Math.min(32 * 1024, compressed.length)),
			], process.env, chunkRoot);
			expect(chunkCli.status, chunkCli.stderr).toBe(0);
			expect(chunkCli.stderr).toBe("");
			expect(chunkCli.stdout).toContain("PLATFORM_BUNDLE_CHUNK_JSON=");

			const envelopeLines = fetched.stdout.trim().split(/\r?\n/);
			const envelope = JSON.parse(envelopeLines[1]!);
			envelope.contentBase64 += "!!!";
			expect(extractPlatformArtifactBundle(out, `${envelopeLines[0]}\n${JSON.stringify(envelope)}\n${envelopeLines[2]}\n`).ok).toBe(false);
			const badInnerBundle = {
				root: "bad",
				files: [{ path: "artifacts/bad.txt", contentBase64: Buffer.from("x").toString("base64"), size: 2 }],
			};
			const badInnerCompressed = gzipSync(Buffer.from(JSON.stringify(badInnerBundle)));
			const badInnerSize = `${PLATFORM_ARTIFACT_BUNDLE_START}\n${JSON.stringify({
				encoding: "gzip-base64",
				size: badInnerCompressed.length,
				sha256: createHash("sha256").update(badInnerCompressed).digest("hex"),
				contentBase64: badInnerCompressed.toString("base64"),
			})}\n${PLATFORM_ARTIFACT_BUNDLE_END}\n`;
			expect(extractPlatformArtifactBundle(out, badInnerSize).ok).toBe(false);

			for (const mutate of [
				(chunk: { offset: number }) => { chunk.offset += 1; },
				(chunk: { total: number }) => { chunk.total += 1; },
				(chunk: { bytes: number }) => { chunk.bytes -= 1; },
				(chunk: { contentBase64: string }) => { chunk.contentBase64 += "!!!"; },
			]) {
				expect((await fetchPlatformArtifactBundle("macos", "lease", marker, {}, chunkRun(mutate))).ok).toBe(false);
			}
			expect((await fetchPlatformArtifactBundle("macos", "lease", marker, {}, chunkRun((chunk) => {
				const content = Buffer.from(chunk.contentBase64, "base64");
				content[0] ^= 1;
				chunk.contentBase64 = content.toString("base64");
			}))).ok).toBe(false);
			const oversized = marker.replace(`"size":${metadata.size}`, `"size":${20 * 1024 * 1024 + 1}`);
			const nested = marker.replace(".platform-artifact-bundle.gz", "parent/.platform-artifact-bundle.gz");
			let invalidMetadataRuns = 0;
			for (const invalidMarker of [oversized, nested]) {
				expect((await fetchPlatformArtifactBundle("macos", "lease", invalidMarker, {}, async () => {
					invalidMetadataRuns += 1;
					throw new Error("must not run");
				})).ok).toBe(false);
			}
			expect(invalidMetadataRuns).toBe(0);
		} finally {
			rmSync(".platform-artifact-bundle.gz", { force: true });
			rmSync(root, { recursive: true, force: true });
			rmSync(out, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
			rmSync(chunkRoot, { recursive: true, force: true });
		}
	});

	it("redacts platform smoke artifacts before writing and scopes Cursor auth to allowed Crabbox runs", () => {
		const code = String.raw`
process.env.CURSOR_API_KEY = "cursor-secret-token-12345";
process.env.PLATFORM_SMOKE_CRABBOX = process.execPath;
const { redactSecrets, scanForSecrets } = await import("./scripts/platform-smoke/artifacts.mjs");
const { execCrabbox, buildTargetBaseArgs } = await import("./scripts/platform-smoke/crabbox-runner.mjs");
const smokeConfig = (await import("./platform-smoke.config.mjs")).default;
const raw = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz cursor-secret-token-12345 https://repo-user:repo-p@ss@example.com/org/repo.git repo-user:repo-p@ss@example.com:org/repo.git";
const redacted = redactSecrets(raw);
const stripped = await execCrabbox(["-e", "process.stdout.write(process.env.CURSOR_API_KEY || 'missing')"]);
const allowed = await execCrabbox(["-e", "process.stdout.write(process.env.CURSOR_API_KEY || 'missing')"], { allowEnv: ["CURSOR_API_KEY"] });
delete process.env.PLATFORM_SMOKE_UBUNTU_IMAGE;
delete process.env.PLATFORM_SMOKE_WINDOWS_VM;
delete process.env.PLATFORM_SMOKE_WINDOWS_SNAPSHOT;
delete process.env.PLATFORM_SMOKE_WINDOWS_NATIVE_WORK_ROOT;
const ubuntuArgs = buildTargetBaseArgs("ubuntu", { ubuntuContainerImage: "example/node:24" });
const windowsArgs = buildTargetBaseArgs("windows-native", smokeConfig);
const result = {
  rawViolations: scanForSecrets(raw),
  redactedViolations: scanForSecrets(redacted),
  redacted,
  stripped: stripped.stdout,
  allowed: allowed.stdout,
  ubuntuImage: ubuntuArgs[ubuntuArgs.indexOf("--local-container-image") + 1],
  crabboxMinVersion: smokeConfig.requiredCrabbox.minVersion,
  windowsVm: windowsArgs[windowsArgs.indexOf("--parallels-source") + 1],
  windowsSnapshot: windowsArgs[windowsArgs.indexOf("--parallels-source-snapshot") + 1],
  windowsWorkRoot: windowsArgs[windowsArgs.indexOf("--parallels-work-root") + 1],
};
console.log(JSON.stringify(result));
if (!result.rawViolations.includes("CURSOR_API_KEY literal found") || !result.rawViolations.includes("potential credential-bearing URL") || !result.rawViolations.includes("potential credential-bearing SCP URL")) process.exit(1);
if (result.redacted.includes("cursor-secret-token-12345") || result.redacted.includes("repo-user") || result.redacted.includes("repo-p") || result.redacted.includes("@ss@") || result.redactedViolations.length !== 0) process.exit(1);
if (result.stripped !== "missing" || result.allowed !== "cursor-secret-token-12345") process.exit(1);
if (result.ubuntuImage !== "example/node:24") process.exit(1);
if (result.crabboxMinVersion !== "0.26.0") process.exit(1);
if (result.windowsVm !== "pi-extension-windows-template" || result.windowsSnapshot !== "crabbox-ready" || result.windowsWorkRoot !== "C:\\crabbox\\pi-cursor-sdk") process.exit(1);
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"stripped":"missing"');
		expect(result.stdout).toContain('"ubuntuImage":"example/node:24"');
		expect(result.stdout).toContain('"crabboxMinVersion":"0.26.0"');
		expect(result.stdout).toContain('"windowsVm":"pi-extension-windows-template"');
	});

});
