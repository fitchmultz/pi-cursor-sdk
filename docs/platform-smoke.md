# Platform Smoke Gate

Status: current local-runtime release gate for Cursor provider/runtime changes. Cloud-runtime changes also require the separate paid `npm run smoke:cloud` gate. The Crabbox runner, packed-install platform-build suite, and real live PTY/ConPTY suite runner are implemented for macOS, Ubuntu, and Windows native targets with one-lease-per-target orchestration.

Detailed detector, registry, command-rendering, implementation-history, replacement, and portability reference: [Platform Smoke Implementation Reference](./platform-smoke-implementation.md).

Branch introduced by: `feat/crabbox-platform-smoke`

Oracle review incorporated: this gate resolves the packed-install workspace conflict, Cursor budget contradiction, Windows shell drift, artifact-on-failure gap, render-location ambiguity, provider-debug ambiguity, and registry-classification gap called out during review.

Crabbox best-practice baseline applied from `~/Projects/crabbox`: Crabbox owns lease, sync, run, evidence transport, and cleanup; this repo owns target policy, package setup, scenario meaning, assertions, artifacts, auth forwarding, redaction, and release criteria.

## Decision

Crabbox is the required local platform smoke runner for `pi-cursor-sdk` releases that touch Cursor provider/runtime behavior. PRs that touch actual cloud runtime execution must also run `npm run smoke:cloud`.

Inner-loop checks remain useful, but they are not release gates:

```bash
npm run verify
npm pack --dry-run
```

The required local release gate is exactly:

```bash
npm run smoke:platform:all
```

Cloud-runtime changes additionally require:

```bash
npm run smoke:cloud
```

`smoke:platform:all` runs `smoke:platform:doctor` first and only starts the target matrix after doctor passes. Maintainers may still run `npm run smoke:platform:doctor` by itself for setup diagnosis.


Per-target commands exist for diagnosis and iteration. They are not additional release-gate commands because requiring each per-target command plus `all` doubles Cursor token use.

No partial adoption exists. The release evidence must include macOS, Ubuntu, and Windows native passing through `smoke:platform:all`.

## Non-negotiable constraints

- No GitHub Actions dependency.
- No cloud provider dependency in the default local platform gate; cloud-runtime changes use the separate paid cloud gate.
- No Crabbox broker/coordinator dependency.
- No release gate that runs on only one operating system.
- No release gate that proves command behavior but not TUI visual behavior.
- No platform release gate based on `pi -e .`.
- No skipped target because setup is missing; missing setup is a doctor failure.
- No one-prompt-per-card visual matrix.
- No `tmux` as the canonical visual test contract.
- No target passes from stdout alone when JSONL or visual proof is required.
- No target loses artifacts on failure.
- No hidden optional evidence. Every required artifact is produced or the suite fails.

## Required Crabbox baseline

The runner uses one supported Crabbox build.

Current baseline:

```text
install: brew install openclaw/tap/crabbox
version: 0.26.0 or newer
binary: Homebrew `crabbox` on PATH (`/opt/homebrew/bin/crabbox` on Apple Silicon Homebrew installs)
```

Use the Homebrew Crabbox binary on PATH for normal release gates. `PLATFORM_SMOKE_CRABBOX=/path/to/crabbox` is only an explicit override for testing a non-default binary. `smoke:platform:doctor` verifies the configured binary and fails when it is older than the configured minimum version.

Required Crabbox providers:

- `local-container` for Ubuntu.
- `ssh` static localhost for macOS. Static localhost leases use Crabbox's shared `static_localhost` lease id, so the runner passes `--reclaim` during macOS warmup to claim that lease for this repository before running suites.
- `parallels` for Windows native.

## Architecture

The source of truth is:

```text
scenario + target capability + artifact contract
```

not a one-off shell script.

Crabbox is deliberately kept as the transport/lifecycle layer. It must not be treated as proof that the pi extension behavior passed; every suite still fails or passes from project-owned assertions and artifact manifests.

High-level flow:

```text
platform-smoke.config.mjs
  -> target definition
  -> target session manager
  -> scenario suite runner
  -> PTY/ConPTY capture on the target
  -> artifact package/download
  -> host-side xterm/Playwright render
  -> visual evidence screenshot/assertion engine
  -> JSONL/assertion engine
  -> artifact manifest
```

Rendering is host-side. Targets capture the real ANSI stream; the macOS host renders it and captures per-evidence screenshots from the rendered xterm DOM. This keeps the renderer identical across macOS, Ubuntu, and Windows native and avoids browser dependency drift inside test targets.

## Target session model

Each target opens one Crabbox target session, syncs once, runs all suites for that target under one coherent target run id, collects artifacts, and stops/releases the target. The release-gate entrypoint runs required targets sequentially to prevent shared host, VM/container, and Cursor API contention; each target runs its own suites in order and fails fast within that target. Platform smoke disables Crabbox git-seed sync (`CRABBOX_SYNC_GIT_SEED=false`) so every run tests the current local checkout and uncommitted smoke-runner changes rather than a remote Git seed.

```text
start target session
  verify target prerequisites
  acquire or warm target
  create unique remote run root
  sync checkout once into extensionSourceRoot
  run platform-build
  run cursor-native-visual-matrix
  run cursor-http1-live
  run cursor-bridge-visual-matrix
  run cursor-abort-cleanup
  run cursor-local-resume-restart
  run cursor-local-resume-safety
  run cursor-local-resume-tool-surface
  run cursor-local-resume-abort
  run cursor-local-resume-tree
  run cursor-local-resume-copy-switch
  run cursor-local-resume-fallback
  run cursor-local-resume-compaction
  run cursor-local-resume-default-dry-run
  run cursor-local-resume-cleanup
  download artifacts after every suite
  stop target
  write lease-cleanup stop evidence
end target session
```

The target session fails fast. The release-gate path handles one target at a time: it warms one Crabbox lease, performs one fresh sync, runs suites in order, and stops that target after the first failure before starting the next target. Total wall time is therefore additive across required targets; this avoids nondeterministic worker loss and live-run stalls from competing VM/container load and concurrent Cursor API calls. Per-suite commands remain available for diagnosis, but they are intentionally not the normal release path because repeated warmup/sync/install cycles make releases too slow.

Runtime budget is part of the contract:

- `smoke:platform:doctor` never calls Cursor.
- `platform-build` runs once per target and is the only suite that performs the full local CI/build/typecheck/package gate. Its target invocations raise only Vitest's default per-test timeout to 15 seconds for host-contention headroom; normal `npm test` keeps the 5-second default, and explicit longer integration-test timeouts still apply.
- Live suites reuse the target checkout and prepared `node_modules` when run after `platform-build`; they do not repeat `npm ci` in a target-session release run. Their interactive Pi process sets `PI_OFFLINE=1` to skip unrelated startup catalog/update probes; the scenario's explicit Cursor provider turn remains live. The PTY launches Pi's JavaScript entry with direct Node argv so multiline prompts remain one positional message on every target.
- Live and local-resume suites share one target-local packed-install prep directory per target-session release run. The first such suite runs `npm pack` and `npm install --no-save <tarball>` once. Visual/abort suites install that packed path with `pi install --approve -l`; local-resume lanes pass the same packed package path to their source-tree smoke harness instead of loading the checkout extension.
- Visual coverage is batched into one native prompt, one focused HTTP/1.1 transport prompt, one bridge prompt, and one abort/cleanup prompt per target. Do not split the card matrices into one prompt per card.
- The gate is fail-fast by target to avoid burning Cursor calls after a platform has already failed.

## Required targets

| Target | Crabbox provider | Execution contract | TUI visual contract |
| --- | --- | --- | --- |
| `macos` | `ssh` static localhost | native macOS shell | PTY ANSI capture and host-side render |
| `ubuntu` | `local-container` | Docker Ubuntu container | PTY ANSI capture and host-side render |
| `windows-native` | `parallels` | Windows 11 clone, native PowerShell/Node | ConPTY ANSI capture and host-side render |

Ubuntu is covered as its own local-container target, and Windows native remains a full visual TUI target.

## Required cloud smoke gate

Cloud validation stays separate from `smoke:platform:all`. Releases that touch actual cloud execution must run both the local platform gate and:

```bash
npm run smoke:cloud
```

The no-flag command is the required `cursor/grok-4.6` matrix. It uses current `gh` CLI authentication to create one private throwaway GitHub repository, seeds clean `main`, `starting-ref`, and `direct-push` branches, and runs persisted-session named lanes for:

- cancellation, with exact agent/run IDs captured before abort, retained `runIdSource` (`metadata` or installed-SDK `Agent.listRuns()` recovery), and terminal `cancelled` independently read through the SDK;
- explicit HTTPS repository plus `startingRef`, requiring a distinct pushed cloud branch with remote-content and starting-ref-ancestry proof, recording whether the SDK returned branch metadata, and validating any returned PR URL through GitHub;
- explicit direct-push opt-in, independently fetching the remote branch and checking its changed file content;
- a nonexistent starting branch, which must fail closed;
- `/cursor-cloud delete <exact bc-id> --yes` in the run's persisted session, followed by independent `Agent.get` not-found/404 and archived-inclusive list exclusion;
- passive artifacts and raw usage, recording observed true/false and validating bounded known shapes when the account returns either. Absence is an observation, not a skipped lane.

Prerequisites are intentionally strict: `CURSOR_API_KEY` with cloud entitlement, Cursor's GitHub integration with access to the new private repository, and `gh` auth with private-repository create, clone/push, inspect, and delete capability. Missing auth, entitlement, integration/access, required output, or any cleanup proof fails the gate. The GitHub mutation scope is destructive but bounded to self-created repositories named `pi-cursor-cloud-smoke-<uuid>` with an exact ownership-marker description. A cleanup handle is exposed only after create ownership is established (or an ambiguous create probe observes that exact marker). Deletion rejects arbitrary repository handles and independently requires an authenticated GitHub API HTTP 404 afterward.

Every path harvests exact IDs from provider metadata and canonical lifecycle session JSONL/journals. Final cleanup takes their union, archives every still-existing agent, requires `archived: true`, deletes it, then requires `Agent.get` not-found/404 and `Agent.list({ runtime: "cloud", includeArchived: true })` exclusion. `SIGINT` and `SIGTERM` first terminate the active detached Pi child, reject the lane, and then enter the same agent/repository cleanup coordinator before the process exits. Evidence is staged to a temporary file, then an event-loop signal checkpoint runs immediately before the atomic rename; that rename is the evidence commit point. A signal observed before it discards staged evidence. A signal dispatched after it but before the final terminal checkpoint still fails the process and suppresses the success marker, while the committed completed-cleanup summary remains valid. Emitting the success marker is the terminal-success boundary. Signal handlers stay installed through process teardown and independently set a failing exit code, so a still-active process cannot exit successfully if a signal is dispatched after that boundary, even when the marker was already written. Cleanup or repository-deletion verification failure fails the gate and retains the raw temporary artifact root. Successful runs remove raw artifacts unless `CURSOR_CLOUD_SMOKE_KEEP_ARTIFACTS=1`.

Before removing successful raw artifacts, the gate atomically replaces `docs/evidence/cursor-cloud-smoke-matrix-latest.json` with a known-shape summary containing timestamp, model, lane observations, exact agent/run IDs, agent cleanup proof, repository cleanup proof, and retained evidence provenance. Provenance records the extension package version, installed `@cursor/sdk` version, git source revision, and a deterministic `packageSourceSha256` over the full published package surface from `package.json` `files` plus `package.json` itself (relative path + bytes; directories expanded; symlinks/non-regular paths rejected). Generated `docs/evidence/*` is outside that published surface and is not hashed. Because successful pre-commit checkouts may be uncommitted, the package-source hash is authoritative for code identity and the revision is baseline identity only. The summary is a runtime-validated known shape (explicit six-lane allowlist, complete lane-agent cleanup coverage, repository proof, provenance) that round-trips through the persisted-evidence validator with no prompts or raw output, and must pass canonical secret scrubbing plus forbidden-field scanning; a run or cleanup failure observed before the atomic rename commit point never overwrites the last successful summary. A signal first dispatched after that point can fail the process while retaining the newly committed completed-cleanup summary, as defined above. Offline release-gate resource coordination (run → harvest IDs → cleanup agents → cleanup repo → evidence only on complete success) lives in `coordinateCloudSmokeReleaseGate()` inside `scripts/lib/cloud-smoke-cleanup-evidence.mjs`. GitHub throwaway fixture ownership lives in `scripts/lib/cloud-smoke-github.mjs`, signal-safe child shutdown lives in `scripts/lib/cloud-smoke-shutdown.mjs`, and `scripts/cloud-runtime-smoke.mjs` keeps concrete lane logic.

`npm run smoke:cloud:context` (`--context-matrix`) remains optional, separate proof for fresh-versus-bootstrap context handoff. `fresh` must answer `NO_MARKER`; `bootstrap` must recall the marker. Its agents receive the same archive, delete, `Agent.get` not-found/404, and archived-inclusive list-exclusion verification, but it does not create a GitHub repository or replace the required-matrix evidence summary.

This cloud gate does not replace the local macOS/Ubuntu/Windows `smoke:platform:all` gate.

## Focused local resume smoke

The platform matrix includes the required local-resume lanes: restart, safety, tool-surface, abort, tree, copy/switch, fallback, compaction, default/opt-out proof, and recorded-ID-only cleanup. Platform lanes run those scripts against the target's shared packed package path, then copy each lane's session JSONL, Cursor SDK debug metadata, runtime-launch record, and other bounded smoke artifacts into its canonical platform suite directory. The same scripts still load the source checkout by default when run directly as focused host-local inner-loop checks. Windows uses the intentionally short target-side evidence component `lr` so the Cursor SDK's derived SQLite path remains below legacy `MAX_PATH`; every suite removes and verifies that directory before use, failing closed on stale or locked evidence.

The smoke starts one sessionful local Cursor run with local resume enabled by default, records the SDK agent id from provider debug metadata, restarts pi against the same session, asks for the remembered marker, and verifies:

- the first run records `localResume: true` and `resumedAgent: false`;
- the second run records `localResume: true`, `resumedAgent: true`, and a one-time bootstrap send plan;
- both runs use the same local SDK `agent-*` id;
- the remembered marker survives the process restart from the bootstrapped current pi transcript.

The safety lane verifies an original session resumes the same local agent after restart, then proves cloned-session copied resume entries and a fork before a future-marker prompt both create a new local `agent-*`. The forked earlier branch must not reveal the future marker.

The tool-surface lane verifies same-session restart reuses the original local agent with the same bridge/tool surface, then enables the builtin pi tool bridge surface and verifies the old resume handle is rejected, a bridge run is created, a new local `agent-*` is used, and a new resume pool key is persisted.

The abort lane verifies a completed bridge-enabled turn persists a local resume handle, an interrupted long-running bridge turn starts from that handle but does not append a new one, and the next same-surface restart uses a new local `agent-*` instead of resuming the pre-abort agent.

The tree lane verifies both realistic navigation to an earlier assistant entry and direct navigation to an earlier `cursor-sdk-agent-resume` custom entry reject the future-seeing SDK agent and do not reveal the future-only marker.

The copy/switch lane copies a session file containing resume custom entries, switches to that copied file, and verifies the copied handle is rejected while transcript bootstrap still recalls the marker.

The fallback lane rewrites a persisted handle to a missing local SDK `agent-*`, verifies create+bootstrap fallback, and asserts the continuity notice is emitted in `pi-stream-events.jsonl`.

The compaction lane uses an isolated temp pi settings file with `compaction.keepRecentTokens: 1` to force manual compaction without huge dummy prompts. It verifies the pre-compaction SDK agent is not reused, the new handle records `compactionGeneration: 1`, and restart resumes the post-compaction agent.

The default/opt-out lane verifies the built-in local resume default resumes, then verifies `PI_CURSOR_LOCAL_RESUME=0` opts out and creates a new agent while bootstrapping the transcript.

The cleanup lane verifies `/cursor-local-resume-cleanup --dry-run` reports only recorded superseded local `agent-*` IDs, `/cursor-local-resume-cleanup --yes` verifies and fsyncs intent before deleting exactly the old recorded ID and fsyncs the result afterward, the current recorded agent still resumes, and tree navigation to the old handle falls back instead of resuming the deleted agent.

## Files and scripts

Files:

```text
platform-smoke.config.mjs
scripts/platform-smoke.mjs
scripts/platform-smoke/artifact-bundle-chunk.mjs
scripts/platform-smoke/artifact-bundle-contract.mjs
scripts/platform-smoke/artifact-fs-safety.mjs
scripts/platform-smoke/artifact-secrets.mjs
scripts/platform-smoke/assertions.mjs
scripts/platform-smoke/artifacts.mjs
scripts/platform-smoke/card-detect.mjs
scripts/platform-smoke/crabbox-runner.mjs
scripts/platform-smoke/doctor.mjs
scripts/platform-smoke/jsonl-text.mjs
scripts/platform-smoke/live-suite-runner.mjs
scripts/platform-smoke/local-resume-runner.mjs
scripts/platform-smoke/local-resume-suites.mjs
scripts/platform-smoke/platform-build-windows.ps1
scripts/platform-smoke/pty-capture.mjs
scripts/platform-smoke/render-ansi.mjs
scripts/platform-smoke/scenarios.mjs
scripts/platform-smoke/target-runtime.mjs
scripts/platform-smoke/targets.mjs
scripts/platform-smoke/visual-evidence.mjs
scripts/platform-smoke/wrapped-line-match.mjs
```

`artifact-bundle-contract.mjs` owns bundle transport markers/path/size caps and the canonical
exact-size base64 decoder. `artifact-secrets.mjs` owns redaction patterns and scanning.
`artifact-fs-safety.mjs` owns no-follow traversal/identity primitives, bounded reads, safe
extraction writes/cleanup, and the exclusive bundle spill writer. `artifacts.mjs` retains
retention/manifest/index bookkeeping and bundle build/format/extract orchestration on top of
those three modules, re-exporting their public names for backward compatibility.

Package scripts:

```json
{
  "check:platform-smoke": "node --check platform-smoke.config.mjs && node --check <platform smoke scripts> && vitest run test/platform-artifact-boundaries.test.ts test/platform-smoke-artifact-transport.test.ts test/cloud-smoke-helpers.test.ts test/cursor-sdk-cloud-list-runs-contract.test.ts test/smoke-cli-package-contracts.test.ts test/smoke-tooling.test.ts",
  "smoke:platform": "node scripts/platform-smoke.mjs",
  "smoke:platform:doctor": "node scripts/platform-smoke.mjs doctor",
  "smoke:platform:macos": "node scripts/platform-smoke.mjs run --target macos",
  "smoke:platform:ubuntu": "node scripts/platform-smoke.mjs run --target ubuntu",
  "smoke:platform:windows-native": "node scripts/platform-smoke.mjs run --target windows-native",
  "smoke:platform:all": "npm run smoke:platform:doctor && node scripts/platform-smoke.mjs run --target macos,ubuntu,windows-native",
  "smoke:cloud": "node scripts/cloud-runtime-smoke.mjs",
  "smoke:cloud:context": "node scripts/cloud-runtime-smoke.mjs --context-matrix",
  "smoke:local-resume": "node scripts/local-resume-smoke.mjs",
  "smoke:local-resume:safety": "node scripts/local-resume-smoke.mjs --safety",
  "smoke:local-resume:tool-surface": "node scripts/local-resume-smoke.mjs --tool-surface",
  "smoke:local-resume:abort": "node scripts/local-resume-smoke.mjs --abort",
  "smoke:local-resume:tree": "node scripts/local-resume-smoke.mjs --tree",
  "smoke:local-resume:copy-switch": "node scripts/local-resume-smoke.mjs --copy-switch",
  "smoke:local-resume:fallback": "node scripts/local-resume-smoke.mjs --fallback",
  "smoke:local-resume:compaction": "node scripts/local-resume-smoke.mjs --compaction",
  "smoke:local-resume:default-dry-run": "node scripts/local-resume-smoke.mjs --default-dry-run",
  "smoke:local-resume:cleanup": "node scripts/local-resume-smoke.mjs --cleanup"
}
```

Add `.artifacts/`, `.crabbox/`, `.debug/`, and `.platform-smoke-runs/` to `.gitignore`.

## Configuration source

All repo-specific behavior lives in `platform-smoke.config.mjs` so the framework can be reused by other pi extensions.

Required config fields:

```js
import { LOCAL_RESUME_SUITE_NAMES } from "./scripts/platform-smoke/local-resume-suites.mjs";

export default {
  packageName: "pi-cursor-sdk",
  cursorModel: "cursor/grok-4.6",
  artifactRoot: ".artifacts/platform-smoke",
  artifactRetention: {
    maxRunDirs: 18,
    maxAgeDays: 14,
    preserveRecentHours: 24,
  },
  requiredTargets: ["macos", "ubuntu", "windows-native"],
  requiredSuites: [
    "platform-build",
    "cursor-native-visual-matrix",
    "cursor-http1-live",
    "cursor-bridge-visual-matrix",
    "cursor-abort-cleanup",
    ...LOCAL_RESUME_SUITE_NAMES,
  ],
  requiredCrabbox: {
    install: "Homebrew package or PLATFORM_SMOKE_CRABBOX override",
    minVersion: "0.26.0",
  },
  ubuntuContainerImage: "pi-cursor-sdk-platform-node:24.16-root",
  ubuntuContainerBaseImage: "cimg/node:24.16",
  nodeValidationMajor: 24,
  windowsParallels: {
    sourceVm: "pi-extension-windows-template",
    snapshot: "crabbox-ready",
    workRoot: "C:\\crabbox\\pi-cursor-sdk",
  },
};
```

`ubuntuContainerBaseImage` is the Ubuntu 24.04 Node 24 base with the current glibc baseline for native test dependencies. The runner builds the local `ubuntuContainerImage` wrapper with only `USER root` changed before warmup because Crabbox 0.36.0 must install SSH/Git/rsync/curl during bootstrap and `cimg/node` defaults to an unprivileged user. An explicit `PLATFORM_SMOKE_UBUNTU_IMAGE` bypasses that build and must already support Crabbox bootstrap. `nodeValidationMajor: 24` is the release-smoke validation baseline. It does not change the package engine by itself. A separate compatibility lane can test Node 22.19 later; this required gate validates Node 24 on every target.

`windowsParallels` records this repo's default shared Windows template contract. Environment overrides may point at a temporary candidate template during infrastructure work, but release runs should use the shared `pi-extension-windows-template` / `crabbox-ready` baseline unless this document is updated.

`artifactRetention` bounds local host evidence growth under `artifactRoot`. `smoke:platform:run` prunes only top-level directories named `run-<timestamp>-<suffix>` before starting a new matrix; it leaves non-run/manual directories untouched and preserves directories newer than `preserveRecentHours` to avoid deleting evidence from active or very recent runs. Doctor is read-only and does not prune artifacts.

## Required local environment

The config owns reusable defaults. Environment variables are local-machine knobs and one-off overrides, not a second source of truth. The doctor fails if required auth or target readiness is missing.

```bash
# Optional override; by default the gate uses Homebrew `crabbox` from PATH.
PLATFORM_SMOKE_CRABBOX=/opt/homebrew/bin/crabbox

PLATFORM_SMOKE_MAC_HOST=localhost
PLATFORM_SMOKE_MAC_USER="$USER"
PLATFORM_SMOKE_MAC_WORK_ROOT="/Users/$USER/crabbox/pi-cursor-sdk"
# Optional prebuilt replacement; bypasses the configured local root-wrapper build.
PLATFORM_SMOKE_UBUNTU_IMAGE="registry.example.com/ubuntu-node24-crabbox:latest"

# Optional Parallels overrides; defaults come from platform-smoke.config.mjs.
PLATFORM_SMOKE_WINDOWS_VM="pi-extension-windows-template"
PLATFORM_SMOKE_WINDOWS_SNAPSHOT="crabbox-ready"
PLATFORM_SMOKE_WINDOWS_USER="<windows-ssh-user>"
PLATFORM_SMOKE_WINDOWS_NATIVE_WORK_ROOT="C:\\crabbox\\pi-cursor-sdk"

# Required for live suites; doctor fails before spending Cursor tokens if absent.
CURSOR_API_KEY="..."
```

Cursor auth is passed as a target process environment value. The key must not appear in repo files, artifacts, logs, or rendered output.

## Workspace model

Every target session uses a unique run root.

```text
<targetWorkRoot>/runs/<run-id>/
  extension-source/       # synced repository under test
  test-workspace/         # live pi cwd and deterministic fixture repo
  pi-project/             # target-local pi settings for packed install
  artifacts/              # target-side suite artifacts
  pack/                   # packed tarball and install material

<targetWorkRoot>/runs/live-prep-<target-session>/
  packed-workspace/       # shared target-local npm install of the packed tarball
  pack/                   # shared live-suite tarball
  ready.json              # package path reused by later live suites
```

Definitions:

- `extensionSourceRoot`: synced repo used for `npm ci`, `npm test`, `npm run typecheck`, and `npm pack`.
- `testWorkspaceRoot`: cwd used by live Cursor suites. It contains deterministic fixture files the prompts operate on: `package.json`, `README.md`, `src/`, and suite scratch directories.
- `piProjectRoot`: target-local pi project where platform-build proves packed install.
- `livePrepRoot`: target-local shared live-suite prep where the first live suite installs the packed tarball once for reuse by later live suites in the same target session.

Live suites run in a suite-local `testWorkspaceRoot`. The extension loaded by pi is the packed tarball package path from `livePrepRoot`, installed into that suite-local workspace with `pi install --approve -l`; no live suite uses `pi -e .`.

The runner must prove this by recording:

- packed tarball path;
- `pi list --approve` output from the suite-local project after `pi install --approve -l <packed package path>`;
- command line showing no `-e .`;
- live suite cwd as `testWorkspaceRoot`.

## Target setup requirements

### macOS

Required:

- OpenSSH enabled on localhost.
- Configured SSH user logs in without interactive prompts.
- `git`, `rsync`, `tar`, `curl`, Node 24+, and npm are available.
- Work root is writable.
- `node-pty` self-test passes.

### Ubuntu

Required:

- Docker-compatible runtime is active.
- `crabbox doctor --provider local-container --json` passes.
- Required local image exists with Node 24+, npm, OpenSSH prerequisites, `git`, `rsync`, `curl`, `sudo`, `python3`, `tar`, and `ripgrep`.
- `node-pty` self-test passes in the container.

### Windows template VM

The user's daily Windows VM is not the long-term test target. Use the shared pi-extension Parallels template unless this project documents a replacement with equal evidence:

```text
source VM: pi-extension-windows-template
snapshot: crabbox-ready
work root: C:\\crabbox\\pi-cursor-sdk
```

Template requirements:

- Windows 11.
- Parallels Tools installed.
- OpenSSH Server enabled.
- Stable SSH user configured.
- Node 24+ and npm installed for native Windows.
- Git for Windows installed.
- PowerShell available.
- `tar` available in native Windows PATH.
- `node-pty` self-test passes in native Windows.
- Source VM is powered off.
- Snapshot named `crabbox-ready` exists.
- The template contains reusable platform tools only; no repo checkout, `.pi` state, Cursor API key, browser auth, smoke artifacts, or temp files.

Crabbox Parallels creates linked clones from the powered-off snapshot. The source template VM is never used directly for smoke runs. If a run has to install a missing global tool or browser on every Windows clone, treat that as template drift and refresh the shared template instead of making the per-run fallback normal.

### Windows native

Required native probe:

```powershell
node --version
npm --version
git --version
tar --version
```

## Doctor command

`npm run smoke:platform:doctor` runs before any token-spending suite. The canonical `npm run smoke:platform:all` script enforces doctor first before it starts macOS, Ubuntu, or Windows suites.

Doctor checks:

1. Required auth is present and optional target overrides resolve against config defaults.
2. Homebrew `crabbox` is available on PATH, or `PLATFORM_SMOKE_CRABBOX` points at an executable override.
3. Crabbox build matches the configured baseline.
4. Crabbox provider registry includes `local-container`, `ssh`, and `parallels`.
5. `crabbox doctor --provider local-container --target linux --json` passes.
6. Docker runtime is active.
7. Crabbox macOS static SSH doctor with `--doctor-probe-ssh` passes, and the localhost SSH probe sees Node, npm, Git, rsync, and tar.
8. `prlctl` exists.
9. Windows source VM exists.
10. Windows source snapshot exists.
11. Windows source VM is stopped and the configured snapshot is power-off/forkable for linked clones.
12. Disposable Windows native clone probe passes and sees Node, npm, Git, tar, and the configured SSH user.
13. Node 24+ is available on every target.
14. npm is available on every target.
15. `git` is available on every target.
16. `rsync` is available on macOS and Ubuntu.
17. `tar` is available on macOS and native Windows.
18. `node-pty` self-test passes on every target.
19. Target pi tool probe proves the shell tool accepts platform-rendered commands on every target.
20. Host-side xterm/Playwright render self-test passes by rendering a minimal ANSI fixture through the repo xterm helper and launching Playwright Chromium to write a tiny PNG. If this fails, run `npm install` and `npx playwright install chromium` before live suites.
21. `CURSOR_API_KEY` is present.
22. Artifact root is writable.
23. `git status --short` is recorded.
24. Forbidden tracked artifacts, package tarballs, `.env*`, auth files, and secrets are absent.

Doctor does not fail merely because the branch has uncommitted source or doc changes under test. It fails on forbidden artifacts and missing platform readiness.

## Dependency spike before implementation

Before adding `node-pty` as a dev dependency, run a phase-zero spike on all three targets:

```text
node -e "require('node-pty'); console.log('node-pty ok')"
```

Windows native must use either verified prebuilt `node-pty` binaries for Node 24 or a documented build toolchain. If Node 24 + Windows native + `node-pty` cannot be made reliable, reject Crabbox as the required platform runner.

## Packed-install rule

Platform smoke tests the installed package, not the source extension path.

Per target, `platform-build` must:

1. Record `node --version` and assert the target Node major is at least `nodeValidationMajor`.
2. Run `npm ci` in `extensionSourceRoot`.
3. Run `npm run check:platform-smoke` on the target so config syntax, smoke harness syntax, invalid target/suite guards, and invariant tests fail before live Cursor calls.
4. Run `npm test` on the target with the same target-local release-tag guard bypass.
5. Run `npm run typecheck`.
6. Run `npm pack`.
7. Create `testWorkspaceRoot` with deterministic fixture files copied from the repo.
8. Create `piProjectRoot`.
9. Install the packed tarball into `piProjectRoot` with `pi install --approve -l <tarball>`.
10. Run `pi list --approve` and assert the installed package points at the packed tarball/install, not `-e .`.

## Required suites

### `platform-build`

Cursor calls: `0`.

Purpose:

- prove build and package readiness on the target OS;
- fail before spending Cursor tokens;
- produce the packed extension used by later suites.

The host `smoke:platform:all` entrypoint enforces doctor first before running targets. Required artifacts include `node-version.txt`, `npm-version.txt`, stdout/stderr for `npm ci`, `npm run check:platform-smoke`, `npm test`, `npm run typecheck`, `npm pack`, packed npm install, `pi install --approve`, and `pi list --approve`, plus `packed-tarball.txt`, `summary.json`, `artifact-manifest.json`, `assertions.json`, and `failures.md` on failed assertions.

### `cursor-local-resume-restart`

Cursor calls: `2`.

Purpose:

- prove guarded local resume default-on behavior across a pi process restart on each required OS;
- assert the first turn creates a local `agent-*` and the second turn resumes the same `agent-*`;
- force local runtime and clear cloud env knobs so ambient cloud settings cannot satisfy this suite.

The suite prepares or reuses the target's packed npm install, runs `npm run smoke:local-resume` with that packed extension path, and asserts the `local-resume-smoke-ok` marker plus the resumed local agent id line. It also requires extracted session, debug, and runtime-launch evidence under `local-resume-evidence/`; checkout `pi -e <repo-root>` is reserved for the standalone inner-loop command.

### `cursor-local-resume-*` focused proof lanes

The remaining local-resume platform suites run the matching focused package script against the shared packed extension on each target, retain the same evidence categories, and assert its success marker plus stderr evidence line:

| Suite | Package script | Purpose |
| --- | --- | --- |
| `cursor-local-resume-safety` | `npm run smoke:local-resume:safety` | clone rejection and fork-before-future no-leak |
| `cursor-local-resume-tool-surface` | `npm run smoke:local-resume:tool-surface` | stale handle rejection after bridge/tool-surface change |
| `cursor-local-resume-abort` | `npm run smoke:local-resume:abort` | interrupted bridge turn does not persist/reuse stale handle |
| `cursor-local-resume-tree` | `npm run smoke:local-resume:tree` | earlier assistant and resume-entry tree targets reject future-seeing agent |
| `cursor-local-resume-copy-switch` | `npm run smoke:local-resume:copy-switch` | copied session file rejects copied resume handle |
| `cursor-local-resume-fallback` | `npm run smoke:local-resume:fallback` | missing local agent falls back with continuity notice |
| `cursor-local-resume-compaction` | `npm run smoke:local-resume:compaction` | compaction boundary creates/resumes post-compaction generation |
| `cursor-local-resume-default-dry-run` | `npm run smoke:local-resume:default-dry-run` | built-in default resumes and env opt-out wins |
| `cursor-local-resume-cleanup` | `npm run smoke:local-resume:cleanup` | recorded-ID-only cleanup deletes old agent and preserves current agent |

### `cursor-native-visual-matrix`

Cursor calls: `1`.

Required environment:

```text
PI_CURSOR_SETTING_SOURCES=none
PI_CURSOR_NATIVE_TOOL_DISPLAY=1
PI_CURSOR_REGISTER_NATIVE_TOOLS=1
PI_CURSOR_PI_TOOL_BRIDGE=0
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=0
PI_CURSOR_SDK_EVENT_DEBUG=1
```

Purpose:

- prove provider reality;
- prove native Cursor tool replay;
- prove deterministic TUI card rendering;
- prove JSONL toolCall/toolResult correctness;
- prove footer/status readability.

The prompt is rendered per target. Shell command steps are platform-specific:

```text
success POSIX:      printf 'cursor visual smoke\n'
success PowerShell: Write-Output 'cursor visual smoke'
failure POSIX:      sh -c 'echo native shell failure >&2; exit 7'
failure PowerShell: Write-Error 'native shell failure'; exit 7
```

Required prompt template:

```text
Native visual matrix.

Use Cursor-native tools only. Do not use pi__ tools.

Steps:
1. read ./package.json and remember the package name.
2. grep ./README.md for "pi-cursor-sdk".
3. find README.md from repo root.
4. find src/cursor-provider.ts from repo root.
5. run shell: <platform-rendered-success-command>
6. write .debug/platform-smoke/<run-id>/native.txt with alpha and beta.
7. edit beta to gamma in that file.
8. run shell and preserve the failure: <platform-rendered-failure-command>
9. answer exactly:
NATIVE_MATRIX_OK package=<name> grep=<yes/no> find=<yes/no> list=<yes/no> shell=<yes/no> shell_fail=<yes/no> write=<yes/no> edit=<yes/no>
```

Required final marker: `NATIVE_MATRIX_OK`.

Required visual card evidence:

- `read`
- `grep`
- `find`
- `shell-success`
- `write`
- `edit-diff`
- `shell-failure`
- `footer-status`

Required JSONL evidence:

- successful `read`, `grep`, `find`/`glob`, `shell`, `write`, and `edit` results;
- successful native `find` result proving `src/cursor-provider.ts` was enumerated;
- failed shell result with `isError=true` and `native shell failure` output;
- final assistant message's last non-empty `text` part contains `NATIVE_MATRIX_OK`;
- assistant usage fields are non-negative.

### `cursor-http1-live`

Cursor calls: `1`.

Required environment:

```text
PI_CURSOR_SETTING_SOURCES=none
PI_CURSOR_HTTP_1_1=1
PI_CURSOR_NATIVE_TOOL_DISPLAY=1
PI_CURSOR_REGISTER_NATIVE_TOOLS=1
PI_CURSOR_PI_TOOL_BRIDGE=0
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=0
PI_CURSOR_SDK_EVENT_DEBUG=1
```

Purpose:

- prove the packed extension completes a real local provider turn through the SDK's opt-in HTTP/1.1/SSE transport on every required OS;
- prove the final TUI status visibly includes `cursor:local ... http1`;
- keep the default transport covered by the other required live suites.

Required final marker: `HTTP1_LIVE_OK`.

Required visual evidence: `http1-status`.

### `cursor-bridge-visual-matrix`

Cursor calls: `1`.

Required environment:

```text
PI_CURSOR_SETTING_SOURCES=none
PI_CURSOR_NATIVE_TOOL_DISPLAY=1
PI_CURSOR_REGISTER_NATIVE_TOOLS=1
PI_CURSOR_PI_TOOL_BRIDGE=1
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1
PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1
PI_CURSOR_SDK_EVENT_DEBUG=1
```

Purpose:

- prove pi bridge request routing;
- prove successful bridge tool card;
- prove failed bridge tool card;
- prove bridge shell card;
- prove bridge diagnostics and JSONL use real pi tool names.

The bridge shell call uses pi's `bash` tool on every target, including Windows native. The command is shell-neutral and relies only on Node, which every target already validates:

```text
node -e "console.log('bridge visual smoke')"
```

Required prompt template:

```text
Bridge visual matrix.

Use pi bridge tools only. Use exact pi__ names.

You must make exactly three pi bridge tool calls before the final answer: pi__bash, pi__read, then pi__read. Do not answer until all three calls complete.

Steps:
1. call pi__bash with command: <platform-rendered-shell-command>
2. call pi__read on ./package.json.
3. call pi__read on ./definitely-missing-platform-smoke-file.txt.
4. answer exactly:
BRIDGE_MATRIX_OK bash_ok=<yes/no> read_ok=<yes/no> read_missing_error=<yes/no>
```

Required final marker: `BRIDGE_MATRIX_OK`.

Required visual card evidence:

- `bridge-read-success`
- `bridge-read-failure`
- `bridge-shell-success`
- `footer-status`

Required diagnostics evidence:

- `run_created`
- `tools_exposed`
- at least one rendered `request_resolved` bridge diagnostic event
- no bridge endpoint URL in collected artifacts
- no bearer token
- no auth/token JSON field payload
- no `CURSOR_API_KEY`

Required JSONL evidence:

- real pi tool call named `read`, success;
- real pi tool call named `read`, failure;
- real pi tool call named `bash`, success;
- final assistant message's last non-empty `text` part contains `BRIDGE_MATRIX_OK`;
- assistant usage fields are non-negative.

### `cursor-abort-cleanup`

Cursor calls: `1`, intentionally interrupted.

Required environment:

```text
PI_CURSOR_SETTING_SOURCES=none
PI_CURSOR_NATIVE_TOOL_DISPLAY=1
PI_CURSOR_REGISTER_NATIVE_TOOLS=1
PI_CURSOR_PI_TOOL_BRIDGE=1
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1
PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1
PI_CURSOR_SDK_EVENT_DEBUG=1
```

Purpose:

- prove long-running bridge cancellation;
- prove no orphan processes;
- prove no false successful answer.

The long-running bridge command uses pi's `bash` tool on every target and relies only on Node, which every target already validates:

```text
node -e "const fs=require('fs');fs.mkdirSync('.debug/platform-smoke',{recursive:true});fs.writeFileSync('.debug/platform-smoke/abort-started.txt',String(process.pid));setTimeout(() => console.log(process.env.PLATFORM_ABORT_MARKER), 30000)"
```

Required prompt template:

```text
Abort cleanup matrix.

Call pi__bash with command:
<platform-rendered-long-running-command>

Do not answer until the tool completes.
```

The harness interrupts after the bridge request is queued.

Required evidence:

- process snapshot before run;
- process snapshot after interrupt;
- `.debug/platform-smoke/abort-started.txt` was written by the long-running process before interrupt;
- no `PLATFORM_ABORT_MARKER` long-running command remains;
- no `SHOULD_NOT_PRINT` process remains;
- marker-scoped bridge/bash/node process cleanup is recorded in `leftover-process-check`;
- no final successful assistant answer claiming completion;
- bridge diagnostics in `artifacts/bridge-diagnostics.jsonl` include `request_queued` for `pi__bash`, `run_cancelled`, and cancelled `request_rejected`;
- cancellation or abort state is visible;
- no successful output contains `SHOULD_NOT_PRINT`.

## Cursor usage budget

Per target maximum live Cursor invocations:

```text
cursor-native-visual-matrix: 1
cursor-http1-live: 1
cursor-bridge-visual-matrix: 1
cursor-abort-cleanup: 1
cursor-local-resume-restart: 2
cursor-local-resume-safety: 5
cursor-local-resume-tool-surface: 3
cursor-local-resume-abort: 3
cursor-local-resume-tree: 4
cursor-local-resume-copy-switch: 2
cursor-local-resume-fallback: 2
cursor-local-resume-compaction: 5
cursor-local-resume-default-dry-run: 3
cursor-local-resume-cleanup: 4
```

Maximum per target: `37` Cursor invocations.

Maximum full gate: `111` Cursor invocations.

The merge gate is `npm run smoke:platform:all`; that script runs doctor first and then the matrix to preserve this budget. No suite adds a new Cursor invocation without updating this plan and the scenario source of truth (`scripts/platform-smoke/scenarios.mjs`, plus `scripts/platform-smoke/local-resume-suites.mjs` for local-resume lanes).

## Artifact contract

Every target session writes under:

```text
.artifacts/platform-smoke/<run-id>/<target>/
```

Every suite writes under:

```text
.artifacts/platform-smoke/<run-id>/<target>/<suite>/
```

After each `smoke:platform run` invocation, the host writes an atomic latest artifact index for agents and humans:

```text
.artifacts/platform-smoke/latest.json
```

`latest.json` records the invocation timestamps, command selection, PID, run id(s), target/suite artifact directories, paths to suite summaries/assertions/failures when present, rendered terminal HTML/PNG paths, visual evidence, session JSONL, JSONL tool-result summaries, capped Cursor SDK/provider debug artifact paths, and local-resume evidence roots/indexes/runtime-launch records. The per-suite artifact directories remain the source of truth; `latest.json` is only a discoverability pointer.

Common required artifacts:

```text
summary.json
artifact-manifest.json
target.json
suite.json
command.txt
exit-code.txt
crabbox.stdout.txt
crabbox.stderr.txt
crabbox.timing.json
assertions.json
failures.md                  # only when assertions fail
```

Required `platform-build` artifacts:

```text
node-version.txt
npm-version.txt
npm-ci.stdout.txt
npm-ci.stderr.txt
check-platform-smoke.stdout.txt
check-platform-smoke.stderr.txt
npm-test.stdout.txt
npm-test.stderr.txt
typecheck.stdout.txt
typecheck.stderr.txt
npm-pack.stdout.txt
npm-pack.stderr.txt
packed-tarball.txt
packed-node-install.stdout.txt
packed-node-install.stderr.txt
pi-install.stdout.txt
pi-install.stderr.txt
pi-list.stdout.txt
pi-list.stderr.txt
```

Every target-session release run also writes a `lease-cleanup/` suite directory under the same target run id:

```text
lease-cleanup/summary.json
lease-cleanup/assertions.json
lease-cleanup/crabbox.stop.stdout.txt
lease-cleanup/crabbox.stop.stderr.txt
lease-cleanup/crabbox.stop.exit-code.txt
```

A stop failure is a failed target result, even when all functional suites passed.

Required PTY artifacts for live suites:

```text
pty.events.jsonl
terminal.ansi
terminal.txt
terminal.html
terminal.full.png
terminal.final-viewport.png
```

Required card artifacts:

```text
cards/
  index.html
  cards.json
  *.png
```

Required live session and provider-debug artifacts:

```text
artifacts/session.jsonl
cursor-sdk-events/
  sessions/**/session.json
  sessions/**/<turn-artifact>.json or .jsonl
```

Required local-resume artifacts:

```text
local-resume-evidence.json        # counts retained files by evidence category
local-resume-evidence/
  runtime-launches.jsonl          # proves the packed extension path used by each pi process
  sessions/**/*.jsonl
  debug/**/*                      # Cursor SDK/provider turn metadata
  agent/**/*                      # bounded non-secret runtime state when written
```

Required abort artifacts:

```text
artifacts/abort-started.txt
logs/process-before.stdout.txt
logs/process-after.stdout.txt
logs/leftover-process-check.stdout.txt
```

Provider debug artifacts are required for every live suite through `PI_CURSOR_SDK_EVENT_DEBUG=1` and suite-scoped debug dirs.

## Artifact collection on failure

The target-side live and local-resume runners encode only canonical bounded text evidence as gzip-compressed JSON/base64. Unknown extensions are secret-scanned and then omitted when benign; a secret finding still fails the run. Binary content under a transport-eligible text extension fails with bounded `binary-content` evidence, and direct bundles containing either unknown extensions or binary content are never extracted. The inner bundle schema is exactly `{files}`, and each entry is exactly `{path, contentBase64, size}`: source-root and per-file metadata are rejected, canonical paths and decoded content are secret-scanned, secret-bearing paths are rejected, and filenames in findings are redacted. The caller-selected artifact root is a trust boundary. Its final component must be a real directory, and its real path must equal the same relative path mapped beneath the canonical real CWD or temp base. This permits expected platform base aliases such as macOS `/var` → `/private/var` but rejects user-created intermediate root links. Every traversed directory is secured with lstat/open/fstat/post-lstat identity checks (POSIX opens use `O_DIRECTORY|O_NOFOLLOW`), its descriptor stays open while descendants are visited, and all current/ancestor identities plus the original ctime, mtime, size, link count, and mode are rechecked around directory reads and bounded file reads. These immutable metadata checks apply only to traversal guards; extraction uses identity-only guards because creating destination entries legitimately mutates parent metadata. Every regular artifact file, regardless of name or extension, is binary-safe scanned from a descriptor-bounded snapshot before transport eligibility is checked. Binary scans retain exact `CURSOR_API_KEY`, generic auth assignments, and structured bearer/cookie/bridge/JSON signatures in UTF-8/ASCII, UTF-16LE/BE, and UTF-32LE/BE at any byte alignment; the intentionally broad generic credential-URL and SCP-style heuristics run only on valid UTF-8 text so random compressed/executable bytes cannot create false failures. Static child symlinks fail as non-regular entries; a nested rename/symlink ABA invalidates the whole traversal, discarding collected findings and bytes in favor of bounded failure evidence. Sensitive files (`.env*`, `auth.json`, `id_rsa`, `id_ed25519`, `*.pem`, and `*.key`) therefore fail the run when they contain secrets but are never transported. `node_modules/` and `.git/` are non-artifact infrastructure and are pruned before recursion. File size is checked before allocation or reading. An unreadable, changed, or oversized file fails closed; oversized files are not read and produce bounded limit evidence, while the host scanner reports an oversized or otherwise unscannable artifact as a finding so the suite fails. Bundles allow at most 512 files, 5 MiB per file, 40 MiB aggregate decoded content, 4,096 UTF-8 bytes per path, 4,096 total path components, 64 MiB inflated JSON, and 20 MiB compressed transport. The writer and extractor enforce the same limits; limit overflow emits only a bounded `bundle-limit-exceeded.json` failure artifact. Before host filesystem mutation, extraction rejects duplicate and file-prefix-conflicting paths, symlink/non-directory destination components, and pre-existing final paths. On POSIX controllers it sends the already prevalidated bounded files to the packaged `artifact-openat-extract.c` helper, compiled once into a private temporary directory. The helper independently validates the complete frame before mutation, requires its opened root identity to match the caller's pinned root, and uses descriptor-relative `mkdirat`/`openat` with `O_NOFOLLOW` one canonical component at a time. Substituted symlinks and pre-open path swaps therefore fail without following them, final files use `O_EXCL`, and detected identity drift rolls created files back through retained parent descriptors even when a directory was moved. This is race-safe extraction, not a sandbox against a hostile same-owner process: such a process can transiently relocate an already-open directory or the pinned root itself, although it cannot make extraction overwrite an existing destination. Windows controllers reject every nonempty extraction bundle before mutation because Node exposes no handle-relative Windows creation API; Windows remains a supported release target when the matrix is orchestrated from the macOS/POSIX controller. Small bundles stay between `PLATFORM_LIVE_BUNDLE_JSON_START` and `PLATFORM_LIVE_BUNDLE_JSON_END`; larger bundles exclusively create and descriptor-write the exact CWD-relative `.platform-artifact-bundle.gz` final component (`O_NOFOLLOW` on POSIX), emit that exact marker path, and allow chunk reads only for that one-component path. No intermediate spill path is accepted. Windows uses lstat identity checks for directories and lstat/fstat identity checks for regular files and the spill, without POSIX-only flags. The host retrieves exact 32 KiB chunks through no-sync Crabbox runs before releasing the lease. Compact control output is collected through Crabbox's local `--capture-stdout` file. This works on scenario failure and preserves the original command exit code; chunk transport success is not substituted for suite success, and no tar/zip side channel exists.

Required fail-through behavior:

1. Run the scenario and write target-side session/debug/runtime evidence.
2. Encode the artifact bundle in a `finally` path after applying path, secret, file-size, file-count, aggregate, inflated-JSON, and compressed-size limits; emit it inline or write the marked gzip file. Any bound overflow or traversal invalidation must emit the bounded limit-failure artifact instead of partial evidence, prior findings, or bytes.
3. Preserve the real scenario process exit code in Crabbox output.
4. Before lease release, have the host fetch any marked chunks and call `extractPlatformArtifactBundle()` even for a nonzero result.
5. Write host-side `exit-code.txt`, `assertions.json`, and `failures.md` from the process result plus extracted evidence.
6. Verify the canonical `artifact-manifest.json`; missing or unsafe bundle content fails the suite.

There is no tar/zip side channel. Crabbox stdout carries the inline bundle or its authenticated retrieval marker/chunks, while the canonical host suite directory remains the durable source of truth.

## Assertion contract

Each suite produces `assertions.json`:

```json
{
  "ok": true,
  "target": "ubuntu",
  "suite": "cursor-native-visual-matrix",
  "checks": [
    { "id": "final-marker", "ok": true },
    { "id": "card-read", "ok": true },
    { "id": "jsonl-read", "ok": true }
  ]
}
```

Failures produce `failures.md` with:

- target;
- suite;
- failed assertion IDs;
- artifact paths;
- command summary;
- next diagnostic command.

## Security and redaction

The runner must binary-safe scan every bounded regular artifact file, including transport-excluded sensitive names and unknown extensions, and fail closed when a file exceeds the scan cap, cannot be scanned, or is non-regular. It never follows non-regular entries or transports sensitive filenames. Non-artifact infrastructure (`node_modules/` and `.git/`) is pruned. The workspace-root `.platform-artifact-bundle.gz` spill is outside scenario artifact roots and is ignored by Git. It fails on:

- the literal `CURSOR_API_KEY` value;
- bearer tokens;
- auth headers;
- cookies;
- bridge endpoint URLs;
- raw Cursor SDK auth payloads;
- contents of `~/.pi/agent/auth.json`.

Bridge diagnostics may include safe tool names and correlation IDs only.

## Release bar

A local provider/runtime release is ready only after this exact command passes on the maintainer machine:

```bash
npm run smoke:platform:all
```

Cloud-runtime releases additionally require:

```bash
npm run smoke:cloud
```

`smoke:platform:all` runs doctor first and then all required local targets and suites in one full gate execution.
