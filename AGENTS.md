# AGENTS.md

## Purpose

This repository is a pi provider extension that registers Cursor SDK-backed models under the `cursor` provider. Agent work is successful when changes preserve pi-native model/thinking/session behavior, keep Cursor API keys out of repo state and logs, and pass the local validation commands below.

## Repository map

- `src/index.ts` registers the pi extension, provider, fallback warnings, Cursor fast controls, native replay wrappers, question tool, and pi tool bridge hooks.
- `src/model-discovery.ts` discovers Cursor models, builds pi model metadata, stores per-model metadata, and defines fallback models.
- `src/cursor-provider.ts` streams through local `@cursor/sdk` agents, injects local MCP bridge config, resumes live bridge runs, and sanitizes Cursor SDK errors.
- `src/cursor-provider-errors.ts` owns scrubbed Cursor SDK run failure detail, abort reason formatting, and provider error sanitization.
- `src/cursor-session-agent.ts` owns session-scoped SDK agent pooling, send-state commits, and lifecycle invalidation on compaction/tree/shutdown.
- `src/cursor-session-send-policy.ts` owns session send planning (`bootstrap` vs `incremental`), periodic agent rebootstrap threshold, and prompt mode selection.
- `src/cursor-provider-live-run-drain.ts` owns live-run drain/replay mirroring, pre-send continuation, and native replay turn emission.
- `src/cursor-provider-turn-coordinator.ts` owns SDK delta/step handling, tool completion routing, and trace/native-replay emission during a turn.
- `src/cursor-tool-lifecycle.ts` owns low-noise deferred in-progress lifecycle labels for long-running Cursor tools (coalesced with completed replay cards; bridge excluded).
- `src/cursor-incomplete-tool-visibility.ts` owns bounded user-visible labels/traces for started Cursor SDK tool calls discarded without completion.
- `src/cursor-sdk-event-debug.ts` owns opt-in provider event artifact capture for Cursor SDK callbacks, stream events, replay/drain/bridge decisions, final partials, and summaries under `.debug/cursor-sdk-events/`, including discarded incomplete started tool calls when `PI_CURSOR_SDK_EVENT_DEBUG=1`.
- `src/cursor-sdk-event-debug-constants.ts` owns debug artifact/env names and default artifact base-dir resolution.
- `src/cursor-sdk-event-debug-session.ts` owns debug session grouping, turn artifact directory allocation, and session manifest updates.
- `src/cursor-agents-context.ts` owns Cursor-model suppression of pi `<project_context>` / `AGENTS.md` duplication and `PI_CURSOR_PRESERVE_PI_AGENTS_MD`.
- `src/cursor-sdk-output-filter.ts` suppresses Cursor SDK integrator bootstrap noise from pi's TUI.
- `src/cursor-edit-diff.ts` owns canonical edit diff fallback resolution for replay/display paths.
- `src/cursor-record-utils.ts` owns shared record/string-key parsing helpers used across bridge and transcript layers.
- `src/cursor-partial-content-emitter.ts` owns shared thinking/text block emission for live-run drain and turn coordinator paths.
- `src/cursor-sensitive-text.ts` owns canonical secret scrubbing for provider errors and native replay display.
- `src/cursor-transcript-tool-specs.ts` owns the unified per-tool transcript and replay display spec registry.
- `src/cursor-pi-tool-bridge-types.ts` owns shared bridge/MCP type contracts.
- `src/cursor-env-boolean.ts` owns canonical env boolean parsing (default and tri-state optional) for bridge diagnostics, flags, and native replay gating.
- `src/cursor-live-run-coordinator.ts` owns live Cursor run registry/scope matching, queued events, drain leases, idle disposal timers, and release cleanup.
- `src/cursor-pi-tool-bridge.ts` re-exports bridge registration and snapshot helpers; exposes active pi tools to local Cursor agents through a per-run loopback MCP bridge.
- `src/cursor-pi-tool-bridge-snapshot.ts` owns bridge snapshot building, env gating, and surface signatures.
- `src/cursor-pi-tool-bridge-server.ts` owns loopback HTTP routing and run endpoint registry for bridge runs.
- `src/cursor-pi-tool-bridge-run.ts` owns MCP transport setup, pending bridge calls, pi tool dispatch, cancellation, and run lifecycle.
- `src/cursor-pi-tool-bridge-abort.ts` owns bridge pi tool execution abort tracking and process signal handling.
- `src/cursor-pi-tool-bridge-diagnostics.ts` owns bridge debug diagnostics serialization and stderr logging.
- `src/cursor-pi-tool-bridge-mcp.ts` owns MCP name/schema conversion and pi-to-MCP content helpers for the bridge.
- `src/cursor-question-tool.ts` owns the bridge-exposed `cursor_ask_question` pi UI tool.
- `src/cursor-native-tool-display.ts` re-exports native replay display registration and state APIs.
- `src/cursor-native-tool-display-registration.ts` owns native replay tool registration and model-scoped activation.
- `src/cursor-native-replay-routing.ts` owns canonical native replay disposition (`queue_replay` / `inactive_trace` / `transcript_trace`) and context-tool partitioning for drain.
- `src/cursor-native-replay-trace.ts` owns inactive native replay trace formatting (`title: summary`).
- `src/cursor-context-tools.ts` owns `context.tools` snapshot helpers at provider stream start.
- `src/cursor-display-text.ts` owns shared single-line sanitization and 240-char truncation for replay/trace display.
- `src/cursor-native-tool-display-replay.ts` owns replay card rendering and diff/preview formatting.
- `src/cursor-native-tool-display-tools.ts` owns native/replay tool definition factories and replay execute wrappers.
- `src/cursor-native-tool-display-state.ts` owns native replay display state, env gating, and record/consume helpers.
- `src/cursor-tool-transcript.ts`, `src/cursor-transcript-utils.ts`, `src/cursor-transcript-tool-formatters.ts`, and `src/cursor-tool-names.ts` handle display-only Cursor native tool replay and transcript labels.
- `src/cursor-mcp-timeout-override.ts` owns Cursor SDK MCP call timeout overrides for long-running local MCP tools.
- `src/cursor-state.ts` owns `/cursor-fast`, `--cursor-fast`, `--cursor-no-fast`, session state, and global fast defaults.
- `src/context.ts`, `src/context-window-cache.ts`, and `src/bundled-context-windows.ts` handle prompt conversion and context-window caches.
- `test/**/*.test.ts` contains Vitest coverage for provider registration, discovery, state, context, bridge, replay, and streaming behavior.
- `docs/cursor-model-ux-spec.md` is the maintainer design source of truth for Cursor model UX. Keep it aligned with behavior changes.
- `docs/cursor-testing-lessons.md` is the maintainer source of truth for regression testing lessons (auth.json, isolated smoke harnesses, JSONL replay scans, plan-mode replay traps).

## Operating rules

- Prefer the smallest change that preserves the current pi user contract.
- Treat Cursor SDK model metadata as the source of truth for model IDs, parameters, variants, thinking controls, and context variants. Do not hardcode new model-specific behavior unless it is a documented fallback.
- HARD REPO RULE: never guess what the Cursor SDK outputs, expects, or does. Always verify Cursor SDK behavior against the installed `@cursor/sdk` package and/or the official TypeScript SDK docs at `https://cursor.com/docs/sdk/typescript` before making claims or implementation changes.
- Keep pi-native abstractions first: context is a model variant, thinking uses pi thinking metadata, and Cursor-only `fast` is extension state/status.
- Preserve the default pi footer; use extension status only for Cursor-only state such as `cursor fast`.
- Stop discovery once package scripts, README, config files, tests, and the relevant `src/` modules explain the task. Do not broad-search `node_modules` unless debugging a dependency API.
- Ask the user before changing public UX, published package metadata, dependency families, or behavior that requires a migration. Otherwise proceed and verify locally.

## Setup and commands

- Install dependencies: `npm install`
- Run tests: `npm test`
- Typecheck: `npm run typecheck`
- Package-readiness check: `npm pack --dry-run`
- Watch tests while developing: `npm run test:watch`
- Local development run, requires a Cursor key: `CURSOR_API_KEY="your-key" pi -e . --model cursor/composer-2.5`
- List Cursor models, requires pi and usually a Cursor key: `pi --list-models cursor`
- Capture provider/SDK event artifacts for one prompt, requires a Cursor key: `CURSOR_API_KEY="your-key" npm run debug:provider-events -- --prompt "hello"`

There is no lint or format script in `package.json` at this time.

## Coding conventions

- TypeScript is ESM with `moduleResolution: "NodeNext"`; keep `.js` extensions on local relative imports.
- Keep strict TypeScript types. Avoid `any` except in tests or when narrowing untyped external SDK data.
- Keep provider runtime code side-effect-light. Do not write secrets, and do not let cache or discovery failures break response streaming unless the run cannot proceed safely.
- Add or update tests for behavior changes in `src/`. Prefer focused unit tests over live Cursor calls.
- If dependency versions change, update `package-lock.json` with npm. Do not manually edit generated dependency output.
- Do not commit `dist/`, `coverage/`, `.env*`, `.pi/`, or package tarballs.

## Validation and done criteria

Done means:

- The intended behavior or documentation change is complete.
- `npm test` and `npm run typecheck` pass, unless the change is docs-only and the user asked for minimal validation.
- `npm pack --dry-run` passes when package metadata, publishable docs, dependencies, or ignored artifacts change.
- Related README/docs/tests are updated when behavior, commands, user-visible model IDs, flags, or troubleshooting change.
- No secrets, local API keys, or noisy local state are added.

If validation fails:

1. Triage the first failing test/type error to root cause.
2. Fix failures caused by the change.
3. If a failure is unrelated or cannot be run locally, report the command, failure, likely reason, and what still needs verification.

## Planning and large changes

Use a short written plan before multi-file behavior changes, SDK integration changes, or public UX changes. Use `PLANS.md` only if a task needs durable multi-session tracking; do not create one for routine edits.

## Security and side effects

- NEVER store Cursor API keys in repo files, `~/.pi/agent/cursor-sdk.json`, tests, logs, snapshots, or docs examples.
- Scrub Cursor SDK errors and output that may contain API keys, bearer tokens, cookies, sessions, or auth headers.
- `PI_CURSOR_SDK_EVENT_DEBUG=1` and `npm run debug:provider-events` write raw local artifacts that may include prompts, tool args/results, local paths, or secrets; keep them under gitignored `.debug/`, do not print or commit them, and keep run-scoped debug state explicit rather than process-global.
- Ambient Cursor settings/rules loading is enabled by default through `PI_CURSOR_SETTING_SOURCES=all`; keep SDK startup log filtering intact so settings/skills output does not corrupt pi's TUI.
- Live `pi`/Cursor smoke tests may call external services and require Cursor auth in `~/.pi/agent/auth.json` and/or `CURSOR_API_KEY`; run them for Cursor provider/runtime changes. If auth is unavailable, report live smoke as release-blocked instead of skipped-ready. See `docs/cursor-testing-lessons.md` for isolated harness auth seeding.
- For Cursor provider/runtime changes, follow `docs/cursor-live-smoke-checklist.md`. Assume every runtime surface is in scope. Use real `pi -e . --cursor-no-fast --model cursor/composer-2.5` invocations, a temporary `--session-dir`, manual observation, and no secret printing. Do not mark release-ready with optional/deferred/mostly-passing smoke items outstanding.

## PR review workflow (maintainer)

When the user requests a PR review (including thermo-nuclear / deep maintainability review):

- Remediate **every** finding, structural and polish; do not leave “nice to have” items open.
- When **you are the parent maintainer session** orchestrating remediation (not a delegated child worker), prefer dispatching a remedial code/docs subagent; the parent coordinates review, commit, push, and re-review loops. Child workers should implement assigned fixes directly and must not inherit subagent-dispatch instructions from this section.
- After remediations land, **repeat the review** on the updated branch until there are **no** remaining findings (including docs/PR-body drift and test-contract gaps).
- Do not approve on passing unit tests alone. Thermo-nuclear review is maintainability-only and does **not** tell you to skip live smoke; repo smoke gates live here and in `docs/cursor-live-smoke-checklist.md`.

## Pre-commit live smoke (maintainer)

Before **every commit** that touches Cursor provider/runtime, prompt/session send policy, agents-context dedup, bridge, replay, or related extension wiring:

- Run real `pi` against the local extension: `pi -e . --cursor-no-fast --model cursor/composer-2.5` with a fresh `--session-dir` under `/tmp` (see `docs/cursor-live-smoke-checklist.md`).
- Prefer `npm run smoke:live` (`scripts/tmux-live-smoke.sh`) or the relevant checklist subset via tmux when TUI observation matters; use `npm run smoke:isolated` for full pre-release packaging + live preflight when appropriate.
- If Cursor auth (`~/.pi/agent/auth.json` or `CURSOR_API_KEY`) is unavailable, **do not commit**—report blocked, not skipped-ready.
- Unit tests (`npm test`, `npm run typecheck`) are necessary but not sufficient for these commits.

## Progress updates and handoff

For multi-step or tool-heavy work, give short progress updates after meaningful milestones: what changed, what is being checked, and any blocker. Final handoff should include changed files, validation commands/results, skipped checks with reasons, and any follow-up risks.

## Updating this file

Keep this file concise and repo-specific. Update it when commands, package layout, safety constraints, or validation expectations change. Put specialized subdirectory rules in a nested `AGENTS.md` only when that subtree has materially different commands or constraints.
