# Cursor native tool replay

pi-cursor-sdk has two separate pi-facing paths plus Cursor's own local-agent tool surface:

1. **Local pi MCP bridge:** default-on for local Cursor agents. It exposes the current pi session's bridgeable active tools to Cursor through a tokenized `127.0.0.1` MCP endpoint, excluding internal Cursor replay activity names and, by default, overlapping built-in pi tools (`read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`). When Cursor calls one of those MCP tools, pi executes the real pi tool through the normal pi tool path.
2. **Cursor native tool replay:** display-only. It renders completed Cursor SDK tool activity as pi-native-looking cards using recorded Cursor results.

This document is about replay. Replay is not execution and is not the local pi bridge.

## Live bridge vs replay

| Surface | Names Cursor can call | Names pi shows | IDs | Execution behavior |
| --- | --- | --- | --- | --- |
| Local pi MCP bridge | Live MCP names such as `pi__sem_reindex`, only when exposed in the current run | Real pi tool names such as `sem_reindex` | Bridge run and tool IDs begin with `cursor-pi-bridge-*` | Real pi execution through normal pi `toolCall` / `toolResult` flow |
| Cursor native tool replay | None; replay names are not callable tools | Native-compatible card names or neutral Cursor activity labels | Replay IDs begin with `cursor-replay-*` | Display-only recorded Cursor results; no re-run, file mutation, MCP call, or pi state mutation |
| Cursor-native host tools/settings/plugins/MCP | Cursor SDK local-agent tool names, as provided by Cursor | Only replay cards or transcript summaries when reported by the SDK | Cursor SDK-owned IDs | Neither pi bridge nor replay execution; owned by the Cursor SDK local agent path |

Replay labels, replay cards, and transcript tool names are display-only/context-only. Bridge MCP names are also not pi tool names: Cursor must call the exposed `pi__*` MCP name, while pi history and cards use the real pi tool name.

## Local pi bridge summary

The bridge is enabled by default when bridgeable active pi tools exist. Cursor sees bridge-owned MCP names such as `pi__sem_reindex`, while pi history and tool cards use the real pi tool name such as `sem_reindex`. The bridge hides overlapping built-in pi tools by default because Cursor already has native equivalents; extension/custom tools and non-overlapping active tools present in pi's active tool registry normally remain exposed. pi-cursor-sdk also registers `cursor_ask_question` for Cursor models when the bridge is enabled, exposed to Cursor as `pi__cursor_ask_question`, so Cursor can ask the user to choose instead of silently defaulting when the pi UI is available. The bridge does not call pi tool `execute()` handlers directly; it queues the request, emits a real pi `toolCall`, waits for the matching pi `toolResult`, and resolves the Cursor MCP call back into the same live Cursor SDK run without creating a new `Agent`, unless the run was disposed, aborted, or cancelled.

Rollback, timeout, and diagnostics controls:

```bash
PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/composer-2.5
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 pi --model cursor/composer-2.5
PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS=7200 pi --model cursor/composer-2.5
PI_CURSOR_MCP_TOOL_TIMEOUT_MS=7200000 pi --model cursor/composer-2.5
PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1 pi --model cursor/composer-2.5
```

`PI_CURSOR_PI_TOOL_BRIDGE=0` disables the bridge, including `pi__cursor_ask_question`. `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1` opts in to exposing overlapping pi tool names that Cursor already has native equivalents for (`read`, `bash`, `write`, `edit`, `grep`, `find`, and `ls`). By default those names are hidden even when pi's Cursor replay wrapper has registered them as extension tools; non-overlapping active built-ins remain bridgeable by default. `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` emits typed, allowlisted, scrubbed single-line JSONL bridge diagnostics to `process.stderr` with prefix `[pi-cursor-sdk:bridge]`; it is off by default, uses run-safe IDs that are not reused in endpoint paths, and does not print endpoint URLs/path components/tokens, raw args/results, file contents, or secrets. Cursor-native tools, Cursor settings, plugins, and configured Cursor MCP servers still come from the Cursor SDK local agent path. Cloud Cursor agents are out of scope for this bridge.

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
- semantic codebase search (`semSearch`)
- screen recording (`recordScreen`)

Cursor `glob` activity is displayed through native `find` cards.

Edit and write activity replays through pi-facing `edit` and `write` cards only when replay arguments truthfully satisfy the matching pi schema, but still uses recorded Cursor results only. The adapter passes through truthful Cursor paths, content when Cursor reported it, and recorded diff/details; it does not pretend Cursor's editing schema is pi's schema and it fails closed if a recorded replay result is missing. Cursor `StrReplace` with recorded replacement text displays as native-looking `edit`; path-only Cursor `edit` and notebook edit activity fall back to neutral Cursor activity so pi does not reject the replay before recorded-result handling. Cursor `write` displays as native-looking `write`. Diagnostics, delete, todos/plans, task, image, MCP, semantic search, and screen recording activity use neutral Cursor activity cards with pi's default success/error tool shell. Neutral Cursor activity cards carry display metadata such as `activityTitle` and `activitySummary`, so partial/collapsed cards can say `Cursor plan`, `Cursor todos`, `Cursor MCP`, `Cursor semantic search`, `Cursor screen recording`, or `Cursor edit` instead of only `Cursor activity`. These replay tools only display recorded Cursor results; they never mutate files or execute tool work directly. Replay paths are normalized to workspace-relative paths when possible. Collapsed replay cards include bounded previews for diffs and text details so small edits, todos, task output, and MCP results are visible without expanding; edit previews omit raw unified diff headers and show compact numbered changed/context lines using pi's native diff added/removed/context colors, and write previews use syntax highlighting when pi can infer a language from the path. Image generation replay cards show the saved image path in the collapsed summary and render the image inline when pi terminal image display is enabled and the generated file is still readable.

## What replay does not do

Native replay is display-only:

- pi does not re-run Cursor-side commands.
- pi does not apply Cursor-side edits or deletes.
- pi does not call Cursor-side MCP servers.
- replay-only cards do not update pi state or generate images.
- replay does not expose pi tool schemas to Cursor; the local pi MCP bridge is the separate path that exposes active pi tools.
- Cursor workflow tools such as `SwitchMode` and Cursor todo state are not pi workflow controls; reported todo/plan events are displayed as Cursor activity only. Plan/todo replay cards do not drive pi plan-mode state.

If a Cursor read completion reports no content, the extension may include a bounded local file preview for safe in-workspace paths. That preview is labeled as a local preview captured at transcript time, not guaranteed Cursor-observed content.

Other unsupported Cursor SDK tools may still be described through a bounded scrubbed activity transcript when the SDK reports completed tool-call data. Started Cursor SDK tool calls that never receive a completion event are discarded without a synthetic replay error; missing completion is not itself treated as a Cursor tool failure. Explicit failures remain visible when Cursor reports an error through a completed tool call or step result. Some Cursor-internal workflow actions may only appear in Cursor's own thinking stream or not be reported as replayable SDK tool completions.

## Ordering and non-interactive output

As Cursor SDK tool completions arrive, the extension mirrors native Codex ordering by ending a tool-use turn, letting pi render the recorded tool results, then continuing with live post-tool Cursor thinking/text, later Cursor tool batches, or Cursor's final answer as the next assistant turn. For plan-mode runs, neutral Cursor plan/todo cards can therefore appear before the final Cursor plan text.

Bridged pi tool calls follow the same visible pi `toolUse` turn shape, but they are real pi tool executions rather than replayed Cursor results. Split-run usage accounting keeps Cursor SDK internal counters out of pi usage: each live Cursor prompt is counted once, replay/bridge tool-call turns include visible assistant activity in output estimates, consumed tool results are counted once as input on the following assistant turn, and `usage.totalTokens` remains the replayable Cursor prompt/context estimate.

For shell replay, completed `stdout` / `stderr` remain the primary source. If a successful completed shell result is empty and Cursor emitted unambiguous `shell-output-delta` data while exactly one shell call was active, the replay card uses that delta as display-only fallback data. Overlapping shell calls make delta attribution ambiguous, so those fallback deltas are dropped rather than guessed. `(no output)` is kept only when no completed output or safe delta fallback is available.

Non-interactive and session consumers still receive bounded scrubbed transcript data so `pi -p` keeps printing normal assistant text.

## Synthetic-name policy

Synthetic replay names are internal compatibility details. New model-facing prompt text and user-visible cards use native tool names when renderer-compatible, or neutral Cursor activity labels when not. Legacy sessions that already contain old internal replay names are rewritten to safe labels in prompt text and display surfaces.

Bridge MCP names are also not pi tool names. Cursor may see names such as `pi__sem_reindex` inside the local MCP bridge, but pi session output uses the real pi tool name.

## Conflicts and opt out

Native replay wrappers are registered only for tool names not already owned by another extension. If another extension already owns a wrapper name needed for replay, pi-cursor-sdk skips only the conflicting wrapper and uses the scrubbed Cursor activity transcript for that tool instead. Legacy replay wrappers remain registered for old sessions, but their model-facing and user-visible labels are sanitized.

Disable native replay registration entirely:

```bash
PI_CURSOR_NATIVE_TOOL_DISPLAY=0 pi --model cursor/composer-2.5
```

`PI_CURSOR_REGISTER_NATIVE_TOOLS=0` is also accepted as a registration-only opt-out.
