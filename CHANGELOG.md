# Changelog

## Unreleased

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
