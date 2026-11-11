import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import spawn from "cross-spawn";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sealedNodePath } from "../scripts/lib/cursor-smoke-env.mjs";
import { writeRawTestEvidence } from "./helpers/raw-test-evidence.mjs";

const script = fileURLToPath(new URL("../scripts/ci-compatibility.mjs", import.meta.url));
for (const flag of ["-h", "--help"]) {
  test(`compatibility ${flag} works outside a checkout without installing or probing`, () => {
    const cwd = mkdtempSync(join(tmpdir(), "compat-help-"));
    try {
      const result = spawnSync(process.execPath, [script, flag], { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /--working-tree --official-only --versions 1\.5\.0/);
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

const { NATIVE_COMPATIBILITY_TEST_FILES, qualifySelectedHost, runCompatibilityCommand } =
  await import("../scripts/ci-compatibility-phases.mjs");

for (const scenario of [undefined, "build", "verify", "native", "forwarded"]) {
  test(`npm compatibility command runs its canonical phases: ${scenario ?? "pass"}`, (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "compat-command-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const log = join(cwd, "phases.jsonl");
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    mkdirSync(join(cwd, "scripts"));
    for (const file of ["ci-compatibility-native.mjs", "ci-compatibility-phases.mjs"]) {
      writeFileSync(join(cwd, "scripts", file), readFileSync(new URL(`../scripts/${file}`, import.meta.url)));
    }
    for (const phase of ["build", "verify"]) {
      writeFileSync(join(cwd, `${phase}.cjs`),
        `require("node:fs").appendFileSync(process.env.FIXTURE_COMPAT_LOG, JSON.stringify({phase:${JSON.stringify(phase)}})+"\\n");\n`
        + `if (process.env.FIXTURE_COMPAT_FAIL_PHASE === ${JSON.stringify(phase)}) process.exitCode = 1;\n`);
    }
    const files = [...NATIVE_COMPATIBILITY_TEST_FILES, ...(scenario === "forwarded" ? ["test/forwarded.test.mjs"] : [])];
    for (const file of files) {
      mkdirSync(dirname(join(cwd, file)), { recursive: true });
      writeFileSync(join(cwd, file),
        `import {appendFileSync} from "node:fs";\nimport assert from "node:assert/strict";\nimport test from "node:test";\n`
        + `test(${JSON.stringify(file)}, () => {\n`
        + `appendFileSync(process.env.FIXTURE_COMPAT_LOG, JSON.stringify({phase:"native",file:${JSON.stringify(file)}})+"\\n");\n`
        + `assert.notEqual(process.env.FIXTURE_COMPAT_FAIL_PHASE, "native");\n});\n`);
    }
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ private: true, scripts: {
      build: "node build.cjs", verify: "node verify.cjs", "check:compat": packageJson.scripts["check:compat"],
    } }));
    const env = { ...process.env, HOME: cwd, PATH: sealedNodePath(),
      FIXTURE_COMPAT_LOG: log, FIXTURE_COMPAT_FAIL_PHASE: scenario ?? "",
      npm_config_update_notifier: "false" };
    delete env.NODE_TEST_CONTEXT;
    delete env.BASH_ENV;
    const args = ["run", "check:compat", ...(scenario === "forwarded" ? ["--", "test/forwarded.test.mjs"] : [])];
    const result = spawn.sync("npm", args, { cwd, encoding: "utf8", env });
    if (process.env.PI_CURSOR_TEST_EVIDENCE_DIR) writeRawTestEvidence(process.env.PI_CURSOR_TEST_EVIDENCE_DIR,
      `compat-command-${scenario ?? "pass"}.json`, JSON.stringify({ status: result.status,
        signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr,
        phases: readFileSync(log, "utf8") }, null, 2));
    assert.equal(result.status, ["build", "verify", "native"].includes(scenario) ? 1 : 0, result.stderr + result.stdout);
    const events = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events[0].phase, "build");
    if (scenario === "build") assert.equal(events.length, 1);
    else {
      assert.equal(events[1].phase, "verify");
      if (scenario === "verify") assert.equal(events.length, 2);
      else assert.deepEqual(events.slice(2).map(event => event.file).sort(), [...files].sort());
    }
  });
}

test("qualification gives build, verify and native contracts independent commands", (t) => {
  const spawn = t.mock.method(childProcess, "spawnSync", () => ({ status: 0 }));
  syncBuiltinESMExports();
  try {
    qualifySelectedHost((command, args) => runCompatibilityCommand(command, args, {}));
    const calls = spawn.mock.calls.map(call => call.arguments);
    assert.equal(calls[1][2].timeout, 360_000, "aggregate verify needs its own finite budget");
    assert.deepEqual(calls.map(([, , options]) => options.timeout), [180_000, 360_000, 180_000]);
    assert.deepEqual(calls.map(([command, args]) => [command, args]), [
      ["npm", ["run", "build"]], ["npm", ["run", "verify"]],
      [process.execPath, ["--test", ...NATIVE_COMPATIBILITY_TEST_FILES]],
    ]);

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

test("the native phase entry propagates a child termination signal", { skip: process.platform === "win32" }, (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "compat-signal-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const entry = join(cwd, "native-entry.mjs"), preload = join(cwd, "terminate-native.cjs");
  writeFileSync(entry, readFileSync(new URL("../scripts/ci-compatibility-native.mjs", import.meta.url)));
  writeFileSync(join(cwd, "ci-compatibility-phases.mjs"), readFileSync(new URL("../scripts/ci-compatibility-phases.mjs", import.meta.url)));
  writeFileSync(preload, 'if (process.execArgv.includes("--test")) process.kill(process.pid, "SIGTERM");\n');
  const env = { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [entry], { cwd, env, encoding: "utf8" });
  if (process.env.PI_CURSOR_TEST_EVIDENCE_DIR) writeRawTestEvidence(process.env.PI_CURSOR_TEST_EVIDENCE_DIR,
    "compat-command-signal.json", JSON.stringify({ status: result.status, signal: result.signal,
      error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2));
  assert.equal(result.signal, "SIGTERM", result.stderr + result.stdout);
  assert.equal(result.status, null);
});

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
