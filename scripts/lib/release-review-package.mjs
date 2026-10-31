import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sealedNodePath } from "./cursor-smoke-env.mjs";
import { hash, run } from "./release-review-io.mjs";

export function packPublishedPackage(root, manifest, directory) {
	const destination = join(directory, "previous-tarball");
	mkdirSync(destination);
	const output = join(directory, "npm-pack.json");
	const env = {
		PATH: sealedNodePath(), HOME: directory, TMPDIR: directory,
		npm_config_cache: join(directory, "npm-cache"), npm_config_registry: "https://registry.npmjs.org/",
	};
	run("npm", ["pack", `${manifest.name}@${manifest.version}`, "--ignore-scripts", "--pack-destination", destination, "--json"],
		{ cwd: root, env, output });
	const data = JSON.parse(readFileSync(output, "utf8"));
	const entries = Array.isArray(data) ? data : Object.values(data);
	assert.equal(entries.length, 1, "Expected one previously published npm tarball");
	const [packed] = entries;
	assert.equal(packed.name, manifest.name);
	assert.equal(packed.version, manifest.version);
	assert.equal(basename(packed.filename), packed.filename);
	const tarball = join(destination, packed.filename);
	assert.equal(`sha512-${hash(tarball, "sha512", "base64")}`, packed.integrity, "Previous npm tarball integrity differs");
	return { tarball, receipt: output };
}

export function comparePackages(root, previous, candidate, directory) {
	const oldDir = join(directory, "previous-package");
	const newDir = join(directory, "candidate-package");
	mkdirSync(oldDir);
	mkdirSync(newDir);
	run("tar", ["-xzf", basename(previous), "-C", oldDir], { cwd: dirname(previous) });
	run("tar", ["-xzf", basename(candidate), "-C", newDir], { cwd: dirname(candidate) });
	const artifactPatch = join(directory, "package.diff");
	const paths = join(directory, "package-files.z");
	const args = ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
	run("git", [...args, "--binary", "--", oldDir, newDir], { cwd: root, output: artifactPatch, allowed: [0, 1] });
	run("git", [...args, "--name-status", "-z", "--", oldDir, newDir], { cwd: root, output: paths, allowed: [0, 1] });
	const entries = readFileSync(paths, "utf8").split("\0").filter(Boolean);
	assert.equal(entries.length % 2, 0, "Malformed package file-status list");
	const artifactFiles = [];
	for (let i = 1; i < entries.length; i += 2) {
		const path = entries[i].replaceAll("\\", "/");
		const oldPrefix = `${oldDir.replaceAll("\\", "/")}/`;
		const newPrefix = `${newDir.replaceAll("\\", "/")}/`;
		const prefix = path.startsWith(oldPrefix) ? oldPrefix : newPrefix;
		assert.ok(path.startsWith(prefix), `Unexpected package diff path: ${path}`);
		artifactFiles.push(path.slice(prefix.length));
	}
	return { artifactPatch, artifactDiffSha256: hash(artifactPatch), artifactFiles: [...new Set(artifactFiles)], oldDir, newDir };
}

export function assertExtractedPackages(root, scope, directory) {
	const oldDir = join(directory, "previous");
	const newDir = join(directory, "candidate");
	mkdirSync(oldDir);
	mkdirSync(newDir);
	run("tar", ["-xzf", basename(scope.previousTarball), "-C", oldDir], { cwd: dirname(scope.previousTarball) });
	run("tar", ["-xzf", basename(scope.tarball), "-C", newDir], { cwd: dirname(scope.tarball) });
	for (const [actual, expected] of [[scope.oldDir, oldDir], [scope.newDir, newDir]]) {
		run("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--quiet", "--no-ext-diff", "--no-textconv", "--no-renames", "--", actual, expected], { cwd: root });
	}
}
