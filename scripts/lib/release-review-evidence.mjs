import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { collectReleaseContext, latestPublishedRelease } from "./release-review-github.mjs";
import { hash, run, writeJson } from "./release-review-io.mjs";
import { comparePackages, packPublishedPackage } from "./release-review-package.mjs";

const shaPattern = /^[a-f0-9]{40}$/;
const sourceDiffArgs = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];

function git(root, ...args) {
	return run("git", args, { cwd: root });
}

function gitFile(root, path, args) {
	run("git", args, { cwd: root, output: path });
}

function names(path) {
	return readFileSync(path, "utf8").split("\0").filter(Boolean);
}

function sourceBaseline(root, base, directory) {
	const sourceBase = join(directory, "source-base");
	const sourceBaseArchive = join(directory, "source-base.tar");
	mkdirSync(sourceBase);
	run("git", ["archive", "--format=tar", "--output", sourceBaseArchive, base], { cwd: root });
	run("tar", ["-xf", basename(sourceBaseArchive), "-C", sourceBase], { cwd: dirname(sourceBaseArchive) });
	return { sourceBase, sourceBaseArchive, sourceBaseSha256: hash(sourceBaseArchive) };
}

function lineCount(path) {
	if (!existsSync(path) || !lstatSync(path).isFile()) return null;
	let lines = 0;
	for (const byte of readFileSync(path)) if (byte === 10) lines++;
	return lines;
}

function sourceDiff(root, base, target, directory) {
	const patch = join(directory, "source.diff");
	const paths = join(directory, "source-files.z");
	gitFile(root, patch, ["diff", ...sourceDiffArgs, "--binary", base, target, "--"]);
	gitFile(root, paths, ["diff", ...sourceDiffArgs, "--name-only", "-z", base, target, "--"]);
	const sourceFiles = names(paths);
	const baseline = sourceBaseline(root, base, directory);
	const sourceLineCounts = sourceFiles.map((path) => ({
		path, before: lineCount(join(baseline.sourceBase, path)), after: lineCount(join(root, path)),
	}));
	return { patch, diffSha256: hash(patch), sourceFiles, sourceLineCounts, ...baseline };
}

export function requireCleanWorkingFiles(root) {
	run("git", ["diff", "--quiet", "--no-ext-diff", "--no-textconv"], { cwd: root });
}

function cleanIndex(root) {
	run("git", ["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv"], { cwd: root });
}

export function requireCleanCheckout(root) {
	requireCleanWorkingFiles(root);
	cleanIndex(root);
}

function commit(root, ref) {
	const sha = git(root, "rev-parse", "--verify", `${ref}^{commit}`);
	assert.match(sha, shaPattern, `Not a commit: ${ref}`);
	return sha;
}

function tree(root, ref) {
	const sha = git(root, "rev-parse", "--verify", `${ref}^{tree}`);
	assert.match(sha, shaPattern, `Not a tree: ${ref}`);
	return sha;
}

export function repositoryRoot() {
	return git(process.cwd(), "rev-parse", "--show-toplevel");
}

export function captureCommitReview(root, mode, baseInput, directory) {
	requireCleanWorkingFiles(root);
	const head = commit(root, "HEAD");
	let base, targetTree, target;
	if (mode === "pre-commit") {
		base = head;
		targetTree = git(root, "write-tree");
		assert.match(targetTree, shaPattern, "The staged index does not have a complete tree");
		target = targetTree;
	} else {
		assert.match(baseInput ?? "", shaPattern, "pre-push requires the exact remote branch or main base SHA");
		cleanIndex(root);
		base = commit(root, baseInput);
		run("git", ["merge-base", "--is-ancestor", base, head], { cwd: root });
		target = head;
		targetTree = tree(root, head);
	}
	const diff = sourceDiff(root, base, target, directory);
	const commits = join(directory, "commits.txt");
	gitFile(root, commits, mode === "pre-push"
		? ["log", "--reverse", "--format=%H%n%B%n", `${base}..${head}`]
		: ["log", "-1", "--format=%H%n%B%n", head]);
	return { mode, base, head, target, targetTree, ...diff, commits, commitsSha256: hash(commits) };
}

export function assertCommitReviewUnchanged(root, scope, directory) {
	const current = captureCommitReview(root, scope.mode, scope.base, directory);
	for (const key of ["base", "head", "target", "targetTree", "diffSha256", "commitsSha256", "sourceBaseSha256"]) {
		assert.equal(current[key], scope[key], `The reviewed ${key} changed`);
	}
	assert.equal(hash(scope.patch), scope.diffSha256, "Reviewed source diff changed");
	assert.equal(hash(scope.commits), scope.commitsSha256, "Reviewed commit context changed");
	assert.deepEqual(current.sourceLineCounts, scope.sourceLineCounts, "Reviewed source line counts changed");
	assertSourceBaseline(root, scope, current);
}

export function assertSourceBaseline(root, scope, current) {
	assert.equal(hash(scope.sourceBaseArchive), scope.sourceBaseSha256, "Reviewed source baseline archive changed");
	assert.equal(current.sourceBaseSha256, scope.sourceBaseSha256, "Reviewed source baseline identity changed");
	run("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--quiet", "--no-ext-diff", "--no-textconv", "--no-renames",
		"--", scope.sourceBase, current.sourceBase], { cwd: root });
}

export function verifySourceBaseline(root, scope, directory) {
	assertSourceBaseline(root, scope, sourceBaseline(root, scope.base, directory));
}

export function catalogIdentity(root, staged = false) {
	return {
		source: commit(root, "HEAD"),
		...(staged ? { targetTree: git(root, "write-tree") } : {}),
		catalogSha256: hash(join(root, "src/cursor-fallback-models.generated.ts")),
		generatorSha256: hash(join(root, "scripts/refresh-cursor-model-snapshots.mjs")),
		runId: process.env.GITHUB_RUN_ID,
		runAttempt: process.env.GITHUB_RUN_ATTEMPT,
	};
}

export async function captureReleaseReview(root, options, directory) {
	requireCleanCheckout(root);
	const source = commit(root, "HEAD");
	assert.equal(source, options.source, "Checkout differs from the planned release source");
	assert.match(options.releaseSource ?? "", shaPattern, "Missing original release source");
	run("git", ["merge-base", "--is-ancestor", options.releaseSource, source], { cwd: root });
	const artifact = resolve(options.artifact);
	const candidateManifest = join(artifact, "release.json");
	const candidate = JSON.parse(readFileSync(candidateManifest, "utf8"));
	const repository = process.env.GITHUB_REPOSITORY;
	assert.equal(candidate.repository, repository, "Candidate repository differs from this run");
	assert.equal(candidate.source, source, "Candidate source differs from the reviewed checkout");
	assert.equal(candidate.releaseSource ?? candidate.source, options.releaseSource, "Candidate covers a different original merge");
	assert.equal(basename(candidate.filename), candidate.filename, "Candidate filename is not local to its artifact");
	const tarball = join(artifact, candidate.filename);
	assert.equal(hash(tarball), candidate.sha256, "Candidate tarball SHA-256 differs");
	assert.equal(`sha512-${hash(tarball, "sha512", "base64")}`, candidate.integrity, "Candidate tarball integrity differs");
	const manifest = JSON.parse(git(root, "show", `${source}:package.json`));
	assert.equal(candidate.name, manifest.name);
	assert.equal(candidate.version, manifest.version);
	const notes = join(artifact, "release-notes.md");
	assert.equal(readFileSync(notes, "utf8"), `${candidate.notes}\n`, "Candidate release notes differ from its receipt");
	const catalogReceipt = resolve(options.catalogReceipt);
	const catalogOutput = `${catalogReceipt}.log`;
	const catalog = JSON.parse(readFileSync(catalogReceipt, "utf8"));
	assert.deepEqual(catalog, { ...catalogIdentity(root), status: "passed", outputSha256: hash(catalogOutput) },
		"Catalog check did not cover this source, run, and output");
	assert.match(process.env.GITHUB_RUN_ID ?? "", /^\d+$/, "Missing GitHub run ID");
	assert.match(process.env.GITHUB_RUN_ATTEMPT ?? "", /^\d+$/, "Missing GitHub run attempt");

	const release = await latestPublishedRelease(repository, process.env.GH_TOKEN);
	assert.ok(!release.draft && !release.prerelease, "The previous GitHub release is not published and stable");
	const previousRelease = join(directory, "previous-github-release.json");
	writeJson(previousRelease, release);
	const base = commit(root, `refs/tags/${release.tag_name}`);
	const previousManifest = JSON.parse(git(root, "show", `${base}:package.json`));
	assert.equal(previousManifest.name, candidate.name);
	assert.equal(release.tag_name, `v${previousManifest.version}`, "Published tag and manifest version differ");
	const previous = packPublishedPackage(root, previousManifest, directory);
	const diff = sourceDiff(root, base, source, directory);
	const packageDiff = comparePackages(root, previous.tarball, tarball, directory);
	const commitsFile = join(directory, "commits.txt");
	gitFile(root, commitsFile, ["log", "--reverse", "--format=%H%n%B%n", `${base}..${source}`]);
	const idsFile = join(directory, "commit-ids.txt");
	gitFile(root, idsFile, ["rev-list", "--reverse", `${base}..${source}`]);
	const commitIds = readFileSync(idsFile, "utf8").split("\n").filter(Boolean);
	const context = join(directory, "pr-issue-context.json");
	const prospective = options.pull ? { number: options.pull, head: source } : undefined;
	writeJson(context, await collectReleaseContext({
		repository, commits: commitIds, token: process.env.GH_TOKEN, prospective,
	}));
	return {
		mode: "release", base, baselineTag: release.tag_name, head: source, target: source, targetTree: tree(root, source),
		releaseSource: options.releaseSource, ...(prospective ? { prospectivePull: prospective.number } : {}),
		candidateSha256: candidate.sha256, candidateIntegrity: candidate.integrity,
		previousRelease, previousReleaseSha256: hash(previousRelease),
		previousTarball: previous.tarball, previousTarballSha256: hash(previous.tarball),
		npmReceipt: previous.receipt, npmReceiptSha256: hash(previous.receipt),
		candidateManifest, candidateManifestSha256: hash(candidateManifest),
		catalogReceipt, catalogReceiptSha256: hash(catalogReceipt), catalogOutput,
		runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
		...diff, ...packageDiff, commits: commitsFile, commitsSha256: hash(commitsFile), notes, notesSha256: hash(notes),
		context, contextSha256: hash(context), tarball, catalog,
	};
}

export function assertReleaseReviewUnchanged(root, scope) {
	requireCleanCheckout(root);
	assert.equal(commit(root, "HEAD"), scope.head, "Release checkout changed during review");
	assert.equal(tree(root, "HEAD"), scope.targetTree, "Release tree changed during review");
	assert.equal(commit(root, `refs/tags/${scope.baselineTag}`), scope.base, "Previous release tag changed during review");
	assert.equal(hash(scope.tarball), scope.candidateSha256, "Candidate tarball changed during review");
	assert.equal(hash(scope.previousTarball), scope.previousTarballSha256, "Previous npm tarball changed during review");
	assert.equal(hash(scope.previousRelease), scope.previousReleaseSha256, "Previous GitHub release evidence changed during review");
	assert.equal(hash(scope.npmReceipt), scope.npmReceiptSha256, "npm registry receipt changed during review");
	assert.equal(hash(scope.candidateManifest), scope.candidateManifestSha256, "Candidate receipt changed during review");
	assert.equal(hash(scope.catalogReceipt), scope.catalogReceiptSha256, "Catalog receipt changed during review");
	assert.equal(hash(scope.catalogOutput), scope.catalog.outputSha256, "Catalog output changed during review");
	assert.equal(hash(scope.artifactPatch), scope.artifactDiffSha256, "Package diff changed during review");
	assert.equal(hash(scope.patch), scope.diffSha256, "Source diff changed during review");
	assert.equal(hash(scope.commits), scope.commitsSha256, "Commit context changed during review");
	assert.equal(hash(scope.notes), scope.notesSha256, "Release notes changed during review");
	assert.equal(hash(scope.context), scope.contextSha256, "PR and issue context changed during review");
	assert.equal(process.env.GITHUB_RUN_ID, scope.runId, "GitHub run changed during review");
	assert.equal(process.env.GITHUB_RUN_ATTEMPT, scope.runAttempt, "GitHub run attempt changed during review");
	assert.deepEqual({ ...catalogIdentity(root), status: "passed", outputSha256: scope.catalog.outputSha256 },
		scope.catalog, "Catalog inputs changed during review");
}
