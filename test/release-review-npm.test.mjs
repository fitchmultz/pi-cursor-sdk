import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const moduleUrl = new URL("../scripts/lib/release-review-package.mjs", import.meta.url).href;
const integrity = "sha512-7HFR2ICqcVIoIla/xndbZyIef2l1s98vdTxVFAFhk/LkfENDV8rVms2fQSTT3c14zpUIIu13SkMc6Plu+jTYpA==";

// The receipt fields and npm argv follow the real npm pack of pi-cursor-sdk@0.5.5.
function runPack(t, archive) {
	const root = mkdtempSync(join(tmpdir(), "cursor release npm-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin"), evidence = join(root, "evidence");
	mkdirSync(bin); mkdirSync(evidence);
	const npm = join(bin, process.platform === "win32" ? "npm.cjs" : "npm");
	writeFileSync(npm, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
if (args[0] !== "pack" || args[1] !== "pi-cursor-sdk@0.5.5") process.exit(2);
const destination = args[args.indexOf("--pack-destination") + 1];
const filename = "pi-cursor-sdk-0.5.5.tgz";
fs.writeFileSync(path.join(destination, filename), ${JSON.stringify(archive)});
console.log(JSON.stringify([{ name: "pi-cursor-sdk", version: "0.5.5", filename, integrity: ${JSON.stringify(integrity)} }]));
`);
	chmodSync(npm, 0o755);
	if (process.platform === "win32") {
		writeFileSync(join(bin, "npm.cmd"), `@"${process.execPath}" "%~dp0npm.cjs" %*\r\n`);
	}
	const program = `
process.execPath = ${JSON.stringify(join(bin, process.platform === "win32" ? "node.exe" : "node"))};
const { packPublishedPackage } = await import(${JSON.stringify(moduleUrl)});
const result = packPublishedPackage(${JSON.stringify(root)}, { name: "pi-cursor-sdk", version: "0.5.5" }, ${JSON.stringify(evidence)});
console.log(JSON.stringify(result));
`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8" });
	return { result, evidence };
}

test("published npm pack receipt is bound to the downloaded archive", (t) => {
	const { result } = runPack(t, "reviewed archive bytes\n");
	assert.equal(result.status, 0, result.stderr);
	const receipt = JSON.parse(result.stdout);
	assert.equal(readFileSync(receipt.tarball, "utf8"), "reviewed archive bytes\n");
	assert.equal(JSON.parse(readFileSync(receipt.receipt, "utf8"))[0].integrity, integrity);
});

test("published npm pack rejects an archive that does not match npm integrity", (t) => {
	const { result } = runPack(t, "different archive bytes\n");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Previous npm tarball integrity differs/);
});
