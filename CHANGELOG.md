# Changelog

## Unreleased

### Changed

- Enable guarded branch-scoped local Cursor SDK resume by default for local runtime; users can opt out with `--cursor-no-local-resume`, `PI_CURSOR_LOCAL_RESUME=0`, or `local.resume: false`.

### Added

- Add `/cursor-refresh-config` to call the current pooled Cursor SDK agent's `agent.reload()` for filesystem Cursor config refreshes without recreating the agent.
- Add explicit local Cursor safety controls: `--cursor-auto-review` / `PI_CURSOR_AUTO_REVIEW` and `--cursor-sandbox` / `PI_CURSOR_SANDBOX`, plus `local.autoReview` and `local.sandboxOptions.enabled` config. Defaults stay off.
- Add one-shot manual local stuck-run recovery with `--cursor-local-force` / `PI_CURSOR_LOCAL_FORCE`, wired only to the next `Agent.send(..., { local: { force: true } })`; no persistent config default, retry loop, or automatic force recovery is added.
- Add minimal explicit Cursor cloud runtime execution after first-use acknowledgement and safety preflight. Defaults stay local + loopback MCP; cloud runs use fresh context by default, skip the pi bridge/local MCP/env forwarding, leave cloud agents alive for Cursor-managed cleanup, and keep project config limited to the runtime default for the initial cloud slice.
- Show Cursor runtime directly in the interactive status footer (`cursor:local · fast:on|off|n/a`, `cursor:cloud · fast:n/a`) so cloud opt-in is visible.
- Name explicit Cursor cloud agents from the current pi session title when available so Cursor Cloud agent lists are easier to match back to pi sessions.
- Add explicit Cursor-managed cloud environment selection with `--cursor-cloud-env-type`, `--cursor-cloud-env-name`, `PI_CURSOR_CLOUD_ENV_TYPE`, `PI_CURSOR_CLOUD_ENV_NAME`, and `cloud.environment.type/name` user config. This selects Cursor Cloud `cloud` / `pool` / `machine` environments without forwarding local env values.
- Stream bounded display-only Cursor Cloud completion telemetry when available: agent/run IDs, pushed branch and PR URL with fetch/checkout hint, passive artifact paths, and raw cloud usage without persisting it into transcript content or feeding that usage into pi accounting.
- Add `/cursor-cloud list`, `/cursor-cloud archive <bc-agentId>`, and `/cursor-cloud delete <bc-agentId> --yes` for session-branch recorded cloud agents; archive/delete reject empty, non-`bc-`, wildcard, unrecorded, bulk, and unconfirmed delete requests before SDK calls.
- Add guarded branch-scoped local Cursor SDK resume; it stores SDK agent IDs only in pi session custom entries, re-supplies current model/tool transport, and falls back to create+bootstrap with a display-only continuity note when resume is unavailable.

### Fixed

- Stop applying Cursor SDK `RunResult.usage` to pi assistant messages when no per-turn `turn-ended` usage is available; long local sessions can report full-agent-context usage there, which can poison compaction/session token totals. Pi now falls back to bounded local estimates unless real per-turn SDK usage is present and fits the selected model window.
- Pass the current Cursor model selection on every SDK `agent.send()` so resumed and pooled agents keep pi's active model as the source of truth.

## 0.1.56 - 2026-07-04

### Changed

- Upgrade the pinned Cursor SDK runtime dependency to exact `@cursor/sdk@1.0.23` after auditing the 1.0.22 → 1.0.23 package/type/docs delta.
- Bump the local pi validation baseline (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) to `0.80.3` after reviewing the current installed Pi 0.80.3 changelog.

### Fixed

- Preserve Cursor SDK `RunError` terminal failure details and codes when formatting failed run diagnostics.

### Validation

- `npm run typecheck`, `npm test`, `npm run check:platform-smoke`, `npm pack --dry-run`, and `npm run smoke:platform:all` pass locally.
- Thermo-nuclear subagent release review signed off with no behavior, TUI/visual, package-baseline, or maintainability blockers.

## 0.1.55 - 2026-07-02

### Changed

- Show Cursor models that do not expose a Cursor `fast` parameter as `cursor-fast:n/a` in the interactive footer instead of plain `cursor`, including `cursor-fast:n/a · plan` when Cursor plan mode is active.

### Validation

- `npm test`, `npm run typecheck`, `npm run typecheck:tests`, `npm pack --dry-run`, `npm run smoke:platform:all`, and release review pass locally.

## 0.1.54 - 2026-07-02

### Changed

- Show Cursor fast state explicitly in the interactive footer for fast-capable Cursor models as `cursor-fast:on` or `cursor-fast:off`, while preserving plain `cursor` status for Cursor models without fast support and clearing status for non-Cursor models.

### Fixed

- Accept wrapped `package.json` read-card paths in platform-smoke visual assertions while keeping JSONL result checks as the source of truth for the actual bridge read target.

### Validation

- `npm test`, `npm run typecheck`, `npm run typecheck:tests`, `npm pack --dry-run`, `npm run smoke:platform:all`, and subagent review loop pass locally.

## 0.1.53 - 2026-06-29

### Changed

- Use real per-turn Cursor SDK usage when available, including cache read/write fields, while keeping local prompt/output estimates as the no-SDK-usage fallback. SDK-attributed context occupancy is pinned to latest-turn input plus output so cumulative run input and cache reads do not overstate compaction pressure; fallback context occupancy uses the replayable context estimate so split tool turns do not show a tiny footer percentage next to large input counts.
- Shorten Cursor bootstrap and incremental prompt boundary text while preserving host-tool, configured MCP, pi bridge, exact-output, shell cwd, plan-mode, and latest-image guidance. The callable-surface manifest remains enabled by default but uses compact wording for Cursor host/configured MCP tools and pi tools/bridge exposure.

### Fixed

- Resolve standalone Windows platform-smoke suite setup by resolving the local `pi` CLI after target dependencies are installed instead of falling back to a missing global `pi.cmd`.

### Validation

- Usage accounting regression tests prove the old 6.7M cumulative fixture now reports per-turn input `25,432`, cache read `24,000`, and context `26,044` instead of a sub-1k char/4 estimate or cumulative input.
- Prompt-builder measurement reduced pi's local bootstrap estimate from 537 to 367 tokens for explicit no-bridge eval prompts and from 546 to 367 tokens for interactive bridge prompts; this is not a claim about real Cursor token savings because SDK/Cursor-side settings, rules, and tool schemas dominate actual usage.
- `pi-model-eval` default-seed HumanEval+ smoke for `cursor/gpt-5.5@272k (medium)` passed 5/5 with average pi-estimated input reduced from 721.2 to 648.2 on the same first five tasks; real Cursor usage is now reported from SDK usage when available.
- Focused live smokes verified exact-output, Cursor-native file read, pi bridge `pi__read`, and corrected footer context percentages after split tool turns.
- `npm run verify`, `npm pack --dry-run`, and `npm run smoke:platform:all` pass locally; release-review subagent returned no findings.

## 0.1.52 - 2026-06-28

### Fixed

- Serialize Cursor provider turns per pi session scope so parallel same-session Cursor model evaluations cannot supersede each other's SDK session agent or drain the wrong live run. Queued aborts now return an aborted stream without creating a Cursor SDK agent or leaking the turn queue.

### Validation

- `npm run check:platform-smoke`, `npm run typecheck`, `npm test` (796 tests), and `npm publish --dry-run` pass locally.
- `npm run smoke:platform:all` passes on macOS, Ubuntu, and Windows native with Cursor auth. Artifact index: `.artifacts/platform-smoke/latest.json`.
- Subagent review/fix loop and thermo-nuclear release review completed with final `NO FINDINGS`.

## 0.1.51 - 2026-06-25

### Changed

- Upgrade the pinned Cursor SDK runtime dependency to `@cursor/sdk@1.0.22` after auditing the 1.0.19 → 1.0.22 package/type/docs delta. Cursor SDK now declares its Node ConnectRPC transport dependency directly, so packed npm installs resolve `@connectrpc/connect-node` from the SDK path instead of failing at runtime (#131).
- Refresh the offline Cursor fallback model catalog from the live SDK catalog: add `claude-fable-5` and `composer-2`, and preserve variant-only `cyber=false` defaults on Opus variants. Live authenticated discovery remains the source of truth.
- Codify the maintainer release-review gate: npm/GitHub releases must run a thermo-nuclear review/fix loop until no findings or polish items remain, in addition to the platform smoke gate.

### Fixed

- Classify Cursor SDK `onStall` cancellation wrappers (`ConnectError: [unknown] [canceled] This operation was aborted`) as retryable network failures during active Cursor turns so sudden network outages do not escape as process-level crashes (#128).

### Validation

- `npm run verify` passes against package version `0.1.51` (`check:platform-smoke`, `typecheck`, and `npm test` with 794 tests).
- `npm pack --dry-run` produces `pi-cursor-sdk-0.1.51.tgz` without bundling `@cursor/sdk` or its transport tree; a temp consumer install resolves `@connectrpc/connect-node` from the `@cursor/sdk@1.0.22` dependency path, `npm ls @connectrpc/connect-node undici` is coherent, and the SDK imports successfully.
- `npm run smoke:platform:all` passes on macOS, Ubuntu, and Windows native with Cursor auth (platform-build, native-replay visual matrix, bridge visual matrix, abort cleanup, packed installs, PTY/ConPTY capture, JSONL assertions, redaction scans). Artifact index: `.artifacts/platform-smoke/latest.json`.
- `npm audit --audit-level=low` reports 3 upstream advisories in the SDK-owned `@connectrpc/connect-node -> undici@5.29.0` tree with no npm-provided fix; this release keeps npm dependency resolution coherent rather than bundling a mismatched transport override.

## 0.1.50 - 2026-06-24

### Added

- Normalize Cursor context-overflow failures into pi's `context_length_exceeded` form via a `message_end` handler so pi's auto-compact-retry recovery fires when a Cursor run fails on a too-large prompt. Scoped to the Cursor provider, limited to `stopReason === "error"`, never matches throttling/rate-limit signals, and idempotent. See pi `docs/custom-provider.md` "Context Overflow Errors".

### Changed

- Bump the local pi validation baseline (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) from `0.80.1` to `0.80.2` after reviewing current installed Pi 0.80.2 docs and types. Published pi core peer dependencies remain `"*"`.
- Reconcile the README recommended/validated pi baseline wording (previously `0.80.1` recommended vs `0.79.10` validated) to the current `0.80.2` baseline.

### Validation

- `npm run typecheck`, `npm test` (790 tests), and `npm pack --dry-run` pass against the `0.80.2` pi core local validation baseline.
- `npm run smoke:platform:all` passes on macOS, Ubuntu, and Windows native (native-replay visual matrix, bridge visual matrix, abort cleanup; packed installs, PTY/ConPTY capture, JSONL assertions, redaction scans) with Cursor auth.

## 0.1.49 - 2026-06-23

### Changed

- Update the local pi validation baseline to `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` `0.80.1` after reviewing the Pi 0.80.0 and 0.80.1 changelogs plus current package/provider docs.
- Move source and test imports that typecheck against old root `@earendil-works/pi-ai` globals to `@earendil-works/pi-ai/compat`, matching the Pi 0.80 migration guidance.

### Validation

- `npm test`, `npm run typecheck`, and `npm pack --dry-run` pass against the `0.80.1` pi core local validation baseline.

## 0.1.48 - 2026-06-22

### Fixed

- Bundle Cursor's Node ConnectRPC transport seam with `undici` `7.28.0` so downstream `pi install npm:pi-cursor-sdk` production installs inherit the audited transport dependency instead of npm's root-only `overrides` fix.

## 0.1.47 - 2026-06-22

### Changed

- Update the local pi validation baseline to `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` `0.79.10` after reviewing the Pi 0.79.10 changelog, extension compaction events, provider/package docs, and release workflow.

### Fixed

- Refresh the test event harness for Pi 0.79.10's required `session_before_compact` and `session_compact` `reason` / `willRetry` metadata.

## 0.1.46 - 2026-06-21

### Changed

- Update the local pi validation baseline to `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` `0.79.9` after reviewing current installed Pi extension, provider, package, and security docs.
- Bump the maintained `undici` override to `7.28.0` and refresh vulnerable transitive audit dependencies so `npm audit --audit-level=low` reports zero vulnerabilities.

### Fixed

- Resolve maintainer shell smoke self-test failures under mise by sealing smoke PATHs with the real `process.execPath` Node executable instead of the `node` shim path.
- Harden the platform bridge visual matrix by asserting the exact JSONL tool-result order required by the documented prompt contract.

## 0.1.45 - 2026-06-18

### Fixed

- Classify Cursor SDK HTTP/2 `NGHTTP2_ENHANCE_YOUR_CALM` and stream-reset `ConnectError`s as retryable network errors so active-turn process errors do not hard-crash pi (#127).

## 0.1.44 - 2026-06-16

### Changed

- Upgrade the pinned Cursor SDK runtime dependency to `@cursor/sdk@1.0.19`, add the SDK's still-required Node ConnectRPC transport as a direct runtime dependency, and remove the stale `sqlite3` override now that the old SDK `sqlite3 -> node-gyp@8` deprecated install-warning chain is gone (#115).

## 0.1.43 - 2026-06-15

### Changed

- Update the local pi validation baseline to `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` `0.79.4` after validating the extension under pi 0.79.4.

## 0.1.42 - 2026-06-10

### Added

- Surface Cursor SDK `task` activity as `Cursor subagent` replay/lifecycle cards by default, including description, subagent kind, model, short safe agent ID metadata, task-only expand hints, and returned `conversationSteps` summaries when the SDK provides them.
- Add `PI_CURSOR_TASK_PRESENTATION=task` as an escape hatch for the older explicit `Cursor task` wording.

### Fixed

- Suppress unsafe nested subagent path displays, including out-of-workspace absolute paths, traversal, home aliases, URI-shaped paths, and Windows drive forms, while preserving in-workspace relative summaries.

## 0.1.41 - 2026-06-09

### Changed

- Upgrade the pinned Cursor SDK runtime dependency to `@cursor/sdk@1.0.18` after auditing the 1.0.17 → 1.0.18 SDK type/docs delta; preserve existing local-agent defaults while carrying the SDK `requestId` correlation field through debug metadata and generic run failure diagnostics.
- Update the local pi validation baseline to `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` `0.79.1`, including platform-smoke artifact retention and visual smoke manifest evidence for Pi 0.79.1 release checks.

### Fixed

- Keep plan-mode Cursor tool guidance canonical so bootstrap prompts do not duplicate the same instructions while incremental prompts still carry the plan-mode reminder.
- Preserve turn-local Cursor usage estimates for incremental/live sends instead of replacing them with replayable-context totals.
- Honor pi's disabled tool registry state when syncing Cursor bridge/question/skill/replay tools so `--no-tools` removes pi bridge exposure while leaving Cursor SDK host tools under Cursor's own control.
- Keep bridge MCP result flushing behind the bridge run abstraction rather than leaking protocol scheduling into provider pre-send drain.

## 0.1.40 - 2026-06-08

### Changed

- Update the local pi validation baseline to `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` `0.79.0` after reviewing current Pi extension, package, SDK/RPC, model/provider, and project-trust docs. Runtime Cursor setting-source defaults remain risk-on and unchanged: unset `PI_CURSOR_SETTING_SOURCES` still loads `all` Cursor setting sources.
- Make maintainer smoke/debug scripts pass Pi 0.79 `--approve` explicitly when they must load project-local package settings, extensions, or instructions in noninteractive release automation.

### Fixed

- Prune old local platform-smoke artifact run directories before new matrix runs so `.artifacts/platform-smoke` does not grow without bound while preserving recent and manual evidence directories.

## 0.1.39 - 2026-06-08

### Fixed

- Surface Cursor shell command starts with scrubbed command previews, including path-bearing commands, and stream bounded `shell-output-delta` stdout/stderr progress before completion so users do not stare at only pi's generic `Working...` state.
- Mark generic Cursor SDK run failures and Cursor SDK network failures with pi-native retry classifier phrases so pi's existing auto-retry/backoff flow can recover transient failures automatically instead of requiring a manual follow-up message.

## 0.1.38 - 2026-06-08

### Added

- Add shared Cursor replay result readers so transcript formatting, native replay cards, and activity builders consume the same MCP-like content/diff/file-preview extraction logic.
- Add a canonical Cursor model lifecycle sync helper for session start, before-agent-start, model selection, and turn start registration paths.
- Add lazy Cursor provider registration so extension startup can register models and commands without importing the Cursor SDK runtime until the provider is invoked.
- Add shared Cursor native tool-name and pi-tool-bridge environment helpers for provider/runtime registration code.

### Changed

- Centralize Cursor tool presentation ownership in the typed presentation registry, including labels, aliases, lifecycle titles, replay metadata, side-effect policies, and web-tool classification.
- Consolidate Cursor session cwd, session file/id, generation, and scope-key handling in `cursor-session-scope`; remove the older cwd/message-offset helper split.
- Simplify Cursor session-agent lifecycle invalidation on model select, compaction preparation, tree navigation, shutdown, and scope changes.
- Refine Cursor tool lifecycle/replay display routing so completed replay cards, inactive traces, native replay activation, and duplicate step/delta completions share one display path.
- Keep Cursor agents-context dedup and fallback-catalog warning registration model-scoped through the shared lifecycle helper.
- Keep edit/write replay previews on the shared structured diff/file preview renderers while retaining SDK expanded-text fallback behavior.
- Update maintainer docs and repo map entries for the new ownership boundaries.

### Fixed

- Clear started Cursor tool calls when a completed delta reports the same tool under a different SDK call id, preventing stale native replay edit starts from surfacing as `Cursor edit did not complete` after successful final text.
- Keep Cursor agents-context dedup registration in a tracked module so clean package builds resolve `src/index.ts` imports.
- Accept Windows-rendered absolute `README.md` paths in platform-smoke grep-card detection without weakening prompt false-positive checks.
- Preserve Cursor skill activation and question-tool registration through lazy provider/runtime import boundaries.
- Preserve fast local discovery incomplete-tool suppression while still surfacing aborts, SDK failures, and no-text incomplete runs.

## 0.1.37 - 2026-06-06

### Changed

- Cut Cursor native replay over to one canonical replay surface: neutral `cursor` activity cards plus native-compatible `read`, `bash`, `grep`, `find`, `ls`, `edit`, and `write` cards. Legacy `cursor_*` replay wrapper names, alias exports, old `cursorToolName` replay-detail parsing, and replay-only prompt metadata are removed instead of preserved behind compatibility shims (#123).
- Keep edit/write replay previews on the shared structured diff/file preview renderers, while retaining unstructured `expandedText` unified-diff extraction only as a fallback for current SDK payloads that do not include structured diff fields.

### Fixed

- Stop registering duplicate replay-only prompt snippets/guidelines for every Cursor SDK activity wrapper, eliminating the inflated prompt metadata reported by issue #123 while preserving current TUI replay card titles, summaries, typed details, and `sourceToolName` display metadata.

## 0.1.36 - 2026-06-05

### Fixed

- Classify Cursor backend `ConnectError: [unavailable] Error` failures with code 14 and `aiserver.v1.ErrorDetails` as recoverable network/service errors, preventing duplicate process-level uncaught exceptions from crashing pi while still surfacing scrubbed retry guidance.

## 0.1.35 - 2026-06-05

### Changed

- Share the Cursor SDK startup-output filter through one published `shared/` helper while preserving the existing provider and maintainer-script import paths.
- Add prompt snippets for the Cursor bridge question and skill activation tools so their pi-native prompt metadata matches their existing schemas and guidelines.

### Fixed

- Scope fileless/in-memory Cursor session agents by pi session ID instead of the process-wide anonymous fallback, so terminal shutdown of one ephemeral session does not poison later no-session replacements.

## 0.1.34 - 2026-06-04

### Changed

- Update the local pi validation baseline to `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` `0.78.1` after reviewing the Pi 0.78.1 changelog and extension/provider docs. Pi core peer dependency ranges now follow current pi package guidance with `"*"` ranges, and docs call pi 0.78.1 the recommended validated baseline rather than a hard pin.
- Gate Cursor native replay tool registration on Pi 0.78.1's precise `ctx.mode === "tui"` instead of treating all dialog-capable UI modes as safe for terminal replay rendering; RPC/JSON/print modes keep bridge/question tools without TUI-only replay wrappers.

### Fixed

- Align `cursor_ask_question` and `cursor_activate_skill` failure paths with Pi's current custom-tool contract by throwing on invalid input, unavailable UI, missing skills, and skill load failures instead of returning successful tool results with ignored `isError` fields.

## 0.1.33 - 2026-06-04

### Fixed

- Prevent connect-node-only Cursor SDK network resets such as `ConnectError: [aborted] read ECONNRESET` from escaping as process-level uncaught exceptions during active Cursor turns, while keeping provenance-free generic ConnectRPC errors unsuppressed (#121).
- Suppress expected Cursor SDK abort `ConnectError` / `AbortError` shapes during abandoned live-run cancellation so idle-resume and interrupt cleanup paths keep pi alive for later prompts (#120).

## 0.1.32 - 2026-06-02

### Added

- Add a production typing-safety regression test that blocks broad TypeScript escape hatches such as `as unknown as`, `as any`, `as never`, explicit `any`, and production `@ts-ignore` / `@ts-expect-error` usage.

### Changed

- Replace repeated native replay render-test `as never` casts with typed test render fixture helpers.
- Use the maintained Homebrew Crabbox binary on `PATH` for platform smoke with a `0.24.0` minimum version, keeping `PLATFORM_SMOKE_CRABBOX` as an explicit override only.

### Fixed

- Harden local Cursor cache/config JSON parsing so model-list, context-window, and fast-default files are validated from `unknown` before trusted values are used.

## 0.1.31 - 2026-06-01

### Added

- Add Cursor `:fast` and `:slow` virtual model aliases for models with a Cursor SDK `fast` parameter so subagents and workflow-spawned agents can choose fast/slow independently of saved `/cursor-fast` defaults (#112).

## 0.1.30 - 2026-06-01

### Added

- Preserve pi Agent Skills for Cursor runs by rewriting pi's skill catalog into Cursor-safe activation instructions and exposing `cursor_activate_skill` through the pi MCP bridge as `pi__cursor_activate_skill` when visible pi skills are available (#113).

### Changed

- Document that deprecated install warnings currently come from the closed-source Cursor SDK's `sqlite3@5.1.x` transitive dependency chain, and document root-project override limits/workarounds instead of relying on unsupported transitive package overrides (#115).

## 0.1.29 - 2026-06-01

### Added

- Add the maintainer-local `smoke:platform:*` release gate for macOS, Ubuntu, and Windows native through Crabbox, including packed-install proof, PTY/ConPTY ANSI capture, host-side xterm/PNG visual evidence, JSONL tool/final-marker checks, bridge diagnostics, usage/cache assertions, abort cleanup, artifact manifests, and redaction scans.

### Changed

- Upgrade the pinned Cursor SDK runtime dependency to `@cursor/sdk@1.0.17` for package version `0.1.29`.
- Clarify Composer multi-part final text semantics: final-answer consumers use the last non-empty assistant `text` part, and platform smoke markers must appear in that final text part (#111).
- Prefer the selected Cursor SDK model alias, such as `composer-2-5`, for Cursor fast-state keys while retaining legacy fallback reads for older `composer-2.5` / base-model keys.
- Speed up the platform smoke release gate without dropping coverage by running targets concurrently, reusing one live packed-install prep per target session, and replacing fixed sleeps with readiness polling where safe.

### Fixed

- Suppress unhelpful generic `Cursor shell: shell` lifecycle noise for shell commands whose details are unsafe to display, while keeping completed shell cards/traces visible.
- Dedupe duplicate active Cursor SDK tool lifecycle starts by stable tool-call fingerprints, preserving completed tool results.
- Harden Windows bridge abort cleanup with marker-scoped bash process cancellation and required abort diagnostics.

## 0.1.28 - 2026-05-29

### Changed

- Update the local pi validation baseline to `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` `0.78.0` after reviewing the 0.78.0 changelog; peer dependency ranges remain minimum-only at `>=0.76.0` (#108).

### Fixed

- Prevent Cursor SDK ConnectRPC network resets such as `ConnectError: [aborted] read ECONNRESET` from escaping as process-level uncaught exceptions during active Cursor turns; pi now surfaces the existing scrubbed retry guidance and remains available for the next turn (#107).

## 0.1.27 - 2026-05-29

### Changed

- Upgrade the pinned Cursor SDK runtime dependency to `@cursor/sdk@1.0.16` and keep the local validation baseline on pi `0.77.0`.
- Align Cursor context-window checkpoint reads with the SDK 1.0.16 local platform options by scoping direct `createAgentPlatform()` calls to the pi session cwd, matching the workspace used for `Agent.create()`.
- Review SDK 1.0.16 public-surface changes: new custom `LocalAgentStore` exports (`JsonlLocalAgentStore`, `SqliteLocalAgentStore`, store filters/paginators), per-call `store` options on local agent/list/message APIs, `Cursor.configure()` / `configureCursorSdk()` local defaults, HTTP/1 agent override support, public `CursorAgentPlatformOptions` local-store fields, and the removal of `AgentOptions.platform`. The extension continues to use the SDK default SQLite store and does not install a custom global SDK configuration because pi session cwd remains the source of truth for local persistence.

## 0.1.26 - 2026-05-29

### Added

- Cache the discovered Cursor model catalog on disk at `~/.pi/agent/cursor-sdk-model-list.json` (`0600`, keyed by an API-key fingerprint) so warm pi startups skip the live `Cursor.models.list` network round-trip that added several seconds to boot (#78). Tune with `PI_CURSOR_SDK_MODEL_CACHE_TTL_MS` (default 24h) or disable with `PI_CURSOR_SDK_DISABLE_MODEL_CACHE=1`.

### Changed

- Clarify setup docs and runtime auth messages: `pi-cursor-sdk` requires a Cursor SDK API key and does not reuse Cursor Agent CLI/Desktop login or subscription auth.
- `/cursor-refresh-models` now forces a live catalog refresh, bypassing the on-disk cache and rewriting it. A previously cached catalog is preferred over the bundled fallback when a live refresh fails.
- Lazy-load the Cursor SDK runtime so warm cached startup paths avoid importing `@cursor/sdk` until live model discovery or a Cursor turn needs it (#100).

### Fixed

- Prevent Cursor SDK `ConnectError: [unauthenticated]` failures from crashing pi as process-level uncaught exceptions; surface them as recoverable Cursor auth errors instead.

## 0.1.25 - 2026-05-28

### Fixed

- Keep fallback Cursor models visible before `/login` on pi 0.77 by using a non-secret provider API-key sentinel while still resolving real keys from pi auth, `--api-key`, and `CURSOR_API_KEY`.

## 0.1.24 - 2026-05-28

### Changed

- Refresh the bundled Cursor fallback model catalog from `@cursor/sdk@1.0.15`, including Claude Opus 4.8 context variants and the updated `opus-latest` alias target.

## 0.1.23 - 2026-05-28

### Changed

- Upgrade the pinned Cursor SDK runtime dependency to `@cursor/sdk@1.0.15` and validate development/test packages against pi `0.77.0`.
- Register Cursor provider auth with pi 0.77's `$CURSOR_API_KEY` config-value syntax while keeping legacy `CURSOR_API_KEY` placeholder handling for older stored auth and pi 0.76 compatibility.
- Keep pi peer dependencies minimum-only with no upper bound so users can try newer pi releases before a matching extension update is published; `0.77.0` is the validation baseline, not a maximum supported version.

## 0.1.22 - 2026-05-28

### Fixed

- Fix pi auto-compaction `AgentBusyError` (`already has active run`) by marking pooled session agents busy as soon as a Cursor SDK `run.wait()` starts (live and direct turns), releasing scoped live-run drain state, and resetting the pooled agent on `session_before_compact` before summarization streams (`prepareCursorSessionForCompaction` in `src/cursor-session-compaction-prep.ts`).

## 0.1.21 - 2026-05-28

**Upgrade:** Requires **pi 0.76.0+** and installs exact **`@cursor/sdk@1.0.14`**. Older pi or Cursor SDK combinations are not supported on this release line.

### Added

- Add Cursor SDK **`agent` / `plan` mode** controls: `--cursor-mode agent|plan` for one run, `/cursor-mode agent|plan` (persisted in the session), and `/cursor-mode` to show current mode. Default is `agent`. Plan-mode `createPlan` / `updateTodos` activity stays display-only in pi replay.
- Add a bootstrap **callable tool surfaces** block on the first Cursor send (default on). It summarizes Cursor host tools, exposed `pi__*` bridge tools for the run, and that configured Cursor MCP servers are discovered at runtime. Disable with `PI_CURSOR_TOOL_MANIFEST=0`. See [cursor-tool-surfaces.md](docs/cursor-tool-surfaces.md).
- Add maintainer `/cursor-tools` to print the effective callable-surface manifest for the current session.

### Changed

- Cut over to exact `@cursor/sdk@1.0.14` and drop compatibility paths for older Cursor SDK releases.
- Raise the documented pi floor to **0.76.0+** (`peerDependencies` are minimum-only `>=0.76.0` with no upper bound).
- Seed Cursor SDK mode through `Agent.create({ mode })` and pass the effective mode on every `agent.send(..., { mode })` so CLI and slash-command mode stay authoritative for pooled session agents.
- Shorten bootstrap tool-boundary prompt text; move the full pi bridge contract out of per-tool MCP descriptions (one-line pointer to the bootstrap block); add a shell `cd` hint to the tool tail guard.
- Refactor the Cursor provider turn pipeline (prepare / send / finalize / emit / coordinator) and centralize tool presentation, replay details, and run outcomes. Behavior is intended to be the same or stricter; see **Fixed** for user-visible corrections.

### Fixed

- Fix edit/write **activity replay diff previews** so path-only fallbacks still show diff content instead of title-only cards.
- Fix **replay diff card colors** in the TUI.
- Fix **`generateImage` error replay titles** when the SDK reports a failed image call.
- Fix **abort races** during turn finalize and send cleanup so user aborts and overlapping runs tear down more reliably.
- Fix maintainer **`smoke:isolated` / `smoke:live` print-mode** captures hanging on pi 0.76 when stdout is redirected but stdin stays open (close stdin for `-p` / `--print` runs).

### Maintainer

- Add `npm run smoke:visual` for offscreen TUI visual smoke (ANSI/text/HTML/PNG/JSONL).
- Add [Cursor dogfood checklist](docs/cursor-dogfood-checklist.md) and tighten live/visual smoke env isolation for pi 0.76 `--session-id`, plan mode, and native-replay card proof.
- Add package metadata regression tests for the SDK/pi cutover baselines.

## 0.1.20 - 2026-05-26

### Added

- Shorten known Cursor SDK MCP initialize/listTools timeouts to 10 seconds by default so unavailable configured MCP servers fail fast on first send instead of blocking for the SDK's 60-second protocol default; unknown MCP protocol timeout stacks keep the SDK default. Override with `PI_CURSOR_MCP_CONNECT_TIMEOUT_MS` or `PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS`.
- Add maintainer cold-start timing probe `scripts/probe-mcp-coldstart.mjs` and `npm run debug:mcp-coldstart`.

### Changed

- Document first-send MCP cold-start behavior and initialize/listTools timeout defaults in README troubleshooting.
- Centralize Cursor started-tool visibility classification across incomplete-tool cards, lifecycle progress, fast local discovery suppression, and completed replay titles.
- Rework the cold-start probe to run each scenario in a fresh child process before the first Cursor SDK import.

### Fixed

- Make pooled Cursor session agents idle before send planning/reuse by awaiting fire-and-forget live-run `run.wait()` cleanup in `acquireSessionCursorAgent()`, scoped to the pooled agent instance id, so pi auto-compaction summarization does not hit Cursor SDK `AgentBusyError` (`already has active run`) or plan against stale send state while manual `/compact` after idle still works.
- Fix stale busy pooled-agent waits so reset, terminal disposal, and pool-key replacement wake blocked acquires even when an old SDK `run.wait()` never settles.
- Remove test-only live-run coordinator detachment hooks and keep race invariants inside the session-agent lease/pool contract.
- Keep non-60-second timer scheduling on the cheap path by only capturing timeout stack traces for Cursor SDK's 60-second MCP protocol default.

## 0.1.19 - 2026-05-25

### Added

- Add maintainer Cursor SDK event capture probes, `npm run debug:sdk-events` and `npm run debug:provider-events`, with structured artifacts for SDK callbacks, stream events, provider decisions, bridge diagnostics, drain timelines, final partials, wait results, conversations, and optional pi session snapshots.
- Add display-only replay for Cursor SDK `semSearch` and `recordScreen` activity, including distinct labels for semantic codebase search versus web search.
- Add recognizable Cursor web search/fetch activity cards for SDK MCP/host completions and local Cursor transcript `webSearchToolCall` / `webFetchToolCall` records.
- Surface incomplete started Cursor SDK tool calls as bounded neutral `Cursor … did not complete` cards or traces, including safe reasons for missing completion, abort, SDK failure, and run-drain cleanup while preserving #52 maintainer debug artifacts and excluding bridge-owned `pi__*` calls.
- Add low-noise pending lifecycle visibility for long-running Cursor tools, delayed so fast start/complete pairs coalesce into completed replay cards instead of duplicate permanent start cards.
- Render unknown future Cursor SDK tools as neutral bounded Cursor activity cards, while keeping explicit known-tool replay/transcript formatting authoritative.

### Changed

- Add a Cursor tool-tail guard and periodic session-agent rebootstrap so pooled local Cursor sessions recover from stale tool-tail or long incremental-send chains without losing the pi-facing session contract.
- Refactor Cursor session send planning into `src/cursor-session-send-policy.ts` and document the new session-agent/send-policy ownership in `AGENTS.md`.
- Improve collapsed summaries and bounded transcript text for neutral Cursor activity replay cards, including MCP, task, image, plan/todo, semantic search, record screen, web search/fetch, and future/unknown tools.
- Document the SDK ToolType replay matrix, alias normalization, replay boundaries, and known SDK reporting limits for web search/fetch, future tools, and abort exceptions.
- Route incomplete started-tool visibility through the same native replay disposition used by completed replay, so inactive, conflicting, non-native, and bridge-only contexts fall back to safe traces instead of invalid `cursor` tool-use turns.
- Harden Cursor lifecycle and incomplete-tool labels to scrub commands, URLs, absolute paths, key/flag path values, and secrets before showing user-visible activity.
- Remove the 4096-message local Cursor transcript counting cap so web-tool transcript fallback can work in very long reused local Cursor sessions.

### Fixed

- Fix replay JSONL scan false positives from successful read results and document JSONL replay scan semantics for maintainer smoke triage.
- Suppress duplicate pi `AGENTS.md` injection on Cursor models only when effective Cursor `settingSources` load overlapping `user` / `project` rule layers. Uses exact `contextFiles` block removal exclusively via the `before_agent_start` hook, honors `-nc` and `PI_CURSOR_SETTING_SOURCES=none`, restores full pi context when switching to non-Cursor models, and supports `PI_CURSOR_PRESERVE_PI_AGENTS_MD=1` opt-out.
- Fix collapsed read replay labels when Cursor reports only a local file preview.
- Surface scrubbed Cursor SDK failure and abort reasons in pi instead of generic provider errors, and bound `ConnectError` / `ETIMEDOUT` failures at Cursor SDK async boundaries.
- Harden replay fallbacks and debug discarded SDK tool calls without leaking raw call IDs or secret-bearing payloads.
- Document #40 tool-call-as-plain-text triage and the repro template for distinguishing model narration from real pi replay failures.
- Label Cursor web search and web fetch activity clearly in TUI/replay output without mislabeling SDK `semSearch`.
- Surface direct local Cursor transcript `WebSearch` calls that the SDK stream omits.
- Prevent Esc/user aborts during active local Cursor SDK runs from crashing pi with uncaught `ConnectError: [canceled] This operation was aborted` errors.
- Prevent deferred lifecycle timers from leaking `Cursor …` progress into terminal error/final partials after `run.wait()` resolves or rejects.
- Preserve abort-time incomplete-tool visibility for live runs, including when earlier replay or bridge events are still queued, without replaying or synthesizing earlier tool work.
- Treat missing pi session snapshots in Cursor SDK debug artifacts as optional skipped debug data instead of false `pi_session_snapshot` errors, and let `debug-provider-events` backfill the snapshot after pi exits when the session file appears later.

## 0.1.18 - 2026-05-23

### Added

- Add `scripts/isolated-cursor-smoke.sh` and `npm run smoke:isolated` for packed `/tmp` install smoke with seeded `auth.json`, plan-strip shim, and JSONL replay-error scans.
- Add `scripts/fixtures/plan-strip-shim/` to simulate plan-mode execute stripping active tools to `read`, `bash`, `edit`, and `write`.
- Extend `scripts/validate-smoke-jsonl.mjs` with `--replay-errors` and `--replay-errors-only` to fail on persisted `Tool grep/cursor/find/ls not found` entries.
- Add [Cursor testing lessons](docs/cursor-testing-lessons.md) documenting auth.json seeding, isolated harness layout, JSONL replay scans, and the plan-mode replay regression chain.
- Add regression coverage in `test/cursor-native-replay-stress.test.ts`, `test/cursor-native-replay-trace.test.ts`, `test/cursor-native-replay-routing.test.ts`, and expanded live-run / extension lifecycle tests.

### Changed

- Centralize native replay routing in `src/cursor-native-replay-routing.ts` (`resolveNativeReplayDisposition`, shared context-tool partitioning) for turn coordinator and live-run drain.
- Unify 240-character display truncation in `src/cursor-display-text.ts` and share `getActiveContextToolNames()` via `src/cursor-context-tools.ts`.
- Unify inactive native replay trace formatting through `src/cursor-native-replay-trace.ts` (`title: summary`) for both live-run drain and turn-coordinator paths.
- On non-Cursor model switch, strip all registered native replay wrappers except core pi tools (`read`, `bash`, `edit`, `write`), not only `cursor`.
- Document `auth.json` as the primary live-smoke auth source in the live smoke checklist, README maintainer gate, and UX spec.

### Fixed

- Fix `Tool grep not found` and related native replay failures after plan-mode execute resets active tools by re-syncing registered Cursor replay wrappers on `before_agent_start` and `turn_start`.
- Skip native replay `toolUse` when a replay tool is inactive in `context.tools`; emit scrubbed thinking trace instead of a broken pi tool call.
- Partition live-run drain replay emission so inactive queued native tools fall back to trace output instead of invalid `toolUse` turns.

## 0.1.17 - 2026-05-23

### Added

- Surface in-progress Cursor SDK `task` activity in the TUI from SDK-provided `args.description`, with one deduped line such as `Cursor task: Explore AI/automation projects` and no generic heartbeat or per-tool start spam.

### Changed

- Bump pi dev dependency baseline to `0.75.5` for read-tool collapsed-card rendering, package update fixes, and other upstream pi changes. Cursor edit replay remains display-only via `diffString`; pi's new SDK `details.patch` field is not required because Cursor agents do not execute pi's edit tool.
- Rework live-run internals into dedicated coordination/drain/turn/partial-content modules (`cursor-live-run-coordinator.ts`, `cursor-provider-live-run-drain.ts`, `cursor-provider-turn-coordinator.ts`, `cursor-partial-content-emitter.ts`) while preserving the provider's external contract.
- Complete phase-2 remediation for #23/#24/#25 by splitting bridge ownership across snapshot/server/run/abort/diagnostics/MCP/types modules, splitting native replay ownership across state/registration/replay/tools modules, and unifying tool completion routing through `resolveToolCompletion`.
- Replace monolithic provider test coverage with focused stream/bridge/replay/live-run suites plus shared harness helpers.
- Promote smoke automation into packaged entrypoints (`npm run smoke:live`, `npm run smoke:steering`, `npm run smoke:jsonl`) and make helper retry/polling behavior explicit (TUI answer/footer polling plus deterministic tmux cleanup).
- Document the hard maintainer rule that Cursor SDK behavior must be verified against the installed `@cursor/sdk` package and/or official TypeScript SDK docs before implementation or release claims.
- Bump package metadata to `0.1.17` so the dry-run tarball no longer collides with the existing `v0.1.16` tag.

### Fixed

- Resolve startup noise issue #17 by extending Cursor SDK bootstrap filtering to late hook compatibility warnings and ripgrep/ignore-mapping output while preserving non-startup logs.
- Fix steering/follow-up delivery for active pooled Cursor runs by resuming/waiting on the in-flight run and sending incremental follow-up text after pending tool/result flow completes instead of issuing a second concurrent `Agent.send()`; additional stale tool batches from the old run are cancelled so the new user input is not lost.
- Resolve issue #19 with a canonical edit-diff fallback resolver (`diffString → diff → unifiedDiff → patch`) shared by replay and transcript formatting paths.
- Resolve issue #20 by updating the token-tracking investigation note to mark the `0.75.3` observation as point-in-time and call out the current `0.75.5` development baseline.
- Resolve issue #21 by decomposing prior 1k+ provider/transcript/bridge/test monoliths into ownership-scoped modules.
- Harden bridge diagnostics and secret scrubbing so debug JSONL stays run-safe and allowlisted without endpoint path material, raw args/results, or credential payloads.
- Make Cursor SDK output filtering safe for overlapping provider streams by restoring the global stdout/stderr/console patch only after the last active install.
- Reject bridge MCP calls cleanly when tool-dispatch handlers throw, and avoid suppressing unrelated MCP replay solely because an external payload reuses a known bridge request ID.
- Bound native replay diff/write previews by both lines and characters, summarize non-text MCP content without dumping raw payload JSON, and make expanded-diff truncation copy truthful.
- Change smoke forbidden-material scans to report only matching file names, not secret-bearing matched lines.
- Harden live-smoke direct-output checks so a step logs `PASS` only after both command exit and expected stdout assertion succeed, with the basic prompt retrying once on empty output even when the first command exits zero.

## 0.1.16 - 2026-05-22

### Added

- Reuse Cursor SDK agents within the same pi session when model, API key, cwd, bridge surface, and pi context remain compatible, sending incremental follow-up prompts instead of re-bootstrapping full history on every turn.
- Add context fingerprinting to choose bootstrap vs incremental `Agent.send()` prompts, including branch and compaction summary detection after `/tree` navigation and session compaction.
- Add a manual [Cursor live smoke checklist](docs/cursor-live-smoke-checklist.md) for release validation with real `pi -e . --cursor-no-fast --model cursor/composer-2.5` runs, diagnostics safety scans, TUI observation, bridge/replay checks, abort/cancel coverage, and an assume-everything-is-in-scope no-optional/no-deferred release rule.
- Share the Cursor pi bridge contract through provider prompts and bridged MCP tool descriptions via `src/cursor-bridge-contract.ts`.
- Isolate Cursor usage and live-run accounting in `src/cursor-usage-accounting.ts` and `src/cursor-live-run-accounting.ts`.

### Changed

- Clarify the Cursor provider tool contract in README and replay docs: separate Cursor-native surface, pi bridge surface, and display-only replay.
- Document bridge debug diagnostics (`PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1`) and the scrubbed JSONL allowlist behavior.
- Refresh Cursor fast footer status on `turn_start` and treat models with the `cursor-sdk` API as Cursor models for status updates.

### Fixed

- Harden Cursor pi tool bridge diagnostics so debug JSONL uses run-safe IDs separate from tokenized loopback routes and an allowlisted serializer that omits endpoint path material, raw args/results, and secrets.
- Improve Cursor SDK token accounting for `/session` and compaction by keeping raw Cursor internal usage diagnostic-only, counting split-run tool-call activity/tool-result consumption in approximate pi session usage, using `usage.totalTokens` for the replayable Cursor prompt/context estimate, and sharing the same matched tool-result boundary between provider usage and bridge result resolution.
- Fix duplicated final assistant text when Cursor streams partial post-tool text that prefixes the eventual final answer.
- Preserve the latest user request in budgeted incremental Cursor session-agent prompts.
- Invalidate and recreate session agents on compaction, API key changes, send errors, session shutdown, and `/tree` navigation so reused agents stay aligned with the active branch.
- Treat `/reload` session shutdown as non-terminal for the session-agent pool so the same session can acquire a fresh Cursor SDK agent after reload.
- Bootstrap prompts now include branch summaries after `/tree` navigation.
- Harden Cursor pi tool bridge validation and contract boundaries.

## 0.1.15 - 2026-05-21

### Added

- Add the default-on local pi MCP tool bridge, which exposes bridgeable active pi tools to local Cursor agents while executing calls through pi's normal tool path.
- Add `cursor_ask_question` through the bridge so Cursor can ask users through pi UI as `pi__cursor_ask_question`.
- Add `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1` for opting in to overlapping built-in pi tools that are hidden from the Cursor bridge by default.
- Add Cursor SDK MCP tool-call timeout overrides via `PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS` and `PI_CURSOR_MCP_TOOL_TIMEOUT_MS` for long-running local MCP tools, including bridged pi tools.
- Replay Cursor SDK `grep` activity through native pi `grep` cards and `glob` activity through native pi `find` cards, so search activity matches built-in tool UX in interactive TTY sessions.

### Changed

- Load Cursor setting sources with `PI_CURSOR_SETTING_SOURCES=all` by default while filtering direct Cursor SDK startup logs so settings, rules, plugins, and configured Cursor MCP servers are available without corrupting pi's TUI.

### Fixed

- Replay recorded Cursor tool errors, including nonzero shell exits and timeout-backgrounded shell commands, as native pi tool errors instead of successful green cards.
- Format zero-match Cursor grep results as `(no matches)` instead of raw `{ "totalMatches": 0 }` JSON in native replay and transcript output.
- Strip trailing colons from Cursor grep file-list replay output.
- Make native Cursor read replay closer to pi's built-in read cards by displaying session-relative paths and 20-line continuation hints.
- Convert Cursor SDK shell timeouts from milliseconds to seconds in native bash replay cards instead of rendering `30000ms` as `30000s`.
- Use the pi session cwd for Cursor `Agent.create`, not only native tool replay display. Completes the 0.1.10 cwd work that previously updated replay registration but left the Cursor agent runtime on `process.cwd()`.
- Replay path-only Cursor `write` activity through neutral recorded Cursor activity instead of invalid native pi `write` calls.
- Preserve literal `cursor_edit`, `cursor_write`, and `cursor_mcp` text in user messages, assistant text, tool args, and tool results while still relabeling structured replay tool names.
- Avoid hiding unrelated MCP activity whose result payload merely contains a bridge tool name, while still suppressing real bridge-owned Cursor MCP replay by invocation identity and call ID.
- Clean up pending native replay waits when abort signals are already aborted or abort before listener registration.
- Suppress direct Cursor SDK settings/skills startup noise, including late `managed_skills.removed` lines, without swallowing unrelated non-startup stdout/stderr output.

## 0.1.14 - 2026-05-18

### Changed
- Refreshed the Cursor fallback model snapshot and bundled default/non-Max context-window cache from the current `@cursor/sdk` 1.0.13 catalog, including Composer 2.5 (`composer-2.5` and `composer-2-5`) with default fast-mode support.
- Updated README, demo, and maintainer model UX docs to use Composer 2.5 as the primary Composer example.

## 0.1.13 - 2026-05-18

### Fixed
- Restored lightweight GitHub pi install behavior by removing bundled dependency metadata from the published package. The package already uses the latest `@cursor/sdk` `1.0.13`; local and GitHub installs continue to use the repo-level audited lockfile and overrides.

## 0.1.12 - 2026-05-18

### Fixed
- Bundle the audited `@cursor/sdk` dependency tree so `pi install npm:pi-cursor-sdk` preserves patched `sqlite3`, `tar`, and `undici` transitive versions even though npm package-level `overrides` are not applied when the package is installed as a dependency.

## 0.1.11 - 2026-05-18

### Changed
- Updated the local pi package baseline to `@earendil-works/*` `0.75.3`, including the Node.js `>=22.19.0` runtime floor and refreshed npm lockfile.
- Added prompt metadata for the non-mutating Cursor replay tools so pi can describe `cursor_edit` and `cursor_write` more clearly in tool guidance.
- Removed tracked CueLoop runtime state from the repository and ignored local `.cueloop/` artifacts.


## 0.1.10 - 2026-05-15

### Added

- Replay Cursor SDK `edit` and `write` activity through native pi tool-use turns using non-mutating `cursor_edit` and `cursor_write` cards, so Cursor file changes are visible as first-class tool activity without shadowing pi's built-in `edit` and `write` schemas.
- Add a maintainer `npm run refresh:cursor-snapshots` workflow for refreshing the reviewable Cursor fallback model catalog and optional checkpoint-derived context-window snapshot before releases.

### Changed

- Improve Cursor edit/write replay card UX with concise created/updated/deleted/unchanged summaries and expanded colored diffs.
- Clarify image follow-up behavior: only latest user-message image bytes are forwarded; earlier images remain transcript placeholders and should be reattached or described.
- Allow `/cursor-refresh-models` to refresh the live Cursor model catalog after auth changes without restarting pi.
- Label local read fallback previews as transcript-time local previews when Cursor read result content is unavailable.

### Fixed

- Prevent local read fallback previews from escaping the workspace through symlinks and from bypassing sensitive-path checks through sensitive symlink names.
- Budget oversized prompt history before `Agent.send`, including image-token reservations, while preserving system/tool-boundary instructions and the latest user request.
- Preserve assistant text emitted before native Cursor tool replay.
- Use the pi session cwd for native replay tool registration and update fallback execution to the latest session cwd.

## 0.1.9 - 2026-05-14

### Fixed

- Clean up recorded native Cursor tool replay outputs when abandoned replay runs are disposed, avoiding retained file or command output in process memory.
- Restore `/cursor-fast` state when session persistence fails during command handling.
- Preserve distinct same-payload Cursor tool completions while deduplicating duplicate SDK completion surfaces.
- Respect exact `model@context` context-window cache overrides before falling back to parsed base-model context values.
- Emit native replay text block endings with saved content indexes instead of searching by object identity.
- Redact discovery failure details with the same secret patterns used for stream errors.

### Changed

- Update fallback Sonnet 4.6 context variants from `300k` to the current `200k` catalog variant.
- Skip ambiguous Cursor SDK aliases shared by multiple base models or colliding with base model IDs, preventing misleading pi model rows.
- Reduce context-window cache reloads during model catalog registration.
- Document image carry-forward as a product decision rather than silently changing current latest-user-message image forwarding behavior.

## 0.1.8 - 2026-05-14

### Changed

- Update the verified dependency baseline to `@cursor/sdk` 1.0.13 and Vitest 4.1.6.
- Register latest-style Cursor SDK model aliases returned by `Cursor.models.list()` as pi-selectable Cursor model IDs, including context-qualified alias variants where applicable.
- Clarify Max Mode behavior against current Cursor SDK docs: Cursor may enable required Max Mode automatically, but the extension still only advertises catalog-exposed context variants.

## 0.1.7 - 2026-05-10

### Fixed

- Preserve Cursor post-tool thinking and text that arrive before a native replay tool-use turn closes.
- Count prompt input only once when one Cursor SDK run is split across multiple native replay turns.
- Tighten native replay registration tests and documentation around registration opt-out behavior.

## 0.1.6 - 2026-05-10

### Fixed

- Avoid loading failures when another extension already owns `read`, `bash`, or `ls`; Cursor native replay now registers only non-conflicting wrappers and falls back to scrubbed activity transcripts for skipped tools.
- `PI_CURSOR_NATIVE_TOOL_DISPLAY=0` now skips Cursor native replay tool registration instead of only disabling replay at runtime.

## 0.1.5 - 2026-05-09

### Changed

- Added pi-native `/login` API-key integration for the Cursor provider. Startup discovery now checks pi `--api-key`, the stored `cursor` key in `~/.pi/agent/auth.json`, then `CURSOR_API_KEY`.
- Fallback Cursor models remain available when startup discovery cannot authenticate; once auth is saved, fallback model runs can use the stored key, while `/reload` or restart refreshes the full live Cursor model catalog.
- Improved Cursor activity display by preserving Cursor thinking, streaming Cursor text deltas live when native replay is not active, and replaying completed Cursor internal `read`, `bash`, and `ls` activity through pi's native tool rendering path in interactive TTY sessions where possible. Native Cursor tool replay now follows Codex-style ordering as Cursor SDK tool completions arrive: assistant tool-use turn, recorded pi tool results, live post-tool Cursor thinking/text, any later Cursor tool batches, then final assistant answer. Non-interactive runs keep bounded scrubbed transcript output, and raw Cursor call IDs remain omitted.
- Stopped copying Cursor SDK cumulative internal agent/tool/cache token usage into pi usage, preventing false context-overflow and compaction triggers after long Cursor runs.

### Fixed

- Avoid duplicate final answer text after Cursor streams post-tool text before a later native replayed tool batch.

## 0.1.4 - 2026-05-07

### Fixed

- Restores the GitHub install path to the normal source package layout after the npm-only bundled dependency patch.

## 0.1.3 - 2026-05-07

### Fixed

- Bundled the resolved `@cursor/sdk` runtime dependency tree so npm consumers receive the patched `sqlite3` and `undici` dependency graph used by local verification.

## 0.1.2 - 2026-05-07

### Changed

- Migrated the local pi development baseline and peer metadata from deprecated `@mariozechner/*` packages to maintained `@earendil-works/*` `0.74.0`.
- Regenerated the npm lockfile against the current stable dependency graph and cleared moderate audit findings with current transitive overrides.

## 0.1.1 - 2026-05-05

### Fixed

- Use the bundled default context window for newly discovered Cursor models that do not expose a catalog `context` parameter.
- Redact more Cursor SDK error formats, including JSON-style `apiKey`, `token`, `session_id`, and multi-pair cookie values.

### Changed

- Keep local demo-script notes out of the published npm tarball.

## 0.1.0 - 2026-05-04

Initial public release.

### Added

- Cursor provider registration for pi backed by local `@cursor/sdk` agents.
- Cursor model discovery with fallback startup models when discovery is unavailable.
- Context-window model variants such as `cursor/gpt-5.5@1m` and `cursor/gpt-5.5@272k`.
- Pi native thinking-level mapping for Cursor SDK `reasoning`, `effort`, and boolean `thinking` controls when exposed by the SDK.
- Cursor fast-mode controls through `/cursor-fast`, `--cursor-fast`, and `--cursor-no-fast`.
- Image forwarding from the latest user message to Cursor.
- Cursor-side trace output before final text while preserving pi's default footer.
- Local context-window override cache from successful Cursor SDK checkpoint metadata.

### Notes

- All Cursor SDK models are treated as thinking-capable, even when `pi --list-models` shows `thinking=no`; that column only means pi cannot control a thinking parameter for that model.
- Fallback Cursor models are selection-only. Actual Cursor runs require `CURSOR_API_KEY` or pi's `--api-key`.
- Cursor cloud agents, Cursor Max Mode selection, pi tool-schema forwarding, and ambient Cursor setting/rule loading are not supported in this release.
