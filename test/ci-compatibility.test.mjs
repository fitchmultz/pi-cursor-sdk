import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
      assert.match(result.stdout, /--working-tree --official-only --versions 0\.87\.1,0\.99\.1,1\.0\.3/);
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

const { qualifySelectedHost, runCompatibilityCommand } =
  await import("../scripts/ci-compatibility-phases.mjs");

test("qualification gives build, verify and native contracts independent commands", (t) => {
  const spawn = t.mock.method(childProcess, "spawnSync", () => ({ status: 0 }));
  syncBuiltinESMExports();
  try {
    qualifySelectedHost((command, args) => runCompatibilityCommand(command, args, {}));
    const calls = spawn.mock.calls.map(call => call.arguments);
    assert.equal(calls[1][2].timeout, 360_000, "aggregate verify needs its own finite budget");
    assert.deepEqual(calls.map(([, , options]) => options.timeout), [180_000, 360_000, 180_000]);
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const campaign = calls.map(([command, args]) =>
      [command === process.execPath ? "node" : command, ...args].join(" "),
    ).join(" && ");
    assert.equal(campaign, packageJson.scripts["check:compat"],
      "phased qualification must retain every command and native contract in check:compat");

    for (const [command, args] of [
      ["npm.cmd", ["run", "verify"]],
      ["npm", ["verify"]],
      ["npm", ["run", "verify:other"]],
      ["npm", ["run", "verify", "--silent"]],
    ]) {
      runCompatibilityCommand(command, args, {});
      assert.equal(spawn.mock.calls.at(-1).arguments[2].timeout, 180_000,
        `${command} ${args.join(" ")} must use the ordinary budget`);
    }
    for (const timeout of [0, 600_000]) {
      runCompatibilityCommand("npm", ["run", "verify"], { timeout });
      assert.equal(spawn.mock.calls.at(-1).arguments[2].timeout, timeout,
        "explicit caller budgets must take precedence");
    }
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const failingPhase of [0, 1, 2]) {
  test(`qualification stops after failed phase ${failingPhase}`, () => {
    const calls = [];
    const failure = new Error("phase failed");
    assert.throws(() => qualifySelectedHost((command, args) => {
      calls.push([command, args]);
      if (calls.length === failingPhase + 1) throw failure;
    }), error => error === failure);
    assert.equal(calls.length, failingPhase + 1);
  });
}

test("POSIX watchdog stops npm-style descendants before workspace cleanup", {
  skip: process.platform === "win32",
}, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "compat-watchdog-"));
  const marker = join(cwd, "descendant-survived");
  const ready = join(cwd, "descendant-ready");
  try {
    const descendant = `require('node:fs').writeFileSync(process.argv[2], 'ready'); setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'survived'), 1500)`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2], process.argv[3]], {stdio:'ignore'}); setInterval(() => {}, 1000)`;
    const result = runCompatibilityCommand(process.execPath, ["-e", parent, descendant, marker, ready], {
      cwd, encoding: "utf8", timeout: 1000,
    });
    assert.equal(result.error?.code, "ETIMEDOUT");
    assert.equal(existsSync(ready), true, "the descendant must actually start before the watchdog fires");
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(existsSync(marker), false, "a descendant must not keep using the workspace after timeout");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
