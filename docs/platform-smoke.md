# Platform Smoke

Status: optional comprehensive local-runtime matrix plus focused changed-behavior checks. Offline/faux verification and exact-input retained-evidence reuse come first. Paid checks are only the smallest meaningful proof needed for changed behavior on one representative environment; docs/metadata-only changes need none. No full paid campaign replay, matrix-only host coverage, or automatic paid retries. No paid Cloud testing for generic PRs/releases; only PRs/issues explicitly focused on Cursor Cloud may select a necessary focused Cloud check. Automated Cursor PR reviews continue unchanged. The Crabbox runner, packed-install platform-build suite, and real live PTY suite runner are implemented for Apple Silicon macOS and Ubuntu targets with one-lease-per-target orchestration.

Detailed artifact transport/extraction, detector, registry, command-rendering, implementation-history, replacement, and portability reference: [Platform Smoke Implementation Reference](./platform-smoke-implementation.md).

Branch introduced by: `feat/crabbox-platform-smoke`

Oracle review incorporated: this gate resolves the packed-install workspace conflict, Cursor budget contradiction, artifact-on-failure gap, render-location ambiguity, provider-debug ambiguity, and registry-classification gap called out during review.

Crabbox best-practice baseline applied from `~/Projects/crabbox`: Crabbox owns lease, sync, run, evidence transport, and cleanup; this repo owns target policy, package setup, scenario meaning, assertions, artifacts, auth forwarding, redaction, and release criteria.

## Decision

Keep offline cross-platform CI, build/type/package checks, and native/faux contracts. Reuse retained proof when its tested inputs are unchanged. If changed behavior needs new real-service proof, choose the smallest existing check and one representative environment. Source-file touch alone does not require a live run.

Offline checks:

```bash
npm run verify
npm pack --dry-run
```

Example focused live selection for changed restart behavior (choose the relevant suite/target, not this example by default):

```bash
node scripts/platform-smoke.mjs run --target macos --suite cursor-local-resume-restart
```

Optional comprehensive coverage, not an unconditional commit/release gate:

```bash
npm run smoke:platform:all
```

That command runs doctor first, then all configured targets/suites. The CLI can run one existing suite on one target without running the full matrix. Doctor itself makes no Cursor calls but checks the comprehensive setup; it is not proof of a provider turn. Per-target commands without `--suite` run every configured suite on that target, so prefer explicit suite selection.

Only a PR/issue explicitly focused on Cursor Cloud permits necessary paid Cloud testing; generic PRs/releases and incidental Cloud changes do not. Even for Cloud-focused work, `npm run smoke:cloud` is an optional multi-lane matrix, not mandatory. Select coverage only when its live proof is needed, retaining the selected check's full assertions and cleanup contract.

Do not repeat successful unchanged lanes or automatically retry paid failures. Preserve raw failed evidence, diagnose offline, and choose another call only when necessary. Report selected scope honestly; optional unrun hosts/lanes do not block landing, and focused evidence is not full-matrix proof.

## Non-negotiable constraints

- No GitHub Actions dependency.
- No paid Cloud testing for generic PRs/releases. Explicitly Cursor Cloud-focused PRs/issues are the only testing exception; keep Cloud checks separate from local checks.
- No Crabbox broker/coordinator dependency.
- Keep offline cross-platform coverage; do not require a paid host matrix merely for matrix coverage.
- Visual claims require rendered evidence, not command success alone.
- Packed-install claims require packed-install evidence; direct `pi -e .` proof has a narrower scope.
- Missing setup fails a selected check; optional unselected targets are not failed release prerequisites.
- No one-prompt-per-card visual matrix.
- No `tmux` as the canonical visual test contract.
- No target passes from stdout alone when JSONL or visual proof is required.
- No target loses artifacts on failure.
- Every selected suite retains its required artifacts and assertions or fails. Do not weaken a check to reduce cost.

## Required Crabbox baseline

The runner uses one supported Crabbox build.

Current baseline:

```text
install: brew install openclaw/tap/crabbox
version: 0.26.0 or newer
binary: Homebrew `crabbox` on PATH (`/opt/homebrew/bin/crabbox` on Apple Silicon Homebrew installs)
```

Use the Homebrew Crabbox binary on PATH for selected platform checks. `PLATFORM_SMOKE_CRABBOX=/path/to/crabbox` is only an explicit override for testing a non-default binary. `smoke:platform:doctor` verifies the configured binary and fails when it is older than the configured minimum version.

Required Crabbox providers:

- `local-container` for Ubuntu.
- `ssh` static localhost for macOS. Static localhost leases use Crabbox's shared `static_localhost` lease id, so the runner passes `--reclaim` during macOS warmup to claim that lease for this repository before running suites.

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
  -> PTY capture on the target
  -> artifact package/download
  -> host-side xterm/Playwright render
  -> visual evidence screenshot/assertion engine
  -> JSONL/assertion engine
  -> artifact manifest
```

Rendering is host-side. Targets capture the real ANSI stream; the macOS host renders it and captures per-evidence screenshots from the rendered xterm DOM. This keeps the renderer identical across Apple Silicon macOS and Ubuntu and avoids browser dependency drift inside test targets.

## Target session model

Each selected target opens one Crabbox session, syncs once, runs selected suites under one coherent run id, collects artifacts, and stops/releases the target. The comprehensive entrypoint runs configured targets sequentially to prevent shared host, VM/container, and Cursor API contention; each target runs its own suites in order and fails fast within that target. Platform smoke disables Crabbox git-seed sync (`CRABBOX_SYNC_GIT_SEED=false`) so every run tests the current local checkout and uncommitted smoke-runner changes rather than a remote Git seed.

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

The target session fails fast. The comprehensive path handles one target at a time: it warms one lease, syncs once, runs suites in order, and stops the target after its first failure before starting the next. This avoids competing VM/container load and Cursor calls. Routine verification should instead select the smallest meaningful changed-behavior suite on one representative target; do not replay the full campaign or duplicate a focused run with the full matrix.

A focused `--suite` run warms its own lease and stops it after the suite command and its artifact capture, including when either throws after warmup. The stop output goes to the suite's `crabbox.stop.*` files. A failed stop fails the suite's `lease-stop` check; if the suite threw, the reported target error includes both failures. If writing the `crabbox.stop.*` files fails, the reported target error gives the stop's exit code and signal with that write error, even when the stop succeeded; exit 0 means the lease was stopped. The report has no `lease-stop` check for that suite. Suites in a target session use the session's lease, and only the session stops it. The session records its stop in `lease-cleanup/`, also when a suite throws; the thrown suite error is then reported, together with the stop failure if the stop fails. If writing the `lease-cleanup/` files fails, the reported target error gives the stop's exit code and signal with that write error, as above.

Runtime budget is part of the contract:

- `smoke:platform:doctor` never calls Cursor.
- `platform-build` runs once per target and is the only suite that performs the full local CI/build/typecheck/package gate. TypeScript 7 owns builds and package type checks; dev-only `@typescript/typescript6` is used only by the AST architecture test because TypeScript 7 has no stable compiler API. Vitest 5 defaults `clearMocks` to `true`. Target invocations raise only Vitest's default per-test timeout to 15 seconds for host-contention headroom; normal `npm test` keeps the 5-second default, and explicit longer integration-test timeouts still apply.
- Live suites reuse the target checkout and prepared `node_modules` when run after `platform-build`; they do not repeat `npm ci` in a target-session release run. Their interactive Pi process sets `PI_OFFLINE=1` to skip unrelated startup catalog/update probes; the scenario's explicit Cursor provider turn remains live. The PTY launches Pi's JavaScript entry with direct Node argv so multiline prompts remain one positional message on every target.
- Live and local-resume suites share one target-local packed-install prep directory per target-session release run. The first such suite runs `npm pack` and `npm install --no-save <tarball>` once. Visual/abort suites install that packed path with `pi install --approve -l`; local-resume lanes pass the same packed package path to their source-tree smoke harness instead of loading the checkout extension.
- Visual coverage is batched into one native prompt, one focused HTTP/1.1 transport prompt, one bridge prompt, and one abort/cleanup prompt per target. Do not split the card matrices into one prompt per card.
- The gate is fail-fast by target to avoid burning Cursor calls after a platform has already failed.

## Comprehensive matrix targets

| Target | Crabbox provider | Execution contract | TUI visual contract |
| --- | --- | --- | --- |
| `macos` | `ssh` static localhost | native Apple Silicon macOS shell | PTY ANSI capture and host-side render |
| `ubuntu` | `local-container` | Docker Ubuntu container | PTY ANSI capture and host-side render |

Ubuntu is covered as its own local-container target.

## Explicit Cursor Cloud-focused testing exception

No paid Cloud testing for generic PRs or releases. Only a PR or issue explicitly focused on Cursor Cloud may select necessary paid Cloud proof, after offline/faux checks and retained-evidence reuse. Incidental Cloud code changes do not qualify. The no-flag multi-lane command remains callable but is not mandatory even for Cloud-focused work:

```bash
npm run smoke:cloud
```

This optional `cursor/grok-4.6` matrix retains its complete run/evidence and cleanup contract. It uses current `gh` CLI authentication to create one private throwaway GitHub repository, seeds clean `main`, `starting-ref`, and `direct-push` branches, and runs persisted-session named lanes for:

- cancellation, with exact agent/run IDs captured before abort, retained `runIdSource` (`metadata` or installed-SDK `Agent.listRuns()` recovery), and terminal `cancelled` independently read through the SDK;
- explicit HTTPS repository plus `startingRef`, requiring a distinct pushed cloud branch with remote-content and starting-ref-ancestry proof, recording whether the SDK returned branch metadata, and validating any returned PR URL through GitHub;
- explicit direct-push opt-in, independently fetching the remote branch and checking its changed file content;
- a nonexistent starting branch, which must fail closed;
- `/cursor-cloud delete <exact bc-id> --yes` in the run's persisted session, followed by independent `Agent.get` not-found/404 and archived-inclusive list exclusion;
- passive artifacts and raw usage, recording observed true/false and validating bounded known shapes when the account returns either. Absence is an observation, not a skipped lane.

Prerequisites are intentionally strict: `CURSOR_API_KEY` with cloud entitlement, Cursor's GitHub integration with access to the new private repository, and `gh` auth with private-repository create, clone/push, inspect, and delete capability. Missing auth, entitlement, integration/access, required output, or any cleanup proof fails the gate. The GitHub mutation scope is destructive but bounded to self-created repositories named `pi-cursor-cloud-smoke-<uuid>` with an exact ownership-marker description. A cleanup handle is exposed only after create ownership is established (or an ambiguous create probe observes that exact marker). Deletion rejects arbitrary repository handles and independently requires an authenticated GitHub API HTTP 404 afterward.

Every path harvests exact IDs from provider metadata and canonical lifecycle session JSONL/journals. Final cleanup takes their union, archives every still-existing agent, requires `archived: true`, deletes it, then requires `Agent.get` not-found/404 and `Agent.list({ runtime: "cloud", includeArchived: true })` exclusion. `SIGINT` and `SIGTERM` first terminate the active detached Pi child, reject the lane, and then enter the same agent/repository cleanup coordinator before the process exits. Evidence is staged to a temporary file, then an event-loop signal checkpoint runs immediately before the atomic rename; that rename is the evidence commit point. A signal observed before it discards staged evidence. A signal dispatched after it but before the final terminal checkpoint still fails the process and suppresses the success marker, while the committed completed-cleanup summary remains valid. Emitting the success marker is the terminal-success boundary. Signal handlers stay installed through process teardown and independently set a failing exit code, so a still-active process cannot exit successfully if a signal is dispatched after that boundary, even when the marker was already written. Cleanup or repository-deletion verification failure fails the gate and retains the raw temporary artifact root. Successful runs remove raw artifacts unless `CURSOR_CLOUD_SMOKE_KEEP_ARTIFACTS=1`.

Before removing successful raw artifacts, the gate atomically replaces `docs/evidence/cursor-cloud-smoke-matrix-latest.json` with a known-shape summary containing timestamp, model, lane observations, exact agent/run IDs, agent cleanup proof, repository cleanup proof, and retained evidence provenance. Provenance records the extension package version, installed `@cursor/sdk` version, git source revision, and a deterministic `packageSourceSha256` over the full published package surface from `package.json` `files` plus `package.json` itself (relative path + bytes; directories expanded; symlinks/non-regular paths rejected). Generated `docs/evidence/*` is outside that published surface and is not hashed. Because successful pre-commit checkouts may be uncommitted, the package-source hash is authoritative for code identity and the revision is baseline identity only. The summary is a runtime-validated known shape (explicit six-lane allowlist, complete lane-agent cleanup coverage, repository proof, provenance) that round-trips through the persisted-evidence validator with no prompts or raw output, and must pass canonical secret scrubbing plus forbidden-field scanning; a run or cleanup failure observed before the atomic rename commit point never overwrites the last successful summary. A signal first dispatched after that point can fail the process while retaining the newly committed completed-cleanup summary, as defined above. Offline release-gate resource coordination (run → harvest IDs → cleanup agents → cleanup repo → evidence only on complete success) lives in `coordinateCloudSmokeReleaseGate()` inside `scripts/lib/cloud-smoke-cleanup-evidence.mjs`. GitHub throwaway fixture ownership lives in `scripts/lib/cloud-smoke-github.mjs`, signal-safe child shutdown lives in `scripts/lib/cloud-smoke-shutdown.mjs`, and `scripts/cloud-runtime-smoke.mjs` keeps concrete lane logic.

Only within the explicitly Cursor Cloud-focused exception, `npm run smoke:cloud:context` (`--context-matrix`) remains optional, separate proof for fresh-versus-bootstrap context handoff. `fresh` must answer `NO_MARKER`; `bootstrap` must recall the marker. Its agents receive the same archive, delete, `Agent.get` not-found/404, and archived-inclusive list-exclusion verification, but it does not create a GitHub repository or replace the required-matrix evidence summary.

Cloud product capabilities and offline contracts remain supported. Neither this Cloud matrix nor the comprehensive local matrix is an unconditional ship requirement.

## Focused local resume smoke

The optional comprehensive platform matrix includes these local-resume lanes: restart, safety, tool-surface, abort, tree, copy/switch, fallback, compaction, default/opt-out proof, and recorded-ID-only cleanup. Platform lanes run those scripts against the target's shared packed package path, then copy each lane's session JSONL, Cursor SDK debug metadata, runtime-launch record, and other bounded smoke artifacts into its canonical platform suite directory. The same scripts still load the source checkout by default when run directly as focused host-local inner-loop checks.

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
scripts/platform-smoke/artifact-anchored-extract.d.mts
scripts/platform-smoke/artifact-anchored-extract.mjs
scripts/platform-smoke/artifact-bundle-chunk.mjs
scripts/platform-smoke/artifact-bundle-contract.mjs
scripts/platform-smoke/artifact-fs-safety.mjs
scripts/platform-smoke/artifact-openat-extract.c
scripts/platform-smoke/artifact-secrets.mjs
scripts/platform-smoke/assertions.mjs
scripts/platform-smoke/artifacts.mjs
scripts/platform-smoke/card-detect.mjs
scripts/platform-smoke/crabbox-runner.mjs
scripts/platform-smoke/doctor.mjs
scripts/platform-smoke/jsonl-text.mjs
scripts/platform-smoke/live-suite-runner.mjs
scripts/platform-smoke/local-resume-runner.mjs
scripts/platform-smoke/local-resume-suites.d.mts
scripts/platform-smoke/local-resume-suites.mjs
scripts/platform-smoke/pty-capture.mjs
scripts/platform-smoke/render-ansi.mjs
scripts/platform-smoke/scenarios.d.mts
scripts/platform-smoke/scenarios.mjs
scripts/platform-smoke/target-runtime.mjs
scripts/platform-smoke/targets.mjs
scripts/platform-smoke/visual-evidence.mjs
scripts/platform-smoke/wrapped-line-match.mjs
```

`artifact-bundle-contract.mjs` owns bundle transport markers/path/size caps and the canonical
exact-size base64 decoder. `artifact-secrets.mjs` owns redaction patterns and scanning.
`artifact-fs-safety.mjs` owns no-follow traversal/identity primitives, bounded reads, safe
extraction writes/cleanup, and the exclusive bundle spill writer.
`artifact-anchored-extract.mjs` owns the native helper adapter, compilation, and result mapping.
`artifact-anchored-extract.d.mts` declares the adapter's inputs and extraction outcome type.
`artifact-openat-extract.c` owns descriptor-relative creation, identity verification, and rollback.
`artifacts.mjs` retains
retention/manifest/index bookkeeping and bundle build/format/extract orchestration on top of
the contract, secrets, and fs-safety modules, re-exporting their public names for backward compatibility.

Package scripts:

```json
{
  "check:platform-smoke": "node --check platform-smoke.config.mjs && node --check <platform smoke scripts>",
  "smoke:platform": "node scripts/platform-smoke.mjs",
  "smoke:platform:doctor": "node scripts/platform-smoke.mjs doctor",
  "smoke:platform:macos": "node scripts/platform-smoke.mjs run --target macos",
  "smoke:platform:ubuntu": "node scripts/platform-smoke.mjs run --target ubuntu",
  "smoke:platform:all": "npm run smoke:platform:doctor && node scripts/platform-smoke.mjs run --target macos,ubuntu",
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
  requiredTargets: ["macos", "ubuntu"],
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
  ubuntuContainerImage: "pi-cursor-sdk-platform-node:24.22.3-root",
  ubuntuContainerBaseImage: "cimg/node:24.21",
  ubuntuContainerNodeImage: "node:24.22.3-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496",
  nodeValidationMajor: 24,
};
```

`ubuntuContainerBaseImage` is `cimg/node:24.21`, the Ubuntu 24.04 Node 24 base with the current glibc baseline for native test dependencies. The runner replaces the base image's Node executable with the checksum-pinned Node 24.22.3 executable from `ubuntuContainerNodeImage` and sets `USER root` before warmup because Crabbox 0.36.0 must install SSH/Git/rsync/curl during bootstrap and `cimg/node` defaults to an unprivileged user. An explicit `PLATFORM_SMOKE_UBUNTU_IMAGE` bypasses that build and must already support Crabbox bootstrap. The package requires Node 24.22.3 (24.x) or 26.13.1 and newer, and this gate validates Node 24 on Apple Silicon macOS and Ubuntu.


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
- `git`, `rsync`, `tar`, `curl`, Node 24.22.3+ (24.x), and npm are available.
- Work root is writable.
- `node-pty` self-test passes.

### Ubuntu

Required:

- Docker-compatible runtime is active.
- `crabbox doctor --provider local-container --json` passes.
- Required local image exists with Node 24.22.3+ (24.x), npm, OpenSSH prerequisites, `git`, `rsync`, `curl`, `sudo`, `python3`, `tar`, and `ripgrep`.
- `node-pty` self-test passes in the container.

## Doctor command

`npm run smoke:platform:doctor` runs before any token-spending suite. The canonical `npm run smoke:platform:all` script enforces doctor first before it starts Apple Silicon macOS or Ubuntu suites.

Doctor checks:

1. Required auth is present and optional target overrides resolve against config defaults.
2. Homebrew `crabbox` is available on PATH, or `PLATFORM_SMOKE_CRABBOX` points at an executable override.
3. Crabbox build matches the configured baseline.
4. Crabbox provider registry includes `local-container` and `ssh`.
5. `crabbox doctor --provider local-container --target linux --json` passes.
6. Docker runtime is active.
7. Crabbox macOS static SSH doctor with `--doctor-probe-ssh` passes, and the localhost SSH probe sees Node, npm, Git, rsync, and tar.
13. Node's major version is at least 24 on every target. Use the patched versions listed in Requirements; this doctor check does not enforce patch versions.
14. npm is available on every target.
15. `git` is available on every target.
16. `rsync` is available on macOS and Ubuntu.
17. `tar` is available on Apple Silicon macOS and Ubuntu.
18. `node-pty` self-test passes on every target.
19. Target pi tool probe proves the shell tool accepts platform-rendered commands on every target.
20. Host-side xterm/Playwright render self-test passes by rendering a minimal ANSI fixture through the repo xterm helper and launching Playwright Chromium to write a tiny PNG. If this fails, run `npm install` and `npx playwright install chromium` before live suites.
21. `CURSOR_API_KEY` is present.
22. Artifact root is writable.
23. `git status --short` is recorded.
24. Forbidden tracked artifacts, package tarballs, `.env*`, auth files, and secrets are absent.

Doctor does not fail merely because the branch has uncommitted source or doc changes under test. It fails on forbidden artifacts and missing platform readiness.

## Dependency spike before implementation

Before adding `node-pty` as a dev dependency, run a phase-zero spike on both targets:

```text
node -e "require('node-pty'); console.log('node-pty ok')"
```


## Packed-install rule

Platform smoke tests the installed package, not the source extension path.

Per target, `platform-build` must:

1. Record `node --version` and assert the target Node major is at least `nodeValidationMajor`.
2. Run `npm ci` in `extensionSourceRoot`.
3. Run `npm run check:platform-smoke` on the target to check config and smoke harness syntax.
4. Run `npm test` on the target with the same target-local release-tag guard bypass; this includes the smoke guards and invariant tests before live Cursor calls.
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

- prove guarded local resume default-on behavior across a pi process restart on each selected OS;
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

- prove the packed extension completes a real local provider turn through the SDK's opt-in HTTP/1.1/SSE transport on each selected OS;
- prove the final TUI status visibly includes `cursor:local ... http1`;
- use offline contracts or valid retained default-transport evidence rather than adding unrelated live runs.

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

The bridge shell call uses pi's `bash` tool on every target. The command is shell-neutral and relies only on Node, which every target already validates:

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
- pi's own PTY exit after the interrupt and quit is recorded (`live-status.json` `ptyExit`; host `pi-exit` check);
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

Declared maximum full matrix: `74` Cursor invocations (`37` per target across two targets). These are scenario budgets, not measured fixed billable model-call or SDK-step counts; actual service usage can differ.

`npm run smoke:platform:all` is optional comprehensive coverage; it runs doctor first and then the matrix within these declared budgets. Routine verification selects only necessary changed-behavior proof on one representative environment. No suite adds a new Cursor invocation without updating this plan and the scenario source of truth (`scripts/platform-smoke/scenarios.mjs`, plus `scripts/platform-smoke/local-resume-suites.mjs` for local-resume lanes).

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

`artifacts/live-status.json` keeps two facts apart. `observation` is what ended the PTY wait: `evidence-observed` (final marker plus persisted session JSONL), `interrupt-sent` (abort lane), `pi-exited`, or `wait-expired`. `ptyExit` is node-pty's own exit receipt: `{ "kind": "exited", "exitCode", "signal" }`, or `{ "kind": "not-observed" }` when `/quit`, EOF, Ctrl+C and kill produced no exit. Failure text names a POSIX signal death as `signal N`, because node-pty then reports `exitCode` 0 as a placeholder; the receipt keeps both fields. The host `final-marker` check reads `observation`; the `pi-exit` check fails unless `ptyExit.kind` is `exited`. A marker or an interrupt request alone never passes a suite, and a missing exit fails it even after the marker. Offline owners: `node --test test/platform-smoke-live-runner-pty.test.mjs` runs the real runner through a real `node-pty` PTY against `test/fixtures/fake-pi-tui.mjs`. It needs a built `node-pty`, so CI runs it only in the Apple Silicon macOS native-platforms job. `test/platform-target-runtime.test.ts` sends recorded `live-status.json` outcomes through the artifact bundle into the host checks on POSIX controllers; Windows controllers fail closed on nonempty bundle extraction.

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

Evidence collection runs even when a scenario fails. Only bounded, secret-scanned canonical text evidence is transported; unsafe or missing content fails the suite.

On POSIX controllers, extraction reports `committed`, `rejected` (nothing created), `rolled-back`, `rollback-incomplete`, or `unknown`. The last two outcomes can leave created entries. A failed bundle-extraction check records the extraction outcome in `assertions.json` and `failures.md`.

The artifact root is a trust boundary, not a sandbox against hostile same-owner processes. Windows controllers reject nonempty bundles.

See [Artifact transport and extraction](./platform-smoke-implementation.md#artifact-transport-and-extraction) for the schema, limits, scanning, identity guards, outcome semantics, and inline/chunk protocol.

Required fail-through behavior:

1. Run the scenario and write target-side session/debug/runtime evidence.
2. Encode the artifact bundle in a `finally` path after applying path, secret, file-size, file-count, aggregate, inflated-JSON, and compressed-size limits; emit it inline or write the marked gzip file. Any bound overflow or traversal invalidation must emit the bounded limit-failure artifact instead of partial evidence, prior findings, or bytes.
3. Preserve the real scenario process exit code in Crabbox output.
4. Before lease release, have the host fetch any marked chunks.
5. Call `extractPlatformArtifactBundle()` on the captured bundle even for a nonzero result. Extraction uses local bytes and does not need the lease.
6. Write host-side `exit-code.txt`, `assertions.json`, and `failures.md` from the process result plus extracted evidence.
7. Verify the canonical `artifact-manifest.json`; missing or unsafe bundle content fails the suite.

There is no tar/zip side channel. Crabbox stdout carries the inline bundle or its authenticated retrieval marker/chunks, while the canonical host suite directory remains the durable source of truth.

## Assertion contract

Each suite produces `assertions.json` with `ok`, `checks`, and `writtenAt`. Failed checks can include error text; `failures.md` lists their IDs and errors (or `failed`), plus a failure count. Artifact paths and diagnostic hints appear only if a check includes them in its error text. See the [assertion output format](./platform-smoke-implementation.md#assertion-output-format) for details.

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

Complete offline/faux verification and reuse valid exact-input retained proof. If changed behavior still needs real-service evidence, run the smallest meaningful existing check on one representative environment. Keep its assertions, visual proof when relevant, persisted session/debug evidence, and cleanup intact. Docs/metadata-only changes need no paid calls; optional unrun matrix lanes do not block landing.

No paid Cloud testing for generic PRs/releases; only explicitly Cursor Cloud-focused PRs/issues may select necessary focused Cloud proof. The multi-lane Cloud command and `smoke:platform:all` remain optional comprehensive tools, not unconditional gates. No full paid campaign replay, matrix-only host coverage, or automatic paid retries. Automated Cursor PR reviews continue unchanged. Record exactly what passed, what retained evidence was reused, and any specific necessary proof still missing.
