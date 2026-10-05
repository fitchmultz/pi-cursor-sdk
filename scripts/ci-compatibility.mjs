#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { NATIVE_COMPATIBILITY_TEST_FILES, qualifySelectedHost, runCompatibilityCommand } from "./ci-compatibility-phases.mjs";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/ci-compatibility.mjs --automation PATH [--official-version VERSION] [--fork-ref SHA] [--select-only]
CI resolves latest stable official Pi and maintained fork main once; supplied identities stay frozen.
--select-only installs the selected official graph for subsequent native platform checks.

Manual qualification: node scripts/ci-compatibility.mjs [--working-tree] [--official-only] [--versions 0.87.1,0.99.1,1.0.2]
Default manual invocation requires a clean checkout and checks official minimum/latest and current fork offline.
--working-tree  Build an isolated snapshot of tracked and nonignored new files, without committing.
--official-only Skip the fork clone/build.
--versions      Select exact official releases (manual default: minimum/latest).
Manual selection flags cannot be combined with --automation.

Examples:
  node scripts/ci-compatibility.mjs --automation ../automation
  node scripts/ci-compatibility.mjs --working-tree --official-only --versions 0.87.1,0.99.1,1.0.2
Exit codes: 0 success/help; 1 qualification or invalid argument failure.`);
  process.exit(0);
}
let versions, automation;
let officialVersion = "latest", forkRef = "main";
for (let index = 0; index < args.length; index++) {
  if (["--working-tree", "--official-only", "--select-only"].includes(args[index])) continue;
  if (args[index] === "--versions" && /^\d+\.\d+\.\d+(,\d+\.\d+\.\d+)*$/.test(args[index + 1] ?? "")) {
    versions = args[++index].split(",");
  } else if (args[index] === "--automation" && args[index + 1] && !args[index + 1].startsWith("--")) {
    automation = resolve(args[++index]);
  } else if (args[index] === "--official-version" && /^(latest|\d+\.\d+\.\d+)$/.test(args[index + 1] ?? "")) {
    officialVersion = args[++index];
  } else if (args[index] === "--fork-ref" && /^(main|[a-f0-9]{40})$/.test(args[index + 1] ?? "")) {
    forkRef = args[++index];
  } else throw new Error(`Invalid argument: ${args[index]}. Use --help.`);
}
if (automation) {
  assert.ok(!versions && !args.includes("--working-tree") && !args.includes("--official-only"), "Manual selection flags cannot be combined with --automation");
} else {
  assert.ok(!args.some(arg => ["--official-version", "--fork-ref", "--select-only"].includes(arg)), "Pass --automation with the pinned shared helpers for CI selection");
}
const source = process.cwd();
// Native host tests create nested sockets; keep the POSIX root short.
const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "pc-"));
let env;
if (automation) {
  const { isolatedEnvironment } = await import(pathToFileURL(join(automation, "scripts/common.mjs")));
  env = { ...isolatedEnvironment(root), PI_CURSOR_SETTING_SOURCES: "none" };
} else {
  const home = join(root, "home");
  mkdirSync(home);
  mkdirSync(join(root, "tmp"));
  const userConfig = join(root, "user.npmrc");
  const globalConfig = join(root, "global.npmrc");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  env = {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home, XDG_CONFIG_HOME: home, TMPDIR: join(root, "tmp"),
    PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0", PI_CURSOR_SETTING_SOURCES: "none", GIT_TERMINAL_PROMPT: "0", CI: "true",
    npm_config_registry: "https://registry.npmjs.org",
    npm_config_cache: process.env.npm_config_cache ?? join(root, "npm-cache"),
    npm_config_audit: "false", npm_config_fund: "false",
    npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
  };
}

function run(command, args, cwd = source, capture = false, commandEnv = env) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = runCompatibilityCommand(command, args, {
    cwd,
    env: commandEnv,
    encoding: "utf8",
    shell: process.platform === "win32" && command === "npm",
    stdio: capture ? "pipe" : "inherit",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr ?? ""}`);
  return result.stdout ?? "";
}

function buildFork(fork) {
  const forkSha = run("git", ["rev-parse", "HEAD"], fork, true).trim();
  assert.match(forkSha, /^[a-f0-9]{40}$/);
  console.log(`Fork host: fitchmultz/pi@${forkSha}`);
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], fork);
  run("npm", ["run", "hydrate:model-data"], fork);
  run("npm", ["run", "build:offline"], fork);
  return forkSha;
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
  if (automation) {
    const { prepareHost, selectDevelopmentHost } = await import(pathToFileURL(join(automation, "scripts/hosts.mjs")));
    const { writeJson } = await import(pathToFileURL(join(automation, "scripts/common.mjs")));
    const automationRelative = relative(source, automation);
    const sourcePaths = automationRelative.startsWith("..") ? [] : ["--", ".", `:(exclude)${automationRelative}`];
    assert.equal(run("git", ["status", "--porcelain", ...sourcePaths], source, true), "", "Clean checkout required before compatibility qualification");
    const official = await prepareHost(join(root, "official"), "official", officialVersion, env);
    const selected = selectDevelopmentHost(source, official, env);
    const evidence = process.env.PI_COMPAT_EVIDENCE_DIR || join(source, ".artifacts", "ci-compatibility");
    mkdirSync(evidence, { recursive: true });
    writeJson(join(evidence, "official.json"), { provenance: official.provenance, ...selected });
    Object.assign(env, { PI_COMPAT_HOST: "official", PI_COMPAT_EXPECTED_VERSION: selected.version,
      PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir, PI_PACKAGE_DIR: selected.packageDir,
      PI_HOST_INDEX: selected.index, PI_HOST_CLI: selected.cli });
    if (args.includes("--select-only")) {
      console.log(`Selected official Pi ${selected.version} for native platform checks.`);
    } else {
      qualifySelectedHost(run);
      // Retain latest-SDK emit, but pack the reviewed locked runtime bundle.
      run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
      Object.assign(env, { PI_COMPAT_EXPECTED_PACKAGE_DIR: official.packageDir,
        PI_PACKAGE_DIR: official.packageDir, PI_HOST_INDEX: official.index, PI_HOST_CLI: official.cli });
      // npm 11 returns an array; npm 12 keys the same records by package name.
      const packed = Object.values(JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], source, true)));
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
      run("git", ["-C", fork, "fetch", "--depth", "1", "origin", forkRef]);
      run("git", ["-C", fork, "checkout", "--detach", "--quiet", "FETCH_HEAD"]);
      const forkSha = buildFork(fork);
      const forkPackages = join(root, "fork-package");
      run(process.execPath, [join(automation, "scripts/pack-fork.mjs"), fork, forkPackages, forkSha], fork);
      const forkHost = await prepareHost(join(root, "fork-host"), "fork", forkPackages, env);
      const forkSelected = selectDevelopmentHost(source, forkHost, env);
      writeJson(join(evidence, "fork.json"), { provenance: forkHost.provenance, ...forkSelected });
      Object.assign(env, { PI_COMPAT_HOST: "fork", PI_COMPAT_EXPECTED_VERSION: forkSelected.version,
        PI_COMPAT_EXPECTED_PACKAGE_DIR: forkSelected.packageDir, PI_PACKAGE_DIR: forkSelected.packageDir,
        PI_HOST_INDEX: forkSelected.index, PI_HOST_CLI: forkSelected.cli });
      qualifySelectedHost(run);
      probe("fork-npm", forkHost.packageDir, npmExtension);
      probe("fork-git", forkHost.packageDir, gitExtension);
      console.log("Official Pi and the current fork load both installed Cursor extension forms offline.");
    }
  } else {
    if (!args.includes("--working-tree")) assert.equal(run("git", ["status", "--porcelain"], source, true), "", "Clean checkout required (use --working-tree for authorized uncommitted changes)");
    if (!versions) {
      const latest = JSON.parse(run("npm", ["view", "@earendil-works/pi-coding-agent", "dist-tags.latest", "--json"], source, true));
      assert.match(latest, /^\d+\.\d+\.\d+$/, "Official Pi latest must be a stable release");
      versions = ["0.87.1", latest];
    }
    const gitExtension = join(root, "git-consumer");
    if (args.includes("--working-tree")) {
      mkdirSync(gitExtension);
      const sourceFiles = () => run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], source, true).split("\0").filter(Boolean);
      const files = sourceFiles();
      const manifest = [];
      for (const file of new Set(files)) {
        // Exclude local state even when accidentally tracked or symlinked.
        if (file.split("/").some(part => ["node_modules", ".git", ".pi", ".debug", ".artifacts", "dist", "coverage"].includes(part) || part.startsWith(".env"))) continue;
        const from = join(source, file);
        if (!existsSync(from)) continue; // tracked deletion
        assert.ok(lstatSync(from).isFile(), `Snapshot requires regular files: ${file}`);
        const to = join(gitExtension, file);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        manifest.push({ path: file, sha256: createHash("sha256").update(readFileSync(to)).digest("hex") });
      }
      assert.deepEqual(sourceFiles(), files, "Source inventory changed while snapshotting; retry once edits stop");
      for (const file of manifest) assert.equal(createHash("sha256").update(readFileSync(join(source, file.path))).digest("hex"), file.sha256, `Source changed while snapshotting: ${file.path}`);
      console.log(`Exact working-tree snapshot SHA256: ${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")} (${manifest.length} files)`);
      run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], gitExtension);
      run("npm", ["run", "build"], gitExtension);
    } else {
      run("git", ["clone", "--no-hardlinks", "--quiet", source, gitExtension]);
      run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], gitExtension);
    }
    // npm 11 returns an array; npm 12 keys the same records by package name.
    const packed = Object.values(JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], args.includes("--working-tree") ? gitExtension : source, true)));
    assert.equal(packed.length, 1);
    const tarball = join(root, packed[0].filename);
    const consumer = join(root, "npm-consumer");
    run("npm", ["install", "--prefix", consumer, "--omit=dev", "--no-audit", "--no-fund", tarball]);
    const npmExtension = join(consumer, "node_modules", "pi-cursor-sdk");
    for (const version of new Set(versions)) {
      const hostRoot = join(root, `official-${version}`);
      run("npm", ["install", "--prefix", hostRoot, "--omit=dev", "--ignore-scripts",
        "--no-audit", "--no-fund", `@earendil-works/pi-coding-agent@${version}`]);
      const host = join(hostRoot, "node_modules", "@earendil-works", "pi-coding-agent");
      probe(`official-${version}`, host, npmExtension);
      if (args.includes("--working-tree")) {
        const nativeEnv = { ...env, PI_CURSOR_TEST_HOST: join(host, "dist", "index.js") };
        run(process.execPath, ["--test", ...NATIVE_COMPATIBILITY_TEST_FILES], gitExtension, false, nativeEnv);
      }
    }
    if (!args.includes("--official-only")) {
      const fork = join(root, "fork");
      run("git", ["clone", "--depth", "1", "--branch", "main", "--quiet", "https://github.com/fitchmultz/pi.git", fork]);
      buildFork(fork);
      const forkHost = join(fork, "packages", "coding-agent");
      probe("fork-npm", forkHost, npmExtension);
      probe("fork-git", forkHost, gitExtension);
    }
    console.log("Selected compatibility qualification passed offline.");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
