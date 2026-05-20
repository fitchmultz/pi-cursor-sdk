# Cursor native tool replay

pi-cursor-sdk is a Cursor provider, not a bridge that makes Cursor call pi tools. Cursor still runs through its own SDK agent and internal tools.

That means Cursor models use Cursor SDK's local-agent tool surface plus configured Cursor settings, plugins, and MCP servers, not the full pi-native tool surface available to built-in providers. Pi-side tools registered by pi or other extensions are not passed to Cursor as callable schemas unless Cursor exposes an equivalent capability through its own tool surface.

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
- `readLints`
- `delete`
- `updateTodos`
- `createPlan`
- `task`
- `generateImage`
- `mcp`

Cursor `glob` activity is displayed through native `find` cards.

Edit and write activity use replay-only `cursor_edit` and `cursor_write` tool cards because Cursor's file-editing schema is not the same as pi's built-in `edit` and `write` schemas. Lints, delete, todos/plans, task, image, and MCP activity use replay-only Cursor cards such as `cursor_read_lints`, `cursor_delete`, and `cursor_task`. These replay tools only display recorded Cursor results; they never mutate files or execute tool work directly. Replay paths are normalized to workspace-relative paths when possible. Collapsed replay-only cards include bounded previews for diffs and text details so small edits, todos, task output, and MCP results are visible without expanding; edit previews omit raw unified diff headers and show compact numbered changed/context lines. `generateImage` replay cards show the saved image path in the collapsed summary and render the image inline when pi terminal image display is enabled and the generated file is still readable.

## What replay does not do

Native replay is display-only:

- pi does not re-run Cursor-side commands.
- pi does not force Cursor to call pi tools.
- pi tool schemas are not passed through to Cursor.
- Cursor replay-only cards do not apply edits, delete files, launch tasks, update pi state, call MCP servers, or generate images.
- Cursor workflow tools such as `SwitchMode` and Cursor todo state are not pi workflow controls; reported todo/plan events are displayed as Cursor activity only.

If a Cursor read completion reports no content, the extension may include a bounded local file preview for safe in-workspace paths. That preview is labeled as a local preview captured at transcript time, not guaranteed Cursor-observed content.

Other unsupported Cursor SDK tools may still be described through a bounded scrubbed activity transcript when the SDK reports completed tool-call data. Started Cursor SDK tool calls that never receive a completion event can be surfaced as an error replay card when a replay wrapper exists, or as a transcript note otherwise. Some Cursor-internal workflow actions may only appear in Cursor's own thinking stream or not be reported as replayable SDK tool completions.

## Ordering and non-interactive output

As Cursor SDK tool completions arrive, the extension mirrors native Codex ordering by ending a tool-use turn, letting pi render the recorded tool results, then continuing with live post-tool Cursor thinking/text, later Cursor tool batches, or Cursor's final answer as the next assistant turn.

Non-interactive and session consumers still receive bounded scrubbed transcript data so `pi -p` keeps printing normal assistant text.

## Conflicts and opt out

Native replay wrappers are registered only for tool names not already owned by another extension. If another extension already owns a wrapper such as `read`, `bash`, `grep`, `find`, `ls`, `cursor_edit`, `cursor_write`, `cursor_read_lints`, `cursor_delete`, `cursor_update_todos`, `cursor_task`, `cursor_create_plan`, `cursor_generate_image`, or `cursor_mcp`, pi-cursor-sdk skips only the conflicting wrapper and uses the scrubbed Cursor activity transcript for that tool instead.

Disable native replay registration entirely:

```bash
PI_CURSOR_NATIVE_TOOL_DISPLAY=0 pi --model cursor/composer-2.5
```

`PI_CURSOR_REGISTER_NATIVE_TOOLS=0` is also accepted as a registration-only opt-out.
