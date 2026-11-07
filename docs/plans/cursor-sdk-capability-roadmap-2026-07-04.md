# Cursor SDK capability roadmap

Status: **Active current-state capability ledger and remaining-work plan**. Historical reconciliation baseline: `a2d574b` on 2026-07-18. Implementation status refreshed 2026-07-29 against current source and installed `@cursor/sdk@1.0.23`.

This document separates landed behavior, open work, deliberate product exclusions, and SDK/API contract gaps. Historical probes are context only; current source, tests, installed SDK types/source, and retained smoke evidence are the acceptance authorities.

## Status taxonomy

Every capability in this roadmap has exactly one status:

| Status | Meaning |
| --- | --- |
| **Implemented** | Landed behavior with current source and test or smoke anchors. |
| **Still open** | In-scope work with explicit acceptance criteria. |
| **Intentionally deferred/rejected** | Not scheduled under the current product/security contract; the reason or revisit condition is explicit. |
| **Blocked on SDK/API** | No implementation should start until the exact missing external contract is available or Pi explicitly accepts the listed adapter burden. |

## Non-negotiable product constraints

1. Local agents remain the default for plain `cursor/*` model runs.
2. Local Cursor agents retain Pi tools by default through the canonical loopback MCP bridge.
3. Cloud is explicit opt-in and cannot be acknowledged or safety-weakened by project config.
4. Cloud uses the local streaming/coordinator shape where the SDK permits it, while clearly reporting cloud runtime and cloud-only limitations.
5. Pi does not automatically inject or forward the local bridge, local MCP, `local.customTools`, local settings or skill metadata, or process environment values to cloud. Explicit bootstrap is cloud-bound, requires explicit consent, and sends prior Pi context, which may include file contents, tool outputs, paths or skill references, environment values, or secrets.
6. The bridge invariant remains Cursor tool call → real Pi `toolCall` → matching Pi `toolResult` → Cursor result.
7. `npm run smoke:platform:all` remains required for provider/runtime/bridge changes; `npm run smoke:cloud` is additionally required when actual cloud execution changes.

## Current configuration and runtime contract

**Status: Implemented.** `src/cursor-config.ts` and `src/cursor-runtime-state.ts` own field-specific precedence, stricter safety caps, first-use acknowledgement, trust-gated project loading, explicit save destinations, runtime status, cloud context/repo/ref/direct-push/local-state choices, and Cursor-managed environment selection. Coverage is in `test/cursor-config.test.ts` and `test/cursor-runtime-state.test.ts`.

Field-specific effective source precedence:

- Runtime: CLI > environment > session > trusted project > user > built-in.
- Cloud acknowledgement: CLI > environment > session > user > built-in.
- Other cloud fields (repo/ref, context handoff, direct push, PR controls, local-state allow, env names/file forwarding, and Cursor-managed environment): CLI > environment > user > built-in, subject to field-specific validation and safety caps.
- Local `autoReview`, `sandbox`, and `resume`: CLI > environment > trusted project > user > built-in.
- Local HTTP/1.1/SSE transport: session > environment > user > built-in; project config is excluded.
- Local `force`: CLI > environment > built-in.

Safety-sensitive cloud fields preserve explicit one-shot CLI intent. Below CLI, a stricter user setting may cap a riskier environment choice; field-specific validation still applies. Persisted/public session state currently supplies runtime, cloud acknowledgement, and the local HTTP/1.1 preference; it supplies no other cloud fields. Project config is excluded from acknowledgement and all other cloud fields; trusted project config may select runtime only. It cannot acknowledge cloud or provide repo/ref, bootstrap, env names, direct-push, local-state, environment, or cleanup choices. Local `autoReview`, `sandbox`, and `resume` may load from trusted project config; local `force` cannot.

| Setting | Current behavior | Status |
| --- | --- | --- |
| Runtime | `--cursor-runtime`, `PI_CURSOR_RUNTIME`, `runtime`; built-in default is `local`. | **Implemented** |
| First cloud acknowledgement | `--cursor-cloud-ack`, `PI_CURSOR_CLOUD_ACK`, session/user acknowledgement; project config excluded. | **Implemented** |
| Explicit repo/ref | HTTPS repo override; branch/ref requires repo and maps to `repos[].startingRef`. | **Implemented** |
| Direct push | Explicit CLI/environment/user choice maps to `workOnCurrentBranch`; default false. | **Implemented** |
| Cloud PR controls | Strictly opt-in CLI/environment/user `autoCreatePR` and `skipReviewerRequest`; unset SDK fields stay omitted and project config is excluded. | **Implemented** |
| Local HTTP/1.1/SSE | Opt-in environment/session/user choice configures the SDK before local agent creation, splits pool identity, and shows `http1`; project config and cloud are excluded. | **Implemented** |
| Local-only state allow | Explicit CLI/environment/user escape hatch; default is fail closed. | **Implemented** |
| Context handoff | Fresh by default; bootstrap requires explicit CLI/environment/user consent because it sends prior Pi context to cloud, which may include file contents, tool outputs, paths or skill references, environment values, or secrets. | **Implemented** |
| Cursor-managed environment | Explicit `cloud` / `pool` / `machine` selection; Pi does not automatically forward process environment values. | **Implemented** |
| Pi env forwarding and `.env` reads | Parsed reserved shapes fail preflight with Cursor-native environment guidance. | **Intentionally deferred/rejected** — avoids a parallel secret-management path. |
| Inline cloud MCP | No create/send path supplies it. | **Intentionally deferred/rejected** — live historical probes showed unsafe first-run/replacement persistence behavior. |
| Local resume | Default-on branch-scoped resume with strict session/tree/compaction/tool-surface/store identity and explicit cleanup. Persisted pi sessions use per-session SQLite stores; fileless acquisitions use removable temporary stores. | **Implemented** |
| Cloud resume | Every cloud turn creates a new cloud agent. | **Intentionally deferred/rejected** — lifecycle, privacy, compaction, and broader live evidence decisions remain unresolved. |

Automatic provider startup in print/JSON/RPC does not prompt and fails closed when acknowledgement or required Pi-owned safety choices are absent. The `/cursor-runtime cloud` command is separate: it may request confirmation whenever the host exposes UI (`ctx.hasUI`), including an RPC host with UI. The trust gate, project-local post-trust loading exception, and explicit `--approve` / `--no-approve` CLI-to-provider contract are covered in `test/cursor-project-trust-contract-*.test.ts`.

## Capability ledger

| Capability | Status | Current evidence, acceptance, or reason |
| --- | --- | --- |
| One runtime-aware `cursor/*` provider; local default; explicit cloud opt-in | **Implemented** | Defaults: `src/cursor-config.ts`; dispatch: `src/cursor-provider-turn-prepare.ts`; coverage: `test/cursor-config.test.ts`, `test/cursor-provider-stream-config.test.ts`. |
| Field-specific runtime/cloud/local precedence, user safety caps, trust-gated project loading, cloud project saves limited to runtime | **Implemented** | `src/cursor-config.ts`; `test/cursor-config.test.ts`, `test/cursor-project-trust-contract-*.test.ts`. |
| First-use disclosure and acknowledgement, including remote execution, tools/context, branching/retention, and Max Mode cost | **Implemented** | `src/cursor-runtime-state.ts`; `test/cursor-runtime-state.test.ts`. |
| Project config cannot acknowledge cloud or set cloud safety/repo/environment choices | **Implemented** | Project source is omitted for those fields in `src/cursor-config.ts`; covered by `test/cursor-config.test.ts`. |
| Fresh cloud context by default; explicit, consented bootstrap; original Pi project instructions preserved | **Implemented** | Bootstrap is cloud-bound and sends prior Pi context, which may include file contents, tool outputs, paths or skill references, environment values, or secrets. Anchors: `src/cursor-provider-turn-prepare.ts`, `src/cursor-agents-context.ts`; `test/cursor-provider-stream-config.test.ts`, `test/cursor-agents-context.test.ts`. |
| Per-switch interactive fresh/bootstrap chooser | **Intentionally deferred/rejected** | Fresh is the safe default; explicit CLI/environment/user consent already covers higher-trust bootstrap without another prompt. |
| Session-scoped cloud choices beyond runtime and acknowledgement | **Intentionally deferred/rejected** | Current session state persists only runtime and acknowledgement. CLI, environment, and user config already cover explicit repo/ref/context/direct-push/local-state/environment choices. Revisit only if a temporary session-only UX is approved. |
| Explicit HTTPS repo/ref/direct-push mapping | **Implemented** | `src/cursor-cloud-options.ts`; `test/cursor-cloud-options.test.ts`. |
| Dirty/unpushed local-state validation against the explicit cloud repo/ref target | **Implemented** | `src/cursor-cloud-local-state.ts` matches conservative HTTPS plus GitHub SSH/scp repository identities, normalizes branch targets shared with SDK options, compares `HEAD` with a locally observable non-symbolic target tracking ref uniquely covered by the selected remote fetch refspec, isolates Git from ambient repository/index/config environment redirection while allowing ordinary user/system URL and refspec config only to veto target authorization, detects hidden-index/untracked/submodule state, rejects replacement/graft ancestry, and reports reasoned fail-closed outcomes for mismatch, ambiguity, missing refs, or Git errors; `src/cursor-provider-turn-prepare.ts` supplies the resolved target. Coverage: `test/cursor-cloud-local-state.test.ts`, `test/cursor-cloud-local-state-safety.test.ts`, `test/cursor-cloud-options.test.ts`, `test/cursor-provider-cloud-env-validation.test.ts`. |
| Fingerprinted interactive warn-once/status behavior for unchanged dirty state | **Intentionally deferred/rejected** | Current runs fail every time unless explicitly allowed; no repeated-click UX is needed until product feedback justifies it. |
| Pi env forwarding and `.env` reading | **Intentionally deferred/rejected** | `src/cursor-cloud-options.ts` rejects configured forwarding and directs users to Cursor-native environments; covered by `test/cursor-provider-cloud-env-validation.test.ts`. |
| Explicit Cursor-managed cloud/pool/machine environment selection | **Implemented** | `src/cursor-cloud-options.ts`; `test/cursor-provider-stream-config.test.ts`. |
| No automatic injection or forwarding of the local Pi bridge, local MCP, `local.customTools`, local settings or skill metadata, or process environment values to cloud | **Implemented** | This excludes automatic metadata forwarding, not content explicitly included in consented bootstrap context. Anchors: `src/cursor-cloud-options.ts`, `src/cursor-provider-turn-prepare.ts`, `src/cursor-skill-tool.ts`; `test/cursor-provider-stream-config.test.ts`, `test/cursor-skill-tool.test.ts`. |
| Inline cloud MCP | **Intentionally deferred/rejected** | SDK types expose `mcpServers`, but the current product omits them because historical first-run/replacement probes showed hidden persistence and replacement failure. Revisit only with a deterministic SDK contract and retained passing evidence. |
| Cursor-native SDK `agents` / Pi-subagent mapping | **Intentionally deferred/rejected** | SDK exposes `AgentOptions.agents`; no automatic Pi mapping is approved. Cursor may load native `.cursor/agents/*.md` from its own settings. |
| Runtime-aware footer; cloud fast state is `n/a`; local HTTP/1.1 shows `http1` | **Implemented** | `src/cursor-state.ts`, `src/cursor-http1.ts`; `test/cursor-runtime-state.test.ts`, `test/cursor-http1-state.test.ts`, and required `cursor-http1-live` platform smoke. |
| Best-effort catalog ID/alias preflight through public `Agent.create()` | **Implemented** | `src/cursor-provider-turn-prepare.ts` calls `Agent.create()`. Installed SDK code checks the base model ID/alias against `Cursor.models.list()`, but does not validate variant parameters or cloud runtime availability, and catalog lookup failures can fall through; backend create/send errors are authoritative. The mocked provider coverage in `test/cursor-provider-stream-config.test.ts` proves only that Pi calls the public `Agent.create()` path. |
| `/model` cloud annotations, compatibility warning, and cloud-aware `--list-models` | **Blocked on SDK/API** | Missing contract: installed `ModelListItem` has no local/cloud availability field, and no maintained account-scoped availability/preflight source exists. Preserve best-effort catalog ID/alias preflight through `Agent.create()` while backend create/send errors remain authoritative; P1.5 states the acceptance trigger. |
| Cloud streaming through the shared coordinator | **Implemented** | `src/cursor-provider-turn-prepare.ts` and `src/cursor-provider-turn-send.ts` use `CursorSdkTurnCoordinator`; `test/cursor-provider-stream-config.test.ts` covers direct cloud mode. P2.7 adds retained cloud activity-card evidence. |
| Abort cancels the active cloud run | **Implemented** | `src/cursor-provider-turn-send.ts`; `test/cursor-provider-cloud-reporting.test.ts`. |
| Detach/keep-running control | **Intentionally deferred/rejected** | Abort stays fast and canceling; no detach lifecycle or ownership contract is approved. |
| Cloud agent naming from Pi session title | **Implemented** | `src/cursor-provider-turn-prepare.ts`; `test/cursor-provider-stream-config.test.ts`. |
| Agent/run IDs, branch/PR, passive artifacts, and raw usage completion telemetry | **Implemented** | `src/cursor-cloud-reporting.ts`, `src/cursor-provider-turn-finalize.ts`; `test/cursor-provider-cloud-reporting.test.ts`, `test/cursor-cloud-reporting.test.ts`. Raw usage remains display-only and outside Pi accounting/transcript. |
| Artifact auto-download or download command | **Intentionally deferred/rejected** | Runtime lists passive artifacts only; Cursor UI remains the download surface unless explicit product scope is added. |
| Durable cloud create intent, returned run ID, branch-scoped ledger, malformed-line isolation | **Implemented** | `src/cursor-cloud-lifecycle.ts`, `src/cursor-provider-turn-prepare.ts`, `src/cursor-provider-turn-send.ts`; `test/cursor-cloud-lifecycle.test.ts`. |
| Exact recorded-ID `/cursor-cloud list`, `/cursor-cloud archive <bc-agentId>`, and `/cursor-cloud delete <bc-agentId> --yes` commands with durable mutation intent/result | **Implemented** | `src/cursor-cloud-lifecycle.ts`; `test/cursor-cloud-lifecycle.test.ts`. No bulk or raw filters. |
| Automatic cleanup, exit prompt, bulk deletion, raw filters, or global sweeping | **Intentionally deferred/rejected** | Exact recorded-ID commands are the safety boundary; normal exit leaves cloud agents archiveable. |
| Cloud resume/default-on | **Intentionally deferred/rejected** | Local remains default. Cloud resume needs explicit lifecycle/privacy/compaction policy and broader live evidence before reconsideration. |
| Agent/run URL display | **Intentionally deferred/rejected** | Public `SDKAgentInfo` exposes no URL. Current reporting shows IDs and PR URL; do not depend on private raw shapes. |
| Remote Pi bridge | **Intentionally deferred/rejected** | No approved public endpoint, per-run auth, tool allowlist, trust model, cancellation, redaction, or cleanup contract exists. Cloud must not depend on it. |
| Cloud-specific auth/integration remediation | **Implemented** | `src/cursor-provider-errors.ts` preserves scrubbed HTTPS integration remediation and distinguishes Cloud API authentication while retaining local handling; runtime provenance is threaded by the turn runner/finalization path. Coverage: `test/cursor-provider-errors.test.ts`, `test/cursor-provider-stream-auth.test.ts`, `test/cursor-provider-run-outcome.test.ts`. |
| PR controls beyond direct push (`autoCreatePR`, `skipReviewerRequest`) | **Implemented** | Strictly opt-in CLI/environment/user inputs map to SDK cloud options only when explicitly set; the generic resolver can accept a session-layer value for tests/embedding, but current persisted/public session state exposes no PR-control command or value. Project config is excluded, and unset options remain omitted. Anchors: `src/cursor-config.ts`, `src/cursor-runtime-state.ts`, `src/cursor-cloud-options.ts`, focused config/option/provider/registration tests, and `docs/evidence/cursor-cloud-pr-controls-2026-07-19.md`. |
| Required cloud runtime matrix and optional fresh/bootstrap context proof | **Implemented** | `scripts/cloud-runtime-smoke.mjs`, dedicated child/artifact/GitHub/cleanup/shutdown helpers under `scripts/lib/cloud-smoke-*`, `package.json`, and `docs/platform-smoke.md` keep no-flag `smoke:cloud` as the release gate and `smoke:cloud:context` as optional context proof. Both use persisted sessions and fail-closed verified agent cleanup. |
| Expanded repo/ref/direct-push/missing-branch/cancel/delete/artifact/usage smoke matrix | **Implemented** | `scripts/cloud-runtime-smoke.mjs` plus focused GitHub/cleanup helpers self-create/seed/delete a private GitHub repository, run the named required lanes, verify exact metadata/lifecycle IDs (including retained cancel run-ID source and installed-SDK `Agent.listRuns()` recovery), remote/API outcomes, archive+delete cleanup, and atomically write sanitized provenance-bearing `docs/evidence/cursor-cloud-smoke-matrix-latest.json` only after a successful no-flag run. Offline contracts: `test/cloud-smoke-helpers.test.ts`, `test/cursor-sdk-cloud-list-runs-contract.test.ts`, `test/smoke-tooling.test.ts`, `test/smoke-cli-package-contracts.test.ts`, `test/maintainer-scripts-declarations.test.ts`. |
| Cloud activity-card fixture and visual contract | **Implemented** | Normalized installed-SDK capture: `test/fixtures/cursor-cloud-activity-callbacks-2026-07-19.json`; actual cloud prepare/send/coordinator coverage plus installed Pi `AssistantMessageComponent` fixed-width render assertion: `test/cursor-provider-cloud-activity.test.ts`; retained provenance and cleanup proof: `docs/evidence/cursor-cloud-activity-callbacks-2026-07-19.md`. |
| Default Pi-tool transport via SDK `local.customTools` | **Blocked on SDK/API** | Missing contract: `SDKCustomToolContext` provides no `AbortSignal`, deadline, or cancellation channel. Revisit only if the SDK adds them or Pi accepts an adapter owning aborts, timeouts, child cleanup, diagnostics, permissions, and platform-smoke parity. The loopback MCP bridge remains canonical. |
| Guarded branch-scoped local `Agent.resume()`, per-session stores, and recorded-ID cleanup | **Implemented** | `src/cursor-session-agent.ts`, `src/cursor-session-store.ts`, `src/cursor-session-agent-resume.ts`, `src/cursor-session-agent-cleanup.ts`; store/resume/cleanup tests and `npm run smoke:platform:all` lanes cover isolation, restart, tree, compaction, copy/fork, tool-surface, abort, fallback, opt-out, and cleanup. |
| Cursor bundled ripgrep initialization | **Implemented** | `src/cursor-ripgrep-path.ts` resolves the installed SDK platform package before local agent creation; `test/cursor-ripgrep-path.test.ts` covers direct and nested npm layouts plus override preservation. |
| Raw Cursor SDK `AbortError` containment | **Implemented** | `src/cursor-sdk-process-error-guard.ts` suppresses Cursor SDK stack-provenance abort errors while any provider turn or session process-error guard is active; focused process-guard tests cover DOMException/Error, uncaught/rejection, inactive, and provenance-negative paths. |
| Bounded bridge `CallTool` waits | **Implemented** | `src/cursor-pi-tool-bridge-run.ts` caps pending calls at the effective MCP tool timeout with a lower-only override, removes expired requests, and aborts active Pi execution; `test/cursor-pi-tool-bridge-call-timeout.test.ts` covers timeout/cancel lifecycle. |
| Optional Cursor question prompt | **Implemented** | `PI_CURSOR_ASK_QUESTION=0` removes only `cursor_ask_question` while preserving the rest of the bridge; `src/cursor-question-tool.ts` and registration/bridge tests own the contract. |
| Automatic local force recovery | **Intentionally deferred/rejected** | Manual `--cursor-local-force` is implemented. Automatic recovery lacks Pi ownership, heartbeat/staleness proof, active-run status, stable idempotency, and cross-handle cleanup guarantees. |
| Feeding `RunResult.usage` into Pi message/context accounting | **Intentionally deferred/rejected** | Real local evidence showed full-agent-context values that poison compaction. Pi uses valid local `turn-ended` usage or bounded estimates; cloud raw usage stays display-only until its field semantics are captured. Coverage is in usage/provider tests and retained local compaction evidence. |

## Prioritized remaining work

These are separate implementation flights. Completed flights remain recorded with their landed evidence.

### P0.1 — Target-aware repo/ref local-state validation

**Status: Implemented.**

`inspectCursorCloudLocalState()` now matches local HTTPS remotes against the same explicit HTTPS identity and, for GitHub, accepts equivalent `ssh://user@github.com/path` and scp-style `user@github.com:path` remotes while preserving transport-specific identity for other hosts plus conservative GitHub case/lowercase-`.git` rules. It requires exactly one remote whose Git-resolved fetch and push URLs identify that target; isolates Git from ambient repository/index/config environment redirection case-insensitively while allowing ordinary user/system URL and refspec config only to veto target authorization; uses bounded Git subprocesses with a 64 MiB output buffer; detects hidden-index, ordinary untracked, submodule, POSIX file-mode, and fsmonitor-safe state; rejects replacement/graft ancestry; and compares `HEAD` with a locally observable non-symbolic remote-tracking ref uniquely covered by that remote's fetch refspec. `refs/heads/<branch>` is normalized once for inspection and SDK options, while invalid Git branch names and other `refs/*` forms are rejected. Inside a Git worktree, an explicit repo without a starting ref and a full commit SHA are unverified because server defaults and remote commit containment cannot be proven from the available tracking evidence; `allowLocalState` is the explicit override and skips local Git probes while static repo/ref validation remains active. No-explicit-repo inspection retains current-upstream comparison. Sparse checkouts intentionally fail closed because skip-worktree entries require `allowLocalState`. This is local tracking evidence, not a fetch; users must fetch when remote state may have changed. Stashes are intentionally excluded because they are not active worktree, index, or `HEAD` state. Repo mismatch, ambiguous or mixed/rewritten remote URLs, local-only or unproven refs/upstreams, hidden index state, replacement/graft ancestry, bare repositories, absent `HEAD`, ambient Git redirection, and Git failures remain reasoned fail-closed local-only state.

Source anchors: `src/cursor-cloud-options.ts` (cloud option mapping and preflight), `src/cursor-cloud-local-state.ts` (target normalization, Git environment/runner, remote identity/refspec validation, and local-state inspection), and the cloud-only call in `src/cursor-provider-turn-prepare.ts`.

Test anchors: `test/cursor-cloud-local-state.test.ts` and `test/cursor-cloud-local-state-safety.test.ts` (split only for parallel run time) together cover starting-ref normalization, repository discovery, environment isolation, large Git output, HTTPS and GitHub SSH/scp identity matching, target-probe provenance, wildcard/refspec ownership, ahead/behind commits, hidden index and dirty state, ambient Git redirection, replacement/graft ancestry, bare repositories, unborn `HEAD`, and Git failures; `test/cursor-cloud-options.test.ts` covers preflight messages and SDK option mapping; `test/cursor-provider-cloud-env-validation.test.ts` proves target mismatch blocks cloud agent creation.

### P0.2 — Non-interactive project-trust proof

**Status: Implemented.**

`test/cursor-project-trust-contract-*.test.ts` packs and extracts the extension, then launches the installed Pi CLI against that isolated provider with isolated agent/project directories and a project `.pi/cursor-sdk.json` in print, JSON, and RPC modes. A test-only wrapper in the extracted package records the canonical `session_start` scope and `resolveCursorProviderTurnConfig()` result. The matrix proves `--no-approve` keeps the provider on the built-in local runtime, explicit `--approve` allows recognized or standalone project config to select cloud while keeping acknowledgement out of project scope, and a standalone `.pi/cursor-sdk.json` remains ignored without an explicit trust decision even when Pi's raw no-resource trust bit is true and user acknowledgement already exists. It also creates a Pi-recognized resource in an earlier `session_start` listener and proves that this post-resolution race cannot activate project config. Automatic provider startup never calls UI confirmation, and each mode returns its documented process status. Project config and saves require immutable provenance from Pi's project-trust event or explicit `--approve`; because Pi 0.84.0 loads `pi install -l` project-local extensions only after that event, project-local installs require `--approve` on each run that reads or writes `.pi/cursor-sdk.json`. Saves do not create trust resources automatically, preserve unrecognized fields, reject malformed or non-object JSON before rewriting or appending session state, and serialize concurrent read-modify-write operations. The mocked provider assertion proves missing cloud acknowledgement fails before SDK create, resume, or send. No live cloud call is made by the contract proof.

Source anchors: `src/cursor-session-scope.ts`, `src/cursor-config.ts`, `src/cursor-runtime-state.ts`, and cloud preflight in `src/cursor-provider-turn-prepare.ts` / `src/cursor-cloud-options.ts`.

### P1.3 — Cloud auth/integration remediation

**Status: Implemented.**

`sanitizeCursorProviderError()` now recognizes the installed SDK's verified `IntegrationNotConnectedError` shape without eagerly importing the SDK, retains the scrubbed provider, and includes only a parsed HTTPS help URL after removing URL userinfo and applying canonical sensitive-text scrubbing. Cloud runtime authentication failures identify Cloud API authentication, direct operators to user or service-account operational keys, and reject Team Admin API keys as Cloud Agents credentials. Local and unknown-runtime handling remains unchanged. The runner retains its resolved runtime before cloud `Agent.create()`, while wait/finalization paths use the prepared runtime discriminator.

Source anchors: `src/cursor-provider-errors.ts`, `src/cursor-provider-turn-runner.ts`, `src/cursor-provider-run-finalizer.ts`, `src/cursor-provider-turn-finalize.ts`, and `src/cursor-provider-run-outcome.ts`.

Test anchors: `test/cursor-provider-errors.test.ts` uses installed `AuthenticationError` and `IntegrationNotConnectedError`; `test/cursor-provider-stream-auth.test.ts` covers cloud create-time failures before prepare completes; `test/cursor-provider-run-outcome.test.ts` covers terminal cloud/local classification.

### P1.4 — PR-control scope

**Status: Implemented.**

`cloud.autoCreatePR` and `cloud.skipReviewerRequest` now accept CLI/environment/user inputs through the cloud CLI/environment/session/user source order with user safety denials and explicit project exclusion; no PR-control session command is exposed. The corresponding `--cursor-cloud-auto-create-pr` / `PI_CURSOR_CLOUD_AUTO_CREATE_PR` and `--cursor-cloud-skip-reviewer-request` / `PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST` controls are off unless explicitly set. `buildCursorCloudAgentOptions()` omits both SDK fields for the built-in unset state, preserving prior SDK behavior, and maps explicit boolean values to the installed `@cursor/sdk@1.0.23` `AgentOptions.cloud` fields.

Source anchors: `src/cursor-config.ts`, `src/cursor-runtime-state.ts`, and `src/cursor-cloud-options.ts`; installed contract: `node_modules/@cursor/sdk/dist/esm/options.d.ts:181-188`.

Test anchors: `test/cursor-config.test.ts`, `test/cursor-cloud-options.test.ts`, `test/cursor-provider-stream-config.test.ts`, and `test/index-registration.test.ts` cover precedence, project exclusion, unset omission, option mapping, and CLI/env integration.

Live evidence: `docs/evidence/cursor-cloud-pr-controls-2026-07-19.md` records the one-run throwaway-repository probe and exact agent cleanup verification.

### P1.5 — Model availability UX

**Status: Blocked on SDK/API.**

Exact missing contract: installed `@cursor/sdk@1.0.23` `ModelListItem` exposes catalog metadata but no local/cloud availability, and the SDK/API exposes no maintained account-scoped availability source suitable for picker/list annotations.

Acceptance trigger and criteria:

- Start only when SDK/API availability metadata or a maintained account-scoped preflight source exists.
- Then add `/model` annotations, runtime compatibility warnings, list filtering, and catalog-drift contract tests.
- Preserve best-effort catalog ID/alias preflight through `Agent.create()` while treating backend create/send errors as authoritative; never infer a compatibility map from catalog count or model parameters.

Likely anchors after the contract exists: `src/model-discovery.ts`, `src/cursor-state.ts`, model discovery tests.

### P2.6 — Expanded cloud smoke matrix

**Status: Implemented.**

The no-flag `npm run smoke:cloud` release gate now self-creates one private GitHub throwaway repository, seeds clean `main`, `starting-ref`, and `direct-push` branches, and runs named cancel, explicit repo/starting-ref branch/PR reporting, direct-push, missing-branch fail-closed, persisted-session lifecycle delete, and account-conditional artifact/raw-usage observation lanes with `cursor/composer-2-5`. The branch lane independently verifies a distinct pushed branch's remote content and ancestry from `starting-ref`, records whether the SDK returned branch metadata, and validates returned PR URLs when the account returns one. Compatible observations share runs to bound paid calls. The optional `npm run smoke:cloud:context` split remains unchanged in purpose.

Every created path harvests exact agent/run IDs from provider metadata and canonical lifecycle JSONL/journals. Final cleanup archives every still-existing union member, verifies `archived: true`, deletes it, then requires `Agent.get` not-found/404 and archived-inclusive list exclusion. Lifecycle delete receives the same independent checks. Repository deletion runs after lane and agent cleanup in the release-gate coordinator and must independently return authenticated HTTP 404. Missing credentials, `gh` capability, entitlement, integration/repository access, required output, cancellation/lifecycle proof, agent cleanup, or repository cleanup fails the gate and retains raw temporary artifacts.

A successful no-flag run secret-scans and atomically writes the known-shape `docs/evidence/cursor-cloud-smoke-matrix-latest.json` before removing raw artifacts; failures observed before the atomic rename commit point preserve the prior tracked summary. A signal first dispatched after that point can fail the process while retaining the newly committed completed-cleanup summary. The retained summary includes evidence provenance: extension package version, installed `@cursor/sdk` version, git source revision, and `packageSourceSha256` over the full published package/`package.json` surface (not a manual three-file list; generated evidence is excluded). On uncommitted pre-commit checkouts the package-source hash is authoritative and revision is baseline identity. Throwaway GitHub repos use UUID names plus ownership-marker descriptions; cleanup handles are exposed only after ownership is established, delete rejects non-owned handles, and `SIGINT`/`SIGTERM` terminate active detached Pi children before entering the same fail-closed resource cleanup coordinator. Evidence staging crosses an event-loop signal checkpoint immediately before its atomic rename commit point, with handlers retained through process teardown; a pre-commit signal discards staged evidence, while a post-commit signal dispatched before the terminal-success checkpoint fails without a marker. The marker is the explicit terminal-success boundary, and the handler independently sets a failing exit code for any signal dispatched while the process remains active after it. Raw-run projection and persisted-evidence validation are separate explicit six-lane/cleanup/provenance allowlists with complete lane-agent cleanup coverage and idempotent round-trip checks. Offline resource coordination is injectable via `coordinateCloudSmokeReleaseGate()`; concrete lanes stay in the entrypoint. Source and contract anchors: `scripts/cloud-runtime-smoke.mjs`, `scripts/cloud-runtime-smoke.d.mts`, `scripts/lib/cloud-smoke-*.mjs`, `docs/platform-smoke.md`, `test/cloud-smoke-helpers.test.ts`, `test/cursor-sdk-cloud-list-runs-contract.test.ts`, `test/smoke-tooling.test.ts`, `test/smoke-cli-package-contracts.test.ts`, and `test/maintainer-scripts-declarations.test.ts`.

### P2.7 — Cloud activity-card contract check

**Status: Implemented.**

`test/fixtures/cursor-cloud-activity-callbacks-2026-07-19.json` retains a normalized, secret-free excerpt of the installed `@cursor/sdk@1.0.23` cloud capture with read, shell, and task activity across both callback channels. The fixture contract asserts installed SDK version equality, exact source `bc-*` / `run-*` IDs, source callback counts exceeding the retained excerpt, terminal `finished`, and cleanup `archived` / `deleted` / `getNotFound` / `listExcluded` all true. `test/cursor-provider-cloud-activity.test.ts` feeds that fixture through `streamCursor()`'s actual cloud `Agent.create()` / `send()` path and shared `CursorSdkTurnCoordinator`, deliberately enables ambient local native-display/bridge settings, and asserts bounded traces/final output with no local/MCP create/send assumptions, Pi tool-call/native replay cards, or live-run `toolUse` leak. It also initializes the installed Pi built-in `dark` theme without a watcher (`initTheme("dark", false)`), renders the actual `done.message` through installed Pi `AssistantMessageComponent` at fixed width 80, asserts every line's `visibleWidth` stays within width with a bounded line count, and checks representative read/shell/task/final activity with no bridge/native-replay leakage. This is a real renderer contract against the pinned Pi dev dependency, not PNG/screenshot evidence.

Current source anchors are `prepareCursorCloudProviderTurn()` in `src/cursor-provider-turn-prepare.ts` (cloud coordinator with native replay and bridge disabled), `sendCursorProviderTurn()` in `src/cursor-provider-turn-send.ts` (`onDelta` / `onStep` forwarding), and `CursorSdkTurnCoordinator.handleDelta()` / `.handleStep()` in `src/cursor-provider-turn-coordinator.ts` (tool activity normalization/routing). Capture provenance and exact agent cleanup proof are retained at `docs/evidence/cursor-cloud-activity-callbacks-2026-07-19.md`; no raw debug path is retained.

## Historical probe context

**Evidence classification: Historical only; not current release evidence.**

The 2026-07-05/06 local/cloud probes described repo/ref behavior, protected-branch fallback, direct push, missing branch, env vars, inline MCP, cancel/archive/delete, artifacts, raw usage, auth, resume, force, and `customTools` cancellation. Temporary repositories and agents were reportedly cleaned up. No tracked cloud smoke report exists at baseline `a2d574b`, and successful `scripts/cloud-runtime-smoke.mjs` runs delete raw artifacts by default. These claims may guide future probes but cannot satisfy a current smoke gate.

Model catalog size is a separate fact from cloud compatibility:

- Historical 2026-07-06 live output reported 32 models.
- The current generated fallback records 34 SDK catalog models in `src/cursor-fallback-models.generated.ts`.
- Neither count proves cloud availability. Installed `ModelListItem` has no runtime-availability field, so no compatibility map may be inferred from catalog count.

Retained local evidence remains current only for its named local contracts, including `docs/evidence/cursor-local-compaction-boundary-2026-07-08.md` and the local resume evidence files. It is not cloud smoke evidence.

## Current implementation anchors

- `src/cursor-config.ts` — effective config, precedence, safety caps, project trust, fast-default migration.
- `src/cursor-runtime-state.ts` — runtime selection, acknowledgement, status, commands.
- `src/cursor-cloud-options.ts` — cloud preflight, repository/direct-push options, and Cursor-managed environment mapping.
- `src/cursor-cloud-local-state.ts` — starting-ref validation, hermetic Git probes, remote/refspec verification, and local-state inspection.
- `src/cursor-provider-turn-prepare.ts` — cloud agent creation, context handoff, bridge/replay exclusion, naming.
- `src/cursor-provider-turn-send.ts` — send options, run-ID persistence, abort cancellation.
- `src/cursor-provider-turn-finalize.ts` — successful cloud reporting and outcome finalization.
- `src/cursor-cloud-reporting.ts` — bounded branch/PR/artifact/raw-usage display reporting.
- `src/cursor-cloud-lifecycle.ts` — durable branch ledger and exact recorded-ID lifecycle commands.
- `scripts/cloud-runtime-smoke.mjs` — required expanded cloud matrix, optional context proof, retained sanitized summary, and archive/delete verification.
- `src/cursor-session-agent.ts` and local resume/lifecycle/cleanup modules — local pooling and guarded resume.
- `src/cursor-pi-tool-bridge-run.ts` and `src/cursor-pi-tool-bridge-snapshot.ts` — canonical local Pi-tool transport.
- `src/cursor-skill-tool.ts` — removes Pi skill metadata from the cloud system prompt.
- `src/cursor-provider-errors.ts` — runtime-aware scrubbed provider authentication and integration remediation.

Primary focused coverage:

- `test/cursor-config.test.ts`
- `test/cursor-project-trust-contract-*.test.ts`
- `test/cursor-runtime-state.test.ts`
- `test/cursor-cloud-options.test.ts`
- `test/cursor-cloud-local-state.test.ts`
- `test/cursor-cloud-local-state-safety.test.ts`
- `test/cursor-provider-stream-config.test.ts`
- `test/cursor-provider-cloud-env-validation.test.ts`
- `test/cursor-provider-cloud-reporting.test.ts`
- `test/cursor-provider-errors.test.ts`
- `test/cursor-cloud-reporting.test.ts`
- `test/cursor-cloud-lifecycle.test.ts`
- local resume, usage-accounting, bridge, and provider turn suites

## Installed SDK contract anchors

Installed package: `@cursor/sdk@1.0.23`.

- `options.d.ts` — `AgentOptions`, cloud repo/ref/direct-push/environment/PR options, model catalog shape, `AgentOptions.agents`, and `customTools` surfaces.
- `agent.d.ts` — `SDKAgent`, per-send options, public agent metadata, and artifact methods.
- `stubs.d.ts` — public `Agent.create()` / resume / list / get / cancel / archive / delete declarations; `cloud-agent.d.ts` — the cloud-agent implementation surface.
- `run.d.ts` and `artifacts.d.ts` — branch/PR/usage and artifact metadata.
- `errors.d.ts` — `IntegrationNotConnectedError.helpUrl` and `.provider`.
- Installed bundled source — public `Agent.create()` performs best-effort base model ID/alias preflight through `Cursor.models.list()`; it does not validate variant parameters or cloud runtime availability, catalog lookup failures can fall through, and backend create/send errors remain authoritative. Also anchors current option forwarding.

Do not schedule Pi env forwarding, inline cloud MCP, remote Pi bridge, Pi-subagent mapping, cloud resume/default-on, agent/run URL display, detach/keep-running, automatic cleanup, bulk deletion, raw filters, or artifact auto-download without changing the explicit status and recording the new product/security or SDK/API decision here first.
