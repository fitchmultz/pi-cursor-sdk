/**
 * Artifact management — directory layout, manifest, redaction scanning, packaging.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	MAX_BUNDLE_AGGREGATE_BYTES, MAX_BUNDLE_FILE_BYTES, MAX_BUNDLE_FILE_COUNT,
	MAX_BUNDLE_PATH_BYTES, MAX_BUNDLE_PATH_COMPONENTS,
	MAX_COMPRESSED_BUNDLE_BYTES, MAX_INFLATED_BUNDLE_JSON_BYTES,
	PLATFORM_ARTIFACT_BUNDLE_END, PLATFORM_ARTIFACT_BUNDLE_FILE_MARKER,
	PLATFORM_ARTIFACT_BUNDLE_PATH, PLATFORM_ARTIFACT_BUNDLE_START,
	decodeCanonicalBase64, isCanonicalPlatformBundlePath,
} from "./artifact-bundle-contract.mjs";
import {
	boundedFileSnapshot, openRegularFileNoFollow, walkArtifactTree,
	writeBundleSpillFile, writeExtractedFiles,
} from "./artifact-fs-safety.mjs";
import { isBinaryArtifactContent, redactArtifactText, redactSecrets, scanForSecrets } from "./artifact-secrets.mjs";

export {
	MAX_BUNDLE_AGGREGATE_BYTES, MAX_BUNDLE_FILE_BYTES, MAX_BUNDLE_FILE_COUNT,
	MAX_BUNDLE_PATH_BYTES, MAX_BUNDLE_PATH_COMPONENTS,
	MAX_COMPRESSED_BUNDLE_BYTES, MAX_INFLATED_BUNDLE_JSON_BYTES,
	PLATFORM_ARTIFACT_BUNDLE_END, PLATFORM_ARTIFACT_BUNDLE_FILE_MARKER,
	PLATFORM_ARTIFACT_BUNDLE_PATH, PLATFORM_ARTIFACT_BUNDLE_START,
	isCanonicalPlatformBundlePath,
};
export { openRegularFileNoFollow };
export { isBinaryArtifactContent, redactArtifactText, redactSecrets, scanForSecrets };

const PLATFORM_SMOKE_RUN_DIR_PATTERN = /^run-(\d+)-[a-z0-9]+$/i;
const HOURS_TO_MS = 60 * 60 * 1000;
const DAYS_TO_MS = 24 * HOURS_TO_MS;
const LATEST_INDEX_NAME = "latest.json";
const INLINE_BUNDLE_MAX_BYTES = 48 * 1024;
const PLATFORM_ARTIFACT_TEXT_EXTENSIONS = new Set([
	"ansi", "html", "js", "json", "jsonl", "log", "md", "mjs", "ts", "txt", "yaml", "yml",
]);

function isTransportableTextPath(path) {
	const extension = path.toLowerCase().match(/\.([^.\/]+)$/)?.[1];
	return extension !== undefined && PLATFORM_ARTIFACT_TEXT_EXTENSIONS.has(extension);
}

function finiteNonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finiteNonNegativeInteger(value) {
	return Number.isInteger(value) && value >= 0;
}

/** Prune old top-level platform-smoke run artifact directories. */
export function prunePlatformSmokeArtifacts(artifactRoot, retention = {}, options = {}) {
	const root = resolve(process.cwd(), artifactRoot);
	const maxRunDirs = finiteNonNegativeInteger(retention.maxRunDirs) ? retention.maxRunDirs : undefined;
	const maxAgeDays = finiteNonNegativeNumber(retention.maxAgeDays) ? retention.maxAgeDays : undefined;
	const preserveRecentHours = finiteNonNegativeNumber(retention.preserveRecentHours) ? retention.preserveRecentHours : 24;
	const enabled = retention.enabled !== false && (maxRunDirs !== undefined || maxAgeDays !== undefined);
	const result = { root, enabled, removed: [], kept: [], ignored: [] };
	if (!enabled || !existsSync(root)) return result;

	const nowMs = finiteNonNegativeNumber(options.nowMs) ? options.nowMs : Date.now();
	const preserveRecentMs = preserveRecentHours * HOURS_TO_MS;
	const maxAgeMs = maxAgeDays === undefined ? undefined : maxAgeDays * DAYS_TO_MS;
	const runDirs = [];

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			result.ignored.push(entry.name);
			continue;
		}
		const match = PLATFORM_SMOKE_RUN_DIR_PATTERN.exec(entry.name);
		if (!match) {
			result.ignored.push(entry.name);
			continue;
		}
		runDirs.push({ name: entry.name, path: resolve(root, entry.name), timestampMs: Number(match[1]) });
	}

	const recentCutoffMs = nowMs - preserveRecentMs;
	const protectedRecent = new Set(runDirs.filter((dir) => dir.timestampMs > recentCutoffMs).map((dir) => dir.name));
	const removeNames = new Set();

	if (maxAgeMs !== undefined) {
		const staleCutoffMs = nowMs - maxAgeMs;
		for (const dir of runDirs) {
			if (dir.timestampMs < staleCutoffMs) removeNames.add(dir.name);
		}
	}

	if (maxRunDirs !== undefined && runDirs.length > maxRunDirs) {
		const sortedNewestFirst = [...runDirs].sort((a, b) => b.timestampMs - a.timestampMs);
		let remainingKeepSlots = maxRunDirs - protectedRecent.size;
		for (const dir of sortedNewestFirst) {
			if (protectedRecent.has(dir.name)) continue;
			if (remainingKeepSlots > 0) {
				remainingKeepSlots--;
				continue;
			}
			removeNames.add(dir.name);
		}
	}

	for (const dir of runDirs) {
		if (!removeNames.has(dir.name)) {
			result.kept.push(dir.name);
			continue;
		}
		rmSync(dir.path, { recursive: true, force: true });
		result.removed.push(dir.name);
	}
	result.kept.sort();
	result.removed.sort();
	result.ignored.sort();
	return result;
}

/** Create a suite artifact directory. */
export function createSuiteDir(artifactRoot, runId, targetName, suiteName) {
	const dir = resolve(process.cwd(), artifactRoot, runId, targetName, suiteName);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Write artifact-manifest.json. */
export function writeManifest(dir, expectedFiles) {
	const actual = [];
	function walk(d) {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const fp = resolve(d, entry.name);
			if (entry.isDirectory()) walk(fp);
			else if (entry.isFile()) actual.push(relative(dir, fp));
		}
	}
	if (existsSync(dir)) walk(dir);

	const manifest = {
		expected: expectedFiles ?? [],
		present: actual,
		missing: (expectedFiles ?? []).filter(f => !actual.includes(f)),
		writtenAt: new Date().toISOString(),
	};
	writeFileSync(resolve(dir, "artifact-manifest.json"), JSON.stringify(manifest, null, 2));
	return manifest;
}

function artifactRelativePath(root, path) {
	return relative(root, path).replace(/\\/g, "/");
}

function safeArtifactPath(path) {
	return redactSecrets(path || ".");
}

function isSensitiveTransportPath(root, path) {
	return artifactRelativePath(root, path).split("/").some((name) =>
		/^\.env/i.test(name) || /^auth\.json$/i.test(name) || /^(?:id_rsa|id_ed25519|.*\.pem|.*\.key)$/i.test(name));
}

/** Binary-safe scan of every bounded artifact file except non-artifact infrastructure. */
export function scanArtifacts(dir) {
	const findings = [];
	const failures = [];
	function relativeDetails(root, path) {
		const relativePath = artifactRelativePath(root, path) || ".";
		const file = safeArtifactPath(relativePath);
		for (const violation of scanForSecrets(relativePath)) findings.push({ file, violation });
		return { relativePath, file };
	}
	walkArtifactTree(dir, {
		directoryRead: (path, _parents, root) => failures.push({ file: relativeDetails(root, path).file, violation: "artifact scan directory-read" }),
		fileRead: (path, _parents, root) => failures.push({ file: relativeDetails(root, path).file, violation: "artifact scan file-read" }),
		nonRegular: (path, _parents, root) => failures.push({ file: relativeDetails(root, path).file, violation: "artifact scan non-regular-entry" }),
		file: (path, parents, root) => {
			const { file } = relativeDetails(root, path);
			const snapshot = boundedFileSnapshot(path, MAX_BUNDLE_FILE_BYTES, parents);
			if (!snapshot.ok) {
				failures.push({ file, violation: `artifact scan ${snapshot.reason}` });
				return;
			}
			for (const violation of scanForSecrets(snapshot.content)) findings.push({ file, violation });
		},
	});
	return failures.length > 0 ? failures : findings;
}

/** Write summary.json for a suite. */
export function writeSummary(dir, data) {
	writeFileSync(resolve(dir, "summary.json"), JSON.stringify({
		...data,
		writtenAt: new Date().toISOString(),
	}, null, 2));
}

function readJsonFile(path) {
	const snapshot = boundedFileSnapshot(path);
	if (!snapshot.ok) return undefined;
	try {
		return JSON.parse(snapshot.content.toString("utf8"));
	} catch {
		return undefined;
	}
}

function shouldTransportBundleFile(root, path, pathPrefix) {
	if (isSensitiveTransportPath(root, path) || !isTransportableTextPath(path)) return false;
	if (pathPrefix) return true;
	const rel = relative(root, path).replace(/\\/g, "/");
	return /^(?:artifacts\/(?:terminal\.(?:ansi|txt)|session\.jsonl|live-status\.json|pi-command\.json|bridge-diagnostics\.jsonl|abort-started\.txt)|logs\/(?:process-|leftover-process-check)[^/]*|cursor-sdk-events\/.*\/(?:session|metadata)\.json)$/i.test(rel);
}

function singleFilePlatformArtifactBundle(pathPrefix, name, value) {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	return {
		files: [{
			path: [pathPrefix || "artifacts", name].join("/"),
			contentBase64: Buffer.from(content).toString("base64"),
			size: Buffer.byteLength(content),
		}],
	};
}

function bundleLimitArtifact(pathPrefix, reasons) {
	return singleFilePlatformArtifactBundle(pathPrefix, "bundle-limit-exceeded.json", {
		status: "failed",
		reasons: [...new Set(reasons)],
		limits: {
			maxFileBytes: MAX_BUNDLE_FILE_BYTES,
			maxFileCount: MAX_BUNDLE_FILE_COUNT,
			maxAggregateBytes: MAX_BUNDLE_AGGREGATE_BYTES,
			maxPathBytes: MAX_BUNDLE_PATH_BYTES,
			maxPathComponents: MAX_BUNDLE_PATH_COMPONENTS,
			maxInflatedJsonBytes: MAX_INFLATED_BUNDLE_JSON_BYTES,
			maxCompressedBytes: MAX_COMPRESSED_BUNDLE_BYTES,
		},
	});
}

export function buildPlatformArtifactBundle(root, pathPrefix = "") {
	const prefixViolations = scanForSecrets(pathPrefix);
	if (prefixViolations.length > 0) {
		return singleFilePlatformArtifactBundle("artifacts", "bundle-redaction-violations.json",
			prefixViolations.map((violation) => ({ file: "[artifact-path-prefix]", violation })));
	}
	const files = [];
	const findings = [];
	const limitReasons = [];
	let aggregateBytes = 0;
	walkArtifactTree(root, {
		directoryRead: () => limitReasons.push("directory-read"),
		fileRead: () => limitReasons.push("file-read"),
		nonRegular: () => limitReasons.push("non-regular-entry"),
		file: (path, parents, canonicalRoot) => {
			const rel = artifactRelativePath(canonicalRoot, path);
			const file = safeArtifactPath(rel);
			const pathViolations = scanForSecrets(rel);
			for (const violation of pathViolations) findings.push({ file, violation });
			const snapshot = boundedFileSnapshot(path, MAX_BUNDLE_FILE_BYTES, parents);
			if (!snapshot.ok) {
				limitReasons.push(snapshot.reason);
				return;
			}
			const { content } = snapshot;
			for (const violation of scanForSecrets(content)) findings.push({ file, violation });
			if (pathViolations.length > 0 || !shouldTransportBundleFile(canonicalRoot, path, pathPrefix)) return;
			if (isBinaryArtifactContent(content)) {
				limitReasons.push("binary-content");
			} else if (files.length >= MAX_BUNDLE_FILE_COUNT) {
				limitReasons.push("file-count");
			} else if (aggregateBytes + content.length > MAX_BUNDLE_AGGREGATE_BYTES) {
				limitReasons.push("aggregate-bytes");
			} else {
				files.push({ path: [pathPrefix, rel].filter(Boolean).join("/"), contentBase64: content.toString("base64"), size: content.length });
				aggregateBytes += content.length;
			}
		},
	});
	if (limitReasons.length > 0) return bundleLimitArtifact(pathPrefix, limitReasons);
	if (findings.length > 0) {
		return singleFilePlatformArtifactBundle(pathPrefix, "bundle-redaction-violations.json", findings);
	}
	return { files };
}

function validatePlatformArtifactBundle(bundle) {
	if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) ||
		Object.keys(bundle).length !== 1 || !Object.hasOwn(bundle, "files") ||
		!Array.isArray(bundle.files) || bundle.files.length > MAX_BUNDLE_FILE_COUNT) return undefined;
	const files = [];
	const paths = new Set();
	let aggregateBytes = 0;
	let pathComponents = 0;
	for (const file of bundle.files) {
		if (!file || typeof file !== "object" || Array.isArray(file) ||
			Object.keys(file).length !== 3 || !Object.hasOwn(file, "path") ||
			!Object.hasOwn(file, "contentBase64") || !Object.hasOwn(file, "size") ||
			!isCanonicalPlatformBundlePath(file.path) || scanForSecrets(file.path).length > 0 ||
			!isTransportableTextPath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BUNDLE_FILE_BYTES) return undefined;
		const comparisonPath = process.platform === "win32" ? file.path.toLowerCase() : file.path;
		if (paths.has(comparisonPath)) return undefined;
		paths.add(comparisonPath);
		pathComponents += file.path.split("/").length;
		if (pathComponents > MAX_BUNDLE_PATH_COMPONENTS) return undefined;
		aggregateBytes += file.size;
		if (aggregateBytes > MAX_BUNDLE_AGGREGATE_BYTES) return undefined;
		const content = decodeCanonicalBase64(file.contentBase64, file.size);
		if (!content || content.length !== file.size || isBinaryArtifactContent(content) || scanForSecrets(content).length > 0) return undefined;
		files.push({ path: file.path, content });
	}
	for (const path of paths) {
		const segments = path.split("/");
		for (let index = 1; index < segments.length; index++) {
			if (paths.has(segments.slice(0, index).join("/"))) return undefined;
		}
	}
	return files;
}

function compressPlatformArtifactBundle(bundle) {
	if (!validatePlatformArtifactBundle(bundle)) throw new Error("platform artifact bundle exceeds decoded limits");
	const serialized = Buffer.from(JSON.stringify(bundle));
	if (serialized.length > MAX_INFLATED_BUNDLE_JSON_BYTES) throw new Error("platform artifact bundle exceeds inflated JSON limit");
	const compressed = gzipSync(serialized, { level: 9 });
	if (compressed.length > MAX_COMPRESSED_BUNDLE_BYTES) throw new Error("platform artifact bundle exceeds compressed limit");
	return compressed;
}

function platformArtifactBundleEnvelope(compressed) {
	return {
		encoding: "gzip-base64",
		size: compressed.length,
		sha256: createHash("sha256").update(compressed).digest("hex"),
		contentBase64: compressed.toString("base64"),
	};
}

function formatCompressedPlatformArtifactBundle(compressed) {
	return `${PLATFORM_ARTIFACT_BUNDLE_START}\n${JSON.stringify(platformArtifactBundleEnvelope(compressed))}\n${PLATFORM_ARTIFACT_BUNDLE_END}\n`;
}

export function formatPlatformArtifactBundle(bundle) {
	return formatCompressedPlatformArtifactBundle(compressPlatformArtifactBundle(bundle));
}

export function writePlatformArtifactBundle(root, pathPrefix = "") {
	rmSync(PLATFORM_ARTIFACT_BUNDLE_PATH, { force: true });
	const validPrefix = pathPrefix === "" || (isCanonicalPlatformBundlePath(pathPrefix) && scanForSecrets(pathPrefix).length === 0);
	let bundle = validPrefix ? buildPlatformArtifactBundle(root, pathPrefix) : undefined;
	let compressed;
	if (!bundle || !validatePlatformArtifactBundle(bundle)) {
		bundle = bundleLimitArtifact("artifacts", [validPrefix ? "invalid-bundle" : "invalid-path-prefix"]);
		compressed = compressPlatformArtifactBundle(bundle);
	} else {
		try {
			compressed = compressPlatformArtifactBundle(bundle);
		} catch (error) {
			bundle = bundleLimitArtifact(pathPrefix, [error instanceof Error ? error.message : "bundle-encoding"]);
			compressed = compressPlatformArtifactBundle(bundle);
		}
	}
	const inline = formatCompressedPlatformArtifactBundle(compressed);
	if (Buffer.byteLength(inline) <= INLINE_BUNDLE_MAX_BYTES) {
		process.stdout.write(inline);
		return bundle;
	}
	writeBundleSpillFile(PLATFORM_ARTIFACT_BUNDLE_PATH, compressed);
	process.stdout.write(`${PLATFORM_ARTIFACT_BUNDLE_FILE_MARKER}${JSON.stringify({
		path: PLATFORM_ARTIFACT_BUNDLE_PATH,
		...platformArtifactBundleEnvelope(compressed),
		encoding: "gzip",
		contentBase64: undefined,
	})}\n`);
	return bundle;
}

export function isSafePlatformBundlePath(outputDir, bundlePath) {
	if (!isCanonicalPlatformBundlePath(bundlePath)) return false;
	const outPath = resolve(outputDir, bundlePath);
	const rel = relative(outputDir, outPath).replace(/\\/g, "/");
	return rel === bundlePath && !isAbsolute(rel);
}

export function extractPlatformArtifactBundle(outputDir, stdout) {
	const failed = { ok: false, violations: [] };
	const start = stdout.indexOf(PLATFORM_ARTIFACT_BUNDLE_START);
	const end = stdout.indexOf(PLATFORM_ARTIFACT_BUNDLE_END, start);
	if (start === -1 || end === -1) return failed;
	let bundle;
	const payload = stdout.slice(start + PLATFORM_ARTIFACT_BUNDLE_START.length, end).trim();
	if (Buffer.byteLength(payload) > MAX_INFLATED_BUNDLE_JSON_BYTES) return failed;
	try {
		const parsed = JSON.parse(payload);
		if (parsed?.encoding !== "gzip-base64" || typeof parsed.contentBase64 !== "string" ||
			!Number.isSafeInteger(parsed.size) || parsed.size < 1 || parsed.size > MAX_COMPRESSED_BUNDLE_BYTES ||
			typeof parsed.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsed.sha256)) return failed;
		const compressed = decodeCanonicalBase64(parsed.contentBase64, parsed.size);
		if (!compressed || compressed.length !== parsed.size || createHash("sha256").update(compressed).digest("hex") !== parsed.sha256) return failed;
		bundle = JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_INFLATED_BUNDLE_JSON_BYTES }).toString("utf8"));
	} catch { return failed; }
	const decodedFiles = validatePlatformArtifactBundle(bundle);
	if (!decodedFiles || decodedFiles.some((file) => !isSafePlatformBundlePath(outputDir, file.path))) return failed;

	const files = [];
	const violations = [];
	let aggregateBytes = 0;
	for (const file of decodedFiles) {
		const text = file.content.toString("utf8");
		violations.push(...scanForSecrets(file.content).map((violation) => ({ file: file.path, violation })));
		if (file.path.endsWith("redaction-violations.json")) {
			try {
				const parsed = JSON.parse(text);
				if (Array.isArray(parsed)) violations.push(...parsed.filter((item) => typeof item?.violation === "string").map((item) => ({
					file: typeof item.file === "string" ? item.file : file.path, violation: item.violation,
				})));
			} catch {}
		}
		try {
			const content = Buffer.from(redactArtifactText(file.path, text));
			aggregateBytes += content.length;
			if (content.length > MAX_BUNDLE_FILE_BYTES || aggregateBytes > MAX_BUNDLE_AGGREGATE_BYTES) return failed;
			files.push({ path: file.path, content });
		} catch { return failed; }
	}

	const succeeded = writeExtractedFiles(outputDir, files);
	return succeeded ? { ok: true, violations } : failed;
}

function collectFiles(root) {
	const files = [];
	function walk(dir) {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = resolve(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) files.push(path);
		}
	}
	if (existsSync(root)) walk(root);
	files.sort();
	return files;
}

function existingPath(path) {
	return existsSync(path) ? path : undefined;
}

function providerDebugPathFields(debugRoot) {
	if (!existsSync(debugRoot)) return {};
	const providerDebugArtifacts = collectFiles(debugRoot);
	const keyArtifacts = providerDebugArtifacts.filter((path) => /(?:^|[\\/])(?:session|summary|timeline|provider-events|bridge-events|wait-result)\.(?:json|jsonl)$/i.test(path));
	const capped = keyArtifacts.slice(0, 40);
	return {
		providerDebugRoot: debugRoot,
		providerDebugArtifactCount: providerDebugArtifacts.length,
		providerDebugArtifacts: capped,
		...(providerDebugArtifacts.length > capped.length ? { providerDebugArtifactsTruncated: true } : {}),
	};
}

function pathFields(suiteDir) {
	const artifactsDir = resolve(suiteDir, "artifacts");
	const debugRoot = resolve(suiteDir, "cursor-sdk-events");
	const localResumeEvidenceRoot = resolve(suiteDir, "local-resume-evidence");
	const paths = {
		artifactManifest: existingPath(resolve(suiteDir, "artifact-manifest.json")),
		summary: existingPath(resolve(suiteDir, "summary.json")),
		assertions: existingPath(resolve(suiteDir, "assertions.json")),
		failures: existingPath(resolve(suiteDir, "failures.md")),
		terminalHtml: existingPath(resolve(artifactsDir, "terminal.html")),
		terminalFullPng: existingPath(resolve(artifactsDir, "terminal.full.png")),
		terminalFinalViewportPng: existingPath(resolve(artifactsDir, "terminal.final-viewport.png")),
		visualEvidence: existingPath(resolve(artifactsDir, "visual-evidence.json")),
		sessionJsonl: existingPath(resolve(artifactsDir, "session.jsonl")),
		jsonlToolResults: existingPath(resolve(artifactsDir, "jsonl-tool-results.json")),
		localResumeEvidence: existingPath(resolve(suiteDir, "local-resume-evidence.json")),
		localResumeEvidenceRoot: existingPath(localResumeEvidenceRoot),
		localResumeRuntimeLaunches: existingPath(resolve(localResumeEvidenceRoot, "runtime-launches.jsonl")),
		...providerDebugPathFields(debugRoot),
	};
	for (const [key, value] of Object.entries(paths)) {
		if (value === undefined) delete paths[key];
	}
	return paths;
}

function suiteIndexFromResult(result, artifactRoot) {
	if (!result?.suiteDir) return undefined;
	const suiteDir = resolve(result.suiteDir);
	const summary = readJsonFile(resolve(suiteDir, "summary.json"));
	const target = readJsonFile(resolve(suiteDir, "target.json"));
	const suite = readJsonFile(resolve(suiteDir, "suite.json"));
	const rel = relative(resolve(process.cwd(), artifactRoot), suiteDir).split(/[\\/]/);
	return {
		target: summary?.target ?? target?.targetName ?? rel.at(-2),
		suite: summary?.suite ?? suite?.suiteName ?? rel.at(-1),
		runId: target?.runId ?? rel.at(-3),
		ok: result.ok === true,
		artifactDir: suiteDir,
		paths: pathFields(suiteDir),
	};
}

function targetIndexesFromRun(targetName, result, artifactRoot) {
	const suiteResults = Array.isArray(result?.results) ? result.results : [result];
	const suites = suiteResults.map((suiteResult) => suiteIndexFromResult(suiteResult, artifactRoot)).filter(Boolean);
	const runIds = [...new Set(suites.map((suite) => suite.runId).filter(Boolean))];
	return {
		target: targetName,
		ok: result?.ok === true,
		...(result?.error ? { error: redactSecrets(result.error) } : {}),
		runId: runIds.length === 1 ? runIds[0] : undefined,
		runIds,
		suites,
	};
}

/** Build a stable, agent-readable platform-smoke latest index from target run results. */
export function buildLatestPlatformSmokeIndex(config, runResults, metadata = {}) {
	const artifactRoot = resolve(process.cwd(), config?.artifactRoot ?? ".artifacts/platform-smoke");
	const targets = runResults.map(({ targetName, result }) => targetIndexesFromRun(targetName, result, artifactRoot));
	const runIds = [...new Set(targets.flatMap((target) => target.runIds).filter(Boolean))].sort();
	const newestRunId = runIds
		.map((runId) => ({ runId, match: PLATFORM_SMOKE_RUN_DIR_PATTERN.exec(runId) }))
		.filter((entry) => entry.match)
		.sort((a, b) => Number(b.match[1]) - Number(a.match[1]))[0]?.runId ?? runIds.at(-1);
	return {
		schemaVersion: 1,
		kind: "platform-smoke-latest",
		runId: runIds.length === 1 ? runIds[0] : newestRunId,
		runIds,
		artifactRoot,
		startedAt: metadata.startedAt,
		finishedAt: metadata.finishedAt,
		command: metadata.command,
		pid: process.pid,
		ok: targets.every((target) => target.ok),
		targets,
	};
}

/** Atomically write .artifacts/platform-smoke/latest.json. */
export function writeLatestPlatformSmokeIndex(config, runResults, metadata = {}) {
	const index = buildLatestPlatformSmokeIndex(config, runResults, metadata);
	mkdirSync(index.artifactRoot, { recursive: true });
	const outPath = resolve(index.artifactRoot, LATEST_INDEX_NAME);
	const tmpPath = resolve(dirname(outPath), `.${LATEST_INDEX_NAME}.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tmpPath, `${JSON.stringify(index, null, 2)}\n`);
	renameSync(tmpPath, outPath);
	return { index, path: outPath };
}

/** Return concise existing evidence paths for a failed suite result. */
export function platformSmokeSuiteEvidence(result, artifactRoot) {
	const suite = suiteIndexFromResult(result, artifactRoot ?? ".artifacts/platform-smoke");
	if (!suite) return undefined;
	return {
		suite: suite.suite,
		artifactDir: suite.artifactDir,
		paths: suite.paths,
	};
}

/** Write command.txt recording the command that was executed. */
export function writeCommand(dir, cmd) {
	writeFileSync(resolve(dir, "command.txt"), Array.isArray(cmd) ? cmd.join(" ") + "\n" : cmd + "\n");
}

/** Write exit-code.txt. */
export function writeExitCode(dir, code, signal) {
	writeFileSync(resolve(dir, "exit-code.txt"), `code=${code}\nsignal=${signal ?? "none"}\n`);
}
