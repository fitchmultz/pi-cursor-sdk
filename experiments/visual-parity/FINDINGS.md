# Visual parity experiment: `zai/glm-5.1` vs `cursor/composer-2.5`

## Prompts (identical)

1. Read `package.json` and reply with only the `name` field.
2. Use `ls` on `src/` and reply with file names only.
3. Run `echo visual-parity-bash-ok` via bash and reply with stdout only.

## Gaps found (before fixes)

| Area | Native `glm-5.1` | `cursor/composer-2.5` (before) |
|------|------------------|--------------------------------|
| Read tool result in session | Full file body in `toolResult` | Truncated to ~12 lines (`... N more lines truncated`) |
| Pre-tool thinking in tool-use turn | `thinking` block before `toolCall` when model emits it | Often missing; thinking went to activity trace only |
| Edit/write card titles | `edit` / `write` | `Cursor edit` / `Cursor write` |

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

TTY captures remain minimal when piping into `pi` (final answers only). Use exported HTML sessions under `captures/*.html` for side-by-side tool card review.
