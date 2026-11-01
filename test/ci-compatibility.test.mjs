import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const { probePackedSdkFirstUse, qualifySelectedHost, runCompatibilityCommand } =
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

function firstUseFixture() {
  const dir = mkdtempSync(join(tmpdir(), "compat-first-use-"));
  const root = join(dir, "homes");
  const extension = join(dir, "install space # % ' é", "pi-cursor-sdk");
  const cli = join(dir, "fake-pi.mjs");
  mkdirSync(root);
  mkdirSync(join(extension, "dist"), { recursive: true });
  const host = (runExtension = true) => writeFileSync(cli, `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
assert.equal(process.env.PI_OFFLINE, "1");
assert.equal(process.env.CURSOR_API_KEY, undefined);
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.deepEqual(JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8")), {});
for (const flag of ["--offline", "--mode", "--no-session", "--no-extensions", "-e"]) assert.ok(process.argv.includes(flag));
${runExtension ? 'await (await import(pathToFileURL(process.argv.at(-1)).href)).default();' : 'process.stderr.write("PI_CURSOR_SDK_FIRST_USE_OK suffix\\n");'}
console.log(JSON.stringify({ id: "first-use", type: "response", success: true }));
`);
  const runtime = (mutation = "", loader = "shared") => writeFileSync(join(extension, "dist", "cursor-sdk-runtime.js"), `
const uncalled = () => { throw new Error("SDK API must not be invoked"); };
const Agent = Object.assign(function Agent() {}, { create: uncalled, resume: uncalled, archive: uncalled,
  delete: uncalled, getUsage: uncalled, messages: { list: uncalled } });
const Cursor = Object.assign(function Cursor() {}, { configure: uncalled, models: { list: uncalled } });
const sdk = { Agent, Cursor, createAgentPlatform: uncalled, getDefaultSdkStateRoot: uncalled };
${mutation}
const shared = Promise.resolve(sdk);
export function loadCursorSdk() { return ${loader}; }
`);
  const run = () => probePackedSdkFirstUse({
    label: "fixture", cli, extension, root,
    env: { PATH: process.env.PATH, CURSOR_API_KEY: "must-not-leak", OPENAI_API_KEY: "must-not-leak", NODE_OPTIONS: "--bad" },
  });
  host();
  runtime();
  return { dir, root, host, runtime, run };
}

test("packed first-use probe checks the shared promise and exports with empty auth in an isolated RPC process", () => {
  const fixture = firstUseFixture();
  try {
    fixture.run(); // Fake SDK methods throw if called; special characters exercise the file URL.
    assert.deepEqual(readdirSync(fixture.root), [], "probe home must be removed after success");
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("first-use probe fails closed on unshared promises, missing SDK functions, or missing marker", () => {
  const fixture = firstUseFixture();
  try {
    fixture.runtime("", "Promise.resolve(sdk)");
    assert.throws(fixture.run, /First-use SDK promise is not shared/);
    fixture.runtime('const failure = Promise.reject(new Error("SDK import rejected"));', "failure");
    assert.throws(fixture.run, /SDK import rejected/);
    for (const name of ["Agent", "Agent.create", "Agent.resume", "Agent.archive", "Agent.delete", "Agent.getUsage",
      "Agent.messages.list", "Cursor", "Cursor.configure", "Cursor.models.list", "createAgentPlatform", "getDefaultSdkStateRoot"]) {
      fixture.runtime(`delete sdk.${name};`);
      assert.throws(fixture.run, new RegExp(`Missing SDK export: ${name.replaceAll(".", "\\.")}`));
    }
    fixture.host(false);
    assert.throws(fixture.run, /SDK first-use marker missing/);
    writeFileSync(join(fixture.dir, "fake-pi.mjs"), `process.stderr.write("PI_CURSOR_SDK_FIRST_USE_OK\\nPI_CURSOR_SDK_FIRST_USE_OK\\n");
console.log(JSON.stringify({id: "first-use", success: true}));`);
    assert.throws(fixture.run, /SDK first-use marker duplicated/);
    writeFileSync(join(fixture.dir, "fake-pi.mjs"), 'console.log("not-json");');
    assert.throws(fixture.run, /SDK first-use emitted invalid RPC output/);
    for (const type of ["extension_error", "agent_start"]) {
      writeFileSync(join(fixture.dir, "fake-pi.mjs"), `process.stderr.write("PI_CURSOR_SDK_FIRST_USE_OK\\n");
console.log(JSON.stringify({type: ${JSON.stringify(type)}}));
console.log(JSON.stringify({id: "first-use", success: true}));`);
      assert.throws(fixture.run, type === "extension_error" ? /extension failed/ : /unexpectedly started a model turn/);
    }
    assert.deepEqual(readdirSync(fixture.root), [], "probe home must be removed after failures");
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("first-use Node guard rejects even a caught fetch or socket attempt", () => {
  const fixture = firstUseFixture();
  try {
    for (const attempt of [
      'try { fetch("https://invalid.example/"); } catch {}',
      'try { (await import("node:net")).connect(9, "127.0.0.1"); } catch {}',
    ]) {
      fixture.runtime(attempt);
      assert.throws(fixture.run, /attempted network or a subprocess/);
      assert.deepEqual(readdirSync(fixture.root), []);
    }
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("first-use probe propagates watchdog failures and cleans up", (t) => {
  const fixture = firstUseFixture();
  const spawn = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.equal(options.timeout, 30_000);
    assert.ok(args.includes("--require"));
    return { status: null, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
  });
  syncBuiltinESMExports();
  try {
    assert.throws(fixture.run, /fixture: SDK first-use process failed: timed out/);
    assert.deepEqual(readdirSync(fixture.root), []);
    assert.equal(spawn.mock.callCount(), 1);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
