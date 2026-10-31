import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { captureCommitReview } from "../scripts/lib/release-review-evidence.mjs";
import { assertExtractedPackages, comparePackages } from "../scripts/lib/release-review-package.mjs";

const script = fileURLToPath(new URL("../scripts/release-review.mjs", import.meta.url));

function command(cwd, executable, args) {
	const result = spawnSync(executable, args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function fixture(t, behavior = "pass") {
	const directory = mkdtempSync(join(tmpdir(), "cursor release review test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const repo = join(directory, "repo"), bin = join(directory, "bin"), skill = join(directory, "skill");
	mkdirSync(repo); mkdirSync(bin); mkdirSync(join(skill, "references"), { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), "Actual review skill fixture\n");
	writeFileSync(join(skill, "references/review-rubric.md"), "Complete review rubric fixture\n");
	command(repo, "git", ["init", "--quiet"]);
	command(repo, "git", ["config", "user.email", "review-test@example.invalid"]);
	command(repo, "git", ["config", "user.name", "Review Test"]);
	command(repo, "git", ["config", "core.autocrlf", "false"]);
	writeFileSync(join(repo, "candidate.txt"), "before\n");
	writeFileSync(join(repo, "package.json"), '{"name":"pi-cursor-sdk","version":"1.0.0"}\n');
	command(repo, "git", ["add", "."]);
	command(repo, "git", ["commit", "--quiet", "-m", "baseline"]);
	const base = command(repo, "git", ["rev-parse", "HEAD"]);
	const fake = join(bin, process.platform === "win32" ? "pi.cjs" : "pi");
	writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs"), cp = require("node:child_process");
if (process.argv.includes("--version")) { console.log("1.4.0"); process.exit(0); }
if (process.env.GH_TOKEN || process.env.CURSOR_API_KEY || process.env.RELEASE_GH_TOKEN || process.env.UNRELATED_SECRET) process.exit(3);
const prompt = fs.readFileSync(process.argv.at(-1).slice(1), "utf8");
const input = JSON.parse(fs.readFileSync(/Read ((?:[A-Za-z]:)?[\\\\/][^\\r\\n]+?[\\\\/]review-input\\.json) for immutable identities/.exec(prompt)[1], "utf8"));
const kind = ${JSON.stringify(behavior)};
if (kind === "interrupted") { process.kill(process.ppid, "SIGTERM"); process.exit(0); }
const inputPath = /Read ((?:[A-Za-z]:)?[\\\\/][^\\r\\n]+?[\\\\/]review-input\\.json) for immutable identities/.exec(prompt)[1];
for (const [i, path] of [inputPath, input.patch, input.commits, ...(kind === "unread" ? [] : input.sourceFiles)].entries()) {
  fs.readFileSync(path);
  console.log(JSON.stringify({type:"tool_execution_start",toolCallId:String(i),toolName:"read",args:{path}}));
  console.log(JSON.stringify({type:"tool_execution_end",toolCallId:String(i),toolName:"read",isError:false}));
}
const report = {
  scopeId: input.scopeId, completed: kind !== "incomplete",
  reviewedFiles: kind === "missing-file" ? [] : input.sourceFiles,
  reviewedArtifacts: input.artifactFiles ?? [], reviewedReleaseNotes: true, reviewedIssueContext: true,
  reviewedCatalog: true, reviewedRegistryReceipt: true, reviewedPreviousRelease: true,
  findings: ["finding","fenced-finding","polish"].includes(kind)
    ? [{path:"candidate.txt",line:1,material:kind !== "polish",description:"Review finding",remedy:"Fix it"}] : [],
  materialLimitations: kind === "limited" ? ["Could not inspect changed file"] : [],
  summary: kind === "secrets" ? "Authorization: Bearer test-bearer-token and " + process.env.ZAI_API_KEY : "Inspected the requested diff and files."
};
if (kind === "changed-index") { fs.writeFileSync("candidate.txt", "changed during review\\n"); cp.execFileSync("git", ["add", "candidate.txt"]); }
const fence = String.fromCharCode(96).repeat(3);
const output = ["fenced-finding","polish","preface"].includes(kind)
  ? (kind === "preface" ? "Inspected the diff and surrounding code.\\n\\n" : "") + fence + "json\\n" + JSON.stringify(report) + "\\n" + fence
  : JSON.stringify(report);
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"zai",model:"glm-5.3",stopReason:kind === "error" ? "error" : "stop",content:[{type:"text",text:output}]}}));
if (kind !== "unsettled") console.log(JSON.stringify({type:"agent_settled",aborted:kind === "aborted"}));
`);
	chmodSync(fake, 0o755);
	if (process.platform === "win32") {
		writeFileSync(join(bin, "pi.cmd"), `@"${process.execPath}" "%~dp0pi.cjs" %*\r\n`);
	}
	const receipt = join(directory, "review.json");
	const env = { ...process.env, PATH: [bin, process.env.PATH].join(delimiter), PI_RELEASE_REVIEW_SKILL: join(skill, "SKILL.md"),
		ZAI_API_KEY: "model-key-for-test", UNRELATED_SECRET: "not-for-the-model" };
	for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "RELEASE_GH_TOKEN", "RELEASE_APP_PRIVATE_KEY", "CURSOR_API_KEY",
		"NODE_AUTH_TOKEN", "NPM_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) delete env[name];
	return { repo, base, receipt, env, run: (...args) => spawnSync(process.execPath, [script, ...args, "--receipt", receipt],
		{ cwd: repo, env, encoding: "utf8" }) };
}

function stageChange(repo) {
	writeFileSync(join(repo, "candidate.txt"), "after\n");
	command(repo, "git", ["add", "candidate.txt"]);
}

test("a settled zero-finding review records the exact staged tree with an isolated child environment", (t) => {
	const f = fixture(t);
	stageChange(f.repo);
	const result = f.run("pre-commit");
	assert.equal(result.status, 0, `${result.stderr}\n${readFileSync(`${f.receipt}.stderr.log`, "utf8")}`);
	const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
	assert.equal(receipt.status, "passed");
	assert.equal(receipt.scope.base, f.base);
	assert.equal(receipt.scope.targetTree, command(f.repo, "git", ["write-tree"]));
	assert.deepEqual(receipt.scope.sourceFiles, ["candidate.txt"]);
	assert.deepEqual(receipt.scope.sourceLineCounts, [{ path: "candidate.txt", before: 1, after: 1 }]);
	assert.deepEqual(receipt.readEvidence, { successfulReads: 4, sourceFiles: 1, artifactFiles: 0 });
	assert.ok(readFileSync(`${f.receipt}.events.jsonl`, "utf8").includes('"agent_settled"'));
});

test("review refuses a GitHub credential in the launching process", (t) => {
	const f = fixture(t);
	stageChange(f.repo);
	f.env.GH_TOKEN = "not-for-the-review";
	const result = f.run("pre-commit");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /separate process without these credentials: GH_TOKEN/);
	assert.doesNotMatch(result.stderr, /not-for-the-review/);
});

for (const [behavior, expected] of Object.entries({
	error: /final review was incomplete/,
	unsettled: /did not settle/,
	aborted: /did not settle/,
	incomplete: /marked the review incomplete/,
	finding: /Review has findings/,
	"fenced-finding": /Review has findings/,
	"missing-file": /did not inspect every changed source file/,
	unread: /No successful read recorded for changed source candidate.txt/,
	limited: /material verification limits/,
	"changed-index": /reviewed target changed/,
})) {
	test(`pre-commit refuses ${behavior} even when Pi exits successfully`, (t) => {
		const f = fixture(t, behavior);
		stageChange(f.repo);
		const result = f.run("pre-commit");
		assert.equal(result.status, 1, result.stdout);
		assert.equal(JSON.parse(readFileSync(f.receipt, "utf8")).status, "failed");
		assert.match(result.stderr, expected);
	});
}

test("pre-commit retains non-material polish without treating it as a material blocker", (t) => {
	const f = fixture(t, "polish");
	stageChange(f.repo);
	const result = f.run("pre-commit");
	assert.equal(result.status, 0, result.stderr);
	const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
	assert.equal(receipt.report.findings[0].material, false);
});

test("pre-commit retains a reviewer's explanation before its final JSON verdict", (t) => {
	const f = fixture(t, "preface");
	stageChange(f.repo);
	const result = f.run("pre-commit");
	assert.equal(result.status, 0, result.stderr);
	const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
	assert.match(receipt.commentary, /Inspected the diff/);
});

test("retained review events are valid JSONL with credential material scrubbed", (t) => {
	const f = fixture(t, "secrets");
	stageChange(f.repo);
	const result = f.run("pre-commit");
	assert.equal(result.status, 0, result.stderr);
	const events = readFileSync(`${f.receipt}.events.jsonl`, "utf8");
	for (const line of events.trim().split("\n")) JSON.parse(line);
	assert.doesNotMatch(events, /test-bearer-token|model-key-for-test/);
	const receipt = readFileSync(f.receipt, "utf8");
	assert.doesNotMatch(receipt, /test-bearer-token|model-key-for-test/);
});

test("an interrupted review cannot leave an earlier passing receipt in place", (t) => {
	const f = fixture(t, "interrupted");
	stageChange(f.repo);
	writeFileSync(f.receipt, JSON.stringify({ status: "passed" }));
	const result = f.run("pre-commit");
	assert.notEqual(result.status, 0);
	assert.equal(JSON.parse(readFileSync(f.receipt, "utf8")).status, process.platform === "win32" ? "failed" : "pending");
});

test("pre-push reviews the outgoing commit even when it has an empty tree diff", (t) => {
	const f = fixture(t);
	command(f.repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "recheck review"]);
	const head = command(f.repo, "git", ["rev-parse", "HEAD"]);
	const result = f.run("pre-push", "--base", f.base);
	assert.equal(result.status, 0, result.stderr);
	const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
	assert.equal(receipt.scope.base, f.base);
	assert.equal(receipt.scope.head, head);
	assert.deepEqual(receipt.scope.sourceFiles, []);
	assert.match(readFileSync(join(`${f.receipt}.inputs`, "commits.txt"), "utf8"), /recheck review/);
});

test("release review rejects a candidate whose bytes differ from its receipt before accessing GitHub", (t) => {
	const f = fixture(t);
	const artifact = join(f.repo, "artifact");
	mkdirSync(artifact);
	writeFileSync(join(artifact, "candidate.tgz"), "different bytes");
	writeFileSync(join(artifact, "release.json"), JSON.stringify({ repository: "fitchmultz/pi-cursor-sdk", source: f.base,
		releaseSource: f.base, filename: "candidate.tgz", sha256: "not-the-candidate-hash" }));
	f.env.GITHUB_REPOSITORY = "fitchmultz/pi-cursor-sdk";
	const result = f.run("release-prepare", "--source", f.base, "--release-source", f.base, "--artifact", artifact,
		"--catalog-receipt", join(f.repo, "not-needed.json"), "--evidence", join(f.repo, "evidence"));
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Candidate tarball SHA-256 differs/);
});

test("catalog qualification refuses a staged change instead of binding it to HEAD", (t) => {
	const f = fixture(t);
	stageChange(f.repo);
	f.env.GITHUB_RUN_ID = "123";
	f.env.GITHUB_RUN_ATTEMPT = "1";
	f.env.CURSOR_API_KEY = "catalog-key-for-test";
	const result = f.run("catalog");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /git .*diff.* failed: 1/);
});

test("staged review baseline extracts the actual Git archive", (t) => {
	const f = fixture(t);
	stageChange(f.repo);
	const evidence = join(f.repo, "evidence");
	mkdirSync(evidence);
	const scope = captureCommitReview(f.repo, "pre-commit", undefined, evidence);
	assert.equal(readFileSync(join(scope.sourceBase, "candidate.txt"), "utf8"), "before\n");
	assert.deepEqual(scope.sourceFiles, ["candidate.txt"]);
});

test("package comparison records added, modified, and removed artifact paths", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "cursor-package-diff-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const before = join(directory, "before"), after = join(directory, "after"), evidence = join(directory, "evidence");
	mkdirSync(join(before, "package"), { recursive: true });
	mkdirSync(join(after, "package"), { recursive: true });
	mkdirSync(evidence);
	writeFileSync(join(before, "package", "changed.txt"), "old\n");
	writeFileSync(join(after, "package", "changed.txt"), "new\n");
	writeFileSync(join(before, "package", "removed.txt"), "removed\n");
	writeFileSync(join(after, "package", "added.txt"), "added\n");
	const oldTar = join(directory, "before.tgz"), newTar = join(directory, "after.tgz");
	command(directory, "tar", ["-czf", basename(oldTar), "-C", before, "package"]);
	command(directory, "tar", ["-czf", basename(newTar), "-C", after, "package"]);
	const diff = comparePackages(directory, oldTar, newTar, evidence);
	assert.deepEqual(diff.artifactFiles.sort(), ["package/added.txt", "package/changed.txt", "package/removed.txt"]);
	assert.match(readFileSync(diff.artifactPatch, "utf8"), /deleted file mode/);
	const scope = { ...diff, previousTarball: oldTar, tarball: newTar };
	const verified = join(directory, "verified");
	mkdirSync(verified);
	assertExtractedPackages(directory, scope, verified);
	const gitConfig = join(directory, "global.gitconfig");
	writeFileSync(gitConfig, "[core]\n\tautocrlf = true\n");
	const previousGitConfig = process.env.GIT_CONFIG_GLOBAL;
	process.env.GIT_CONFIG_GLOBAL = gitConfig;
	t.after(() => {
		if (previousGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = previousGitConfig;
	});
	writeFileSync(join(diff.newDir, "package", "changed.txt"), "new\r\n");
	const converted = join(directory, "converted");
	mkdirSync(converted);
	assert.throws(() => assertExtractedPackages(directory, scope, converted), /git .*diff.* failed: 1/);
	writeFileSync(join(diff.newDir, "package", "changed.txt"), "tampered\n");
	const changed = join(directory, "changed");
	mkdirSync(changed);
	assert.throws(() => assertExtractedPackages(directory, scope, changed), /git .*diff.* failed: 1/);
});
