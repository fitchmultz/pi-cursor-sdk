import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

const artifactsModule = "../scripts/platform-smoke/artifacts.mjs";
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function bundle(path: string) {
	const content = Buffer.from("safe");
	return { files: [{ path, contentBase64: content.toString("base64"), size: content.length }] };
}

function envelope(value: unknown) {
	const compressed = gzipSync(Buffer.from(JSON.stringify(value)));
	return `PLATFORM_LIVE_BUNDLE_JSON_START\n${JSON.stringify({
		encoding: "gzip-base64",
		size: compressed.length,
		sha256: createHash("sha256").update(compressed).digest("hex"),
		contentBase64: compressed.toString("base64"),
	})}\nPLATFORM_LIVE_BUNDLE_JSON_END\n`;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("platform artifact bundle boundaries", () => {
	it("rejects a raw marker payload without writing files", async () => {
		const { extractPlatformArtifactBundle, PLATFORM_ARTIFACT_BUNDLE_END, PLATFORM_ARTIFACT_BUNDLE_START } = await import(artifactsModule);
		const out = tempDir("platform-raw-bundle-");
		const stdout = `${PLATFORM_ARTIFACT_BUNDLE_START}\n${JSON.stringify(bundle("artifacts/raw.txt"))}\n${PLATFORM_ARTIFACT_BUNDLE_END}\n`;

		expect(extractPlatformArtifactBundle(out, stdout).ok).toBe(false);
		expect(readdirSync(out)).toEqual([]);
	});

	it("round-trips an empty canonical bundle without filesystem mutation", async () => {
		const { extractPlatformArtifactBundle, formatPlatformArtifactBundle } = await import(artifactsModule);
		const out = tempDir("platform-empty-bundle-");

		expect(extractPlatformArtifactBundle(out, formatPlatformArtifactBundle({ files: [] })).ok).toBe(true);
		expect(readdirSync(out)).toEqual([]);
	});

	it.skipIf(process.platform !== "win32")("fails closed before mutating nonempty bundles on Windows controllers", async () => {
		const { extractPlatformArtifactBundle, formatPlatformArtifactBundle } = await import(artifactsModule);
		const out = tempDir("platform-windows-extraction-disabled-");

		expect(extractPlatformArtifactBundle(out, formatPlatformArtifactBundle(bundle("artifacts/evidence.txt"))).ok).toBe(false);
		expect(readdirSync(out)).toEqual([]);
	});

	it.each([
		"", ".", "..", "/absolute.txt", "C:/drive.txt", "C:\\drive.txt", "dir\\file.txt",
		"dir//file.txt", "dir/./file.txt", "dir/../file.txt", "dir/", `${"a/".repeat(2048)}file.txt`,
	])("rejects noncanonical writer and extractor path %j before writes", async (path) => {
		const {
			extractPlatformArtifactBundle,
			formatPlatformArtifactBundle,
			PLATFORM_ARTIFACT_BUNDLE_END,
			PLATFORM_ARTIFACT_BUNDLE_START,
		} = await import(artifactsModule);
		const invalidBundle = bundle(path);
		expect(() => formatPlatformArtifactBundle(invalidBundle)).toThrow();

		const compressed = gzipSync(Buffer.from(JSON.stringify(invalidBundle)));
		const envelope = {
			encoding: "gzip-base64",
			size: compressed.length,
			sha256: createHash("sha256").update(compressed).digest("hex"),
			contentBase64: compressed.toString("base64"),
		};
		const out = tempDir("platform-path-bundle-");
		const stdout = `${PLATFORM_ARTIFACT_BUNDLE_START}\n${JSON.stringify(envelope)}\n${PLATFORM_ARTIFACT_BUNDLE_END}\n`;
		expect(extractPlatformArtifactBundle(out, stdout).ok).toBe(false);
		expect(readdirSync(out)).toEqual([]);
	});

	it("rejects aggregate path-component work before extraction", async () => {
		const { extractPlatformArtifactBundle, formatPlatformArtifactBundle } = await import(artifactsModule);
		const files = Array.from({ length: 512 }, (_, index) => ({
			path: `root-${index}/a/b/c/d/e/f/g/file.txt`,
			contentBase64: "",
			size: 0,
		}));
		const out = tempDir("platform-path-work-");

		expect(() => formatPlatformArtifactBundle({ files })).toThrow();
		expect(readdirSync(out)).toEqual([]);
		expect(extractPlatformArtifactBundle(out, envelope({ files })).ok).toBe(false);
		expect(readdirSync(out)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("fails closed on file and directory symlinks without following them", async () => {
		const { buildPlatformArtifactBundle, scanArtifacts } = await import(artifactsModule);
		const root = tempDir("platform-symlink-root-");
		const outside = tempDir("platform-symlink-target-");
		writeFileSync(join(outside, "secret.txt"), "outside target");
		symlinkSync(join(outside, "secret.txt"), join(root, "file-link.txt"));
		symlinkSync(join(outside, "secret.txt"), join(root, ".platform-artifact-bundle.gz"));
		symlinkSync(outside, join(root, "directory-link"), "dir");

		const findings = scanArtifacts(root);
		expect(findings).toHaveLength(3);
		expect(findings).toEqual(expect.arrayContaining([
			{ file: ".platform-artifact-bundle.gz", violation: "artifact scan non-regular-entry" },
			{ file: "directory-link", violation: "artifact scan non-regular-entry" },
			{ file: "file-link.txt", violation: "artifact scan non-regular-entry" },
		]));
		const result = buildPlatformArtifactBundle(root, "evidence");
		const evidence = JSON.parse(Buffer.from(result.files[0].contentBase64, "base64").toString("utf8"));
		expect(result.files[0].path).toBe("evidence/bundle-limit-exceeded.json");
		expect(evidence.reasons).toEqual(["non-regular-entry"]);
	});

	it.skipIf(process.platform === "win32")("rejects intermediate root links and never reports or bundles bytes from a racing nested ancestor", async () => {
		const { buildPlatformArtifactBundle, scanArtifacts } = await import(artifactsModule);
		const root = tempDir("platform-traversal-race-");
		const outside = tempDir("platform-traversal-race-outside-");
		const linkedBase = tempDir("platform-traversal-linked-base-");
		const actualParent = tempDir("platform-traversal-actual-parent-");
		mkdirSync(join(actualParent, "root"));
		symlinkSync(actualParent, join(linkedBase, "parent"), "dir");
		const linkedRoot = join(linkedBase, "parent", "root");
		expect(scanArtifacts(linkedRoot)).toEqual([{ file: ".", violation: "artifact scan directory-read" }]);
		const linkedBundle = buildPlatformArtifactBundle(linkedRoot, "evidence");
		expect(JSON.parse(Buffer.from(linkedBundle.files[0].contentBase64, "base64").toString()).reasons).toContain("directory-read");

		const child = join(root, "nested");
		mkdirSync(join(child, "deep"), { recursive: true });
		mkdirSync(join(outside, "deep"));
		writeFileSync(join(child, "deep", "safe.txt"), "safe-evidence");
		writeFileSync(join(outside, "deep", "sentinel.txt"), "Authorization: Bearer outside-secret-123456789");
		const toggler = spawn(process.execPath, ["--input-type=module", "-e", String.raw`
import { renameSync, symlinkSync } from "node:fs";
const [path, outside] = process.argv.slice(1);
const safe = path + ".safe";
const link = path + ".link";
symlinkSync(outside, link, "dir");
const wait = new Int32Array(new SharedArrayBuffer(4));
process.stdout.write("ready\n");
while (true) {
  renameSync(path, safe); renameSync(link, path); Atomics.wait(wait, 0, 0, 2);
  renameSync(path, link); renameSync(safe, path); Atomics.wait(wait, 0, 0, 1);
}
`, child, outside], { stdio: ["ignore", "pipe", "ignore"] });
		try {
			await new Promise<void>((resolveReady, reject) => {
				const timer = setTimeout(() => reject(new Error("traversal race toggler did not start")), 2_000);
				toggler.stdout.once("data", () => { clearTimeout(timer); resolveReady(); });
				toggler.once("error", reject);
			});
			for (let attempt = 0; attempt < 80; attempt++) {
				const findings = scanArtifacts(root);
				expect(JSON.stringify(findings)).not.toMatch(/outside-secret|sentinel\.txt|bearer token/);
				const result = buildPlatformArtifactBundle(root, "evidence");
				const decoded = result.files.map((file: { contentBase64: string }) => Buffer.from(file.contentBase64, "base64").toString()).join("\n");
				expect(decoded).not.toMatch(/outside-secret|sentinel\.txt|bearer token/);
				if (result.files[0]?.path === "evidence/nested/deep/safe.txt") expect(decoded).toBe("safe-evidence");
				else expect(result.files.map((file: { path: string }) => file.path)).toEqual(["evidence/bundle-limit-exceeded.json"]);
			}
		} finally {
			if (toggler.exitCode === null) {
				toggler.kill();
				await new Promise((resolveExit) => toggler.once("exit", resolveExit));
			}
		}
	});

	it("rejects duplicate and file-prefix paths before filesystem mutation", async () => {
		const { extractPlatformArtifactBundle } = await import(artifactsModule);
		const out = tempDir("platform-conflicting-paths-");
		const entry = (path: string, content = "safe") => ({
			path, contentBase64: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content),
		});

		expect(extractPlatformArtifactBundle(out, envelope({ files: [entry("duplicate.txt"), entry("duplicate.txt")] })).ok).toBe(false);
		expect(extractPlatformArtifactBundle(out, envelope({ files: [
			entry("prefix.txt"), entry("prefix.txt-child.txt"), entry("prefix.txt/child.txt"),
		] })).ok).toBe(false);
		expect(readdirSync(out)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("rejects symlinked output, parent, and final destinations without changing outside files", async () => {
		const { extractPlatformArtifactBundle, formatPlatformArtifactBundle } = await import(artifactsModule);
		const root = tempDir("platform-destination-links-");
		const outside = tempDir("platform-destination-outside-");
		const sentinel = join(outside, "sentinel.txt");
		writeFileSync(sentinel, "outside-sentinel");

		const linkedOutput = join(root, "linked-output");
		symlinkSync(outside, linkedOutput, "dir");
		expect(extractPlatformArtifactBundle(linkedOutput, formatPlatformArtifactBundle(bundle("new.txt"))).ok).toBe(false);

		symlinkSync(outside, join(root, "linked-parent"), "dir");
		expect(extractPlatformArtifactBundle(root, formatPlatformArtifactBundle(bundle("linked-parent/sentinel.txt"))).ok).toBe(false);

		symlinkSync(sentinel, join(root, "linked-final.txt"));
		expect(extractPlatformArtifactBundle(root, formatPlatformArtifactBundle(bundle("linked-final.txt"))).ok).toBe(false);

		writeFileSync(join(root, "existing.txt"), "existing");
		const first = Buffer.from("first");
		const existing = Buffer.from("replacement");
		expect(extractPlatformArtifactBundle(root, formatPlatformArtifactBundle({ files: [
			{ path: "new-parent/first.txt", contentBase64: first.toString("base64"), size: first.length },
			{ path: "existing.txt", contentBase64: existing.toString("base64"), size: existing.length },
		] })).ok).toBe(false);
		expect(readdirSync(root)).not.toContain("new-parent");
		expect(readFileSync(join(root, "existing.txt"), "utf8")).toBe("existing");
		expect(readFileSync(sentinel, "utf8")).toBe("outside-sentinel");
		expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
	});

	it.skipIf(process.platform === "win32")("fails closed while a destination parent races with an outside symlink", async () => {
		const { extractPlatformArtifactBundle, formatPlatformArtifactBundle } = await import(artifactsModule);
		const out = tempDir("platform-destination-race-");
		const outside = tempDir("platform-destination-race-outside-");
		const parent = join(out, "parent");
		mkdirSync(parent);
		const sentinelPaths = Array.from({ length: 24 }, (_, index) => `parent/file-${index}.txt`);
		for (const path of sentinelPaths) writeFileSync(join(outside, path.slice("parent/".length)), "outside-sentinel");
		const paths = ["parent/outside-new.txt", ...sentinelPaths];
		const files = paths.map((path) => ({ path, contentBase64: Buffer.from("bundle-content").toString("base64"), size: 14 }));
		const stdout = formatPlatformArtifactBundle({ files });
		const toggler = spawn(process.execPath, ["--input-type=module", "-e", String.raw`
import { renameSync, symlinkSync } from "node:fs";
const [path, outside] = process.argv.slice(1);
const safe = path + ".safe";
const link = path + ".link";
symlinkSync(outside, link, "dir");
const wait = new Int32Array(new SharedArrayBuffer(4));
process.stdout.write("ready\n");
while (true) {
  renameSync(path, safe); renameSync(link, path); Atomics.wait(wait, 0, 0, 1);
  renameSync(path, link); renameSync(safe, path); Atomics.wait(wait, 0, 0, 1);
}
`, parent, outside], { stdio: ["ignore", "pipe", "ignore"] });
		try {
			await new Promise<void>((resolveReady, reject) => {
				const timer = setTimeout(() => reject(new Error("destination race toggler did not start")), 2_000);
				toggler.stdout.once("data", () => { clearTimeout(timer); resolveReady(); });
				toggler.once("error", reject);
			});
			for (let attempt = 0; attempt < 30; attempt++) {
				expect(toggler.exitCode).toBeNull();
				expect([true, false]).toContain(extractPlatformArtifactBundle(out, stdout).ok);
			}
			expect(toggler.exitCode).toBeNull();
		} finally {
			if (toggler.exitCode === null) {
				toggler.kill();
				await new Promise((resolveExit) => toggler.once("exit", resolveExit));
			}
		}
		for (const path of sentinelPaths) expect(readFileSync(join(outside, path.slice("parent/".length)), "utf8")).toBe("outside-sentinel");
		expect(readdirSync(outside).sort()).toEqual(sentinelPaths.map((path) => path.slice("parent/".length)).sort());
	});

	it.skipIf(process.platform === "win32")("rolls back through a parent descriptor after the opened directory moves outside", () => {
		const out = tempDir("platform-moved-parent-");
		const outside = tempDir("platform-moved-parent-outside-");
		const parent = join(out, "parent");
		const escaped = join(outside, "escaped");
		mkdirSync(parent);
		const parentIdentity = lstatSync(parent);
		const executable = join(tempDir("platform-moved-parent-helper-"), "extract");
		const compiled = spawnSync("cc", [
			"-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", executable,
			"test/fixtures/artifact-moved-parent.c",
		], { encoding: "utf8", timeout: 30_000 });
		expect(compiled.status, compiled.stderr).toBe(0);

		const path = Buffer.from("parent/payload.txt");
		const content = Buffer.from("safe");
		const header = Buffer.alloc(20);
		header.write("PIART01\0");
		header.writeUInt32LE(1, 8);
		header.writeUInt32LE(path.length, 12);
		header.writeUInt32LE(content.length, 16);
		const root = lstatSync(out);
		// The fixture moves the parent after the real write, before the real verification/rollback.
		const result = spawnSync(executable, [out, String(root.dev), String(root.ino), parent, escaped], {
			input: Buffer.concat([header, path, content]), encoding: "utf8", timeout: 5_000,
		});

		expect(result.status, result.stderr).toBe(2);
		expect(result.stdout).toBe("moved-after-write\n");
		expect(lstatSync(escaped)).toMatchObject({ dev: parentIdentity.dev, ino: parentIdentity.ino });
		expect(readdirSync(out)).toEqual([]);
		expect(readdirSync(escaped)).toEqual([]);
	}, 20_000);

	it.skipIf(process.platform === "win32")("pins the output root while its host path races with an outside symlink", async () => {
		const { extractPlatformArtifactBundle, formatPlatformArtifactBundle } = await import(artifactsModule);
		const container = tempDir("platform-output-root-race-");
		const out = join(container, "output");
		const outside = tempDir("platform-output-root-race-outside-");
		mkdirSync(out);
		writeFileSync(join(outside, "sentinel.txt"), "outside-sentinel");
		const files = Array.from({ length: 128 }, (_, index) => {
			const content = Buffer.from(`bundle-${index}`);
			return { path: `file-${index}.txt`, contentBase64: content.toString("base64"), size: content.length };
		});
		const stdout = formatPlatformArtifactBundle({ files });
		const toggler = spawn(process.execPath, ["--input-type=module", "-e", String.raw`
import { renameSync, symlinkSync } from "node:fs";
const [path, outside] = process.argv.slice(1);
const safe = path + ".safe";
const link = path + ".link";
symlinkSync(outside, link, "dir");
const wait = new Int32Array(new SharedArrayBuffer(4));
process.stdout.write("ready\n");
while (true) {
  renameSync(path, safe); renameSync(link, path); Atomics.wait(wait, 0, 0, 1);
  renameSync(path, link); renameSync(safe, path); Atomics.wait(wait, 0, 0, 1);
}
`, out, outside], { stdio: ["ignore", "pipe", "ignore"] });
		try {
			await new Promise<void>((resolveReady, reject) => {
				const timer = setTimeout(() => reject(new Error("output-root race toggler did not start")), 2_000);
				toggler.stdout.once("data", () => { clearTimeout(timer); resolveReady(); });
				toggler.once("error", reject);
			});
			for (let attempt = 0; attempt < 20; attempt++) {
				expect(toggler.exitCode).toBeNull();
				expect([true, false]).toContain(extractPlatformArtifactBundle(out, stdout).ok);
			}
			expect(toggler.exitCode).toBeNull();
		} finally {
			if (toggler.exitCode === null) {
				toggler.kill();
				await new Promise((resolveExit) => toggler.once("exit", resolveExit));
			}
		}
		expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
		expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("outside-sentinel");
	});

	it.skipIf(process.platform === "win32")("extracts a large frame without a stdin pipe deadlock", async () => {
		const out = tempDir("platform-native-large-frame-");
		const moduleUrl = new URL("../scripts/platform-smoke/artifact-anchored-extract.mjs", import.meta.url).href;
		const code = String.raw`
import { lstatSync } from "node:fs";
const { writeExtractedFilesAnchored } = await import(${JSON.stringify(moduleUrl)});
const out = process.argv[1];
const content = Buffer.alloc(4 * 1024 * 1024, 97);
const files = Array.from({ length: 4 }, (_, index) => ({ path: "large-" + index + ".txt", content }));
console.log(JSON.stringify({ ok: writeExtractedFilesAnchored(out, files, lstatSync(out)) }));
`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", code, out], {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		const status = await new Promise<number | null>((resolveStatus, reject) => {
			const timer = setTimeout(() => {
				try { process.kill(-child.pid!, "SIGKILL"); } catch {}
				reject(new Error("large-frame extractor timed out"));
			}, 20_000);
			child.once("error", (error) => { clearTimeout(timer); reject(error); });
			child.once("close", (code) => { clearTimeout(timer); resolveStatus(code); });
		});

		expect(status, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ ok: true });
		for (let index = 0; index < 4; index++) {
			expect(statSync(join(out, `large-${index}.txt`)).size).toBe(4 * 1024 * 1024);
		}
	}, 25_000);

	it.skipIf(process.platform === "win32")("has the native helper validate the complete frame before mutation", async () => {
		const { writeExtractedFilesAnchored } = await import("../scripts/platform-smoke/artifact-anchored-extract.mjs");
		const out = tempDir("platform-native-frame-");
		const root = lstatSync(out);
		const files = [
			{ path: "safe.txt", content: Buffer.from("safe") },
			{ path: "../escape.txt", content: Buffer.from("escape") },
		];

		expect(writeExtractedFilesAnchored(out, files, root)).toBe(false);
		expect(readdirSync(out)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("rolls back the just-created entry when descriptor retention hits the process limit", () => {
		const out = tempDir("platform-native-low-fd-");
		const moduleUrl = new URL("../scripts/platform-smoke/artifact-anchored-extract.mjs", import.meta.url).href;
		const code = String.raw`
import { lstatSync, readdirSync } from "node:fs";
const { writeExtractedFilesAnchored } = await import(${JSON.stringify(moduleUrl)});
const out = process.argv[1];
const files = Array.from({ length: 100 }, (_, index) => ({ path: "f-" + index + ".txt", content: Buffer.from("safe") }));
const ok = writeExtractedFilesAnchored(out, files, lstatSync(out));
console.log(JSON.stringify({ ok, files: readdirSync(out) }));
`;
		const result = spawnSync("/bin/sh", ["-c", "ulimit -n 64; exec \"$@\"", "sh", process.execPath, "--input-type=module", "-e", code, out], {
			encoding: "utf8",
			timeout: 30_000,
		});

		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ ok: false, files: [] });
	});

	it("prunes non-artifact infrastructure", async () => {
		const { buildPlatformArtifactBundle, scanArtifacts } = await import(artifactsModule);
		const root = tempDir("platform-infrastructure-");
		mkdirSync(join(root, "node_modules", "dependency"), { recursive: true });
		mkdirSync(join(root, ".git", "objects"), { recursive: true });
		writeFileSync(join(root, "node_modules", "dependency", "leak.txt"), "Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
		writeFileSync(join(root, ".git", "objects", "leak.txt"), "Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
		writeFileSync(join(root, "evidence.txt"), "safe");

		expect(scanArtifacts(root)).toEqual([]);
		const result = buildPlatformArtifactBundle(root, "evidence");
		expect(result.files.map((file: { path: string }) => file.path)).toEqual(["evidence/evidence.txt"]);
	});

	it("turns an invalid production path prefix into safe bounded evidence", async () => {
		const { extractPlatformArtifactBundle, writePlatformArtifactBundle } = await import(artifactsModule);
		const root = tempDir("platform-writer-prefix-");
		const out = tempDir("platform-writer-prefix-out-");
		writeFileSync(join(root, "evidence.txt"), "safe");
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			stdout += chunk.toString();
			return true;
		}) as typeof process.stdout.write);

		const result = writePlatformArtifactBundle(root, "../escape");

		expect(result.files).toHaveLength(1);
		expect(result.files[0].path).toBe("artifacts/bundle-limit-exceeded.json");
		expect(extractPlatformArtifactBundle(out, stdout).ok).toBe(process.platform !== "win32");
		if (process.platform !== "win32") {
			expect(JSON.parse(readFileSync(join(out, result.files[0].path), "utf8")).reasons).toEqual(["invalid-path-prefix"]);
		} else {
			expect(readdirSync(out)).toEqual([]);
		}
	});
});
