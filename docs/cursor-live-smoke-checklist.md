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
pi --version
npm ls @cursor/sdk @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui
pi -e . --list-models cursor
```

Live pi runs resolve provider auth from **`~/.pi/agent/auth.json`**, not only shell env. Isolated smoke copies that file into a clean temporary `HOME`. Ensure `auth.json` includes a `cursor` provider entry, or export `CURSOR_API_KEY` as a fallback.

The repo also ships partial automation for the prerequisite/basic/default-settings/non-interactive math/TUI output polling/steering/diagnostic/JSONL subset:

```bash
npm run smoke:live
```

`npm run smoke:live` resolves `pi`, `node`, `npm`, `rg`, and `tmux` once in the parent shell, then runs all `pi` shims with the resolved Node directory first on `PATH`. It clears inherited Cursor SDK event-debug env for every child pi run. Isolated helper cases force `PI_CURSOR_SETTING_SOURCES=none`; the `default-settings` helper case explicitly unsets `PI_CURSOR_SETTING_SOURCES` so it exercises the default ambient setting-source path.

The canonical visual runner for section 4 is checked in separately:

```bash
npm run smoke:visual -- --help
```

For native replay regression checks (packed install, plan-strip resync, JSONL replay-error scan), use the isolated helper:

```bash
npm run smoke:isolated
# unit tests + pack only (no live Cursor):
SKIP_LIVE=1 npm run smoke:isolated
# sealed PATH/debug-env guard for the isolated helper:
npm run smoke:isolated -- --self-test
```

`npm run smoke:isolated` follows the same smoke-runner env contract as live/visual/steering helpers: pack-only work resolves only `node`, `npm`, and `env` from the parent shell and does not require `pi`; live checks then resolve `pi` and `rg`. It runs pi/npm shims with the resolved Node directory first on `PATH`, clears Cursor SDK event-debug env, forces `PI_CURSOR_SETTING_SOURCES=none` for provider checks, and explicitly unsets `PI_CURSOR_SETTING_SOURCES` for install/list checks.

Scan persisted sessions for native replay tool failures:

```bash
node scripts/validate-smoke-jsonl.mjs --replay-errors "$SMOKE_DIR"
node scripts/validate-smoke-jsonl.mjs --replay-errors-only "$SMOKE_DIR/session-subdir"
```

The replay scan flags only error `toolResult` / error assistant messages with `Tool grep/cursor/find/ls not found`, not successful reads of docs that mention those strings. See [Cursor testing lessons](./cursor-testing-lessons.md#what-counts-as-a-replay-failure).

`npm run smoke:live` is a helper only; it polls the section 3 TUI for answer/footer evidence and then cleans up the tmux session, but it does not replace the canonical rendered-PNG visual review in section 4. Run the relevant helper `--self-test` (`smoke:live`, `smoke:visual`, `smoke:steering`, or `smoke:isolated`) when changing sealed PATH or env wrappers. Release readiness still requires the manual checks below for detailed visual TUI behavior, bridge, standalone native replay, abort/cancel, packaging, cleanup, and any touched runtime surface not covered by the helper.

Pass criteria:

- `pi --version` reports pi 0.78.0 for this cutover baseline.
- `npm ls` shows `@cursor/sdk@1.0.16` and local `@earendil-works/*@0.78.0` packages.
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
  "cd '$PWD' && PI_CURSOR_SETTING_SOURCES=none pi -e . --cursor-no-fast --model cursor/composer-2.5 --session-dir '$SMOKE_DIR/tui' --session-id cursor-sdk-1016-tui --no-tools 'TUI smoke. Compute 19 + 23. Reply only with SUM=<number>.'"
```

Observe with `tmux capture-pane -pt "$SESSION"` or attach manually.

Pass criteria:

- Footer shows `(cursor) composer-2.5`. With `--cursor-no-fast`, Cursor fast mode is off and the Cursor extension status should not show `cursor fast`; ignore unrelated status text from other extensions.
- The run uses pi 0.78.0 `--session-id` successfully.
- Assistant answer appears correctly.
- `/session` shows one user and one assistant message for the simple run.
- Persisted JSONL has one assistant message. If the screen appears duplicated, inspect JSONL before deciding whether it is a rendering bug.
- Kill the tmux session after the check and verify no smoke tmux sessions remain.

## 4. Mandatory visual card/color rendering check

This is the canonical visual release path for Cursor provider/runtime changes. It requires offscreen TUI visual inspection, not only JSONL or code review. Use pi 0.78.0, `@cursor/sdk@1.0.16`, a fresh temporary session dir, Cursor SDK `plan` mode, native replay enabled, and the checked-in visual runner. The runner resolves `pi` by directly walking the parent `PATH`, uses `process.execPath` for Node, and prepends that Node directory for both prereq checks and tmux launches so `#!/usr/bin/env node` shims use the validated Node. The default matrix is native replay only: native replay registration is forced on, settings sources are `none`, the pi bridge is off, overlapping built-in pi tools are not exposed, and inherited Cursor SDK event-debug artifact env is cleared. With `--event-debug`, debug capture writes to a deterministic directory under `VISUAL_DIR`.

```bash
VISUAL_DIR="$(mktemp -d /tmp/pi-cursor-sdk-1016-visual.XXXXXX)"
VISUAL_ARGS=(
  --ext "$PWD"
  --cwd "$PWD"
  --out-dir "$VISUAL_DIR"
  --wait-ms 60000
  --event-debug
)

npm run smoke:visual -- "${VISUAL_ARGS[@]}" \
  --label read-package \
  --prompt 'Use only your file read tool. Read ./package.json and answer with only the package name. Do not use shell, grep, glob, find, or list tools.'

npm run smoke:visual -- "${VISUAL_ARGS[@]}" \
  --label grep-readme \
  --prompt 'Use only your grep/search tool to search ./README.md for the literal string "pi-cursor-sdk". Do not use shell, read, glob, find, ls, or list tools. Report only the first matching file path.'

npm run smoke:visual -- "${VISUAL_ARGS[@]}" \
  --label find-readme \
  --prompt 'Use only your glob/file-search/find tool to find README.md from the repository root. Do not use shell, read, grep, ls, or list tools. Report matched paths exactly.'

npm run smoke:visual -- "${VISUAL_ARGS[@]}" \
  --label list-src \
  --prompt 'Use only your directory listing tool to list ./src. Do not use shell, read, grep, glob, or find tools. Report whether cursor-provider.ts is present.'

npm run smoke:visual -- "${VISUAL_ARGS[@]}" \
  --label shell-success \
  --prompt "Use only your shell/terminal tool to run printf 'cursor visual smoke\\n'. Do not use read, grep, glob, find, ls, edit, or write. Report the output."

npm run smoke:visual -- "${VISUAL_ARGS[@]}" \
  --label write-file \
  --prompt 'Use your normal file write tool to create .debug/visual-smoke/cursor-mode.txt with exactly two lines: alpha and beta. Do not use shell.'

npm run smoke:visual -- "${VISUAL_ARGS[@]}" \
  --label edit-file \
  --prompt 'Use your normal file edit/str-replace tool to change beta to gamma in .debug/visual-smoke/cursor-mode.txt. Do not use shell.'

npm run smoke:visual -- "${VISUAL_ARGS[@]}" \
  --label read-missing \
  --prompt 'Use only your file read tool to read .debug/visual-smoke/does-not-exist.txt. Then explain the result. Do not use shell, grep, glob, find, ls, edit, or write.'

npm run smoke:visual -- "${VISUAL_ARGS[@]}" \
  --label workflow-activity \
  --prompt 'Stay in Cursor plan mode. If Cursor exposes plan, todo, task, or mode activity for this request, use that capability to outline a tiny unit test without editing files. Otherwise answer with a concise numbered plan. Do not use shell or file mutation tools.'
```

By default, `npm run smoke:visual` writes `.ansi`, `.txt`, `.html`, `.png`, and `.jsonl.path` artifacts. If Playwright Chromium is unavailable in an agent-harness run, rerun with `--no-screenshot`, open the generated `.html` with `agent_browser`, save a PNG screenshot, and record that PNG path beside the runner artifacts. To visually audit bridge behavior or ambient Cursor settings, opt in with `--bridge`, `--bridge --expose-builtin-tools`, or `--setting-sources <value>` and label that evidence separately; do not count those opt-in runs as default native replay matrix proof.

Expected proof for each category is defined in [Cursor Native Tool Visual Audit Workflow](./cursor-native-tool-visual-audit.md). Do not mark a category passed because the prompt was sent. A category passes only when the PNG shows the expected card and the JSONL shows the expected completed `toolCall` / `toolResult` pair with the expected `isError` state.

Pass criteria:

- PNG screenshots exist for every claimed card category, not only text/JSONL logs.
- JSONL paths exist for every claimed card category.
- Required cutover categories have matching PNG + JSONL proof from the default native replay matrix: read, grep/search, find/glob, list, shell success, write, edit/diff, and true read failure.
- Native-looking read/search/find/list/shell/write/edit cards use intended pi card styling.
- Shell success is not red/error-styled; stdout is readable.
- Edit/diff previews show red/green added/removed colors and readable paths.
- True failures are visible, bounded, and distinct from neutral activity.
- Footer/status is readable in Cursor `plan` mode and combines with fast when applicable.
- Neutral Cursor plan/todo/task/mode activity is claimed only if JSONL contains a completed Cursor workflow event; if Cursor only returns plan text, record workflow activity as not exercised instead of passed.
- Evidence paths for ANSI capture, rendered PNG screenshots, JSONL, and debug artifact directories are recorded in [Cursor native tool visual audit](./cursor-native-tool-visual-audit.md) or the release handoff.
- No secrets, raw debug artifacts, or scratch output are committed.

## 5. Cursor SDK plan-mode provider check

```bash
PI_CURSOR_SETTING_SOURCES=none \
pi -e . --cursor-no-fast --cursor-mode plan --model cursor/composer-2.5 \
  --session-dir "$SMOKE_DIR/cursor-mode-plan" \
  --session-id cursor-sdk-1016-plan \
  --no-tools \
  -p 'Cursor mode smoke. Reply with one short implementation plan for printing hello.' \
  > "$SMOKE_DIR/cursor-mode-plan.stdout.txt" \
  2> "$SMOKE_DIR/cursor-mode-plan.stderr.txt"
```

Pass criteria:

- Exit code is `0`.
- stdout contains a short plan-like answer.
- stderr is empty or contains only expected non-secret diagnostics.
- No pi active-tool or pi plan-mode state is mutated merely because Cursor SDK mode is `plan`.

## 6. Bridge multi-tool success and failure

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

## 7. Native replay cards without the pi bridge

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

## 8. Diagnostics safety contract

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

## 9. Long-running bridge and abort/cancel

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

## 10. Final structural session scan

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

## 11. Standard local gates

```bash
git diff --check
npm test
npm run typecheck
npm pack --dry-run
```

Pass criteria:

- All commands exit `0`.
- `npm pack --dry-run` includes all new runtime source files and excludes local smoke artifacts, sessions, package tarballs, `.env*`, `.pi/`, `dist/`, and `coverage/`.

## 12. Cleanup

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
- MCP timeout override behavior (3600s `callTool` default, 10s initialize/listTools default, and SDK-default unknown protocol stacks) when timeout code changes.
- SDK `semSearch` / `recordScreen` activity replay when those formatters change. There is no reliable local prompt that forces Cursor to call these built-in SDK tools on demand; regression is covered by `test/cursor-tool-transcript.test.ts`. Opportunistically confirm neutral `Cursor semantic search` / `Cursor screen recording` cards if a live run surfaces them.
- Ambient Cursor setting-source behavior when startup filtering or local Cursor settings handling changes.
- Model discovery aliases/context variants when model-discovery code or Cursor SDK versions change.

If any surface has no adequate live check, add that check before release instead of assuming mocks cover reality.
