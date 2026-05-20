# Cursor native tool replay

pi-cursor-sdk is a Cursor provider, not a bridge that makes Cursor call pi tools. Cursor still runs through its own SDK agent and internal tools.

This extension can make Cursor SDK tool activity easier to read in interactive pi sessions by replaying completed Cursor tool events as pi-native-looking tool cards.

## What gets replayed

When Cursor reports completed tool activity, the extension can display recorded results for:

- `read`
- `bash`
- `grep`
- `find`
- `ls`
- `edit`
- `write`

Cursor `glob` activity is displayed through native `find` cards.

Edit and write activity use replay-only `cursor_edit` and `cursor_write` tool cards because Cursor's file-editing schema is not the same as pi's built-in `edit` and `write` schemas. These replay tools only display recorded Cursor results; they never mutate files directly.

## What replay does not do

Native replay is display-only:

- pi does not re-run Cursor-side commands.
- pi does not force Cursor to call pi tools.
- pi tool schemas are not passed through to Cursor.
- Cursor edit/write replay cards do not apply edits.

If a Cursor read completion reports no content, the extension may include a bounded local file preview for safe in-workspace paths. That preview is labeled as a local preview captured at transcript time, not guaranteed Cursor-observed content.

## Ordering and non-interactive output

As Cursor SDK tool completions arrive, the extension mirrors native Codex ordering by ending a tool-use turn, letting pi render the recorded tool results, then continuing with live post-tool Cursor thinking/text, later Cursor tool batches, or Cursor's final answer as the next assistant turn.

Non-interactive and session consumers still receive bounded scrubbed transcript data so `pi -p` keeps printing normal assistant text.

## Conflicts and opt out

Native replay wrappers are registered only for tool names not already owned by another extension. If another extension already owns `read`, `bash`, `grep`, `find`, `ls`, `cursor_edit`, or `cursor_write`, pi-cursor-sdk skips only the conflicting wrapper and uses the scrubbed Cursor activity transcript for that tool instead.

Disable native replay registration entirely:

```bash
PI_CURSOR_NATIVE_TOOL_DISPLAY=0 pi --model cursor/composer-2.5
```

`PI_CURSOR_REGISTER_NATIVE_TOOLS=0` is also accepted as a registration-only opt-out.
