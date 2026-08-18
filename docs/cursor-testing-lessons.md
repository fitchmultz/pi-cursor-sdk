# Cursor Testing Lessons

> **Platform Smoke:** The required local cross-platform release gate is `npm run smoke:platform:all`; cloud-runtime changes additionally require `npm run smoke:cloud`. See [the platform smoke runbook](./platform-smoke.md). For portable guidance, see the [implementation reference](./platform-smoke-implementation.md#portability-to-other-pi-extensions) and the repo-local `docs/pi-extension-platform-testing.md` from a Crabbox checkout. The live smoke checklist remains useful for inner-loop development but is not the release gate.

## Purpose

This document records maintainer testing lessons for `pi-cursor-sdk`. It complements unit tests and the [Cursor live smoke checklist](./cursor-live-smoke-checklist.md). Use it when adding regression coverage, debugging false-green releases, or building isolated smoke harnesses.

For a **minimal one-session dogfood pass** (baseline env, one native + one bridge call, JSONL ID patterns, bootstrap manifest, edit diff card), use the [Cursor dogfood checklist](./cursor-dogfood-checklist.md) as inner-loop evidence before running the platform smoke gate.

## Core lesson: integration-shaped bugs beat unit mocks

The native replay `Tool grep not found` failure was integration-shaped, not unit-shaped:

1. **Plan mode** calls `setActiveTools(["read", "bash", "edit", "write"])` when execution starts.
2. **pi-cursor-sdk** only re-synced native replay wrappers on `session_start` / `model_select`, not every turn.
3. **The provider** still emitted native replay `toolUse` for `grep` / `cursor`.
4. **pi's agent loop** looked up tools in `context.tools` and failed with `Tool grep not found`.

Passing hundreds of unit tests did not prove that chain was safe. Regression coverage now includes:

- `test/index.test.ts` — `before_agent_start` and `turn_start` resync after plan-style strip
- `test/cursor-native-replay-stress.test.ts` — plan strip → resync → grep replay; inactive-tool trace fallbacks
- `test/cursor-provider-replay-live-run.test.ts` — inactive replay tools emit trace instead of broken `toolUse`
- `test/cursor-native-replay-trace.test.ts` — shared inactive replay trace formatting
- `test/cursor-native-replay-routing.test.ts` — `resolveNativeReplayDisposition` and `partitionNativeToolsByActiveContext`
- `test/validate-smoke-jsonl.test.ts` — replay scan semantics (real errors vs doc mentions in successful reads)

When changing provider/runtime behavior, ask whether the bug spans **pi extension lifecycle**, **active tool state**, **provider streaming**, and **persisted JSONL**. If yes, add an integration-style unit test or live smoke coverage for that chain.

## Dual-check invariant: `context.tools` vs pi active tools

Native replay routing intentionally uses two layers:

1. **Extension resync** (`before_agent_start`, `turn_start`) updates pi's active tool set via `syncRegisteredNativeCursorToolsForModel`. This fixes the common case where plan-mode execute strips `grep`/`find`/`cursor` before the next turn.
2. **Provider routing** uses the **`context.tools` snapshot** captured when `streamCursor()` starts (`getActiveContextToolNames` in `src/cursor-context-tools.ts`). It does not read live `pi.getActiveTools()` mid-stream.

`src/cursor-native-replay-routing.ts` centralizes provider-side routing against the same `context.tools` snapshot:

- **Turn coordinator** calls `resolveNativeReplayDisposition()` per completed SDK tool → `queue_replay` (queue native `toolUse`), `inactive_trace` (`formatInactiveCursorReplayTrace()`), or `transcript_trace`.
- **Live-run drain** calls `partitionNativeToolsByActiveContext()` on already-queued native tool batches → active tools become `toolUse`; inactive tools get trace only and the batch returns `"handled"` without `toolUse`.

Disposition outcomes:

- `queue_replay` — tool is in `context.tools` and a live run exists
- `inactive_trace` — native replay tool missing from `context.tools`
- `transcript_trace` — native replay off or non-native tool

If resync runs but `context.tools` is still stale (e.g. only `read` listed), the provider must **not** emit `toolUse` for inactive tools. `test/cursor-native-replay-stress.test.ts` covers that stale-snapshot path.

## Auth: use `auth.json`, not only env

pi resolves Cursor auth in this order:

1. pi `--api-key`
2. stored `cursor` key in `~/.pi/agent/auth.json` from `/login`
3. `CURSOR_API_KEY`

For live smoke and isolated harnesses:

- **Do not assume** `CURSOR_API_KEY` or `~/.secrets` alone is enough.
- **Do assume** pi reads auth from the active `HOME`, usually `~/.pi/agent/auth.json`.
- Isolated runs with `env -i HOME=/tmp/...` must **copy** `auth.json` into that temporary home before calling `pi`.

Example seed step used by `scripts/isolated-cursor-smoke.sh`:

```bash
mkdir -p "$HOME/.pi/agent"
cp "$REAL_HOME/.pi/agent/auth.json" "$HOME/.pi/agent/auth.json"
chmod 600 "$HOME/.pi/agent/auth.json"
```

Fallback when `auth.json` lacks a `cursor` provider entry:

```bash
export CURSOR_API_KEY="your-key"
```

Never commit, log, or paste `auth.json` contents, API keys, or session JSONL with secrets.

## Isolated directories: why and how

Use isolated `/tmp` trees when validating:

- packed tarball install (`npm pack` → extract → `pi install --approve -l`)
- clean `HOME` with no inherited shell profile state
- plan-mode-style tool stripping via a shim extension
- JSONL replay-error scans independent of stdout

Recommended layout:

```text
/tmp/pi-cursor-sdk-isolated-<timestamp>/
  home/                 # seeded ~/.pi/agent/auth.json
  pack/                 # npm pack output (*.tgz)
  extract/package/      # unpacked extension
  project/              # empty pi project for install -l
  sessions/
    basic/
    native-replay/
    plan-strip/
```

Commands:

```bash
# full isolated smoke (unit preflight + pack + live pi)
npm run smoke:isolated

# pack/unit only, no live Cursor calls
SKIP_LIVE=1 npm run smoke:isolated

# custom artifact root
ISOLATED=/tmp/pi-cursor-sdk-isolated-manual npm run smoke:isolated
```

Every live check should use its own `--session-dir` under the isolated tree. Do not reuse session dirs across scenarios.

## Harness traps we hit repeatedly

| Trap | What went wrong | Fix |
| --- | --- | --- |
| Clean `HOME` without auth | `pi` could not authenticate Cursor in isolated runs | Copy `~/.pi/agent/auth.json` into isolated `HOME` |
| `npm pack \| tail -1` | Captured npm notice text, not tarball path | Use `ls -t "$PACK_DIR"/*.tgz \| head -1` |
| Packed extension, no install | Provider never loaded in isolated project | Run `npm install --omit=dev` inside extracted package |
| Inherited shell env | mise/profile hooks hung or polluted runs | Use `env -i ... MISE_DISABLE=1` for isolated pi calls |
| No per-check timeout | One stuck prompt blocked entire harness | Wrap each live check with timeout/watchdog |
| stdout-only assertions | Missed replay failures persisted only in JSONL | Scan JSONL for `Tool grep/cursor/find/ls not found` |
| Naive JSONL substring scan | Successful `read` of docs mentioning replay errors looked like failures | `validate-smoke-jsonl.mjs` only flags error `toolResult` / error assistant messages |
| Plan strip only on first turn | Under-tested multi-turn resync | Shim strips on every `turn_start`; stress multi-turn separately |
| Assuming env auth equals pi auth | False "blocked" or false "pass" in CI-like shells | Check `auth.json` provider keys explicitly when needed |

## JSONL is the source of truth for replay regressions

Stdout can look fine while persisted tool results contain errors. Prefer structural JSONL scans over grepping terminal output.

Replay failure scan:

```bash
node scripts/validate-smoke-jsonl.mjs --replay-errors-only "$SESSION_DIR"
```

Combined usage + replay scan after broader smoke:

```bash
node scripts/validate-smoke-jsonl.mjs --replay-errors "$SMOKE_DIR"
```

### What counts as a replay failure

The scan fails only on **persisted error messages**, not arbitrary substring matches in session JSONL:

- error `toolResult` records (`isError: true`) whose text contains:
  - `Tool grep not found`
  - `Tool cursor not found`
  - `Tool find not found`
  - `Tool ls not found`
- error assistant messages (`stopReason: "error"` or `errorMessage`) containing those strings

Successful tool results are ignored even when file contents mention those strings (for example a `read` of `docs/cursor-testing-lessons.md` during plan-strip smoke).

## Usage and compaction JSONL lessons

Session summaries can hide per-message usage bugs. When investigating token or compaction regressions, inspect assistant message `usage` rows directly:

- `usage.input`, `usage.output`, `usage.cacheRead`, and `usage.cacheWrite` are additive spend-style counters for the assistant turn.
- `usage.totalTokens` is pi context occupancy for that turn, not a value to sum across all assistant messages.
- Distinguish published SDK `TokenUsage` from observed raw local `turn-ended.usage`: installed `@cursor/sdk` `toTokenUsage` sets `totalTokens = input+output+cacheRead+cacheWrite`, but captured local raw `turn-ended.usage` keeps `inputTokens` as the full prompt while cache fields partition it (see `test/fixtures/cursor-sdk-turn-ended-usage-1.0.23.json` / issue #196). Map raw turn-ended samples to pi as uncached `input = inputTokens - cacheReadTokens - cacheWriteTokens` and `totalTokens = inputTokens + outputTokens`.
- No single assistant message should persist SDK/full-agent-context-sized usage outside the selected model window.
- Real bad-session evidence should be reduced to a sanitized fixture, like `test/fixtures/cursor-run-usage-compaction-poison.jsonl`, instead of committing raw session JSONL.

The compaction poison fixture mirrors the observed failure shape: one assistant message with `RunResult`-sized input/cache-read counts near 1M immediately before compaction. Regression coverage should prove that such usage falls back to bounded pi estimates before it reaches `AssistantMessage.usage`.

### False-positive edge case (2026-05-23)

Plan-strip live smoke can make Cursor `read` testing docs that *document* replay failure strings. A naive whole-record JSON scan reported four failures from one successful `read` toolResult (`isError: false`).

When changing replay scan logic:

1. Update `scripts/validate-smoke-jsonl.mjs`
2. Add/adjust cases in `test/validate-smoke-jsonl.test.ts` (error toolResult must still fail; successful read of doc text must pass)
3. Re-run `npm run smoke:isolated` on a packed temp install before release

## Plan-mode regression scenario

Simulate plan-mode execute stripping with the repo fixture:

- `scripts/fixtures/plan-strip-shim/index.ts`

It sets active tools to `read`, `bash`, `edit`, `write` on each `turn_start`. Run pi with:

```bash
pi --approve -e scripts/fixtures/plan-strip-shim --cursor-no-fast --model cursor/grok-4.6 \
  --session-dir "$SMOKE_DIR/plan-strip" \
  -p 'After reset, read README.md and answer PLAN_STRIP_OK=yes.'
```

Pass criteria:

- No replay `Tool * not found` entries in JSONL
- Native replay tools (`grep`, `find`, `read`, etc.) succeed after `turn_start` resync
- On non-Cursor model switch, native replay wrappers are removed except core pi tools

## Local validation ladder

Run local checks first, then the local platform smoke gate before claiming release-ready for provider/runtime changes. Add `npm run smoke:cloud` for cloud-runtime changes:

```bash
npm test
npm run typecheck
npm pack --dry-run
SKIP_LIVE=1 npm run smoke:isolated
npm run smoke:isolated            # inner-loop helper; requires auth.json or CURSOR_API_KEY
npm run smoke:live                # inner-loop partial tmux checklist subset
npm run smoke:platform:doctor
npm run smoke:platform:all
npm run smoke:cloud              # required for cloud-runtime changes
```

After changing `scripts/validate-smoke-jsonl.mjs` or replay scan expectations, also run:

```bash
npm test -- test/validate-smoke-jsonl.test.ts
```

Then use the [Cursor live smoke checklist](./cursor-live-smoke-checklist.md) only for focused inner-loop surfaces the scripts do not cover (bridge MCP, abort/cancel, full TUI observation, packaging review, cleanup) before rerunning the local platform smoke gate and, for cloud-runtime changes, `npm run smoke:cloud`.

## What belongs in CI vs platform/manual smoke

- **CI / default `npm test`:** mocked provider tests, extension lifecycle tests, JSONL validator tests, script syntax/help checks. No live Cursor calls.
- **Local platform release gate:** `npm run smoke:platform:all` (runs doctor first). Requires real Cursor auth and cross-platform Crabbox setup.
- **Cloud runtime release gate:** `npm run smoke:cloud` for PRs that touch actual cloud runtime execution.
- **Focused manual smoke:** `npm run smoke:isolated`, `npm run smoke:live`, and selected live-checklist sections for inner-loop debugging of behavior mocks cannot reproduce.

If platform smoke auth or target setup is unavailable, report the release as **blocked**, not skipped-ready.

## Cursor SDK event capture probe

When debugging TUI/progress/replay timing gaps, capture raw Cursor SDK surfaces side-by-side instead of writing a throwaway probe:

```bash
CURSOR_API_KEY=... npm run debug:sdk-events -- \
  --cwd ~/Projects \
  --model composer-2.5 \
  --prompt 'Scan all of my projects and give me ideas that would be great to add the Cursor SDK to' \
  --out /tmp/pi-cursor-sdk-sdk-events-manual
```

The script writes timestamped artifacts under `--out` (default `/tmp/pi-cursor-sdk-sdk-events-<timestamp>`):

- `stream-events.jsonl` — `run.stream()` messages
- `on-delta.jsonl` — `agent.send(..., { onDelta })` updates
- `on-step.jsonl` — `agent.send(..., { onStep })` steps
- `wait-result.json` — final `run.wait()` metadata
- optional `conversation.json` with `--include-conversation`
- `summary.json` — event counts and timing gaps

Stdout prints artifact paths and summary counts only. Raw payloads stay on disk and may contain local paths, project text, tool args/results, or secrets — do not commit or share them.

Hard repo rule: Cursor SDK behavior claims must come from the installed `@cursor/sdk` package and/or https://cursor.com/docs/sdk/typescript, not from memory or ad-hoc probes alone. Current cutover validation targets exact `@cursor/sdk@1.0.27` and Pi 0.84.0 local packages.

## Pi provider SDK event capture

When debugging pi parsing, replay routing, bridge timing, or send-plan behavior, capture the raw `onDelta`/`onStep` payloads **as the Cursor provider receives them** instead of using the direct SDK probe above.

One-shot maintainer script (RPC pi run, gitignored artifacts by default):

```bash
CURSOR_API_KEY=... npm run debug:provider-events -- \
  --cwd . \
  --model cursor/grok-4.6 \
  --prompt 'Repro prompt here' \
  --out .debug/cursor-sdk-events/manual-repro
```

Or read a prompt from disk:

```bash
CURSOR_API_KEY=... npm run debug:provider-events -- \
  --prompt-file .debug/repro-prompt.txt \
  --out .debug/cursor-sdk-events/manual-repro
```

Artifacts under `--out` (default `.debug/cursor-sdk-events/<timestamp>/` under `--cwd`):

- `metadata.json` — model, cwd, send-plan/provider metadata
- `context-snapshot.json` — full pi `Context` passed into the provider turn
- `send-payload.json` — exact `agent.send()` input (text + images)
- `on-delta.jsonl` — raw `InteractionUpdate` objects passed to `turnCoordinator.handleDelta`
- `on-step.jsonl` — raw `onStep` payloads passed to `turnCoordinator.handleStep`
- `stream-events.jsonl` — raw `run.stream()` events when supported
- `pi-stream-events.jsonl` — exact pi stream events emitted to the TUI (`text_delta`, `thinking_delta`, replay cards, `done`, etc.)
- `provider-events.jsonl` — provider lifecycle markers (`agent_send_start`, `agent_send_returned`, …)
- `live-run-events.jsonl` — queued native replay / bridge live-run events
- `bridge-events.jsonl` — bridge lifecycle/request diagnostics (file-only; no stderr unless bridge debug is also enabled)
- `bridge-raw.jsonl` — raw bridged MCP args/results
- `display-decisions.jsonl` — per-tool native replay routing (`queue_replay`, `emit_trace`, `inactive_trace`, dedupe skips, bridge ignores) with transcript/trace text
- `coordinator-events.jsonl` — turn-coordinator side effects (task progress labels, discarded incomplete started tool calls, etc.)
- `drain-events.jsonl` — live-run pre-send drain and per-turn drain lifecycle (`turn_start`, `turn_end`, inactive replay traces, native display registration)
- `timeline.jsonl` — merged cross-layer timeline (one grep-friendly stream for the whole turn)
- `pi-session-snapshot.jsonl` — copy of pi session JSONL at turn finalize (session dir also gets latest `pi-session.jsonl`)
- `final-partial.json` — assistant partial emitted to pi at end of the provider turn
- `errors.jsonl` — provider/stream/conversation failures
- `wait-result.json` — `run.wait()` result
- `conversation.json` — `run.conversation()` when supported
- `summary.json` — counts and artifact paths

During any normal pi session you can also opt in with:

```bash
PI_CURSOR_SDK_EVENT_DEBUG=1 pi --approve -e . --model cursor/grok-4.6
```

Multi-turn sessions group automatically by pi session file:

```text
.debug/cursor-sdk-events/sessions/<session-slug>/
  session.json                 # index of all turns in this pi session
  turn-001-<timestamp>/        # first provider turn
  turn-002-<timestamp>/        # second provider turn
  ...
```

Each turn still gets the full per-turn artifact bundle above. Use `session.json` to jump between turns while debugging incremental send, bridge resolution, or native replay continuation across pi messages. For tool-heavy turns, trace/thinking replay often drains on the **next** pi message — check turn N+1 `drain-events.jsonl` and `pi-stream-events.jsonl` alongside turn N `display-decisions.jsonl`.

Optional env:

- `PI_CURSOR_SDK_EVENT_DEBUG_DIR` — base directory (default `.debug/cursor-sdk-events`)
- `PI_CURSOR_SDK_EVENT_DEBUG_SESSION_DIR` — exact session root for all turns in the current pi session
- `PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR` — exact artifact directory for one isolated turn (the maintainer script sets this via `--out`; bypasses session grouping)
- `PI_CURSOR_SDK_EVENT_DEBUG_STDERR=1` — also print the summary line to stderr (off by default so the pi TUI stays normal)

Capture is file-only by default: no stderr markers, and bridge diagnostics during SDK event debug go to `bridge-events.jsonl` instead of `[pi-cursor-sdk:bridge]` unless you separately set `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1`. Raw payloads stay on disk and may contain secrets — do not commit or share them.

### Discarded incomplete SDK tool calls

When Cursor emits `tool-call-started` without a matching completion/step result, the provider surfaces a bounded neutral **Cursor … did not complete** activity card or thinking trace at run end for failed/aborted runs, runs with no assistant text, and external/side-effectful tools. Incomplete fast local discovery starts (`read`, `grep`, `glob`, `ls`) are debug-only after a successful text-producing run so stale SDK start events do not create red post-answer cards. pi bridge MCP calls (`pi__*`) are excluded because pi already shows the real pi tool execution path.

With `PI_CURSOR_SDK_EVENT_DEBUG=1`, each discarded started call is also recorded in `coordinator-events.jsonl` under phase `discarded-incomplete-started-tool-call` with:

- normalized SDK tool name
- scrubbed call-id hash (raw call IDs are not written)
- reason such as `no-completion-at-run-end`, `abort`, or `sdk-failure`

Stderr output for these records requires `PI_CURSOR_SDK_EVENT_DEBUG_STDERR=1`. This complements the standalone `npm run debug:sdk-events` probe by interpreting a specific provider discard path during normal pi runs. User-visible incomplete cards explain actionable gaps in the TUI; debug artifacts remain maintainer-only (**#52**) and are the source of truth for suppressed fast-local stale starts.

## Tool calls listed as plain text (#40 triage)

**Symptom:** Assistant output lists tool invocations (for example `Tool call`, `Cursor activity`, `call cursor-replay-…`, `toolName`, `browser_navigate`) instead of pi tool execution cards/results.

**What the screenshot in [#40](https://github.com/fitchmultz/pi-cursor-sdk/issues/40) shows:** Plain assistant text that mirrors pi's **prompt transcript format** for replay tool calls (`Tool call (Cursor activity, call cursor-replay-…): …` from `src/context.ts`) rather than a rendered pi `toolCall` card. That pattern usually means the Cursor model **narrated** a tool call as text; it is not proof that pi failed to emit `toolcall_start` / `toolUse`.

**Do not close #40 as duplicate of #55 without session JSONL.** #55 surfaces scrubbed SDK run failures and abort causes in the TUI. #40 can occur with no error toast when the model prints tool metadata as assistant text, when replay is display-only but the user expected real execution, when stale native replay routing or plan-strip resync gaps produce `Tool * not found` errors (see **#52**), or when started SDK tools were discarded at run end (see **#52** maintainer debug and [Discarded incomplete SDK tool calls](#discarded-incomplete-sdk-tool-calls) above). A hard **process exit** from uncaught `ConnectError` / `ETIMEDOUT` is **#43**, not #40 text echo.

### Reporter checklist (required before claiming a provider bug)

Ask the reporter (or capture yourself) for:

| Field | Why |
| --- | --- |
| `pi --version` and installed `pi-cursor-sdk` version | Confirms extension/runtime in use |
| Model ID (for example `cursor/grok-4.6`) | Routing/replay behavior is model-scoped |
| Exact repro prompt and prior turns | Multi-turn replay history affects prompt text |
| Flags: `--cursor-no-fast`, `PI_CURSOR_PI_TOOL_BRIDGE`, `PI_CURSOR_EXPOSE_BUILTIN_TOOLS`, `PI_CURSOR_SETTING_SOURCES`, `PI_CURSOR_TOOL_MANIFEST` | Bridge vs native-only vs narrowed settings; bootstrap callable-surface manifest |
| Whether the listed names are `pi__*` bridge MCP, Cursor-native (`browser_navigate`, `WebSearch`), or `cursor-replay-*` replay IDs | Three different surfaces (see [Cursor native tool replay](./cursor-native-tool-replay.md#live-bridge-vs-replay)) |
| Red toast / `errorMessage` text, if any | Distinguishes #55 failure surfacing from silent text echo |
| Process exit / uncaught `ConnectError` / `ETIMEDOUT` stack trace, if any | Hard network crash (**#43**), not #40 model text echo |
| Session JSONL path (redact secrets before sharing) | Source of truth for `toolCall` vs plain `text` blocks; scan for replay `Tool * not found` (**#52**) |

### Capture steps (maintainers)

Use an isolated session dir and do not paste auth, tokens, or raw debug payloads into issues.

```bash
SMOKE_DIR="/tmp/pi-cursor-sdk-issue40-$(date +%s)"
mkdir -p "$SMOKE_DIR/home/.pi/agent"
cp "$HOME/.pi/agent/auth.json" "$SMOKE_DIR/home/.pi/agent/auth.json"
chmod 600 "$SMOKE_DIR/home/.pi/agent/auth.json"

env -i HOME="$SMOKE_DIR/home" PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
  MISE_DISABLE=1 \
  PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1 \
  pi --approve -e . --cursor-no-fast --model cursor/grok-4.6 \
  --session-dir "$SMOKE_DIR/session" \
  -p '<exact reporter prompt>'
```

Optional provider/SDK timelines (separate from pi session JSONL; see [Pi provider SDK event capture](#pi-provider-sdk-event-capture) and [Cursor SDK event capture probe](#cursor-sdk-event-capture-probe)):

For pi parsing, replay routing, or bridge timing, prefer:

```bash
npm run debug:provider-events -- \
  --cwd "$PWD" \
  --model cursor/grok-4.6 \
  --prompt '<exact reporter prompt>' \
  --out "$SMOKE_DIR/provider-events"
```

Or add `PI_CURSOR_SDK_EVENT_DEBUG=1` to the pi run above (writes under `.debug/cursor-sdk-events/`).

For raw Cursor SDK surfaces only:

```bash
npm run debug:sdk-events -- \
  --cwd "$PWD" \
  --model composer-2.5 \
  --prompt '<exact reporter prompt>' \
  --out "$SMOKE_DIR/sdk-events"
```

### JSONL classification (decision tree)

Start with whether pi stayed alive:

0. **pi process exited / shell returned with an uncaught SDK transport error** — examples include `ConnectError` with `ETIMEDOUT`/`ECONNRESET` and `WriteIterableClosedError: WritableIterable is closed`. Current code keeps Connect/network suppression scoped to active provider turns; raw Cursor SDK `AbortError` DOMExceptions are suppressed while any provider turn or session process-error guard is active. The exact SDK-provenance closed-writable shape is guarded for the Pi session lifecycle because `@cursor/sdk` 1.0.23 controlled-exec can reject after the originating provider turn when it attempts to write a `throw` frame after its internal output iterable has already closed; Bun requires an explicit rejection listener because it bypasses the patched `process.emit` path. The observed raw `write EPIPE` uncaught exception (code `EPIPE`, syscall `write`, stack exactly the single async `WriteWrap.onWriteComplete` frame) from the SDK 1.0.23 local shell executor writing a spawned child's stdin without a stream error listener is guarded only while a local Cursor provider turn is active; containment marks that turn's pooled/resumable agent transport dead so the next acquire disposes it with a bounded wait and recreates it. Idle pooled agents do not suppress EPIPE, and the multi-frame synchronous write-path shape (piped stdout, dead terminal) stays fatal. The Windows sibling surfaces as `write EOF` and intentionally stays fatal because it does not match the observed Node EPIPE contract. Unrelated failures remain fatal. This proves the secondary process-killing write, not the earlier condition that first closed the SDK iterable. Treat a fresh process exit as a process-guard regression, capture the stack/session tail, and route it separately from #40 model text echo. If tools were mid-flight, note whether session JSONL ends abruptly and whether the final tool call lacks a result.

Then inspect the failing assistant turn in `$SMOKE_DIR/session/*.jsonl`:

1. **Error `toolResult` (`isError: true`) or error assistant message contains `Tool grep/cursor/find/ls not found`** — stale `context.tools` snapshot or plan-strip resync gap after plan-mode execute stripped active tools. Run `node scripts/validate-smoke-jsonl.mjs --replay-errors-only "$SMOKE_DIR/session"`. Optional: `display-decisions.jsonl` from `PI_CURSOR_SDK_EVENT_DEBUG=1` shows `inactive_trace` routing. Route to **#52** — not model text echo (those strings appear in persisted error records, not narrated `Tool call (` lines). See [Dual-check invariant](#dual-check-invariant-contexttools-vs-pi-active-tools).
2. **`content` has `type: "toolCall"` blocks and matching `toolResult` rows** — pi executed or replayed tools; if the TUI still looked like plain text, capture a screenshot and pi version (possible pi TUI/display issue, not provider dispatch).
3. **`content` is only `type: "text"` and text contains `Tool call (` / `cursor-replay-` / serialized arg keys** — model text echo of prompt transcript format; not #55, not #52 stale routing. Compare with `buildCursorPrompt()` output in the prior turn.
4. **No `toolCall` blocks, no error toast, user expected real execution** — check whether names are replay-only (`cursor-replay-*`) or Cursor-native MCP; replay never re-runs work ([replay doc](./cursor-native-tool-replay.md)).
5. **`stopReason: "error"` or scrubbed `errorMessage`** — classify under **#55**; check whether incomplete started tools were discarded (`discardIncompleteStartedToolCalls()`). Discarded starts with no completion and no model text echo: see `coordinator-events.jsonl` phase `discarded-incomplete-started-tool-call` ([Discarded incomplete SDK tool calls](#discarded-incomplete-sdk-tool-calls) above); route broader stale/inactive replay gaps to **#52**.
6. **Bridge expected (`pi__*` in Cursor MCP)** — inspect stderr `[pi-cursor-sdk:bridge]` JSONL with `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` for pending/unresolved bridge requests.

Quick structural scan (no secrets):

```bash
node scripts/validate-smoke-jsonl.mjs --replay-errors-only "$SMOKE_DIR/session"
rg '"type": "toolCall"|Tool call \(Cursor|cursor-replay-' "$SMOKE_DIR/session"/*.jsonl
```

### When to file follow-ups

- **#43/#107** — pi exited from an uncaught Cursor SDK transport failure (hard crash, not a scrubbed #55 toast). Observed Connect/network shapes remain guarded only during active provider turns. Raw SDK-provenance `AbortError` DOMExceptions are guarded while a provider turn or session guard is active; the exact local-turn `write EPIPE` shape remains scoped to active local provider turns and invalidates only that turn's local agent transport. The exact SDK-provenance `WriteIterableClosedError` is guarded for the Pi session lifecycle because controlled-exec can reject after a turn. Unrelated failures remain fatal, and new exits need stack/session evidence.
- **#55** — caught SDK run failure or abort with missing/opaque detail (already addressed on main for surfacing).
- **#52** — stale/inactive native replay routing after plan-strip or stale `context.tools` snapshot (`Tool * not found` in JSONL, `inactive_trace` in `display-decisions.jsonl`); or maintainer needs an explicit "started X, never completed" debug line when JSONL shows no completion and no model text echo.
- **New issue** — bridge dispatch failure with `[pi-cursor-sdk:bridge]` evidence, or proven provider bug with JSONL showing missing `toolCall` despite SDK `tool-call-completed` in `on-delta.jsonl` from `debug:provider-events` or `debug:sdk-events` artifacts.
## Related docs and scripts

- [Cursor live smoke checklist](./cursor-live-smoke-checklist.md)
- [Cursor native tool replay](./cursor-native-tool-replay.md)
- `scripts/isolated-cursor-smoke.sh`
- `scripts/tmux-live-smoke.sh`
- `scripts/validate-smoke-jsonl.mjs`
- `scripts/debug-sdk-events.mjs`
- `scripts/debug-provider-events.mjs`
- `shared/` — runtime-safe ESM helpers consumed by provider `src/` and maintainer scripts (`cursor-sensitive-text.mjs`, `cursor-setting-sources.mjs`).
- `scripts/lib/` — maintainer plumbing (CLI arg parsing, secret-aware `fail()`, child-process shutdown, shell timeout/auth helpers). Re-exports `shared/` helpers so published smoke/debug scripts stay aligned with provider runtime (`test/maintainer-scripts-lib.test.ts`).
- `test/helpers/pi-harness.ts` — canonical fake pi/extension harness (`createPiHarness`, shared model/context/event helpers)
- `test/helpers/cursor-provider-harness.ts` — Cursor SDK provider mocks and stream helpers (re-exports pi-harness fixtures; `createNativeToolDisplayPiForTest` for native replay)
