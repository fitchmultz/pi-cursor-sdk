# Cursor Native Tool Visual Audit Workflow

This workflow is the canonical repo path for verifying Cursor SDK tool replay the way a human sees it in pi's interactive TUI, without stealing macOS focus.

Use it before accepting replay-card commits or PRs, and for every Cursor provider/runtime release where TUI card/color behavior could regress. Text logs and JSONL are necessary, but they are not enough when the claim is visual parity: always keep PNGs for the exact prompt, and keep before/after PNGs when reviewing a rendering change.

Current validation baseline: pi 0.78.0, exact `@cursor/sdk@1.0.16`, local validation packages `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` at 0.78.0. Published peer dependencies remain minimum-only at pi 0.76.0+ with no upper bound, so newer pi installs can try the extension before a matching validation release exists.

## Cursor SDK 1.0.16 / pi 0.78.0 cutover visual record

Record the required cutover validation here or in the final release handoff. The default matrix is native replay only: the runner forces native replay registration on, forces Cursor setting sources off, disables the pi bridge, disables overlapping built-in pi tool exposure, and clears inherited Cursor SDK event-debug artifact env. With `--event-debug`, debug capture writes to a deterministic directory under the visual output directory. Do not commit raw ANSI logs, screenshots, terminal recordings, debug artifacts, or `.debug/visual-smoke` scratch files.

| Field | Required value / evidence |
| --- | --- |
| Command/session used | `npm run smoke:visual -- --ext "$PWD" --cwd "$PWD" --mode plan --out-dir <fresh /tmp dir> --label <matrix label> --prompt <matrix prompt>` with default native-replay isolation |
| Baseline versions | `pi --version` = 0.78.0; `npm ls` = `@cursor/sdk@1.0.16` and local `@earendil-works/*@0.78.0` |
| Card categories checked | Claim only categories proven by both PNG and JSONL. Required cutover categories are read, grep/search, find/glob, list, shell success, write, edit/diff, and true read failure. Neutral Cursor plan/todo/task/mode activity is optional/opportunistic and only counts when JSONL contains a completed Cursor workflow event. |
| Observed status/card colors | Confirm native-looking cards use native pi styling; neutral Cursor activity is not red; true errors are distinct; diff previews show red/green; plan status is readable |
| Screenshot/ANSI evidence location | External path only, for example `/tmp/pi-cursor-sdk-1016-visual.*/read-package.{ansi,txt,html,png,jsonl.path}` |
| Debug artifact location | External `.debug/cursor-sdk-events/...` or temp artifact directory path only; do not commit raw artifacts |
| Pass/fail notes | Summarize any mismatch, blocker, or auth/environment limitation |

Required prompt matrix for this cutover:

| Label | Prompt | Required JSONL proof | Required visual proof |
| --- | --- | --- | --- |
| `read-package` | `Use only your file read tool. Read ./package.json and answer with only the package name. Do not use shell, grep, glob, find, or list tools.` | `toolCall.name=read`, `toolResult.toolName=read`, `isError=false` | Native-looking read card; collapsed label/path readable |
| `grep-readme` | `Use only your grep/search tool to search ./README.md for the literal string "pi-cursor-sdk". Do not use shell, read, glob, find, ls, or list tools. Report only the first matching file path.` | `toolCall.name=grep`, `toolResult.toolName=grep`, `isError=false` | Native-looking grep/search card; match preview readable |
| `find-readme` | `Use only your glob/file-search/find tool to find README.md from the repository root. Do not use shell, read, grep, ls, or list tools. Report matched paths exactly.` | `toolCall.name=find`, `toolResult.toolName=find`, `isError=false` | Native-looking find/glob card; matched path readable |
| `list-src` | `Use only your directory listing tool to list ./src. Do not use shell, read, grep, glob, or find tools. Report whether cursor-provider.ts is present.` | `toolCall.name=ls`, `toolResult.toolName=ls`, `isError=false` | Native-looking list card; directory/path readable |
| `shell-success` | `Use only your shell/terminal tool to run printf 'cursor visual smoke\\n'. Do not use read, grep, glob, find, ls, edit, or write. Report the output.` | `toolCall.name=bash`, `toolResult.toolName=bash`, `isError=false` | Shell success card is not red/error-styled; stdout readable |
| `write-file` | `Use your normal file write tool to create .debug/visual-smoke/cursor-mode.txt with exactly two lines: alpha and beta. Do not use shell.` | `toolCall.name=write`, `toolResult.toolName=write`, `isError=false` | Native-looking write card; path/content preview readable |
| `edit-file` | `Use your normal file edit/str-replace tool to change beta to gamma in .debug/visual-smoke/cursor-mode.txt. Do not use shell.` | `toolCall.name=edit`, `toolResult.toolName=edit`, `isError=false` | Native-looking edit card; diff preview shows red/green added/removed lines |
| `read-missing` | `Use only your file read tool to read .debug/visual-smoke/does-not-exist.txt. Then explain the result. Do not use shell, grep, glob, find, ls, edit, or write.` | `toolCall.name=read`, `toolResult.toolName=read`, `isError=true` | True failure is visible, bounded, and distinct from neutral Cursor activity |
| `workflow-activity` | `Stay in Cursor plan mode. If Cursor exposes plan, todo, task, or mode activity for this request, use that capability to outline a tiny unit test without editing files. Otherwise answer with a concise numbered plan. Do not use shell or file mutation tools.` | Optional: completed `cursor` activity whose details/source identify `createPlan`, `updateTodos`, `task`, or mode activity. If absent, record this category as not exercised. | Optional: neutral Cursor workflow activity is neutral, not red, and does not mutate pi plan/todo state. If absent, do not claim this visual category passed. |

Do not mark a category passed because the prompt was sent. A category passes only when the PNG shows the expected card and the JSONL shows the expected completed `toolCall` / `toolResult` pair. If Cursor chooses a different tool, rerun with a tighter prompt or record that the category was not exercised.

## When to use this

Use this workflow when changing or reviewing:

- Cursor native tool replay cards.
- Tool-call turn ordering.
- Tool-result error styling.
- Truncation, continuation hints, timeout labels, or path display.
- Any PR claiming native TUI parity.

Do not use this for ordinary unit-only logic changes.

## Canonical visual inspection path

Earlier manual verification used a visible Terminal window plus `screencapture`. That worked, but it stole system focus and made it easy for the user to type into the audit window by accident.

The canonical workflow is now offscreen and browser-rendered:

1. Spawn `pi` in a pseudo-terminal at a fixed size.
2. Feed the prompt programmatically.
3. Save raw ANSI output and stripped plain text output.
4. Render the terminal buffer through a browser-backed terminal renderer, preferably xterm.js.
5. Save PNG screenshots with `agent_browser` when the harness is available, or Playwright directly when running outside that harness.
6. Inspect the session JSONL for exact persisted `toolCall` / `toolResult` data.

This is the best default release path because it exercises the real pi TUI, captures card class/color/label/order/truncation issues before users see them, avoids desktop focus stealing, and leaves reviewable artifacts. Use visible Terminal/Ghostty screenshots only for terminal-specific or pixel-level bugs that cannot be judged through browser-rendered ANSI.

## Tool stack

The canonical runner is checked in at `scripts/visual-tui-smoke.mjs` and exposed as `npm run smoke:visual`. It uses tmux for the fixed-size PTY, `@xterm/xterm` for browser rendering, and Playwright for automatic PNG capture. It resolves `pi` by directly walking the parent `PATH`, uses `process.execPath` for Node, and prepends that Node directory for prereq checks and tmux launches so `#!/usr/bin/env node` shims use the validated Node and a login shell or stale tmux server `PATH` cannot silently select a different executable.

One-time setup from a clean checkout:

```bash
npm install
npx playwright install chromium
```

`npx playwright install chromium` is only needed for automatic PNG capture. When running inside the pi agent harness, `agent_browser` is the preferred screenshot tool for generated HTML/ANSI output because it can open local files, verify saved artifacts, and capture exact evidence paths; in that case, run `npm run smoke:visual -- --no-screenshot ...` and screenshot the generated `.html` with `agent_browser`. Outside the harness, use Playwright through the checked-in runner.

## Runner contract

`scripts/visual-tui-smoke.mjs` is the durable source of truth for this workflow. It must keep supporting:

- fixed-size tmux PTY execution of the parent-resolved `pi -e <extension-dir> --model cursor/composer-2.5`
- parent-resolved `pi` and `tmux` command paths reused in tmux-launched runs, with `process.execPath`'s directory prepended for prereq checks and tmux launches so Node shims use the validated Node
- `PI_CURSOR_NATIVE_TOOL_DISPLAY=1`
- `PI_CURSOR_REGISTER_NATIVE_TOOLS=1` by default
- `PI_CURSOR_SETTING_SOURCES=none` by default
- `PI_CURSOR_PI_TOOL_BRIDGE=0` by default
- `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=0` by default
- Cursor SDK event-debug artifact env cleared before each run; `--event-debug` sets a deterministic debug directory under `--out-dir`
- `TERM=xterm-256color`
- cwd set to the target audit repo
- prompt paste plus carriage return into the interactive TUI
- bounded post-prompt wait via `--wait-ms`
- artifacts outside the repo by default
- `<label>.ansi`, `<label>.txt`, `<label>.html`, `<label>.png`, and `<label>.jsonl.path`
- `--label`, `--ext`, `--cwd`, `--prompt`, `--prompt-file`, `--wait-ms`, and `--out-dir`
- `--setting-sources` and `--bridge` opt-ins for non-default visual audits; `--expose-builtin-tools` is accepted only with `--bridge`
- repeatable `--leftover-pattern` checks for prompts that can background work
- `-h` / `--help` with examples and exit codes

Example invocation:

```bash
npm run smoke:visual -- \
  --label shell-success \
  --ext "$PWD" \
  --cwd "$PWD" \
  --prompt "Use only your shell/terminal tool to run printf 'cursor visual smoke\\n'. Do not use read, grep, glob, find, ls, edit, or write. Report the output." \
  --wait-ms 60000 \
  --out-dir /tmp/pi-cursor-sdk-visual-review
```

The runner writes the `.png` through Playwright by default. In the pi agent harness, pass `--no-screenshot`, open the generated `.html` with `agent_browser`, save a PNG screenshot, and record that path beside the runner artifacts. The default evidence is native replay evidence only. For bridge/default-settings visual audits, pass `--bridge`, `--bridge --expose-builtin-tools`, or `--setting-sources <value>` explicitly and label that evidence separately.

## Before/after comparison

Use a clean worktree for the baseline and the active worktree for the candidate change:

```bash
BASE=/tmp/pi-cursor-visual-review
BEFORE_WT=$BASE/before-main
AFTER_WT=/path/to/pi-cursor-sdk
TARGET=/path/to/test-workspace

rm -rf "$BASE"
git fetch origin main
BASE_COMMIT=$(git merge-base origin/main HEAD)
git worktree add --detach "$BEFORE_WT" "$BASE_COMMIT"

# Optional speedup when the before worktree has no install of its own.
ln -s "$AFTER_WT/node_modules" "$BEFORE_WT/node_modules"
```

Then run the same prompt against both extension dirs:

```bash
npm run smoke:visual -- \
  --label before-glob-single \
  --ext "$BEFORE_WT" \
  --cwd "$TARGET" \
  --prompt "Use only your glob/file-search/find tool to find src/tools/reindex.ts. Do not use shell, bash, grep, read, ls, or list. Print the matched files exactly as found, then stop." \
  --wait-ms 16000 \
  --out-dir /tmp/pi-cursor-sdk-visual-review-current

npm run smoke:visual -- \
  --label after-glob-single \
  --ext "$AFTER_WT" \
  --cwd "$TARGET" \
  --prompt "Use only your glob/file-search/find tool to find src/tools/reindex.ts. Do not use shell, bash, grep, read, ls, or list. Print the matched files exactly as found, then stop." \
  --wait-ms 16000 \
  --out-dir /tmp/pi-cursor-sdk-visual-review-current
```

For review, create a simple HTML/PNG gallery that places `before-*.png` and `after-*.png` side by side. Keep the generated gallery in `/tmp` unless explicitly asked to commit visual artifacts. In agent-harness runs, use `agent_browser` to open that gallery or the generated single-run HTML and save verified screenshots.

## JSONL inspection

For each visual claim, inspect the JSONL path written by the runner. Confirm at least:

- `toolCall.name` matches the prompt matrix for the category being claimed.
- `toolCall.arguments` show the expected user-facing args.
- `toolResult.toolName` matches the call.
- `toolResult.content[0].text` contains the recorded body expected in the card.
- `toolResult.isError` matches the visual card state.
- The screenshot label and JSONL path are recorded together, so a card category cannot be claimed from a screenshot or JSONL alone.

For local pi MCP bridge claims, also confirm:

- Bridged calls appear as the real pi tool name (for example `sem_reindex`), not the MCP bridge name (for example `pi__sem_reindex`; or `read`/`pi__read` when overlapping built-ins are explicitly exposed).
- The JSONL has no second Cursor MCP replay card for the same bridged call.
- Non-bridge Cursor MCP activity, if present, still renders as neutral Cursor activity instead of being suppressed.

Small helper pattern:

```bash
python3 - <<'PY'
import json, pathlib
path = pathlib.Path('/tmp/pi-cursor-sdk-visual-review-current/shell-success.jsonl.path').read_text().strip()
for line in pathlib.Path(path).read_text().splitlines():
    obj = json.loads(line)
    msg = obj.get('message', {})
    if msg.get('role') == 'assistant':
        for part in msg.get('content', []):
            if part.get('type') == 'toolCall':
                print('CALL', part.get('name'), part.get('arguments'))
    if msg.get('role') == 'toolResult':
        text = msg.get('content', [{}])[0].get('text', '')
        print('RESULT', msg.get('toolName'), 'isError=', msg.get('isError'), repr(text[:160]))
PY
```

## Safety rules

- Prefer the canonical offscreen PTY plus browser-rendered screenshot path. Do not use `osascript`, visible Terminal windows, or `screencapture` unless a user explicitly asks for a real desktop screenshot or the bug is terminal-specific.
- Keep generated screenshots, HTML galleries, ANSI logs, and temporary harness dependencies out of the repo by default.
- Use short, deterministic prompts with bounded wait times.
- For timeout/background prompts, always check for leftovers, preferably with the runner's repeatable `--leftover-pattern` option:

```bash
npm run smoke:visual -- \
  --label shell-timeout \
  --prompt 'Run sleep 30 && echo should-not-print using only the shell tool.' \
  --leftover-pattern 'sleep 30|should-not-print'
```

Manual fallback:

```bash
ps -axo pid,etime,command | rg "sleep 30|should-not-print|<audit-session-label>" || true
```

- If the model uses a different tool than requested, record it as model/provider behavior unless JSONL shows replay lost or misrendered a completed Cursor tool event.
- Do not use `--bridge`, `--bridge --expose-builtin-tools`, or non-`none` `--setting-sources` for the default native replay matrix. Those opt-ins validate different surfaces and must be labeled separately.
- Visual output can differ slightly from macOS Terminal fonts because browser/xterm renderers run offscreen. Treat this workflow as authoritative release evidence for card class, color state, labels, ordering, truncation, footer/status readability, and content. Use a real terminal screenshot only for pixel-level terminal-specific bugs.

## Required evidence before commit or merge

Before accepting a replay-card change, provide:

- Browser-rendered PNG paths captured from offscreen ANSI output.
- Before and after PNG paths when comparing a rendering change.
- The prompt used for each pair.
- ANSI/text/HTML paths when helpful for review.
- JSONL paths for each run.
- A short statement of what changed visually.
- The relevant JSONL `toolCall` / `toolResult` facts, including expected tool name and `isError` state from the prompt matrix.
- `npm test` and `npm run typecheck` results, unless the change is documentation-only.
