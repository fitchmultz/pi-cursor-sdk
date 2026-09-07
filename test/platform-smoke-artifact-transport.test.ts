import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
	const promptOptions = { charsPerToken: 4, maxInputTokens: 239616, imageTokenEstimate: 1200 };
	const benign = { providerMeta: { promptOptions }, enabled: true, disabled: false, empty: "", absent: null, nested: [0, false, null, "", [3, { count: 2 }]] };
	const prompt = 'Before: CURSOR_API_KEY="your-key" after: keep this documentation.';
	const redactedPrompt = 'Before: CURSOR_API_KEY="[redacted]" after: keep this documentation.';
	const parseJsonl = (text: string) => text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));

	it.skipIf(process.platform === "win32").each(["", "local-resume-evidence"])("preserves numeric debug metadata through extraction (%s)", async (prefix) => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-json-metric-"));
		try {
			const source = join(root, "source");
			const path = "cursor-sdk-events/sessions/test/turn-001/metadata.json";
			mkdirSync(dirname(join(source, path)), { recursive: true });
			for (const indent of [undefined, 2]) {
				const raw = JSON.stringify(benign, null, indent);
				writeFileSync(join(source, path), raw);
				const bundle = buildPlatformArtifactBundle(source, prefix);
				expect(bundle.files.map((file: { path: string }) => file.path)).toEqual([prefix ? `${prefix}/${path}` : path]);
				let input = formatPlatformArtifactBundle(bundle);
				for (const pass of [1, 2]) {
					const out = join(root, `out-${indent}-${pass}`);
					mkdirSync(out);
					expect(extractPlatformArtifactBundle(out, input)).toEqual({ ok: true, violations: [] });
					const exported = readFileSync(join(out, prefix, path), "utf8");
					expect(JSON.parse(exported)).toEqual(benign);
					input = formatPlatformArtifactBundle(buildPlatformArtifactBundle(join(out, prefix), prefix));
				}
				expect(readFileSync(join(source, path), "utf8")).toBe(raw);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32").each([
		"context-snapshot.json", "send-payload.json", "provider-events.jsonl", "timeline.jsonl",
	])("preserves escaped documentation prompts through extraction (%s)", async (filename) => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-json-prompt-"));
		try {
			const source = join(root, "source");
			const path = `debug/sessions/test/turn-001/${filename}`;
			mkdirSync(dirname(join(source, path)), { recursive: true });
			const jsonl = filename.endsWith(".jsonl");
			const records = [{ text: prompt, enabled: true }, { text: "Unrelated record", absent: null }];
			const raw = jsonl ? records.map((record) => JSON.stringify(record)).join("\r\n\r\n") + "\r\n" : JSON.stringify(records, null, 2);
			writeFileSync(join(source, path), raw);
			let input = formatPlatformArtifactBundle(buildPlatformArtifactBundle(source, "local-resume-evidence"));
			let previous: string | undefined;
			for (const pass of [1, 2]) {
				const out = join(root, `out-${pass}`);
				mkdirSync(out);
				expect(extractPlatformArtifactBundle(out, input)).toEqual({ ok: true, violations: [] });
				const exported = readFileSync(join(out, "local-resume-evidence", path), "utf8");
				expect(jsonl ? parseJsonl(exported) : JSON.parse(exported)).toEqual([{ ...records[0], text: redactedPrompt }, records[1]]);
				expect(exported).not.toContain("your-key");
				if (previous !== undefined) expect(exported).toBe(previous);
				previous = exported;
				input = formatPlatformArtifactBundle(buildPlatformArtifactBundle(join(out, "local-resume-evidence"), "local-resume-evidence"));
			}
			expect(readFileSync(join(source, path), "utf8")).toBe(raw);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["numeric", "escaped prompt"])("preserves %s records in the actual session copy before bundling", async (kind) => {
		const runnerModule = "../scripts/platform-smoke/live-suite-runner.mjs";
		const { writeJsonlArtifacts } = await import(runnerModule);
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-json-session-"));
		try {
			const sessions = join(root, "native-sessions");
			const artifacts = join(root, "copy", "artifacts");
			mkdirSync(sessions);
			mkdirSync(artifacts, { recursive: true });
			const record = kind === "numeric" ? benign : { text: prompt };
			const expected = kind === "numeric" ? benign : { text: redactedPrompt };
			const raw = `${JSON.stringify(record)}\n\n${JSON.stringify({ sequence: 2, apiKey: "short" })}\n`;
			const source = join(sessions, "native.jsonl");
			writeFileSync(source, raw);
			expect(writeJsonlArtifacts(artifacts, sessions)).toEqual([source]);
			expect(readFileSync(source, "utf8")).toBe(raw);
			const copied = readFileSync(join(artifacts, "session.jsonl"), "utf8");
			expect(parseJsonl(copied)).toEqual([expected, { sequence: 2, apiKey: "[redacted]" }]);
			expect(copied).not.toContain("short");
			const out = join(root, "export");
			mkdirSync(out);
			const result = extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(buildPlatformArtifactBundle(join(root, "copy"))));
			expect(result.ok).toBe(process.platform !== "win32");
			if (result.ok) expect(readFileSync(join(out, "artifacts", "session.jsonl"), "utf8")).toBe(copied);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["extraction", "session copy"])("scrubs secret property names and preserves their values through %s", async (writer) => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle, redactSecrets, scanForSecrets } = await import(artifactsModule);
		const runnerModule = "../scripts/platform-smoke/live-suite-runner.mjs";
		const { writeJsonlArtifacts } = await import(runnerModule);
		const root = mkdtempSync(join(tmpdir(), "platform-json-keys-"));
		const route = "/cursor-pi-tool-bridge/synthetic-route/mcp";
		const bearer = "Bearer s3";
		const record = { ...benign, routes: { [route]: "seen", [bearer]: "seen", nested: [{ [route]: benign, apiKey: "s3" }] } };
		const expected = { ...benign, routes: { [redactSecrets(route)]: "seen", [redactSecrets(bearer)]: "seen", nested: [{ [redactSecrets(route)]: benign, apiKey: "[redacted]" }] } };
		try {
			const source = join(root, "source");
			const out = join(root, "out");
			mkdirSync(source);
			mkdirSync(out);
			const filename = writer === "extraction" ? "capture.json" : "native.jsonl";
			const raw = `${JSON.stringify(record)}\n`;
			expect(scanForSecrets(raw)).toEqual([]);
			writeFileSync(join(source, filename), raw);
			let exported: string;
			if (writer === "session copy") {
				expect(writeJsonlArtifacts(out, source)).toEqual([join(source, filename)]);
				exported = readFileSync(join(out, "session.jsonl"), "utf8");
			} else {
				const result = extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(buildPlatformArtifactBundle(source, "evidence")));
				expect(result.ok).toBe(process.platform !== "win32");
				if (!result.ok) return;
				exported = readFileSync(join(out, "evidence", filename), "utf8");
			}
			expect(JSON.parse(exported)).toEqual(expected);
			for (const secret of ["synthetic-route", "s3"]) expect(exported).not.toContain(secret);
			expect(scanForSecrets(exported)).toEqual([]);
			const second = join(root, "second");
			mkdirSync(second);
			const secondSource = writer === "extraction" ? join(out, "evidence") : out;
			const result = extractPlatformArtifactBundle(second, formatPlatformArtifactBundle(buildPlatformArtifactBundle(secondSource, "evidence")));
			expect(result.ok).toBe(process.platform !== "win32");
			if (result.ok) expect(readFileSync(join(second, "evidence", writer === "extraction" ? filename : "session.jsonl"), "utf8")).toBe(exported);
			expect(readFileSync(join(source, filename), "utf8")).toBe(raw);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["extraction", "session copy"])("keeps bounded nested JSON compact through %s", async (writer) => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle } = await import(artifactsModule);
		const runnerModule = "../scripts/platform-smoke/live-suite-runner.mjs";
		const { writeJsonlArtifacts } = await import(runnerModule);
		const root = mkdtempSync(join(tmpdir(), "platform-json-depth-"));
		let nested: unknown = Array(64).fill(0);
		for (let depth = 0; depth < 20; depth++) nested = [nested];
		const raw = `${JSON.stringify(nested)}\n`;
		expect(Buffer.byteLength(raw)).toBe(170);
		try {
			const source = join(root, "source");
			const out = join(root, "out");
			mkdirSync(source);
			mkdirSync(out);
			const filename = writer === "extraction" ? "capture.json" : "native.jsonl";
			writeFileSync(join(source, filename), raw);
			if (writer === "session copy") {
				writeJsonlArtifacts(out, source);
				expect(readFileSync(join(out, "session.jsonl"), "utf8")).toBe(raw);
			} else {
				const result = extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(buildPlatformArtifactBundle(source, "evidence")));
				expect(result.ok).toBe(process.platform !== "win32");
				if (result.ok) expect(readFileSync(join(out, "evidence", filename), "utf8")).toBe(raw);
			}
			expect(readFileSync(join(source, filename), "utf8")).toBe(raw);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["extraction", "session copy"])("rejects colliding redacted property names before %s writes", async (writer) => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle } = await import(artifactsModule);
		const runnerModule = "../scripts/platform-smoke/live-suite-runner.mjs";
		const { writeJsonlArtifacts } = await import(runnerModule);
		const root = mkdtempSync(join(tmpdir(), "platform-json-key-collision-"));
		try {
			const source = join(root, "source");
			const out = join(root, "out");
			mkdirSync(source);
			mkdirSync(out);
			const raw = JSON.stringify({ nested: [{ "/cursor-pi-tool-bridge/route-one/mcp": 1, "/cursor-pi-tool-bridge/route-two/mcp": 2 }] }) + "\n";
			const filename = writer === "extraction" ? "later.json" : "native.jsonl";
			writeFileSync(join(source, filename), raw);
			writeFileSync(join(out, "session.jsonl"), "prior evidence");
			if (writer === "session copy") {
				expect(() => writeJsonlArtifacts(out, source)).toThrowError(new Error("invalid structured artifact"));
			} else {
				writeFileSync(join(source, "first.json"), "{}");
				const bundle = buildPlatformArtifactBundle(source, "evidence");
				bundle.files.sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path));
				expect(extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(bundle))).toEqual({ ok: false, violations: [] });
			}
			expect(readdirSync(out)).toEqual(["session.jsonl"]);
			expect(readFileSync(join(out, "session.jsonl"), "utf8")).toBe("prior evidence");
			expect(readFileSync(join(source, filename), "utf8")).toBe(raw);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["file", "aggregate"])("rejects post-redaction %s byte overflow before the extraction writer", async (limit) => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle, MAX_BUNDLE_FILE_BYTES, MAX_BUNDLE_AGGREGATE_BYTES } = await import(artifactsModule);
		const fsModule = "../scripts/platform-smoke/artifact-fs-safety.mjs";
		const writer = vi.spyOn(await import(fsModule), "writeExtractedFiles");
		const root = mkdtempSync(join(tmpdir(), "platform-json-output-limit-"));
		try {
			const source = join(root, "source");
			const out = join(root, "out");
			mkdirSync(source);
			mkdirSync(out);
			writeFileSync(join(source, "first.json"), "{}");
			const initial = formatPlatformArtifactBundle(buildPlatformArtifactBundle(source, "evidence"));
			expect(extractPlatformArtifactBundle(out, initial).ok).toBe(process.platform !== "win32");
			expect(writer).toHaveBeenCalledOnce();
			writer.mockClear();
			rmSync(out, { recursive: true });
			mkdirSync(out);
			writeFileSync(join(out, "sentinel.txt"), "untouched");
			const count = limit === "file" ? 1 : Math.floor(MAX_BUNDLE_AGGREGATE_BYTES / MAX_BUNDLE_FILE_BYTES) + 1;
			const size = Math.floor((limit === "file" ? MAX_BUNDLE_FILE_BYTES : MAX_BUNDLE_AGGREGATE_BYTES) / count) - 4;
			const empty = JSON.stringify({ apiKey: "s3", padding: "" });
			const raw = JSON.stringify({ apiKey: "s3", padding: "x".repeat(size - empty.length) });
			for (let index = 0; index < count; index++) writeFileSync(join(source, `later-${index}.json`), raw);
			const bundle = buildPlatformArtifactBundle(source, "evidence");
			expect(bundle.files).toHaveLength(count + 1);
			bundle.files.sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path));
			expect(extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(bundle))).toEqual({ ok: false, violations: [] });
			expect(writer).not.toHaveBeenCalled();
			expect(readdirSync(out)).toEqual(["sentinel.txt"]);
			expect(readFileSync(join(out, "sentinel.txt"), "utf8")).toBe("untouched");
		} finally {
			writer.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	it("rejects post-redaction session byte overflow without replacing prior evidence", async () => {
		const { MAX_BUNDLE_FILE_BYTES } = await import(artifactsModule);
		const runnerModule = "../scripts/platform-smoke/live-suite-runner.mjs";
		const { writeJsonlArtifacts } = await import(runnerModule);
		const root = mkdtempSync(join(tmpdir(), "platform-session-output-limit-"));
		try {
			const source = join(root, "source");
			const out = join(root, "out");
			mkdirSync(source);
			mkdirSync(out);
			const empty = JSON.stringify({ apiKey: "s3", padding: "" }) + "\n";
			const raw = JSON.stringify({ apiKey: "s3", padding: "x".repeat(MAX_BUNDLE_FILE_BYTES - 4 - empty.length) }) + "\n";
			writeFileSync(join(source, "native.jsonl"), raw);
			writeFileSync(join(out, "session.jsonl"), "prior evidence");
			expect(() => writeJsonlArtifacts(out, source)).toThrowError(new Error("invalid structured artifact"));
			expect(readdirSync(out)).toEqual(["session.jsonl"]);
			expect(readFileSync(join(out, "session.jsonl"), "utf8")).toBe("prior evidence");
			expect(readFileSync(join(source, "native.jsonl"), "utf8")).toBe(raw);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		"authorization", "apiKey", "api_key", "accessToken", "refresh_token", "CURSOR_API_KEY",
		"myApiKey", "sdkToken", "serviceSessionId", "cookie", "session",
	])("uses shared field recognition for short and escaped %s strings without changing typed data", async (key) => {
		const { redactArtifactText } = await import(artifactsModule);
		const sharedModule = "../shared/cursor-sensitive-text.mjs";
		const { scrubSensitiveText } = await import(sharedModule);
		expect(scrubSensitiveText(`${key}=s3`)).not.toContain("s3");
		for (const secret of ["s3", 'short"\\secret']) {
			const data = { ...benign, credentials: [{ [key]: secret }, { [key]: "" }], text: prompt };
			for (const indent of [undefined, 2]) {
				const result = redactArtifactText("capture.JsOn", JSON.stringify(data, null, indent));
				expect(JSON.parse(result)).toEqual({ ...benign, credentials: [{ [key]: "[redacted]" }, { [key]: "" }], text: redactedPrompt });
				expect(result).not.toContain(JSON.stringify(secret).slice(1, -1));
				expect(redactArtifactText("capture.JsOn", result)).toBe(result);
			}
		}
	});

	it("keeps the full text scrubber for decoded strings and non-JSON paths", async () => {
		const { redactArtifactText, redactSecrets, scanForSecrets } = await import(artifactsModule);
		const strings = [
			{ text: "before Bearer short-token after", hidden: ["short-token"] },
			{ text: "cookie: first=one-secret; second=two-secret\nkeep this line", hidden: ["one-secret", "two-secret"] },
			{ text: "connect.sid=abc123def456", hidden: ["abc123def456"] },
			{ text: "clone https://repo-user:repo-p@ss@example.com/repo.git or repo-user:repo-p@ss@example.com:org/repo.git", hidden: ["repo-user", "repo-p@ss"] },
			{ text: "http://127.0.0.1:54321/cursor-pi-tool-bridge/bridge-full/mcp", hidden: ["127.0.0.1", "bridge-full"] },
			{ text: "https://127.0.0.1/cursor-pi-tool-bridge/bridge-https/mcp", hidden: ["127.0.0.1", "bridge-https"] },
			{ text: "127.0.0.1:8080/cursor-pi-tool-bridge/bridge-host/mcp", hidden: ["127.0.0.1", "bridge-host"] },
			{ text: "/cursor-pi-tool-bridge/bridge-path/mcp", hidden: ["bridge-path"] },
			{ text: "https://example.com/cursor-pi-tool-bridge/bridge-remote/mcp", hidden: ["bridge-remote"] },
			{ text: String.raw`before apiKey="AAAAAAAAAAAA\"BBBBBBBBBBBB" after`, hidden: ["AAAAAAAAAAAA", "BBBBBBBBBBBB"] },
			{ text: String.raw`before apiKey='AAAAAAAAAAAA\'BBBBBBBBBBBB' after`, hidden: ["AAAAAAAAAAAA", "BBBBBBBBBBBB"] },
			{ text: "before api_key=`abcdefghijkl1234` after", hidden: ["abcdefghijkl1234"] },
		];
		for (const { text, hidden } of strings) {
			const result = redactArtifactText("capture.json", JSON.stringify({ text }));
			expect(JSON.parse(result)).toEqual({ text: redactSecrets(text) });
			for (const secret of hidden) expect(result).not.toContain(secret);
			expect(scanForSecrets(result)).toEqual([]);
			expect(redactArtifactText("capture.json", result)).toBe(result);
			for (const path of ["capture.log", "capture.json.txt", "capture.JSON/terminal.ansi", "no-extension"]) {
				expect(redactArtifactText(path, text)).toBe(redactSecrets(text));
			}
		}
		for (const newline of ["\n", "\r\n"]) {
			const records = [benign, ...strings.map(({ text }) => ({ text }))];
			const raw = ["", ...records.map((record) => JSON.stringify(record)), "  ", ""].join(newline);
			const result = redactArtifactText("capture.JsOnL", raw);
			expect(parseJsonl(result)).toEqual([benign, ...strings.map(({ text }) => ({ text: redactSecrets(text) }))]);
			expect(result.split("\n")).toHaveLength(records.length + 3);
			expect(redactArtifactText("capture.JsOnL", result)).toBe(result);
		}
	});

	it("redacts a synthetic explicit key from ordinary JSON strings", async () => {
		const { redactArtifactText } = await import(artifactsModule);
		const key = "cursor-synthetic-explicit-key-123456";
		vi.stubEnv("CURSOR_API_KEY", key);
		try {
			const result = redactArtifactText("capture.json", JSON.stringify({ text: `before ${key} after`, [key]: "seen" }));
			expect(JSON.parse(result)).toEqual({ text: "before [redacted] after", "[redacted]": "seen" });
			expect(result).not.toContain(key);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it.each(["json", "jsonl"])("rejects malformed %s without leaking content or partially extracting", async (extension) => {
		const { buildPlatformArtifactBundle, extractPlatformArtifactBundle, formatPlatformArtifactBundle, redactArtifactText } = await import(artifactsModule);
		const root = mkdtempSync(join(tmpdir(), "platform-json-invalid-"));
		const malformed = `${extension === "jsonl" ? '{}\n\n' : ""}{"private":"do-not-leak"`;
		try {
			const source = join(root, "source");
			const out = join(root, "out");
			mkdirSync(source);
			mkdirSync(out);
			writeFileSync(join(out, "sentinel.txt"), "untouched");
			writeFileSync(join(source, "first.json"), "{}");
			writeFileSync(join(source, `later.${extension}`), malformed);
			expect(() => redactArtifactText(`later.${extension}`, malformed)).toThrowError(new Error("invalid structured artifact"));
			const bundle = buildPlatformArtifactBundle(source, "evidence");
			bundle.files.sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path));
			expect(bundle.files.map((file: { path: string }) => file.path)).toEqual(["evidence/first.json", `evidence/later.${extension}`]);
			const result = extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(bundle));
			expect(result).toEqual({ ok: false, violations: [] });
			expect(JSON.stringify(result)).not.toContain("do-not-leak");
			expect(readdirSync(out)).toEqual(["sentinel.txt"]);
			expect(readFileSync(join(out, "sentinel.txt"), "utf8")).toBe("untouched");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects an invalid native session record before writing any session-copy artifacts", async () => {
		const runnerModule = "../scripts/platform-smoke/live-suite-runner.mjs";
		const { writeJsonlArtifacts } = await import(runnerModule);
		const root = mkdtempSync(join(tmpdir(), "platform-session-invalid-"));
		try {
			const sessions = join(root, "sessions");
			const artifacts = join(root, "artifacts");
			mkdirSync(sessions);
			mkdirSync(artifacts);
			const raw = '{}\n{"private":"do-not-leak"\n';
			writeFileSync(join(sessions, "native.jsonl"), raw);
			for (const existing of [false, true]) {
				if (existing) writeFileSync(join(artifacts, "session.jsonl"), "prior evidence");
				expect(() => writeJsonlArtifacts(artifacts, sessions)).toThrowError(new Error("invalid structured artifact"));
				expect(readdirSync(artifacts)).toEqual(existing ? ["session.jsonl"] : []);
				if (existing) expect(readFileSync(join(artifacts, "session.jsonl"), "utf8")).toBe("prior evidence");
				expect(readFileSync(join(sessions, "native.jsonl"), "utf8")).toBe(raw);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
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
