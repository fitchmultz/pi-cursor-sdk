# Cursor Live Smoke Checklist

## Purpose

Use this manual checklist before releasing Cursor provider/runtime changes. Unit tests and mocks are necessary, but they are not enough for this extension. See [Cursor testing lessons](./cursor-testing-lessons.md) for auth/isolated-harness pitfalls and the plan-mode replay regression that motivated recent hardening. Always assume every runtime surface is in scope. A release is not ready until every live check below has been observed with `cursor/composer-2.5` through the local working tree.

## Release rule

- Run from a clean working tree except for the intended branch diff.
- Use the local extension under test: `pi -e . --cursor-no-fast --model cursor/composer-2.5`.
- Use a temporary `--session-dir` for every run.
- Do not paste or commit Cursor API keys, raw session contents with secrets, endpoint URLs, or local private paths.
- If a check fails, stop and fix or explicitly mark the release blocked. Do not ship with "optional," "deferred," "mostly," or "probably" checks outstanding.
- Do not narrow the smoke scope to the apparent code diff. Treat provider reality, TUI behavior, bridge behavior, replay behavior, diagnostics safety, abort/cancel cleanup, usage accounting, packaging, and cleanup as in scope for every Cursor provider/runtime release.
- A check is passed only when the visible TUI/output, stderr diagnostics, and persisted JSONL agree with the expected behavior.

## Prerequisites

```bash
export SMOKE_DIR="/tmp/pi-cursor-sdk-live-smoke-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$SMOKE_DIR"
pi -e . --list-models cursor
```

Live pi runs resolve provider auth from **`~/.pi/agent/auth.json`**, not only shell env. Isolated smoke copies that file into a clean temporary `HOME`. Ensure `auth.json` includes a `cursor` provider entry, or export `CURSOR_API_KEY` as a fallback.

The repo also ships partial automation for the prerequisite/basic/default-settings/non-interactive math/TUI output polling/steering/diagnostic/JSONL subset:

```bash
npm run smoke:live
```

For native replay regression checks (packed install, plan-strip resync, JSONL replay-error scan), use the isolated helper:

```bash
npm run smoke:isolated
# unit tests + pack only (no live Cursor):
SKIP_LIVE=1 npm run smoke:isolated
```

Scan persisted sessions for native replay tool failures:

```bash
node scripts/validate-smoke-jsonl.mjs --replay-errors "$SMOKE_DIR"
node scripts/validate-smoke-jsonl.mjs --replay-errors-only "$SMOKE_DIR/session-subdir"
```

The replay scan flags only error `toolResult` / error assistant messages with `Tool grep/cursor/find/ls not found`, not successful reads of docs that mention those strings. See [Cursor testing lessons](./cursor-testing-lessons.md#what-counts-as-a-replay-failure).

The script is a helper only; it polls the section 3 TUI for answer/footer evidence and then cleans up the tmux session, but it does not replace manual visual review of the full TUI checklist. Release readiness still requires the manual checks below for detailed TUI behavior, bridge, standalone native replay, abort/cancel, packaging, cleanup, and any touched runtime surface not covered by the helper.

Pass criteria:

- `cursor/composer-2.5` appears in the model list.
- No Cursor key or auth token is printed.
- If neither `~/.pi/agent/auth.json` cursor auth nor `CURSOR_API_KEY` is available, stop and report the live smoke as blocked.

## 1. Basic provider reality check

```bash
PI_CURSOR_SETTING_SOURCES=none \
pi -e . --cursor-no-fast --model cursor/composer-2.5 \
  --session-dir "$SMOKE_DIR/basic" \
  --no-tools \
  -p 'Live smoke. Reply exactly: PI_CURSOR_SMOKE_OK' \
  > "$SMOKE_DIR/basic.stdout.txt" \
  2> "$SMOKE_DIR/basic.stderr.txt"
```

Pass criteria:

- Exit code is `0`.
- stdout contains `PI_CURSOR_SMOKE_OK`.
- stderr is empty or contains only expected non-secret diagnostics for the specific test.
- The persisted JSONL has exactly one assistant message with non-negative usage fields and `cacheRead/cacheWrite` equal to `0`.

## 2. Default setting-source startup noise check

```bash
pi -e . --cursor-no-fast --model cursor/composer-2.5 \
  --session-dir "$SMOKE_DIR/default-settings" \
  --no-tools \
  -p 'Default settings smoke. Include PRODUCT=42 in the final answer.' \
  > "$SMOKE_DIR/default-settings.stdout.txt" \
  2> "$SMOKE_DIR/default-settings.stderr.txt"
```

Pass criteria:

- Exit code is `0`.
- stdout includes `PRODUCT=42`.
- stderr is empty.
- No Cursor SDK settings/skills startup logs corrupt stdout or the TUI.

## 3. TUI observation check

Run a real interactive session under tmux:

```bash
SESSION="pi-cursor-sdk-smoke-$(date +%s)"
tmux new-session -d -s "$SESSION" -x 120 -y 40 -- zsh -lc \
  "cd '$PWD' && PI_CURSOR_SETTING_SOURCES=none pi -e . --cursor-no-fast --model cursor/composer-2.5 --session-dir '$SMOKE_DIR/tui' --no-tools 'TUI smoke. Compute 19 + 23. Reply only with SUM=<number>.'"
```

Observe with `tmux capture-pane -pt "$SESSION"` or attach manually.

Pass criteria:

- Footer shows `(cursor) composer-2.5`. With `--cursor-no-fast`, Cursor fast mode is off and the Cursor extension status should not show `cursor fast`; ignore unrelated status text from other extensions.
- Assistant answer appears correctly.
- `/session` shows one user and one assistant message for the simple run.
- Persisted JSONL has one assistant message. If the screen appears duplicated, inspect JSONL before deciding whether it is a rendering bug.
- Kill the tmux session after the check and verify no smoke tmux sessions remain.

## 4. Bridge multi-tool success and failure

```bash
PI_CURSOR_SETTING_SOURCES=none \
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 \
PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1 \
pi -e . --cursor-no-fast --model cursor/composer-2.5 \
  --session-dir "$SMOKE_DIR/bridge" \
  -p 'Bridge smoke. Do exactly two tool calls before answering: first call pi__read on ./package.json; second call pi__read on ./definitely-missing-pi-cursor-sdk-smoke-file.txt. Then answer: OK_NAME=<package name>; MISSING_RESULT=<error or success>. Do not use shell.' \
  > "$SMOKE_DIR/bridge.stdout.txt" \
  2> "$SMOKE_DIR/bridge.stderr.txt"
```

Pass criteria:

- stdout includes `OK_NAME=pi-cursor-sdk`.
- Diagnostics include `run_created`, `tools_exposed`, two `request_queued`, two `request_resolved`, and `run_disposed`.
- The missing-file request has `isError: true`.
- Persisted JSONL contains real pi tool calls named `read`, matching `toolResult` messages, and final assistant output.
- Later assistant usage counts consumed tool-result input; no assistant usage has negative values or nonzero cache fields.

## 5. Native replay cards without the pi bridge

```bash
PI_CURSOR_SETTING_SOURCES=none \
PI_CURSOR_PI_TOOL_BRIDGE=0 \
PI_CURSOR_NATIVE_TOOL_DISPLAY=1 \
pi -e . --cursor-no-fast --model cursor/composer-2.5 \
  --session-dir "$SMOKE_DIR/native-replay" \
  -p 'Native replay smoke. Use your Cursor file-reading capability to read ./README.md, then answer README_SEEN=yes if it contains pi-cursor-sdk.' \
  > "$SMOKE_DIR/native-replay.stdout.txt" \
  2> "$SMOKE_DIR/native-replay.stderr.txt"
```

Pass criteria:

- stdout includes `README_SEEN=yes`.
- Persisted JSONL shows an assistant `toolUse` turn with a replayed `read` tool call, a pi `read` `toolResult`, and a final assistant turn.
- Native replay is display-only: it must not re-run Cursor-side mutations or create duplicate pi mutations.

## 6. Diagnostics safety contract

Bridge diagnostics are scrubbed operational logs, not anonymous telemetry.

Allowed fields:

- event name
- run-safe correlation IDs that are not endpoint path components
- bridge/pi tool call IDs derived from the run-safe ID
- hashed Cursor MCP call correlation IDs of the form `cursor-mcp-call-<8 hex chars>`
- exposed pi/MCP tool name pairs
- pending/queued/cancelled counts
- success/error booleans
- rejection kind

Forbidden fields:

- Cursor API keys or auth headers
- bearer tokens, cookies, sessions, or raw credential material
- endpoint URLs, endpoint path components, endpoint tokens, or loopback URLs
- raw tool args
- raw tool results
- stdout/stderr payloads
- file contents
- Cursor settings/skills startup output
- local private session paths in tracked docs

Run a forbidden-material scan over smoke stderr/captures:

```bash
forbidden_files="$(find "$SMOKE_DIR" -type f \( -name '*stderr.txt' -o -name '*capture*.txt' \) -print0 |
  xargs -0 grep -IlE 'CURSOR_API_KEY|Bearer [A-Za-z0-9._-]+|/cursor-pi-tool-bridge/[^ ]+/mcp|127\.0\.0\.1:[0-9]+/cursor-pi-tool-bridge|apiKey|cookie|session-cookie|secret-token' || true)"
if [[ -n "$forbidden_files" ]]; then
  printf 'Forbidden material matched in smoke files; inspect locally without pasting matched lines.\n' >&2
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    if [[ "$file" == "$SMOKE_DIR/"* ]]; then
      printf '  %s\n' "${file#"$SMOKE_DIR/"}" >&2
    else
      printf '  %s\n' "$file" >&2
    fi
  done <<<"$forbidden_files"
  exit 1
fi
```

Pass criteria:

- The scan returns no matching files except deliberately planted test strings that are asserted not to appear in serialized diagnostics, and it does not print matched secret-bearing lines.
- If tool names themselves are considered sensitive for a release target, do not enable `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` for shared logs. The diagnostics contract intentionally allows tool names.

## 7. Long-running bridge and abort/cancel

This check is release-blocking for every Cursor provider/runtime release.

Use a harmless long-running command and interrupt it after the bridge request is queued:

```bash
PI_CURSOR_SETTING_SOURCES=none \
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 \
PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1 \
pi -e . --cursor-no-fast --model cursor/composer-2.5 \
  --session-dir "$SMOKE_DIR/abort" \
  -p 'Abort smoke. Call pi__bash with command: sleep 30 && echo SHOULD_NOT_PRINT. Do not answer until the tool completes.'
```

Pass criteria:

- Interrupting the run does not leave `sleep 30`, `SHOULD_NOT_PRINT`, `pi`, or bridge-related child processes running.
- Diagnostics either show clean cancellation/disposal or the process exits cleanly without orphaning children.
- Persisted JSONL does not contain a false successful final answer.

## 8. Final structural session scan

After all live runs, scan JSONL structurally instead of reading raw content into a report:

```bash
node scripts/validate-smoke-jsonl.mjs "$SMOKE_DIR"
```

Script-enforced pass criteria:

- Every scanned JSONL file is parseable and non-empty.
- Every scanned JSONL file contains at least one assistant message.
- Every assistant message has usage metadata.
- Assistant usage `input`, `output`, and `totalTokens` are non-negative numbers.
- Assistant usage `cacheRead` and `cacheWrite` are exactly `0`.

Additional manual usage checks for provider/accounting changes:

- Tool-heavy runs should show nonzero output for visible assistant/tool-call activity.
- Split runs should count consumed tool-result input once on the following assistant turn.

## 9. Standard local gates

```bash
git diff --check
npm test
npm run typecheck
npm pack --dry-run
```

Pass criteria:

- All commands exit `0`.
- `npm pack --dry-run` includes all new runtime source files and excludes local smoke artifacts, sessions, package tarballs, `.env*`, `.pi/`, `dist/`, and `coverage/`.

## 10. Cleanup

```bash
tmux list-sessions | grep 'pi-cursor-sdk-smoke' || true
rm -rf "$SMOKE_DIR"
```

Pass criteria:

- No smoke tmux sessions remain.
- No smoke child processes remain.
- No smoke artifacts are committed.

## Coverage gaps this checklist makes explicit

Everything in this section is in scope for Cursor provider/runtime releases. These are not accepted as "done" unless the matching live check passes:

- Long-running bridged tool abort/cancel cleanup.
- Native replay cards beyond read, especially shell/edit/write cards, when those renderers change.
- Bridge question UI when `cursor_ask_question` changes.
- MCP timeout override behavior when timeout code changes.
- SDK `semSearch` / `recordScreen` activity replay when those formatters change. There is no reliable local prompt that forces Cursor to call these built-in SDK tools on demand; regression is covered by `test/cursor-tool-transcript.test.ts`. Opportunistically confirm neutral `Cursor semantic search` / `Cursor screen recording` cards if a live run surfaces them.
- Ambient Cursor setting-source behavior when startup filtering or local Cursor settings handling changes.
- Model discovery aliases/context variants when model-discovery code or Cursor SDK versions change.

If any surface has no adequate live check, add that check before release instead of assuming mocks cover reality.
