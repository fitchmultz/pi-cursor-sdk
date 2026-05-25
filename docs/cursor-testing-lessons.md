# Cursor Testing Lessons

## Purpose

This document records maintainer testing lessons for `pi-cursor-sdk`. It complements unit tests and the [Cursor live smoke checklist](./cursor-live-smoke-checklist.md). Use it when adding regression coverage, debugging false-green releases, or building isolated smoke harnesses.

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

- packed tarball install (`npm pack` → extract → `pi install -l`)
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
pi -e scripts/fixtures/plan-strip-shim --cursor-no-fast --model cursor/composer-2.5 \
  --session-dir "$SMOKE_DIR/plan-strip" \
  -p 'After reset, read README.md and answer PLAN_STRIP_OK=yes.'
```

Pass criteria:

- No replay `Tool * not found` entries in JSONL
- Native replay tools (`grep`, `find`, `read`, etc.) succeed after `turn_start` resync
- On non-Cursor model switch, native replay wrappers are removed except core pi tools

## Local validation ladder

Run in order before claiming release-ready for provider/runtime changes:

```bash
npm test
npm run typecheck
npm pack --dry-run
SKIP_LIVE=1 npm run smoke:isolated
npm run smoke:isolated            # requires auth.json or CURSOR_API_KEY
npm run smoke:live                # partial tmux checklist subset
```

After changing `scripts/validate-smoke-jsonl.mjs` or replay scan expectations, also run:

```bash
npm test -- test/validate-smoke-jsonl.test.ts
```

Then follow the full manual [Cursor live smoke checklist](./cursor-live-smoke-checklist.md) for surfaces the scripts do not cover (bridge MCP, abort/cancel, full TUI observation, packaging review, cleanup).

## What belongs in CI vs manual smoke

- **CI / default `npm test`:** mocked provider tests, extension lifecycle tests, JSONL validator tests, script syntax/help checks. No live Cursor calls.
- **Manual / pre-release:** `npm run smoke:isolated`, `npm run smoke:live`, and the full checklist. Requires real Cursor auth and observes TUI/runtime behavior mocks cannot reproduce.

If live smoke auth is unavailable, report the release as **blocked**, not skipped-ready.

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

Hard repo rule: Cursor SDK behavior claims must come from the installed `@cursor/sdk` package and/or https://cursor.com/docs/sdk/typescript, not from memory or ad-hoc probes alone.

## Pi provider SDK event capture

When debugging pi parsing, replay routing, bridge timing, or send-plan behavior, capture the raw `onDelta`/`onStep` payloads **as the Cursor provider receives them** instead of using the direct SDK probe above.

One-shot maintainer script (RPC pi run, gitignored artifacts by default):

```bash
CURSOR_API_KEY=... npm run debug:provider-events -- \
  --cwd . \
  --model cursor/composer-2.5 \
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
- `coordinator-events.jsonl` — turn-coordinator side effects (task progress labels, etc.)
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
PI_CURSOR_SDK_EVENT_DEBUG=1 pi -e . --model cursor/composer-2.5
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

## Related docs and scripts

- [Cursor live smoke checklist](./cursor-live-smoke-checklist.md)
- [Cursor native tool replay](./cursor-native-tool-replay.md)
- `scripts/isolated-cursor-smoke.sh`
- `scripts/tmux-live-smoke.sh`
- `scripts/validate-smoke-jsonl.mjs`
- `scripts/debug-sdk-events.mjs`
- `scripts/debug-provider-events.mjs`
- `test/helpers/cursor-provider-harness.ts` — controllable native replay pi mock (`createNativeToolDisplayPiForTest`)
