import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const NATIVE_COMPATIBILITY_TEST_FILES = Object.freeze([
  "test/ci-compatibility.test.mjs",
  "test/native-provider.test.mjs",
  "test/native-cursor-flow.test.mjs",
  "test/native-cursor-ownership.test.mjs",
  "test/native-cursor-prompt.test.mjs",
]);

/** Separate command watchdogs; a failed phase prevents every later phase. */
export function qualifySelectedHost(run) {
  run("npm", ["run", "build"]);
  run("npm", ["run", "verify"]);
  run(process.execPath, ["--test", ...NATIVE_COMPATIBILITY_TEST_FILES]);
}

const FIRST_USE_MARKER = "PI_CURSOR_SDK_FIRST_USE_OK";
const BLOCKED_MARKER = "PI_CURSOR_SDK_PROBE_BLOCKED";

// Defense in depth for this Node-only subprocess, not an OS network sandbox:
// native addons can bypass these JavaScript hooks. Do not invoke SDK APIs here.
const firstUseGuard = `
const net = require("node:net"), tls = require("node:tls"), http = require("node:http"),
  https = require("node:https"), http2 = require("node:http2"), dns = require("node:dns"),
  dgram = require("node:dgram"), child = require("node:child_process"), workers = require("node:worker_threads");
function deny() { process.stderr.write("${BLOCKED_MARKER}\\n"); throw new Error("First-use probe blocked network or subprocess"); }
net.Socket.prototype.connect = net.connect = net.createConnection = tls.connect = deny;
http.request = http.get = https.request = https.get = http2.connect = globalThis.fetch = deny;
dgram.createSocket = dgram.Socket.prototype.connect = dgram.Socket.prototype.send = deny;
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (name === "lookup" || name === "lookupService" || name.startsWith("resolve") || name === "reverse") target[name] = deny;
  }
}
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) child[name] = deny;
workers.Worker = deny;
require("node:module").syncBuiltinESMExports();
`;

/** First use through the selected npm Pi host, separately from the startup-only RPC probe. */
export function probePackedSdkFirstUse({ label, cli, extension, root, env }) {
  const home = mkdtempSync(join(root, "sdk-first-use-"));
  try {
    const agent = join(home, "agent");
    const temp = join(home, "tmp");
    mkdirSync(agent);
    mkdirSync(temp);
    writeFileSync(join(agent, "auth.json"), "{}");
    const runtime = pathToFileURL(resolve(extension, "dist", "cursor-sdk-runtime.js")).href;
    const extensionFile = join(home, "first-use.mjs");
    writeFileSync(extensionFile, `
import { loadCursorSdk } from ${JSON.stringify(runtime)};
export default async function () {
  const first = loadCursorSdk(), second = loadCursorSdk();
  if (!first || typeof first.then !== "function" || first !== second) throw new Error("First-use SDK promise is not shared");
  const sdk = await first;
  const required = {
    Agent: sdk.Agent, "Agent.create": sdk.Agent?.create, "Agent.resume": sdk.Agent?.resume,
    "Agent.archive": sdk.Agent?.archive, "Agent.delete": sdk.Agent?.delete, "Agent.getUsage": sdk.Agent?.getUsage,
    "Agent.messages.list": sdk.Agent?.messages?.list, Cursor: sdk.Cursor, "Cursor.configure": sdk.Cursor?.configure,
    "Cursor.models.list": sdk.Cursor?.models?.list, createAgentPlatform: sdk.createAgentPlatform,
    getDefaultSdkStateRoot: sdk.getDefaultSdkStateRoot,
  };
  for (const [name, value] of Object.entries(required)) if (typeof value !== "function") throw new Error("Missing SDK export: " + name);
  process.stderr.write("${FIRST_USE_MARKER}\\n");
}
`);
    const guardFile = join(home, "deny-network.cjs");
    writeFileSync(guardFile, firstUseGuard);
    // Retain only OS process-launch and locale settings; never inherit provider credentials.
    const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "LC_CTYPE"]);
    const isolated = Object.fromEntries(Object.entries({ ...process.env, ...env })
      .filter(([name]) => allowed.has(name.toUpperCase())));
    Object.assign(isolated, {
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
      TMPDIR: temp, TMP: temp, TEMP: temp, PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_CURSOR_SETTING_SOURCES: "none", CI: "true",
    });
    const result = runCompatibilityCommand(process.execPath, ["--require", guardFile, cli, "--offline", "--mode", "rpc", "--no-session",
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve", "-e", extensionFile], {
      cwd: home, env: isolated, input: '{"id":"first-use","type":"get_commands"}\n',
      encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) throw new Error(`${label}: SDK first-use process failed: ${result.error.message}`, { cause: result.error });
    assert.equal(result.status, 0, `${label}: SDK first-use process exited with ${result.status}: ${result.stderr}`);
    assert.ok(!result.stderr.includes(BLOCKED_MARKER), `${label}: SDK first-use attempted network or a subprocess: ${result.stderr}`);
    let events;
    try {
      events = result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      throw new Error(`${label}: SDK first-use emitted invalid RPC output`, { cause: error });
    }
    assert.deepEqual(events.filter(event => event.type === "extension_error"), [], `${label}: SDK first-use extension failed`);
    assert.ok(!events.some(event => event.type === "agent_start"), `${label}: SDK first-use unexpectedly started a model turn`);
    assert.ok(events.some(event => event.id === "first-use" && event.success === true), `${label}: SDK first-use RPC failed`);
    const markerCount = result.stderr.split(/\r?\n/).filter(line => line === FIRST_USE_MARKER).length;
    assert.ok(markerCount === 1, `${label}: SDK first-use marker ${markerCount === 0 ? "missing" : "duplicated"}: ${result.stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Own POSIX descendants so a timed-out npm cannot outlive isolated-root cleanup. */
export function runCompatibilityCommand(command, args, options) {
  const defaultTimeout = command === "npm" && args.length === 2 && args[0] === "run" && args[1] === "verify"
    ? 360_000 : 180_000;
  const result = spawnSync(command, args, {
    ...options,
    timeout: options.timeout ?? defaultTimeout,
    detached: process.platform !== "win32",
    killSignal: "SIGKILL",
  });
  if (result.error && result.pid && process.platform !== "win32") {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch (error) {
      // An already-exited group has no descendants left to stop.
      if (error.code !== "ESRCH") throw error;
    }
  }
  return result;
}
