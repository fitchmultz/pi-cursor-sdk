# Cursor Native Tool Visual Audit Workflow

This workflow verifies Cursor SDK tool replay the way a human sees it in pi's interactive TUI, without stealing macOS focus.

Use it before accepting replay-card commits or PRs. Text logs and JSONL are necessary, but they are not enough when the claim is visual parity: always keep before/after PNGs for the exact prompt.

## When to use this

Use this workflow when changing or reviewing:

- Cursor native tool replay cards.
- Tool-call turn ordering.
- Tool-result error styling.
- Truncation, continuation hints, timeout labels, or path display.
- Any PR claiming native TUI parity.

Do not use this for ordinary unit-only logic changes.

## Why this workflow exists

Earlier manual verification used a visible Terminal window plus `screencapture`. That worked, but it stole system focus and made it easy for the user to type into the audit window by accident.

The preferred workflow is now offscreen:

1. Spawn `pi` in a pseudo-terminal at a fixed size.
2. Feed the prompt programmatically.
3. Save raw ANSI output and plain text output.
4. Render the terminal buffer through xterm.js in headless Playwright.
5. Save a PNG screenshot.
6. Inspect the session JSONL for exact persisted `toolCall` / `toolResult` data.

This gives human-like visual evidence without activating Terminal, iTerm, or a browser window.

## Tool stack

Install the harness outside this repo so generated assets and temporary dependencies do not pollute commits:

```bash
HARNESS=/tmp/pi-visual-harness
rm -rf "$HARNESS"
mkdir -p "$HARNESS"
cd "$HARNESS"
npm init -y
npm install node-pty @xterm/xterm playwright
npm rebuild node-pty
```

`npm rebuild node-pty` is useful after Node upgrades; without it, `node-pty` may fail with `posix_spawnp failed`.

## Runner contract

A runner script should:

- Spawn `pi -e <extension-dir> --model cursor/composer-2.5` with:
  - `PI_CURSOR_NATIVE_TOOL_DISPLAY=1`
  - `TERM=xterm-256color`
  - fixed PTY size, for example `150x45`
  - cwd set to the target audit repo.
- Wait for startup.
- Write the exact prompt and carriage return to the PTY.
- Wait a bounded amount of time.
- Save:
  - `<label>.ansi` raw terminal bytes.
  - `<label>.txt` stripped text for quick search.
  - `<label>.png` rendered xterm screenshot.
  - `<label>.jsonl.path` pointing to the latest pi session JSONL.
- Kill the PTY child after capture.
- Check for leftover commands when prompts can background work, especially shell timeout tests.

Example invocation shape:

```bash
node /tmp/pi-visual-harness/run-pi-visual.mjs \
  --label after-shell-nonzero \
  --ext /path/to/pi-cursor-sdk \
  --cwd /path/to/test-workspace \
  --prompt "Run \`printf 'cursor-shell-stderr\\n' >&2; exit 7\` using only the shell/terminal tool. Do not use read, grep, glob, find, ls, edit, or write. Print the command result exactly, then stop." \
  --wait-ms 30000 \
  --out-dir /tmp/pi-visual-harness/review-current
```

Keep the runner in `/tmp` unless the project explicitly decides to check in a maintained audit harness.

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
node /tmp/pi-visual-harness/run-pi-visual.mjs \
  --label before-glob-single \
  --ext "$BEFORE_WT" \
  --cwd "$TARGET" \
  --prompt "Find files matching \`src/tools/reindex.ts\` using only the glob/file-search tool. Do not use shell, bash, grep, read, or ls. Print the matched files exactly as found, then stop." \
  --wait-ms 16000 \
  --out-dir /tmp/pi-visual-harness/review-current

node /tmp/pi-visual-harness/run-pi-visual.mjs \
  --label after-glob-single \
  --ext "$AFTER_WT" \
  --cwd "$TARGET" \
  --prompt "Find files matching \`src/tools/reindex.ts\` using only the glob/file-search tool. Do not use shell, bash, grep, read, or ls. Print the matched files exactly as found, then stop." \
  --wait-ms 16000 \
  --out-dir /tmp/pi-visual-harness/review-current
```

For review, create a simple HTML/PNG gallery that places `before-*.png` and `after-*.png` side by side. Keep the generated gallery in `/tmp` unless explicitly asked to commit visual artifacts.

## JSONL inspection

For each visual claim, inspect the JSONL path written by the runner. Confirm at least:

- `toolCall.name` is the expected pi-facing replay tool name.
- `toolCall.arguments` show the expected user-facing args.
- `toolResult.toolName` matches the call.
- `toolResult.content[0].text` contains the recorded body expected in the card.
- `toolResult.isError` matches the visual card state.

For local pi MCP bridge claims, also confirm:

- Bridged calls appear as the real pi tool name (for example `sem_reindex`), not the MCP bridge name (for example `pi__sem_reindex`; or `read`/`pi__read` when overlapping built-ins are explicitly exposed).
- The JSONL has no second Cursor MCP replay card for the same bridged call.
- Non-bridge Cursor MCP activity, if present, still renders as neutral Cursor activity instead of being suppressed.

Small helper pattern:

```bash
python3 - <<'PY'
import json, pathlib
path = pathlib.Path('/tmp/pi-visual-harness/review-current/after-shell-nonzero.jsonl.path').read_text().strip()
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

- Prefer the offscreen PTY renderer. Do not use `osascript`, visible Terminal windows, or `screencapture` unless a user explicitly asks for a real desktop screenshot.
- Keep generated screenshots, HTML galleries, ANSI logs, and temporary harness dependencies out of the repo by default.
- Use short, deterministic prompts with bounded wait times.
- For timeout/background prompts, always check for leftovers:

```bash
ps -axo pid,etime,command | rg "sleep 2|should-not-print|<audit-session-label>" || true
```

- If the model uses a different tool than requested, record it as model/provider behavior unless JSONL shows replay lost or misrendered a completed Cursor tool event.
- Visual output can differ slightly from macOS Terminal fonts because xterm.js renders offscreen. Treat this workflow as evidence for card class, color state, labels, ordering, truncation, and content. Use a real terminal screenshot only for pixel-level terminal-specific bugs.

## Required evidence before commit or merge

Before accepting a replay-card change, provide:

- Before and after PNG paths.
- The prompt used for each pair.
- JSONL paths for each run.
- A short statement of what changed visually.
- The relevant JSONL `toolCall` / `toolResult` facts.
- `npm test` and `npm run typecheck` results, unless the change is documentation-only.
