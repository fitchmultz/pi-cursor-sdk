import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hash } from "./release-review-hash.mjs";

// Both native feedback and the independent post-process gate consume this ledger.
export function createReviewReadCoverage(root, scope, inputPath) {
	const starts = new Map();
	const reads = new Map();
	let successfulReads = 0;
	function observe(event) {
		if (event.type === "tool_execution_start" && event.toolName === "read" && typeof event.args?.path === "string") {
			starts.set(event.toolCallId, { ...event.args, path: resolve(root, event.args.path) });
		}
		if (event.type === "tool_execution_end" && event.toolName === "read" && event.isError === false && starts.has(event.toolCallId)) {
			const start = starts.get(event.toolCallId);
			const entries = reads.get(start.path) ?? [];
			entries.push({ ...start, result: event.result });
			reads.set(start.path, entries);
			successfulReads++;
		}
	}
	function inspect() {
		const missing = [];
		const requireRead = (label, ...paths) => {
			const alternatives = [];
			let incomplete;
			for (const path of paths.map((item) => resolve(item))) {
				const entries = reads.get(path);
				if (!entries?.length) {
					if (existsSync(path)) alternatives.push({ path, unopened: true });
					continue;
				}
				const imageReads = entries.filter(({ result }) => result?.content?.some((part) =>
					part.type === "text" && part.text.startsWith("Read image file [")));
				if (imageReads.length) {
					if (imageReads.some(({ result }) => result.content.some((part) => part.type === "image")
						&& !result.content.some((part) => part.type === "text" && part.text.includes("Current model does not support images.")))) return path;
					incomplete ??= `Image for ${label} was not available to the reviewer`;
					alternatives.push({ path, imageUnavailable: true });
					continue;
				}
				const contents = readFileSync(path, "utf8");
				const lines = contents ? contents.split("\n").length - Number(contents.endsWith("\n")) : 0;
				const ranges = entries.map(({ offset, limit, result }) => {
					const first = offset ? Math.max(1, offset) : 1;
					const outputLines = result?.details?.truncation?.outputLines ?? Infinity;
					const last = Math.min(lines, first + Math.min(limit ?? Infinity, outputLines) - 1);
					return [first, last];
				}).sort((a, b) => a[0] - b[0]);
				let next = 1;
				const missingRanges = [];
				for (const [first, last] of ranges) {
					if (first > next && next <= lines) missingRanges.push([next, Math.min(first - 1, lines)]);
					next = Math.max(next, last + 1);
				}
				if (next <= lines) missingRanges.push([next, lines]);
				if (!missingRanges.length) return path;
				incomplete ??= `Incomplete read of ${label}: line ${missingRanges[0][0]} of ${lines} was not read`;
				alternatives.push({ path, missingRanges });
			}
			missing.push({ label, alternatives, message: incomplete ?? `No successful read recorded for ${label}` });
		};
		for (const [label, path] of [["review input", inputPath], ["source diff", scope.patch], ["commit context", scope.commits]]) {
			requireRead(label, path);
		}
		if (scope.preparedReviewContext) requireRead("prepared verification context", scope.preparedReviewContext.path);
		if (scope.reviewContext) requireRead("supplied review context", scope.reviewContext.path);
		const sourceReads = [];
		for (const path of scope.sourceFiles) {
			const target = resolve(root, path);
			const sourceTree = existsSync(target) ? "target" : "base";
			const absolutePath = sourceTree === "target" ? target : resolve(scope.sourceBase, path);
			requireRead(`changed source ${path}`, absolutePath);
			if (scope.mode === "release") sourceReads.push({ path, sourceTree, absolutePath, sha256: hash(absolutePath) });
		}
		const artifactSourceReads = [];
		if (scope.mode === "release") {
			for (const path of scope.artifactFiles) {
				const packagePaths = [resolve(scope.newDir, path), resolve(scope.oldDir, path)];
				const copies = packagePaths.flatMap((artifact, index) => {
					if (!reads.has(artifact)) return [];
					const sha256 = hash(artifact);
					const source = sourceReads.find((entry) => entry.sha256 === sha256);
					return source ? [{ artifactTree: index === 0 ? "candidate" : "previous", source, sha256 }] : [];
				});
				const readPath = requireRead(`changed package artifact ${path}`, ...packagePaths, ...copies.map(({ source }) => source.absolutePath));
				const reused = copies.find(({ source }) => source.absolutePath === readPath);
				if (reused) artifactSourceReads.push({ path, artifactTree: reused.artifactTree, source: reused.source.path,
					sourceTree: reused.source.sourceTree, sha256: reused.sha256 });
			}
			for (const [label, path] of [
				["package diff", scope.artifactPatch], ["release notes", scope.notes], ["PR and issue context", scope.context],
				["catalog receipt", scope.catalogReceipt], ["catalog output", scope.catalogOutput],
				["npm registry receipt", scope.npmReceipt], ["previous GitHub release", scope.previousRelease],
			]) requireRead(label, path);
		}
		return { missing, evidence: { successfulReads, sourceFiles: scope.sourceFiles.length, artifactFiles: scope.artifactFiles?.length ?? 0,
			...(artifactSourceReads.length ? { artifactSourceReads } : {}) } };
	}
	return { observe, inspect };
}

export function verifyReadEvidence(root, scope, inputPath, events) {
	const coverage = createReviewReadCoverage(root, scope, inputPath);
	for (const event of events) coverage.observe(event);
	const { missing, evidence } = coverage.inspect();
	assert.ok(!missing.length, missing[0]?.message);
	return evidence;
}
