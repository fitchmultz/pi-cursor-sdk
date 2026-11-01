import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));

function packageRoot(entry, name) {
	let directory = dirname(realpathSync(entry));
	while (true) {
		const manifest = join(directory, "package.json");
		if (existsSync(manifest) && json(manifest).name === name) return directory;
		const parent = dirname(directory);
		assert.notEqual(parent, directory, `Could not find ${name} for ${entry}`);
		directory = parent;
	}
}

function versionFor(entry, name) {
	return json(join(packageRoot(entry, name), "package.json")).version;
}

function importFrom(directory, specifiers) {
	const code = `
const entries = {};
for (const name of JSON.parse(process.argv[1])) {
	const entry = import.meta.resolve(name);
	const module = await import(name);
	if (!Object.keys(module).length) throw new Error(\`\${name} has no exports\`);
	entries[name] = entry;
}
console.log(JSON.stringify(entries));`;
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, JSON.stringify(specifiers)],
		{ cwd: directory, encoding: "utf8" });
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `ESM imports from ${directory} failed: ${result.stderr}`);
	return JSON.parse(result.stdout);
}

function checkBounded(z) {
	const cases = [
		[z.array(z.number()), z.maxLength(2), [1, "a", "b"], [1, 2], [1, "a"]],
		[z.set(z.number()), z.maxSize(2), new Set([1, "a", "b"]), new Set([1, 2]), new Set([1, "a"])],
		[z.map(z.string(), z.number()), z.maxSize(2), new Map([["a", 1], ["b", "x"], ["c", "y"]]),
			new Map([["a", 1], ["b", 2]]), new Map([["a", 1], ["b", "x"]])],
	];
	for (const [unbounded, limit, oversized, valid, invalid] of cases) {
		const bounded = unbounded.check(limit);
		assert.deepEqual(bounded.safeParse(oversized).error?.issues.map((issue) => issue.code), ["too_big"]);
		assert.equal(bounded.safeParse(valid).success, true);
		assert.equal(bounded.safeParse(invalid).error?.issues[0]?.code, "invalid_type");
		assert.ok(unbounded.safeParse(oversized).error?.issues.some((issue) => issue.code === "invalid_type"));
	}
}

const [installedPath, candidatePath] = process.argv.slice(2).map((path) => resolve(path));
assert.ok(installedPath && candidatePath, "Expected the installed package and extracted candidate paths");
const installed = json(join(installedPath, "package.json"));
const candidate = json(join(candidatePath, "package.json"));
assert.equal(installed.name, candidate.name);
assert.equal(installed.version, candidate.version);
const extensionRequire = createRequire(join(realpathSync(installedPath), "package.json"));
const sdkRoot = packageRoot(extensionRequire.resolve("@cursor/sdk"), "@cursor/sdk");
const sdk = json(join(sdkRoot, "package.json"));
const sdkRequire = createRequire(join(sdkRoot, "package.json"));
assert.equal(sdk.version, candidate.dependencies["@cursor/sdk"]);
const resolved = {};
const zodImports = importFrom(sdkRoot, ["zod", "zod/v3", "zod/v4", "zod/v4-mini"]);
for (const [specifier, url] of Object.entries(zodImports)) {
	const entry = fileURLToPath(url);
	assert.equal(packageRoot(entry, "zod"), packageRoot(sdkRequire.resolve(specifier), "zod"));
	const version = versionFor(entry, "zod");
	assert.equal(version, candidate.dependencies.zod, `SDK resolved the wrong ${specifier}`);
	const module = await import(url);
	if (specifier === "zod/v4" || specifier === "zod/v4-mini") checkBounded(module);
	resolved[specifier] = { entry, version };
}
for (const name of ["@modelcontextprotocol/server", "@modelcontextprotocol/core"]) {
	const root = packageRoot(extensionRequire.resolve(name), name);
	const url = importFrom(root, ["zod/v4"])["zod/v4"];
	const entry = fileURLToPath(url);
	assert.equal(packageRoot(entry, "zod"), realpathSync(join(root, "node_modules/zod")),
		`${name} did not resolve its bundled Zod`);
	const version = versionFor(entry, "zod");
	const expected = json(join(candidatePath, "node_modules", name, "node_modules/zod/package.json")).version;
	assert.equal(version, expected, `${name} resolved the wrong bundled Zod`);
	checkBounded(await import(url));
	resolved[name] = { entry, version };
}
const runtime = globalThis.Bun ? "bun" : "import";
const exports = ["@cursor/sdk", "@cursor/sdk/agent", "@cursor/sdk/sqlite"];
if (runtime === "bun") exports.push("@cursor/sdk/bundled", "@cursor/sdk/bundled/sqlite");
for (const url of Object.values(importFrom(realpathSync(installedPath), exports))) {
	assert.equal(packageRoot(fileURLToPath(url), "@cursor/sdk"), sdkRoot);
}
console.log(JSON.stringify({ runtime, installed: installed.version, sdk: sdk.version, resolved }, null, 2));
