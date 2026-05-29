# Changelog

## Unreleased

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
