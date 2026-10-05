import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/ci-compatibility.mjs", import.meta.url));
for (const flag of ["-h", "--help"]) {
  test(`compatibility ${flag} works outside a checkout without installing or probing`, () => {
    const cwd = mkdtempSync(join(tmpdir(), "compat-help-"));
    try {
      const result = spawnSync(process.execPath, [script, flag], { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /--working-tree --official-only --versions 0\.87\.1,0\.99\.1,1\.0\.2/);
      assert.match(result.stdout, /Exit codes:/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}
for (const args of [["--unknown"], ["--versions"], ["--versions", "latest"]]) {
  test(`invalid qualification selection ${args.join(" ")} fails before installing`, () => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid argument:/);
    assert.doesNotMatch(result.stdout, /npm|git/);
  });
}

test("default compatibility gate rejects uncommitted artifacts before installations", () => {
  const cwd = mkdtempSync(join(tmpdir(), "compat-dirty-"));
  try {
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd }).status, 0);
    writeFileSync(join(cwd, "uncommitted.txt"), "dirty checkout\n");
    const result = spawnSync(process.execPath, [script, "--official-only", "--versions", "0.99.1"], { cwd, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Clean checkout required/);
    assert.doesNotMatch(result.stdout, /\$ npm/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
