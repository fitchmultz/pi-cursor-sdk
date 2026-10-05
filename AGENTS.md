# AGENTS.md

## Purpose

This repository is a pi provider extension that registers Cursor SDK-backed models under the `cursor` provider. Agent work is successful when changes preserve pi-native model/thinking/session behavior, keep Cursor API keys out of repo state and logs, and pass the local validation commands below.

## Repository map

- `src/index.ts` registers the pi extension, provider, fallback warnings, Cursor runtime controls, native replay wrappers, question tool, and pi tool bridge hooks.
- `src/cursor-model-auth-resync.ts` owns serialized registration-local catalog discovery, captured runtime-auth fingerprints, retry, supersession and shutdown guards. It checks on session_start or explicit refresh; Pi login/logout do not themselves emit that event.
- `src/model-discovery.ts` discovers Cursor models, builds pi model metadata, stores per-model metadata, and defines fallback models.
- `shared/cursor-model-selection-identities.mjs` owns canonical selectable model/context/fast identities and context-window key normalization shared by runtime discovery and the snapshot generator; its `.d.mts` file owns the TypeScript contract.
- `src/cursor-provider.ts` is a thin `streamCursor()` wrapper that delegates turn execution to the turn runner.
- `src/cursor-provider-turn-runner.ts` orchestrates provider turns (pre-send drain, prepare, send, finalize, emit, cleanup).
- `src/cursor-provider-turn-prepare.ts` owns turn prepare (auth, MCP timeout install, effective local HTTP transport configuration, session agent, live-run setup, coordinator).
- `src/cursor-provider-turn-send.ts` owns SDK `agent.send()` wiring and abort listener registration.
- `src/cursor-provider-turn-finalize.ts` owns unified `awaitFinalizeCursorRunOutcome()` (wait, transcript replay, incomplete tools, artifacts, context cache).
- `src/cursor-provider-turn-emit.ts` owns live vs direct emission from finalized outcomes.
- `src/cursor-provider-turn-types.ts` owns immutable turn phase data and explicit phase result types; phase-local cleanup stays inside the owning phase.
- `src/cursor-provider-run-outcome.ts` owns the discriminated `CursorRunOutcome` model and terminal emission classification.
- `src/cursor-provider-run-finalizer.ts` owns live-run wait completion, outcome application, debug finalization, and SDK abort-suppression disposal.
- `src/cursor-run-final-text.ts` owns final assistant text selection for run outcomes and live-run drain.
- `src/cursor-provider-errors.ts` owns scrubbed Cursor SDK run failure detail, abort reason formatting, and provider error sanitization.
- `src/cursor-provider-lazy.ts` owns the `streamSimple` wrapper that defers Cursor provider execution to invocation and converts provider runtime failures into stream errors; the provider module stays in Pi's static extension graph so host peers resolve through Pi's loader.
- `src/cursor-session-scope.ts` owns pi session cwd, session file/id/name/generation scope keys, and `session_start` / `session_info_changed` registration for session-agent pooling, cloud agent names, and debug grouping.
- `src/cursor-provider-binding.ts` owns per-ExtensionAPI provider closures and one-shot native header receipts capturing scope, usage origin, and canonical projection; `src/cursor-request-provenance.ts` resolves actual-request-equivalent source-ordered occupancy floors and operation-signal summary purpose without text/clocks or sibling scans.
- `src/cursor-session-settings.ts` owns branch-scoped runtime/cloud acknowledgement, mode, fast, and HTTP preferences plus owner-scoped CLI snapshots/one-shot consumption across reload; SDK transport configuration and environment/user defaults remain process-global.
- `src/cursor-session-store.ts` owns current/legacy cwd/session-derived SQLite identity admission, contract-verified pre-migration layout safety, exact identity admission before bounded path walks, atomic derived cwd ownership through admission/open/disposal, temporary stores, and owned-prefix/removal guards (higher user-managed links allowed; persistent opens retain an active matching lease).
- `src/cursor-http1.ts` owns branch-scoped local HTTP/1.1 session state, global-preference override tracking, and extension-owned SDK configuration/null reset.
- `src/cursor-ripgrep-path.ts` owns shared SDK-relative platform package resolution and local-agent ripgrep initialization; `src/cursor-sdk-runtime.ts` initializes the native parser vendor path before shared SDK imports.
- `src/cursor-session-agent.ts` owns session-scoped SDK agent pooling, transport-aware pool identity, send-state commits, busy tracking for in-flight SDK `run.wait()` work, and scoped acquire/dispose state.
- `src/cursor-session-agent-lineage.ts` owns non-resumable per-session local agent lineage custom entries independent of local resume.
- `src/cursor-session-agent-lifecycle.ts` owns lazy session-agent lifecycle invalidation on model select, compaction, tree navigation, shutdown, and scope changes, including shutdown-time HTTP transport reset before module reload.
- `src/cursor-session-compaction-prep.ts` owns `prepareCursorSessionForCompaction()` (release scoped live runs and reset the conversation pool) wired from `session_before_compact` in `src/index.ts`; isolated summary agents never commit ordinary resume handles.
- `src/cursor-session-send-policy.ts` owns session send planning (`bootstrap` vs `incremental`), periodic agent rebootstrap threshold, and prompt mode selection.
- `src/cursor-provider-live-run-drain.ts` owns live-run drain/replay mirroring, pre-send continuation, and native replay turn emission.
- `src/cursor-provider-turn-coordinator.ts` orchestrates SDK delta/step handling during a turn over focused collaborators.
- `src/cursor-provider-turn-shell-output.ts` owns shell-output-delta tracking and merging into completed shell tool calls.
- `src/cursor-provider-turn-tool-ledger.ts` owns started/completed tool identities, fingerprints, and duplicate suppression.
- `src/cursor-provider-turn-sdk-normalizer.ts` normalizes SDK delta/step completions via the ledger and shell tracker.
- `src/cursor-provider-turn-display-router.ts` owns trace vs native-replay display routing during a turn.
- `src/cursor-provider-turn-lifecycle-emitter.ts` owns deferred in-progress lifecycle labels during a turn.
- `src/cursor-tool-lifecycle.ts` owns low-noise deferred in-progress lifecycle labels for long-running Cursor tools (coalesced with completed replay cards; bridge excluded).
- `src/cursor-tool-visibility.ts` owns canonical Cursor tool visibility classification for lifecycle, incomplete-tool, and replay activity titles.
- `src/cursor-incomplete-tool-visibility.ts` owns bounded user-visible labels/traces for started Cursor SDK tool calls discarded without completion.
- `src/cursor-sdk-event-debug.ts` owns opt-in provider event artifact capture for Cursor SDK callbacks, stream events, replay/drain/bridge decisions, final partials, and summaries under `.debug/cursor-sdk-events/`, including discarded incomplete started tool calls when `PI_CURSOR_SDK_EVENT_DEBUG=1`.
- `shared/cursor-sdk-event-debug-env.mjs` owns canonical Cursor SDK event-debug env names; `src/cursor-sdk-event-debug-constants.ts` re-exports them and owns debug artifact base-dir resolution.
- `src/cursor-sdk-event-debug-session.ts` owns debug session grouping, turn artifact directory allocation, and session manifest updates.
- `src/cursor-agents-context.ts` owns Cursor-model suppression of pi `<project_context>` / `AGENTS.md` duplication and `PI_CURSOR_PRESERVE_PI_AGENTS_MD`; `src/cursor-agents-context-registration.ts` owns the static lifecycle registration for that suppression.
- `src/cursor-sdk-output-filter.ts` suppresses Cursor SDK integrator bootstrap noise from pi's TUI.
- `src/cursor-edit-diff.ts` owns canonical edit diff fallback resolution for replay/display paths.
- `src/cursor-record-utils.ts` owns shared record/string-key parsing and neutral unknown-value stringification helpers used across bridge and transcript layers.
- `src/cursor-partial-content-emitter.ts` owns shared thinking/text block emission for live-run drain and turn coordinator paths.
- `shared/cursor-cloud-lifecycle-constants.mjs` owns the canonical Cursor Cloud agent ID pattern, lifecycle entry type, and journal prefix; `src/cursor-cloud-lifecycle.ts` and `scripts/cloud-runtime-smoke.mjs` consume it for provider runtime and maintainer scripts.
- `shared/cursor-sensitive-text.mjs` owns canonical secret scrubbing; `src/cursor-sensitive-text.ts` and maintainer scripts import it directly.
- `shared/cursor-setting-sources.mjs` owns canonical `PI_CURSOR_SETTING_SOURCES` parsing/serialization; `src/cursor-setting-sources.ts` and maintainer scripts import it directly.
- `src/cursor-usage-accounting.ts` owns coherent native current-context mapping from LOCAL turn-ended usage or estimates; cumulative bills never enter native usage.
- `src/cursor-sdk-billed-usage.ts` owns bounded public `Agent.getUsage()` observation and disjoint aggregate-safe validation; no UUID watermarks or guessed client-run billing joins.
- `src/cursor-usage-ledger.ts` owns unique public native origin claims, validated fsynced session-ID journals, raw/reported/terminal/billed facts and canonical branch views; `src/cursor-usage-command.ts` owns truthful `/cursor-usage` view/refresh/export/help with the default footer unchanged.
- `src/cursor-provider-turn-summary.ts` owns fresh text-only LOCAL compaction/tree agents, ephemeral stores and disposal before terminal emission, independent of ordinary conversation tools/mode/resume.
- `scripts/lib/cursor-smoke-env.mjs`, `scripts/lib/cursor-smoke-shell.sh`, and `scripts/lib/cursor-visual-render.mjs` own maintainer smoke PATH/env isolation and browser-rendered visual artifacts; smoke runners should consume these helpers instead of duplicating debug env names, sealed Node PATH logic, or xterm/Playwright rendering.
- `scripts/lib/cloud-smoke-github.mjs` owns throwaway GitHub repository identity, provisioning, and deletion proof; `scripts/lib/cloud-smoke-cleanup-evidence.mjs` owns Cloud agent cleanup, retained evidence/provenance, and release-gate resource coordination; `scripts/lib/cloud-smoke-shutdown.mjs` owns signal-safe detached-child shutdown; `scripts/lib/cloud-smoke-pi-runner.mjs` owns print/RPC child transport; `scripts/lib/cloud-smoke-artifacts.mjs` owns metadata and lifecycle artifact readers. `scripts/cloud-runtime-smoke.mjs` keeps concrete lane orchestration.
- `scripts/platform-smoke/artifact-bundle-contract.mjs` owns the canonical platform artifact bundle path/size/shape contract; `scripts/platform-smoke/artifact-fs-safety.mjs` owns no-follow traversal, bounded reads, extraction preflight, and spill writes; `scripts/platform-smoke/artifact-anchored-extract.mjs` plus `artifact-openat-extract.c` own descriptor-relative POSIX extraction/rollback and fail-closed Windows-controller handling; `scripts/platform-smoke/artifact-secrets.mjs` owns bundle secret-scan/redaction; `scripts/platform-smoke/wrapped-line-match.mjs` owns terminal-wrap-aware line matching. Platform smoke scripts should consume these instead of duplicating fs-safety or redaction logic.
- `src/cursor-tool-presentation-registry.ts` is the canonical typed registry for Cursor tool names, labels, visibility, lifecycle, replay metadata (legacy wrapper names, wrapper labels, side-effect policy, call-summary policy), web remapping, alias normalization, and bridge exclusions for internal replay wrappers only (`cursor`, `cursor_*`); sibling modules derive from it.
- `src/cursor-transcript-tool-specs.ts` owns per-tool transcript formatters and pi display builders keyed by normalized tool name; its display implementation keys must match registry entries exactly (`CURSOR_TOOL_DISPLAY_SPEC_KEYS`).
- `src/cursor-pi-tool-bridge-types.ts` owns shared bridge/MCP type contracts.
- `src/cursor-env-boolean.ts` owns canonical env boolean parsing (default and tri-state optional) for bridge diagnostics, flags, and native replay gating.
- `src/cursor-live-run-coordinator.ts` owns live Cursor run registry/scope matching, queued events, drain leases, idle disposal timers, and release cleanup.
- `src/cursor-pi-tool-bridge.ts` re-exports bridge registration and snapshot helpers; exposes active pi tools to local Cursor agents through a per-run loopback stable MCP v2 bridge.
- `src/cursor-pi-tool-bridge-snapshot.ts` owns bridge snapshot building, env gating, and surface signatures.
- `src/cursor-pi-tool-bridge-server.ts` owns loopback Hono HTTP routing, `Host`/`Origin` validation, and run endpoint registry for bridge runs.
- `src/cursor-pi-tool-bridge-run.ts` owns MCP transport setup, pending bridge calls, pi tool dispatch, cancellation, and run lifecycle.
- `src/cursor-pi-tool-bridge-abort.ts` owns bridge pi tool execution abort tracking and process signal handling.
- `src/cursor-pi-tool-bridge-diagnostics.ts` owns bridge debug diagnostics serialization and stderr logging.
- `src/cursor-pi-tool-bridge-mcp.ts` owns MCP name/schema conversion and pi-to-MCP content helpers for the bridge.
- `src/cursor-model-lifecycle.ts` owns the canonical effective Cursor model lifecycle/sync helper for `session_start`, `before_agent_start`, `model_select` with event-model override, and `turn_start`; callers keep Cursor-only filtering explicit.
- `src/cursor-fallback-warning.ts` owns per-session Cursor fallback catalog warning activation.
- `src/cursor-question-tool.ts` owns the bridge-exposed `cursor_ask_question` pi UI tool and the `pi-cursor-sdk:ask-question:blocked` wait-state event.
- `src/cursor-native-tool-display-registration.ts` owns native replay tool registration and model-scoped activation.
- `src/cursor-native-replay-routing.ts` owns canonical native replay disposition (`queue_replay` / `inactive_trace` / `transcript_trace`) and context-tool partitioning for drain.
- `src/cursor-native-replay-trace.ts` owns inactive native replay trace formatting (`title: summary`).
- `src/cursor-pi-context.ts` owns the stock/transcript Pi context boundary; it uses Pi 0.87.1's required public replay helpers, not a local replay implementation.
- `src/cursor-context-tools.ts` owns request tool snapshots at provider stream start (legacy tools or replayed transcript declarations), distinct from the registry-owned bridge snapshot.
- `src/cursor-display-text.ts` owns shared single-line sanitization and 240-char truncation for replay/trace display.
- `src/cursor-native-tool-display-replay.ts` owns replay card rendering and diff/preview formatting.
- `src/cursor-native-tool-display-tools.ts` owns native/replay tool definition factories and replay execute wrappers.
- `src/cursor-native-tool-display-state.ts` owns native replay display state, env gating, and record/consume helpers.
- `src/cursor-tool-result-display-readers.ts` owns canonical result readers shared by transcript/replay paths, including MCP-like content display normalization.
- `src/cursor-tool-transcript.ts` owns the raw `unknown toolCall -> transcript/display` façade; `src/cursor-transcript-tool-specs.ts`, `src/cursor-transcript-utils.ts`, and `src/cursor-transcript-tool-formatters.ts` implement spec dispatch and formatting.
- `src/cursor-mcp-timeout-override.ts` owns Cursor SDK MCP timeout overrides: 3600s default for `callTool`, 10s default for verified initialize/listTools paths on first send, and SDK-default behavior for unknown MCP protocol stacks.
- `src/cursor-config.ts` owns Cursor SDK config loading, parsing, source precedence, safety-cap resolution, cloud environment selection, and legacy fast-default config persistence.
- `src/cursor-cloud-options.ts` owns cloud SDK option mapping and fail-closed preflight.
- `src/cursor-cloud-local-state.ts` owns canonical cloud starting-ref normalization, hermetic Git probes, remote identity/refspec validation, and reasoned local-state inspection.
- `src/cursor-cloud-lifecycle.ts` owns session-branch cloud lifecycle ledger entries and explicit `/cursor-cloud` list/archive/delete command behavior.
- `src/cursor-durable-fs.ts` owns no-follow regular-file opens, exclusive private creation, fsync, and bounded validated frame IO shared by usage journals, Cloud lifecycle and local cleanup; preserve descriptor/path identity guards.
- `src/cursor-state.ts` owns Cursor fast/mode controls, `/cursor-http` session/user persistence, `/cursor-tools`, local config refresh/cleanup wiring, and stable state re-exports.
- `src/cursor-runtime-state.ts` owns effective Cursor config/runtime resolution, cloud/local runtime flags, runtime status helpers, cloud acknowledgement, and `/cursor-runtime` / `/cursor-cloud` wiring.
- `src/context.ts`, `src/context-window-cache.ts`, and `src/bundled-context-windows.ts` handle prompt conversion and context-window caches.
- `src/cursor-bridge-contract.ts` owns pi bridge MCP description helpers and the exported full bridge contract text (bootstrap/manifest carry the user-facing contract; MCP descriptions use a one-line pointer).
- `src/cursor-tool-manifest.ts` owns bootstrap callable-surface manifest text (`PI_CURSOR_TOOL_MANIFEST`, default on).
- `test/**/*.test.ts` contains Vitest coverage for provider registration, discovery, state, context, bridge, replay, and streaming behavior.
- `test/helpers/pi-harness.ts` is the canonical fake pi/extension harness (`createPiHarness`, shared model/context/event runners, tool factories).
- `test/helpers/cursor-provider-harness.ts` owns Cursor SDK provider mocks/stream helpers and re-exports pi-harness fixtures for provider tests.
- `test/helpers/cursor-provider-ownership.ts` supplies explicit direct-provider fixtures with real public SessionManager/captured accounting; binding/native tests own actual header-receipt proof.
- `docs/cursor-model-ux-spec.md` is the maintainer design source of truth for Cursor model UX. Keep it aligned with behavior changes.
- `docs/cursor-testing-lessons.md` is the maintainer source of truth for regression testing lessons (auth.json, isolated smoke harnesses, JSONL replay scans, plan-mode replay traps).
- `docs/cursor-dogfood-checklist.md` is the minimal one-session dogfood checklist (baseline env, JSONL ID patterns, bootstrap manifest, edit diff card).

## Operating rules

- Prefer the smallest change that preserves the current pi user contract.
- Package 0.5.1 requires Node 24+ and official Pi 0.87.1+. Locked development Pi/TypeBox dependencies are reproducible build snapshots, not qualification targets. Compatibility requires latest stable official Pi and current `fitchmultz/pi` main, resolving version/commit once per workflow run and retaining exact SDK/CLI evidence; optional Pi and TypeBox peer ranges stay `"*"` per Pi guidance.
- Treat Cursor SDK model metadata as the source of truth for model IDs, parameters, variants, thinking controls, and context variants. Do not hardcode new model-specific behavior unless it is a documented fallback.
- HARD REPO RULE: never guess what the Cursor SDK outputs, expects, or does. Always verify Cursor SDK behavior against the installed `@cursor/sdk` package and/or the official TypeScript SDK docs at `https://cursor.com/docs/sdk/typescript` before making claims or implementation changes.
- Contract-test external behavior before relying on it: when code depends on Cursor SDK/pi runtime payloads, timing, lifecycle, errors, usage accounting, or tool/event shapes, add or update a focused test that asserts the observed installed-package/docs/captured-fixture contract and fails if that contract drifts. Do not replace this with mocks based on guesses.
- CODE IS TRUTH: claims about behavior must be backed by current source code, installed dependency code/types, contract tests, or captured command output. If evidence is missing, say `unknown`; do not infer, soften, or fill gaps with assumptions.
- Before every commit and before every push, run a thermo-nuclear/deep maintainability review on the exact diff being committed or pushed. Remediate every material finding and repeat the review until there are no remaining material findings. Do not commit or push without this review evidence.
- Keep pi-native abstractions first: context is a model variant, thinking uses pi thinking metadata, and Cursor-only `fast` is extension state/status.
- Preserve the default pi footer; use extension status only for Cursor-only state such as `cursor:local · fast:on`, `cursor:local · fast:off`, and `cursor:cloud · fast:n/a`.
- Stop discovery once package scripts, README, config files, tests, and the relevant `src/` modules explain the task. Do not broad-search `node_modules` unless debugging a dependency API.
- Make ordinary in-scope UX, package metadata, and dependency choices directly, using native capabilities or maintained libraries where useful. Preserve settled product decisions, migration/data-loss guarantees, and security/trust boundaries; ask only for missing owner information or an unrequested irreversible change, private-data disclosure, or substantial new financial commitment. Verify affected behavior, update affected docs, and update the lockfile when dependencies change.

## Setup and commands

- Install dependencies: `npm install` (runs `prepare`, which compiles `src/` into `dist/` — the manifest entry pi loads)
- Use Node 24+. The platform smoke baseline is Node 24 on macOS, Ubuntu, and Windows.
- Build after editing `src/`: `npm run build` — required before any direct `pi -e .` run, or pi loads the previous build. The cloud/steering/local-resume/provider-debug launchers rebuild automatically (even when run directly with `node scripts/...`), `smoke:live`/`smoke:visual`/`smoke:isolated` build via their npm scripts, and `smoke:platform*` builds inside its packed installs; only direct `pi -e .` runs need a manual build.
- Run tests: `npm test`
- Typecheck (src + tests): `npm run typecheck`
- Typecheck src only: `npm run typecheck:src`
- Typecheck tests/helpers: `npm run typecheck:tests`
- Package-readiness check: `npm pack --dry-run`
- Watch tests while developing: `npm run test:watch`
- Local development run, requires a Cursor key: `CURSOR_API_KEY="your-key" pi --approve -e . --model cursor/grok-4.6`
- List Cursor models, requires pi and usually a Cursor key: `pi --list-models cursor`
- Capture provider/SDK event artifacts for one prompt, requires a Cursor key: `CURSOR_API_KEY="your-key" npm run debug:provider-events -- --prompt "hello"`

There is no lint or format script in `package.json` at this time.

## Coding conventions

- TypeScript 7 builds and checks package types. `@typescript/typescript6` is dev-only for AST architecture and installed-SDK contract tests because TypeScript 7 has no stable compiler API.
- TypeScript is ESM with `moduleResolution: "NodeNext"`; keep `.js` extensions on local relative imports.
- Keep strict TypeScript types. Avoid `any` except in tests or when narrowing untyped external SDK data.
- Vitest 5 defaults `clearMocks` to `true`; do not depend on mock state leaking between tests.
- Keep provider runtime code side-effect-light. Do not write secrets, and do not let cache or discovery failures break response streaming unless the run cannot proceed safely.
- Add or update tests for behavior changes in `src/`. Prefer focused unit tests over live Cursor calls.
- If dependency versions change, update `package-lock.json` with npm. Do not manually edit generated dependency output.
- The bridge runtime closure is bundled and pinned to `@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/hono@2.0.2`, `hono@4.13.9`, and `@hono/node-server@2.1.3`. `@cursor/sdk@1.0.35` remains an exact unbundled dependency.
- Do not commit `dist/`, `coverage/`, `.env*`, `.pi/`, or package tarballs.

## Validation and done criteria

Done means:

- The intended behavior or documentation change is complete.
- Code changes pass `npm test`, `npm run typecheck`, and `npm run typecheck:tests`. For docs-only changes, verify affected links, commands, and documented contracts without asking for a minimal-validation exception; required PR and package checks still apply.
- `npm pack --dry-run` passes when package metadata, publishable docs, dependencies, or ignored artifacts change.
- Related README/docs/tests are updated when behavior, commands, user-visible model IDs, flags, or troubleshooting change.
- No secrets, local API keys, or noisy local state are added.
- Session, resume, lifecycle, and cleanup behavior is verified against persisted session entries and provider/debug metadata, not assistant text alone.

If validation fails:

1. Triage the first failing test/type error to root cause.
2. Fix failures caused by the change.
3. If a failure is unrelated or cannot be run locally, report the command, failure, likely reason, and what still needs verification.

## Planning and large changes

Use a short written plan before multi-file behavior changes, SDK integration changes, or public UX changes. Use `PLANS.md` only if a task needs durable multi-session tracking; do not create one for routine edits.

When plans, reviews, investigations, or generated smoke/debug artifacts are no longer the active source of truth, delete them or fold the durable facts into the current docs. Do not leave stale files under `docs/plans/`, `docs/reviews/`, `docs/investigations/`, `.artifacts/`, `.debug/`, `.crabbox/`, or similar local artifact directories once they are superseded.

## Security and side effects

- NEVER store Cursor API keys in repo files, `~/.pi/agent/cursor-sdk.json`, tests, logs, snapshots, or docs examples.
- Scrub Cursor SDK errors and output that may contain API keys, bearer tokens, cookies, sessions, or auth headers.
- `PI_CURSOR_SDK_EVENT_DEBUG=1` and `npm run debug:provider-events` write raw local artifacts that may include prompts, tool args/results, local paths, or secrets; keep them under gitignored `.debug/`, do not print or commit them, and keep run-scoped debug state explicit rather than process-global.
- Ambient Cursor settings/rules loading is enabled by default through `PI_CURSOR_SETTING_SOURCES=all`; keep SDK startup log filtering intact so settings/skills output does not corrupt pi's TUI. Users can narrow or disable Cursor setting sources explicitly when desired.
- Live `pi`/Cursor smoke tests consume real usage. Run offline/faux checks first and reuse retained evidence when the tested inputs are unchanged. Only if changed behavior needs real-service proof not covered by valid retained evidence, run the smallest meaningful existing live check on one representative environment. Docs/metadata-only changes need no paid runs. See `docs/cursor-testing-lessons.md` for isolated harness auth seeding.
- For live runtime evidence, use `cursor/grok-4.6:slow` as much as needed. If Cursor Cloud does not support that exact model variant, use `cursor/grok-4.6`.
- Live Cursor Cloud probes that create `bc-*` agents must capture agent/run IDs, verify archive/delete cleanup, and report any residual agent; do not assume cleanup from a passed smoke.
- Owner testing policy: “Going forward no more paid Cursor Cloud runs as part of testing. I'm not aware of any users doing Cursor Cloud runs so no more testing Cursor Cloud unless the PR or issue is explicitly focused on Cursor Cloud. Continue with the Cursor automated PR reviews but no more Cursor Cloud runs. No point”. No paid Cloud testing for generic PRs or releases; only a PR or issue explicitly focused on Cursor Cloud permits selecting a necessary focused Cloud check. Cloud code touched incidentally does not qualify. Keep automated Cursor PR reviews enabled and unchanged, and preserve offline Cloud contracts and product capabilities.
- Owner cost policy: “If there are real Cursor calls in the automated testing or part of the ship procedures of the Cursor SDK, please make sure that we are being cost-optimal and extremely efficient. I want to do the bare minimum in terms of real testing that does real cost or usage”. No full paid campaign replay, host matrix merely for matrix coverage, or automatic paid retries. Diagnose failures offline before deciding whether another call is necessary.
- `npm run smoke:platform:all` remains callable as an optional comprehensive local matrix, not an unconditional pre-commit/release gate. Prefer an existing single-suite, single-target run for changed behavior that genuinely needs live proof; see `docs/platform-smoke.md`. Keep each selected check's assertions, persisted JSONL/debug evidence, visual proof when relevant, and cleanup requirements intact. Explicit Cloud commands remain callable only under the Cloud-focused exception; the multi-lane `npm run smoke:cloud` is not mandatory even for Cloud-focused work.

## PR review workflow (maintainer)

When the user requests a PR review (including thermo-nuclear / deep maintainability review):

- Remediate **every** finding, structural and polish; do not leave “nice to have” items open.
- When **you are the parent maintainer session** orchestrating remediation (not a delegated child worker), prefer dispatching a remedial code/docs subagent; the parent coordinates review, commit, push, and re-review loops. Child workers should implement assigned fixes directly and must not inherit subagent-dispatch instructions from this section.
- After remediations land, **repeat the review** on the updated branch until there are **no** remaining findings (including docs/PR-body drift and test-contract gaps).
- Do not approve from test counts alone. Thermo-nuclear review is maintainability-only; it does not replace offline verification or any necessary changed-behavior live proof selected under the owner cost policy here and in `docs/cursor-live-smoke-checklist.md`.

## Release review gate (maintainer)

Before publishing any npm/GitHub release or tagging release-ready status:

- Run a thermo-nuclear/deep maintainability review on the exact release diff, including docs, tests, package metadata, generated artifacts, and PR/issue closure notes.
- Remediate every finding, including polish. Repeat the review/fix loop until the reviewer reports no remaining findings.
- This release review gate is in addition to offline verification and any necessary changed-behavior live proof selected under the owner cost policy; it does not require the comprehensive paid matrix.

## Pre-commit verification (maintainer)

Before a Cursor provider/runtime, prompt/session, agents-context, bridge, replay, or extension-wiring commit:

- Run relevant offline tests, native/faux contracts, type checks, build, and package checks; preserve cross-platform offline CI coverage.
- Reuse exact-input retained proof for unchanged behavior. If real-service proof is still necessary for changed behavior, choose the smallest meaningful existing check on one representative target, such as `node scripts/platform-smoke.mjs run --target macos --suite cursor-local-resume-restart` for restart behavior. Do not run the full paid matrix by default or repeat successful unchanged lanes.
- No paid Cloud testing for generic PRs/releases. Only PRs or issues explicitly focused on Cursor Cloud may use a necessary focused Cloud check; source-file touch alone is not the criterion. Preserve its run/evidence and agent/repository cleanup contract.
- For visual claims, capture ANSI, render through the canonical browser/xterm path, inspect PNG evidence and persisted JSONL. Do not substitute assistant text for session, resume, lifecycle, or cleanup proof.
- If a selected necessary live check lacks auth/resources or fails, report that specific evidence gap; do not claim it passed or automatically retry. Optional unselected matrix lanes do not block landing.

## Progress updates and handoff

For multi-step or tool-heavy work, give short progress updates after meaningful milestones: what changed, what is being checked, and any blocker. Final handoff should include changed files, validation commands/results, skipped checks with reasons, and any follow-up risks.

## Updating this file

Keep this file concise and repo-specific. Update it when commands, package layout, safety constraints, or validation expectations change. Put specialized subdirectory rules in a nested `AGENTS.md` only when that subtree has materially different commands or constraints.

## Cursor Cloud specific instructions

This is a `pi` provider extension (not a server/web app). "Running the app" means launching `pi` with this extension loaded. Standard commands live in `## Setup and commands`; only the non-obvious caveats are below.

- Dependencies install with `npm install` (this triggers `prepare`, which compiles `src/` to `dist/`; the pi manifest loads `dist/index.js`). After editing `src/`, run `npm run build` before any `pi -e .` run or the extension loads the previous build.
- Node: `engines` requires `>=24`. Use Node 24 on `PATH` for tests and live `pi`. Older Node is unsupported.
- `CURSOR_API_KEY` is provided as a cloud-agent secret, so live Cursor runs and full live model discovery work without `/login`. `npm test`, `npm run typecheck`, and `npm pack --dry-run` need no key.
- Run the extension locally with `./node_modules/.bin/pi -e . --model cursor/grok-4.6` (the bare `pi` is not on `PATH`). Add `--approve` for interactive sessions; print-mode smoke: `./node_modules/.bin/pi -e . --model cursor/grok-4.6 --cursor-no-fast --no-session -p "..."`.
- Cold-start gotcha: the first necessary Cursor SDK run in a fresh VM can take longer during SDK/transport warm-up. Do not add a paid throwaway warm-up turn; record cold-start conditions and inspect evidence before treating a slow run as a hang.
- When capturing print-mode (`-p`) output, redirect stdout to a file rather than piping through `tail`/`head` — those pipes buffer until the process exits, hiding streaming progress.
- Use sessionful runs (`--session-dir`/`--session-id`, not `--no-session`) when testing session ledgers, resume identity, branch/fork/clone/switch behavior, or slash commands such as `/cursor-cloud`; `--no-session` is only proof for one-shot provider behavior.
- For slow cloud or slash-command probes, prefer print mode for model turns or raw JSONL RPC with an explicit timeout; the packaged `RpcClient` has a fixed 30s request timeout that can falsely fail long cloud operations.
- Start with offline unit/type/native/package checks. A Linux-only environment can supply representative changed-behavior proof when that is the necessary check; do not claim full macOS/Ubuntu/Windows coverage from it. `npm run smoke:platform:all` is an optional comprehensive matrix, not a mandatory ship step. Paid Cloud testing remains restricted to explicitly Cursor Cloud-focused PRs/issues.
- Visual smoke (`npm run smoke:visual`) needs `pi` on `PATH` (`export PATH="$PWD/node_modules/.bin:$PATH"`) and Playwright Chromium (`npx playwright install chromium`) for PNG capture; use `--no-screenshot` if Chromium is unavailable.
- `npm run smoke:live` needs `pi` on `PATH`. Prefer `./node_modules/.bin` on `PATH` rather than relying on a global install.
