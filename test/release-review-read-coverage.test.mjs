import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { createReviewReadCoverage, verifyReadEvidence } from "../scripts/lib/release-review-read-coverage.mjs";

// Protect the actual release failure: base-head bytes do not cover an existing
// target, and complete diffs/grep results cannot fill skipped evidence intervals.
test("release feedback enumerates every genuine gap using the final gate's exact path and interval rules", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "review-coverage-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
	const file = (name, contents = `${name}\n`) => {
		const path = join(root, name);
		mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); return path;
	};
	const target = file("catalog.ts", lines(100));
	const base = file("base/catalog.ts", lines(100));
	const deleted = file("base/deleted.txt", "deleted\n");
	const artifact = file("candidate/package/catalog.ts", lines(100));
	const input = file("input.json");
	const scope = { mode: "release", sourceBase: join(root, "base"), sourceFiles: ["catalog.ts", "deleted.txt"],
		newDir: join(root, "candidate"), oldDir: join(root, "previous"), artifactFiles: ["package/catalog.ts"],
		patch: file("source.diff"), commits: file("commits.txt"), artifactPatch: file("package.diff"), notes: file("notes.md"),
		context: file("context.json"), catalogReceipt: file("catalog.json"), catalogOutput: file("catalog.log"),
		npmReceipt: file("npm-pack.json", lines(13802)), previousRelease: file("previous-release.json", lines(188)),
		preparedReviewContext: { path: file("prepared.md") }, reviewContext: { path: file("supplied.md") } };
	const coverage = createReviewReadCoverage(root, scope, input), events = [];
	const reader = createReadTool(root);
	async function read(path, offset, limit) {
		const id = String(events.length);
		const start = { type: "tool_execution_start", toolName: "read", toolCallId: id, args: { path, offset, limit } };
		const result = await reader.execute(id, { path, offset, limit });
		const end = { type: "tool_execution_end", toolName: "read", toolCallId: id, isError: false, result };
		for (const event of [start, end]) { events.push(event); coverage.observe(event); }
	}
	for (const path of [input, scope.patch, scope.commits, scope.artifactPatch, scope.notes, scope.context,
		scope.catalogReceipt, scope.catalogOutput, scope.preparedReviewContext.path, scope.reviewContext.path, deleted]) await read(path);
	await read(base, 1, 40); await read(target, 41); await read(artifact, 1, 10);
	await read(scope.npmReceipt, 1, 420); await read(scope.npmReceipt, 13744);
	await read(scope.previousRelease, 1, 120);
	const { missing } = coverage.inspect();
	assert.deepEqual(missing.map(entry => entry.label), ["changed source catalog.ts", "changed package artifact package/catalog.ts", "npm registry receipt", "previous GitHub release"]);
	assert.deepEqual(missing[0].alternatives, [{ path: target, missingRanges: [[1, 40]] }]);
	assert.deepEqual(missing[1].alternatives, [{ path: artifact, missingRanges: [[11, 100]] }, { path: target, missingRanges: [[1, 40]] }]);
	assert.deepEqual(missing[2].alternatives, [{ path: scope.npmReceipt, missingRanges: [[421, 13743]] }]);
	assert.deepEqual(missing[3].alternatives, [{ path: scope.previousRelease, missingRanges: [[121, 188]] }]);
	assert.throws(() => verifyReadEvidence(root, scope, input, events), /changed source catalog.ts: line 1 of 100/);
	await read(target, 1, 40);
	// Real native truncation still limits coverage even with an oversized request.
	await read(scope.npmReceipt, 421, 13323);
	assert.deepEqual(coverage.inspect().missing.find(entry => entry.label === "npm registry receipt").alternatives[0].missingRanges, [[2421, 13743]]);
	for (let offset = 2421; offset <= 13743; offset += 1000) await read(scope.npmReceipt, offset, Math.min(1000, 13744 - offset));
	await read(scope.previousRelease, 121);
	assert.deepEqual(coverage.inspect().missing, []);
	const evidence = verifyReadEvidence(root, scope, input, events);
	assert.deepEqual(evidence, coverage.inspect().evidence);
	assert.deepEqual(evidence.artifactSourceReads.map(({ sha256, ...copy }) => copy), [{ path: "package/catalog.ts", artifactTree: "candidate", source: "catalog.ts", sourceTree: "target" }]);
});
