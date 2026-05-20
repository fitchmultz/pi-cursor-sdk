# Visual parity experiment: `zai/glm-5.1` vs `cursor/composer-2.5`

See **[OUTCOMES.md](./OUTCOMES.md)** for desired vs verified outcomes (not screenshot captions alone).

## Prompts (identical)

1. Read `package.json` and reply with only the `name` field.
2. Use `ls` on `src/` and reply with file names only.
3. Run `echo visual-parity-bash-ok` via bash and reply with stdout only.

## Gaps found (before fixes)

| Area | Native `glm-5.1` | `cursor/composer-2.5` (before) |
|------|------------------|--------------------------------|
| Read tool result in session | Full file body in `toolResult` | Truncated to ~12 lines (`... N more lines truncated`) |
| Pre-tool thinking in tool-use turn | `thinking` block before `toolCall` when model emits it | Often missing; thinking went to activity trace only |
| Edit/write card titles | `edit` / `write` | `Cursor edit` / `Cursor write` (see `pr-assets/before/screenshots/capture-write-tool-1.png`, `capture-edit-tool-1.png`) |

## Fixes applied in extension

1. **Read replay limits** — `buildCursorPiToolDisplay` for `read` now uses pi's `truncateHead` with `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` (2000 lines / 50KB), matching built-in `read` tool cards.
2. **Thinking/text routing** — With native replay enabled, all Cursor `thinking-delta`, `thinking-completed`, and `text-delta` events queue into the native replay turn (not only post-first-tool), so pre-tool thinking appears in the same assistant `toolUse` message as native models.
3. **Edit/write labels** — `cursor_edit` / `cursor_write` replay cards use native-style titles (`edit`, `write`, `updated`, etc.) instead of `Cursor …` prefixes.

## Re-run

```bash
cd experiments/visual-parity
bash run-suite.sh
node analyze-sessions.mjs   # update session paths after each run
```

## Visual verification (2026-05-20)

Inspected **tool-card screenshots** (`screenshots/*-tool-*.png` from session HTML export) and **live pi TUI pane captures** (`tui-captures/*.txt` via tmux).

| Prompt | GLM TUI | Composer TUI | Parity |
|--------|---------|--------------|--------|
| Read `package.json` | Green `read` card, pi truncation + expand hint | Same card shape; `read package.json` (relative path) | Yes |
| List `src/` | Green `$ ls src/` + `Took 0.0s` | Green `$ ls -1 src` + `Took 0.0s` (no SDK timeout line) | Yes |
| Bash echo | Green `$ echo …` | Same | Yes |

Remaining intentional differences:

- GLM may show a **thinking** line before tools when the model emits reasoning; Composer often skips it when the SDK sends no `thinking-delta`.
- **Command text** inside `$ …` cards can differ (`ls src/` vs `ls -1 src`) because Cursor chooses the shell command; display layer now normalizes workspace paths and drops SDK `timeout` from replay args.
- Footer **`cursor fast`** status is Cursor-only extension state.

Regenerate artifacts:

```bash
cd experiments/visual-parity
bash run-suite.sh
node capture-html-tool-cards.mjs
bash capture-live-tui.sh "zai/glm-5.1" "<prompt>" glm-label
bash capture-live-tui.sh "cursor/composer-2.5" "<prompt>" composer-label
```
