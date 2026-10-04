#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  "automation": { type: "string" }, "official-version": { type: "string", default: "latest" },
  "fork-ref": { type: "string", default: "main" }, "select-only": { type: "boolean", default: false },
  "help": { type: "boolean", short: "h", default: false },
} });
if (values.help) {
  console.log("Usage: ci-compatibility.mjs --automation PATH [--official-version VERSION] [--fork-ref SHA] [--select-only]\nDefaults resolve latest stable official Pi and maintained fork main. CI passes once-resolved identities.\n--select-only installs the selected official graph for subsequent native platform checks.\nExample: node scripts/ci-compatibility.mjs --automation ../automation\nExit codes: 0 passed/help, 1 invalid input or qualification failure.");
  process.exit(0);
}
assert.ok(values.automation, "Pass --automation with the pinned shared helpers");
assert.match(values["fork-ref"], /^(main|[a-f0-9]{40})$/, "Fork must be maintained main or this run's resolved SHA");
const automation = resolve(values.automation);
const { prepareHost, selectDevelopmentHost } = await import(pathToFileURL(join(automation, "scripts/hosts.mjs")));
const { isolatedEnvironment, writeJson } = await import(pathToFileURL(join(automation, "scripts/common.mjs")));

const source = process.cwd();
// Native host tests create nested sockets; keep the POSIX root short.
const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "pc-"));
const env = { ...isolatedEnvironment(root), PI_CURSOR_SETTING_SOURCES: "none" };

function run(command, args, cwd = source, capture = false) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    shell: process.platform === "win32" && command === "npm",
    stdio: capture ? "pipe" : "inherit",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr ?? ""}`);
  return result.stdout?.trim() ?? "";
}

function hostCli(host) {
  const manifest = JSON.parse(readFileSync(join(host, "package.json"), "utf8"));
  assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
  assert.ok(typeof manifest.bin?.pi === "string");
  const cli = join(host, manifest.bin.pi);
  assert.ok(existsSync(cli), `Missing Pi CLI: ${cli}`);
  return { cli, version: manifest.version };
}

function probe(label, host, extension) {
  const { cli, version } = hostCli(host);
  const probeHome = join(root, `probe-${label}`);
  mkdirSync(probeHome);
  const input = [
    { id: "models", type: "get_available_models" },
    { id: "commands", type: "get_commands" },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";
  const result = spawnSync(process.execPath, [cli, "--offline", "--mode", "rpc", "--no-session",
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--no-themes", "--no-approve", "-e", extension], {
    cwd: probeHome,
    env: { ...env, HOME: probeHome, XDG_CONFIG_HOME: probeHome,
      PI_CODING_AGENT_DIR: join(probeHome, "agent") },
    input,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${label}: Pi exited with ${result.status}: ${result.stderr}`);
  const events = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(events.filter((event) => event.type === "extension_error"), [], `${label}: extension load failed`);
  assert.ok(!events.some((event) => event.type === "agent_start"), `${label}: unexpected model turn`);
  const models = events.find((event) => event.id === "models");
  const commands = events.find((event) => event.id === "commands");
  assert.equal(models?.success, true, `${label}: model query failed`);
  assert.equal(commands?.success, true, `${label}: command query failed`);
  assert.ok(models.data.models.some((model) => model.provider === "cursor"), `${label}: Cursor models missing`);
  assert.ok(commands.data.commands.some((command) => command.name === "cursor-refresh-models"),
    `${label}: Cursor extension command missing`);
  console.log(`${label}: Pi ${version}, Cursor extension loaded without a model turn`);
}

try {
  const automationRelative = relative(source, automation);
  const sourcePaths = automationRelative.startsWith("..") ? [] : ["--", ".", `:(exclude)${automationRelative}`];
  assert.equal(run("git", ["status", "--porcelain", ...sourcePaths], source, true), "", "Commit changes before compatibility qualification");
  const official = await prepareHost(join(root, "official"), "official", values["official-version"], env);
  const selected = selectDevelopmentHost(source, official, env);
  const evidence = process.env.PI_COMPAT_EVIDENCE_DIR || join(source, ".artifacts", "ci-compatibility");
  mkdirSync(evidence, { recursive: true });
  writeJson(join(evidence, "official.json"), { provenance: official.provenance, ...selected });
  Object.assign(env, { PI_COMPAT_HOST: "official", PI_COMPAT_EXPECTED_VERSION: selected.version,
    PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir, PI_PACKAGE_DIR: selected.packageDir,
    PI_HOST_INDEX: selected.index, PI_HOST_CLI: selected.cli });
  if (values["select-only"]) {
    console.log(`Selected official Pi ${selected.version} for native platform checks.`);
  } else {
    run("npm", ["run", "check:compat"]);
    // Retain latest-SDK emit, but pack the reviewed locked runtime bundle.
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    Object.assign(env, { PI_COMPAT_EXPECTED_PACKAGE_DIR: official.packageDir,
      PI_PACKAGE_DIR: official.packageDir, PI_HOST_INDEX: official.index, PI_HOST_CLI: official.cli });

    const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], source, true));
    assert.equal(packed.length, 1);
    const tarball = join(root, packed[0].filename);
    const consumer = join(root, "npm-consumer");
    run("npm", ["install", "--prefix", consumer, "--omit=dev", "--no-audit", "--no-fund", tarball]);
    const npmExtension = join(consumer, "node_modules", "pi-cursor-sdk");

    const gitExtension = join(root, "git-consumer");
    run("git", ["clone", "--no-hardlinks", "--quiet", source, gitExtension]);
    run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], gitExtension);

    probe(`official-${official.version}`, official.packageDir, npmExtension);
    probe("official-git", official.packageDir, gitExtension);

    const fork = join(root, "fork");
    run("git", ["init", "--quiet", fork]);
    run("git", ["-C", fork, "remote", "add", "origin", "https://github.com/fitchmultz/pi.git"]);
    run("git", ["-C", fork, "fetch", "--depth", "1", "origin", values["fork-ref"]]);
    run("git", ["-C", fork, "checkout", "--detach", "--quiet", "FETCH_HEAD"]);
    const forkSha = run("git", ["rev-parse", "HEAD"], fork, true);
    assert.match(forkSha, /^[a-f0-9]{40}$/);
    console.log(`Fork host: fitchmultz/pi@${forkSha}`);
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], fork);
    run("npm", ["run", "hydrate:model-data"], fork);
    run("npm", ["run", "build:offline"], fork);
    const forkPackages = join(root, "fork-package");
    run(process.execPath, [join(automation, "scripts/pack-fork.mjs"), fork, forkPackages, forkSha], fork);
    const forkHost = await prepareHost(join(root, "fork-host"), "fork", forkPackages, env);
    const forkSelected = selectDevelopmentHost(source, forkHost, env);
    writeJson(join(evidence, "fork.json"), { provenance: forkHost.provenance, ...forkSelected });
    Object.assign(env, { PI_COMPAT_HOST: "fork", PI_COMPAT_EXPECTED_VERSION: forkSelected.version,
      PI_COMPAT_EXPECTED_PACKAGE_DIR: forkSelected.packageDir, PI_PACKAGE_DIR: forkSelected.packageDir,
      PI_HOST_INDEX: forkSelected.index, PI_HOST_CLI: forkSelected.cli });
    run("npm", ["run", "check:compat"]);
    probe("fork-npm", forkHost.packageDir, npmExtension);
    probe("fork-git", forkHost.packageDir, gitExtension);
    console.log("Official Pi and the current fork load both installed Cursor extension forms offline.");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
