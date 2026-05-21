# Cursor native tool replay

pi-cursor-sdk has two separate tool paths:

1. **Local pi MCP bridge:** default-on for local Cursor agents. It exposes the current pi session's bridgeable active tools to Cursor through a tokenized `127.0.0.1` MCP endpoint, excluding internal Cursor replay activity names and, by default, overlapping built-in pi tools (`read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`). When Cursor calls one of those MCP tools, pi executes the real pi tool through the normal pi tool path.
2. **Cursor native tool replay:** display-only. It renders completed Cursor SDK tool activity as pi-native-looking cards using recorded Cursor results.

This document is about replay. Replay is not execution and is not the local pi bridge.

## Local pi bridge summary

The bridge is enabled by default when bridgeable active pi tools exist. Cursor sees bridge-owned MCP names such as `pi__sem_reindex`, while pi history and tool cards use the real pi tool name such as `sem_reindex`. The bridge hides overlapping built-in pi tools by default because Cursor already has native equivalents; extension/custom tools and non-overlapping active tools present in pi's active tool registry normally remain exposed. The bridge does not call pi tool `execute()` handlers directly; it queues the request, emits a real pi `toolCall`, waits for the matching pi `toolResult`, and resolves the Cursor MCP call back into the same Cursor SDK run.

Rollback and timeout controls:

```bash
PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/composer-2.5
PI_CURSOR_PI_TOOL_BRIDGE_BUILTINS=1 pi --model cursor/composer-2.5
PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS=7200 pi --model cursor/composer-2.5
PI_CURSOR_MCP_TOOL_TIMEOUT_MS=7200000 pi --model cursor/composer-2.5
```

`PI_CURSOR_PI_TOOL_BRIDGE=0` disables the bridge. `PI_CURSOR_PI_TOOL_BRIDGE_BUILTINS=1` opts in to exposing all otherwise bridgeable active built-in tools, including overlapping pi tool names that Cursor already has native equivalents for (`read`, `bash`, `write`, `edit`, `grep`, `find`, and `ls`). By default those names are hidden even when pi's Cursor replay wrapper has registered them as extension tools. Cursor-native tools, Cursor settings, plugins, and configured Cursor MCP servers still come from the Cursor SDK local agent path. Cloud Cursor agents are out of scope for this bridge.

## What gets replayed

When Cursor reports completed tool activity, the extension can display recorded results for:

- `read`
- `bash`
- `grep`
- `find`
- `ls`
- `edit`
- `write`
- diagnostics
- delete
- todos and plans
- tasks
- image generation
- MCP activity

Cursor `glob` activity is displayed through native `find` cards.

Edit and write activity replays through pi-facing `edit` and `write` cards only when replay arguments truthfully satisfy the matching pi schema, but still uses recorded Cursor results only. The adapter passes through truthful Cursor paths, content when Cursor reported it, and recorded diff/details; it does not pretend Cursor's editing schema is pi's schema and it fails closed if a recorded replay result is missing. Cursor `StrReplace` with recorded replacement text displays as native-looking `edit`; path-only Cursor `edit` and notebook edit activity fall back to neutral Cursor activity so pi does not reject the replay before recorded-result handling. Cursor `write` displays as native-looking `write`. Diagnostics, delete, todos/plans, task, image, and MCP activity use neutral Cursor activity cards with pi's default success/error tool shell. These replay tools only display recorded Cursor results; they never mutate files or execute tool work directly. Replay paths are normalized to workspace-relative paths when possible. Collapsed replay cards include bounded previews for diffs and text details so small edits, todos, task output, and MCP results are visible without expanding; edit previews omit raw unified diff headers and show compact numbered changed/context lines using pi's native diff added/removed/context colors, and write previews use syntax highlighting when pi can infer a language from the path. Image generation replay cards show the saved image path in the collapsed summary and render the image inline when pi terminal image display is enabled and the generated file is still readable.

## What replay does not do

Native replay is display-only:

- pi does not re-run Cursor-side commands.
- pi does not apply Cursor-side edits or deletes.
- pi does not call Cursor-side MCP servers.
- replay-only cards do not update pi state or generate images.
- replay does not expose pi tool schemas to Cursor; the local pi MCP bridge is the separate path that exposes active pi tools.
- Cursor workflow tools such as `SwitchMode` and Cursor todo state are not pi workflow controls; reported todo/plan events are displayed as Cursor activity only.

If a Cursor read completion reports no content, the extension may include a bounded local file preview for safe in-workspace paths. That preview is labeled as a local preview captured at transcript time, not guaranteed Cursor-observed content.

Other unsupported Cursor SDK tools may still be described through a bounded scrubbed activity transcript when the SDK reports completed tool-call data. Started Cursor SDK tool calls that never receive a completion event can be surfaced as an error replay card when a replay wrapper exists, or as a transcript note otherwise. Some Cursor-internal workflow actions may only appear in Cursor's own thinking stream or not be reported as replayable SDK tool completions.

## Ordering and non-interactive output

As Cursor SDK tool completions arrive, the extension mirrors native Codex ordering by ending a tool-use turn, letting pi render the recorded tool results, then continuing with live post-tool Cursor thinking/text, later Cursor tool batches, or Cursor's final answer as the next assistant turn.

Bridged pi tool calls follow the same visible pi `toolUse` turn shape, but they are real pi tool executions rather than replayed Cursor results.

Non-interactive and session consumers still receive bounded scrubbed transcript data so `pi -p` keeps printing normal assistant text.

## Synthetic-name policy

Synthetic replay names are internal compatibility details. New model-facing prompt text and user-visible cards use native tool names when renderer-compatible, or neutral Cursor activity labels when not. Legacy sessions that already contain old internal replay names are rewritten to safe labels in prompt text and display surfaces.

Bridge MCP names are also not pi tool names. Cursor may see names such as `pi__read` inside the local MCP bridge, but pi session output uses the real pi tool name.

## Conflicts and opt out

Native replay wrappers are registered only for tool names not already owned by another extension. If another extension already owns a wrapper name needed for replay, pi-cursor-sdk skips only the conflicting wrapper and uses the scrubbed Cursor activity transcript for that tool instead. Legacy replay wrappers remain registered for old sessions, but their model-facing and user-visible labels are sanitized.

Disable native replay registration entirely:

```bash
PI_CURSOR_NATIVE_TOOL_DISPLAY=0 pi --model cursor/composer-2.5
```

`PI_CURSOR_REGISTER_NATIVE_TOOLS=0` is also accepted as a registration-only opt-out.
