# Cursor native tool replay

User-facing overview of callable vs display-only tools: [Cursor tool surfaces in pi](./cursor-tool-surfaces.md).

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

Cursor SDK `plan` mode (`--cursor-mode plan` or `/cursor-mode plan`) can make Cursor produce plan-oriented text and plan/todo activity. Replay still treats Cursor `createPlan`, `updateTodos`, task/mode, and related workflow activity as display-only Cursor activity. It does not switch pi into plan mode, mutate pi todos, or change pi active tools.

## Local pi bridge summary

The bridge is enabled by default when bridgeable active pi tools exist. Cursor sees bridge-owned MCP names such as `pi__sem_reindex`, while pi history and tool cards use the real pi tool name such as `sem_reindex`. The bridge hides overlapping built-in pi tools by default because Cursor already has native equivalents; extension/custom tools and non-overlapping active tools present in pi's active tool registry normally remain exposed. pi-cursor-sdk also registers `cursor_ask_question` for Cursor models when the bridge is enabled and default-on `PI_CURSOR_ASK_QUESTION` is left on, exposed to Cursor as `pi__cursor_ask_question`, so Cursor can ask the user to choose instead of silently defaulting when the pi UI is available. When pi has visible Agent Skills loaded, pi-cursor-sdk registers `cursor_activate_skill`, exposed as `pi__cursor_activate_skill`, so Cursor can load the full pi `SKILL.md` that corresponds to the current pi skill catalog. The bridge does not call pi tool `execute()` handlers directly; it queues the request, emits a real pi `toolCall`, waits for the matching pi `toolResult`, and resolves the Cursor MCP call back into the same live Cursor SDK run without creating a new `Agent`, unless the run was disposed, aborted, or cancelled.

Rollback, timeout, and diagnostics controls:

```bash
PI_CURSOR_ASK_QUESTION=0 pi --model cursor/composer-2-5
PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/composer-2-5
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 pi --model cursor/composer-2-5
PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS=7200 pi --model cursor/composer-2-5
PI_CURSOR_MCP_TOOL_TIMEOUT_MS=7200000 pi --model cursor/composer-2-5
PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS=120000 pi --model cursor/composer-2-5
PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS=5 pi --model cursor/composer-2-5
PI_CURSOR_MCP_CONNECT_TIMEOUT_MS=5000 pi --model cursor/composer-2-5
PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1 pi --model cursor/composer-2-5
```

`PI_CURSOR_ASK_QUESTION=0` disables only `cursor_ask_question` / `pi__cursor_ask_question`, leaving the rest of the pi bridge available; it is enabled by default. `PI_CURSOR_PI_TOOL_BRIDGE=0` disables the bridge, including `pi__cursor_ask_question`. `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1` opts in to exposing overlapping pi tool names that Cursor already has native equivalents for (`read`, `bash`, `write`, `edit`, `grep`, `find`, and `ls`). By default those names are hidden even when pi's Cursor replay wrapper has registered them as extension tools; non-overlapping active built-ins remain bridgeable by default. The installed Cursor SDK uses a 60-second MCP protocol default; pi-cursor-sdk overrides that seam by default with 3600 seconds for MCP `callTool` requests and 10 seconds for verified initialize/listTools requests on first send. Bridged calls also have a local fail-closed deadline capped by the effective MCP tool timeout; lower it with `PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS` to reject stale pending state and abort active pi execution sooner. Unknown MCP protocol timeout stacks keep the SDK default. `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` emits typed, allowlisted, scrubbed single-line JSONL bridge diagnostics to `process.stderr` with prefix `[pi-cursor-sdk:bridge]`; it is off by default, uses run-safe IDs that are not reused in endpoint paths, and does not print endpoint URLs/path components/tokens, raw args/results, file contents, or secrets. Cursor-native tools, Cursor settings, plugins, and configured Cursor MCP servers still come from the Cursor SDK local agent path. Cloud Cursor agents are out of scope for this bridge.

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
- web search and web fetch activity (when reported as replayable SDK `mcp` or host tool completions; not SDK `semSearch`)

Cursor `glob` activity is displayed through native `find` cards.

For the full `@cursor/sdk@1.0.23` `ToolType` set, disposition matrix, and runtime alias normalization, see [SDK ToolType replay matrix](#sdk-tooltype-replay-matrix) below. Official SDK reference: https://cursor.com/docs/sdk/typescript

Edit and write activity replays through pi-facing `edit` and `write` cards only when replay arguments truthfully satisfy the matching pi schema, but still uses recorded Cursor results only. The adapter passes through truthful Cursor paths, content when Cursor reported it, and recorded diff/details; it does not pretend Cursor's editing schema is pi's schema and it fails closed if a recorded replay result is missing. Cursor `StrReplace` with recorded replacement text displays as native-looking `edit`; path-only Cursor `edit` and notebook edit activity fall back to neutral Cursor activity so pi does not reject the replay before recorded-result handling. Cursor `write` displays as native-looking `write`. Diagnostics, delete, todos/plans, task/subagent, image, MCP, semantic search, screen recording, and web search/fetch activity use neutral Cursor activity cards with pi's default success/error tool shell. Cursor SDK `task` activity is labeled **Cursor subagent** by default because it represents Cursor-spawned child-agent work; `PI_CURSOR_TASK_PRESENTATION=task` keeps the older **Cursor task** wording for comparison. MCP completions whose `toolName` is `WebSearch` / `web_search` / `WebFetch` / similar are labeled **Cursor web search** or **Cursor web fetch** instead of generic **Cursor MCP**. Neutral Cursor activity cards carry display metadata such as `activityTitle` and `activitySummary`, so partial/collapsed cards can say `Cursor plan`, `Cursor todos`, `Cursor subagent`, `Cursor MCP`, `Cursor semantic search`, `Cursor screen recording`, `Cursor web search`, `Cursor web fetch`, or `Cursor edit` instead of only `Cursor activity`. These replay tools only display recorded Cursor results; they never mutate files or execute tool work directly. Replay paths are normalized to workspace-relative paths when possible. Most collapsed replay cards include bounded previews for diffs and text details so small edits, todos, task output, and MCP results are visible without expanding; web search/fetch activity stays summary-only while collapsed because those cards often arrive after final text and can otherwise bury the answer. Ctrl+O expansion shows the recorded details. Edit previews omit raw unified diff headers and show compact numbered changed/context lines using pi's native diff added/removed/context colors, and write previews use syntax highlighting when pi can infer a language from the path. Image generation replay cards show the saved image path in the collapsed summary and render the image inline when pi terminal image display is enabled and the generated file is still readable.

## SDK ToolType replay matrix

Source of truth for SDK tool names: `@cursor/sdk@1.0.23` conversation `ToolType` values and https://cursor.com/docs/sdk/typescript

Implementation owners: `src/cursor-tool-presentation-registry.ts` (canonical names, labels, visibility, replay policy, bridge exclusions for internal replay wrappers, alias normalization, and display-spec key completeness), `src/cursor-transcript-tool-specs.ts` (registry-keyed display implementations for transcript formatting and pi display builders), `src/cursor-native-tool-display-replay.ts` (replay card rendering derived from registry replay metadata), and `src/cursor-web-tool-activity.ts` (MCP/web alias remapping before display lookup).

**Maintainer invariants — edit/write replay previews:** All colored diff rendering (native `edit` cards and `Cursor edit` activity fallbacks) flows through the single `formatCursorReplayDiff()` in `src/cursor-native-tool-display-replay.ts`. Activity write fallbacks with structured `fileContentAfterWrite` use the same `formatCursorReplayFilePreview()` path as native `write` cards. Structured `diffString` (and `diff`/`lines*`) or `fileContentAfterWrite` on `CursorReplay*Details` (including activity variants) is the source of truth for TUI preview coloring/highlighting. `expandedText` on activity details is for summary/expansion and as a fallback when the current SDK reports a unified diff only in text; it is never the primary preview source when structured fields are present. No parallel +/- coloring loops exist.

This matrix covers **Cursor native tool replay only**. It does not describe the [live pi MCP bridge](#live-bridge-vs-replay) or Cursor-native host tools, settings, plugins, and configured MCP servers from the Cursor SDK local-agent path.

| SDK `ToolType` | pi disposition | pi card / tool name | Notes |
| --- | --- | --- | --- |
| `read` | native replay | `read` | Recorded Cursor read results |
| `shell` | native replay | `bash` | SDK `shell` maps to pi `bash` cards |
| `grep` | native replay | `grep` | |
| `glob` | native replay | `find` | Intentional mapping; not a missing `glob` replay bug |
| `ls` | native replay | `ls` | |
| `edit` | native replay or neutral activity | `edit` or `cursor` | Native `edit` only when recorded args satisfy pi's `edit` schema; path-only or notebook edits fall back to neutral **Cursor edit** activity |
| `write` | native replay or neutral activity | `write` or `cursor` | Native `write` only when recorded content/path args satisfy pi's `write` schema; otherwise neutral **Cursor write** activity |
| `delete` | neutral activity | `cursor` | Collapsed label **Cursor delete** |
| `readLints` | neutral activity | `cursor` | Collapsed label **Cursor diagnostics** |
| `updateTodos` | neutral activity | `cursor` | Collapsed label **Cursor todos**; display-only, does not drive pi todos, including in Cursor SDK `plan` mode |
| `createPlan` | neutral activity | `cursor` | Collapsed label **Cursor plan**; display-only, does not drive pi plan mode, including in Cursor SDK `plan` mode |
| `task` | neutral activity | `cursor` | Collapsed label **Cursor subagent** by default; summary includes description plus subagent kind/model/short ID when Cursor reports them; `PI_CURSOR_TASK_PRESENTATION=task` restores **Cursor task** wording |
| `generateImage` | neutral activity | `cursor` | Collapsed label **Cursor image generation** |
| `mcp` | neutral activity | `cursor` | Collapsed label **Cursor MCP** for non-web MCP completions; web search/fetch MCP `toolName` values reclassify to the rows below |
| `semSearch` | neutral activity | `cursor` | Collapsed label **Cursor semantic search**; semantic codebase search, not web search |
| `recordScreen` | neutral activity | `cursor` | Collapsed label **Cursor screen recording** |
| *(host/MCP alias)* `WebSearch` / `web_search` / similar | neutral activity | `cursor` | Collapsed label **Cursor web search**; display-only Cursor web access reported by the SDK, not an executable pi web tool |
| *(host/MCP alias)* `WebFetch` / `web_fetch` / similar | neutral activity | `cursor` | Collapsed label **Cursor web fetch**; display-only Cursor web access reported by the SDK, not an executable pi web tool |
| _(no spec; future/unknown SDK name)_ | neutral activity | `cursor` | Collapsed label **Cursor** plus SDK tool name via `buildGenericPiToolDisplay()`; bounded fallback transcript only |

**Unknown/future fallback path:** SDK tool names with no registry-backed display implementation entry (future or unknown types) use `buildGenericPiToolDisplay()` in `src/cursor-transcript-tool-specs.ts` with bounded `formatFallback()` content from `src/cursor-transcript-tool-formatters.ts`. Lookup uses `Object.hasOwn()` on the display implementation table so inherited object keys such as `constructor` or `toString` cannot accidentally match a registry spec. When native replay is enabled, those completions queue through neutral pi tool name `cursor` (not native pi `read`/`bash`/… cards). Collapsed labels read like **Cursor futureSemSearchWidget** (title `Cursor` plus the SDK tool name) with optional bounded `activitySummary` from scrubbed args/result lines. Errors keep `details.summary` undefined so unbounded raw errors do not leak into replay cards (#52). Known explicit specs still win over this path; real pi bridge tool names such as `edit` and `write` are not suppressed by internal replay-wrapper exclusions.

**Replay detail disposition model:** `src/cursor-replay-tool-details.ts` stores replay card disposition separately from SDK source tool identity. Variants are `nativeEdit`, `nativeWrite`, `activity` (`sourceToolName` + display `title`), `generateImage`, and `genericFallback`. Path-only or notebook edit/write fallbacks produce `activity` details (neutral `cursor` cards) instead of structured edit/write variants with optional `title` escape hatches. Native edit/write cards use `nativeEdit` / `nativeWrite` only when pi-facing replay args satisfy the matching schema. The renderer dispatches on `variant` only.

Neutral activity rows use pi tool name `cursor` with `activityTitle` / `activitySummary` metadata. User-visible collapsed cards use labels like **Cursor semantic search**.

## Runtime alias normalization

Before display lookup, completed SDK tool names pass through `normalizeCursorToolName()` in `src/cursor-tool-presentation-registry.ts`; MCP web tool names are additionally remapped by `resolveTranscriptToolName()` in `src/cursor-web-tool-activity.ts`. Documented aliases:

| Runtime alias | Canonical SDK name |
| --- | --- |
| `read_file` | `read` |
| `list_dir` | `ls` |
| `run_terminal_cmd`, `terminal`, `bash`, `shell` | `shell` |
| `grep_search`, `search` | `grep` |
| `file_search` | `glob` |
| `write_file`, `writefile` | `write` |
| `strreplace`, `str_replace`, `str-replace`, `edit_file`, `editfile`, `edit_notebook`, `editnotebook`, `notebook_edit`, `notebookedit` | `edit` |
| `websearch`, `web_search`, `web-search` | `webSearch` (via `resolveTranscriptToolName()`) |
| `webfetch`, `web_fetch`, `web-fetch` | `webFetch` (via `resolveTranscriptToolName()`) |

Unlisted aliases keep their original name and fall through to the spec lookup or fallback transcript path. SDK `mcp` completions whose nested `toolName` is `WebSearch` / `web_search` / `WebFetch` / `web_fetch` (or `tool_name`) also resolve to `webSearch` / `webFetch` before display lookup.

## Intentional mappings and fallbacks

These behaviors are by design. They are not pi replay execution bugs:

- **`glob` → `find`:** Cursor glob completions render as native pi `find` cards.
- **`shell` → `bash`:** Cursor shell completions render as native pi `bash` cards, including aliases normalized to `shell`.
- **`edit` / `StrReplace` / notebook edits:** native pi `edit` cards only when recorded replay args truthfully satisfy pi's `edit` schema; otherwise neutral **Cursor edit** activity so pi validation does not reject the replay before recorded-result handling.
- **`write`:** native pi `write` cards only when recorded content/path args satisfy pi's schema; otherwise neutral **Cursor write** activity.
- **Plan/todo tools:** `createPlan` and `updateTodos` replay is display-only and does not drive pi plan mode or pi todo state, even when Cursor SDK mode is `plan` (see [What replay does not do](#what-replay-does-not-do)).
- **`semSearch`:** semantic codebase search activity, not web search.
- **Web search/fetch:** visible **Cursor web search** / **Cursor web fetch** activity when the SDK reports completed replayable tool data (SDK `mcp` with web `toolName`, host aliases above, or local transcript `webSearchToolCall` / `webFetchToolCall` records). These cards are display-only; pi does not expose executable web search/fetch tools through replay.
- **Unknown/future SDK tools:** neutral Cursor activity cards titled with the SDK tool name (for example **Cursor futureSemSearchWidget**) and bounded scrubbed args/result/error text until an explicit spec is added.

## What replay does not do

Native replay is display-only:

- pi does not re-run Cursor-side commands.
- pi does not apply Cursor-side edits or deletes.
- pi does not call Cursor-side MCP servers.
- replay-only cards do not update pi state or generate images.
- replay does not expose pi tool schemas to Cursor; the local pi MCP bridge is the separate path that exposes active pi tools.
- replay does not add pi web search, web fetch, or browser tools; **Cursor web search** / **Cursor web fetch** cards only mirror SDK-reported Cursor web activity.
- Cursor workflow tools such as `SwitchMode` and Cursor todo state are not pi workflow controls; reported todo/plan events are displayed as Cursor activity only. Plan/todo replay cards do not drive pi plan-mode state.

If a Cursor read completion reports no content, the extension may include a bounded local file preview for safe in-workspace paths. That preview is labeled as a local preview captured at transcript time, not guaranteed Cursor-observed content.

Other unsupported Cursor SDK tools may still be described through a bounded scrubbed activity transcript when the SDK reports completed tool-call data. Started Cursor SDK tool calls that never receive a completion event are surfaced as neutral **Cursor … did not complete** activity cards or equivalent low-noise thinking traces with a bounded reason such as `missing completion`, `aborted`, or `SDK run failed` when the run failed/aborted, produced no assistant text, or involved external/side-effectful tools. Incomplete fast local discovery starts (`read`, `grep`, `glob`, `ls`) are recorded for maintainer debug but suppressed from user-visible output after a successful text-producing run, because those are often stale SDK start events that would otherwise create confusing red post-answer cards such as **Cursor find did not complete**. They are not replayed as successful results and raw args/results/errors are not dumped. Explicit failures remain visible when Cursor reports an error through a completed tool call or step result. Some Cursor-internal workflow actions (including web search/fetch that never surfaces as replayable SDK tool completions or local transcript web tool records) may only appear in Cursor's own thinking stream, assistant text, or not be reported as replayable SDK tool data at all.

## SDK reporting limits

These are integration boundaries, not pi replay bugs:

- **Live web-search ordering:** local Cursor WebSearch can be absent from live `onDelta`, `onStep`, and `run.stream()` tool events. When the only evidence is a post-run local transcript `webSearchToolCall`, pi can display the **Cursor web search** card only after `run.wait()` finishes. The extension intentionally keeps assistant text streaming instead of buffering the whole answer just to reorder that card.
- **WebFetch availability:** `pi-cursor-sdk` can display a Cursor web fetch only after the SDK reports a `webFetchToolCall`, web-fetch-shaped MCP completion, or web-fetch host alias. It cannot make the Cursor SDK expose or execute WebFetch in a run where Cursor's tool set does not include it.
- **Future SDK tools:** Cursor's official SDK docs say tool names, args, and result payloads can change. Unknown completed tools therefore fall back to neutral Cursor activity cards with bounded, scrubbed text. The extension cannot render tools that the SDK never emits.
- **Process-level transport exceptions:** Connect/network/abort suppression remains scoped to active provider turns. The exact SDK-provenance `WriteIterableClosedError: WritableIterable is closed` is guarded for the Pi session lifecycle because SDK 1.0.23 controlled-exec can reject after its originating provider turn when it writes an error frame after output closes. The observed raw `write EPIPE` (SDK 1.0.23 local shell executor child stdin write with no stream error listener; stack exactly the single async `WriteWrap.onWriteComplete` frame, no SDK provenance) is guarded only while a local Cursor provider turn is active, and a contained closed pipe marks that turn's pooled/resumable agent transport dead for bounded disposal and recreation on the next acquire. Idle pooled agents do not suppress anything, and multi-frame synchronous write-path EPIPE (piped stdout, dead terminal) stays fatal. Unrelated failures remain fatal; a materially different future SDK process error must be added only after observation.

Maintainer debug (`PI_CURSOR_SDK_EVENT_DEBUG=1`) still records the same discarded started-call events in `coordinator-events.jsonl` under phase `discarded-incomplete-started-tool-call` for investigation (**#52**), including fast local starts suppressed from successful text-producing runs. User-visible incomplete cards and debug artifacts are complementary: cards explain actionable gaps in the TUI; debug files retain normalized tool names and scrubbed call-id hashes without changing default stderr behavior.

### Cursor subagent visibility limits

Cursor SDK `task` activity is surfaced as **Cursor subagent** because it represents Cursor-spawned child-agent work. The card can show the subagent start, final result text, subagent kind/model/short-ID metadata, and compact `conversationSteps` tool-call summaries when the SDK includes them. It is not a native pi subagent session and does not guarantee a live nested action stream. If Cursor only returns final subagent text and no nested tool calls, pi cannot show the subagent's internal read/shell/MCP steps.

## Low-noise tool lifecycle visibility

Most Cursor tool visibility is completion-based: the completed replay card (or bounded transcript trace) is the source of truth for recorded results. For long-running or externally meaningful tools, the provider may also surface one low-noise in-progress line while Cursor is still waiting on the tool.

Lifecycle rules:

- Eligible tools include `task` (shown as **Cursor subagent** by default), `shell`, `mcp`, `generateImage`, `recordScreen`, `semSearch`, web search/fetch activity, and plan/todo activity. Fast local tools such as `read`, `grep`, and `glob` do not get lifecycle lines in normal cases.
- Lifecycle text is emitted as a single bounded, scrubbed thinking line such as `Cursor MCP: external_search` or `Cursor shell: npm test`. Shell pending labels show a scrubbed/truncated command preview, matching pi's native bash UX; the completed replay card remains the source of truth for recorded shell results. Lifecycle lines are not separate permanent replay cards and do not rerun tools.
- A short defer window coalesces fast start+complete pairs: if a tool completes before the defer elapses, only the completed replay card/trace is shown.
- pi bridge MCP calls (`pi__*`) are excluded because pi already shows the real pi tool execution path.
- Implementation: `src/cursor-tool-lifecycle.ts` (eligibility/labels) and `src/cursor-provider-turn-coordinator.ts` (defer, emit, bridge exclusion).

## Ordering and non-interactive output

As Cursor SDK tool completions arrive, the extension mirrors native Codex ordering by ending a tool-use turn, letting pi render the recorded tool results, then continuing with live post-tool Cursor thinking/text, later Cursor tool batches, or Cursor's final answer as the next assistant turn. For plan-mode runs, neutral Cursor plan/todo cards can therefore appear before the final Cursor plan text.

Bridged pi tool calls follow the same visible pi `toolUse` turn shape, but they are real pi tool executions rather than replayed Cursor results. Usage accounting uses per-turn Cursor SDK usage when available before the corresponding pi turn is emitted, including cache read/write fields; SDK-backed `usage.totalTokens` includes latest-turn input, output, cache-read, and cache-write counters per the SDK and pi compaction contracts. If the SDK reports no usage in time, the provider falls back to local `input/output` activity estimates with `usage.totalTokens` set to the current replayable context estimate, then ignores later usage for that live run rather than risk applying stale usage to the wrong pi turn.

For shell replay, completed `stdout` / `stderr` remain the primary source. While exactly one shell call is active, the provider also emits a bounded scrubbed preview of the first few `shell-output-delta` stdout/stderr chunks so long-running commands show visible progress before completion. If a successful completed shell result is empty, the replay card uses unambiguous buffered delta data as display-only fallback data. Overlapping shell calls make delta attribution ambiguous, so those fallback/progress deltas are dropped rather than guessed. `(no output)` is kept only when no completed output or safe delta fallback is available.

JSON and RPC consumers receive structured replay for completed Cursor host tools when replay wrappers are active: host activity is emitted as pi `toolcall_*` / `tool_execution_*` events backed by recorded Cursor results, not by re-running the host tool. Print mode stays text-first so `pi -p` keeps printing normal assistant text. When replay wrappers are inactive, such as with `--no-tools`, non-interactive consumers fall back to bounded scrubbed transcript data in thinking blocks.

## Replay-name policy

Cursor native replay has one neutral replay tool name, `cursor`, plus native-compatible card names when renderer-compatible: `read`, `bash`, `grep`, `find`, `ls`, `edit`, and `write`. Neutral replay identity lives in `activityTitle`, `activitySummary`, and typed replay details, not in extra registered tool names.

Bridge MCP names are also not pi tool names. Cursor may see names such as `pi__sem_reindex` inside the local MCP bridge, but pi session output uses the real pi tool name.

## Conflicts and opt out

Native replay wrappers are registered only for tool names not already owned by another extension. If another extension already owns a wrapper name needed for replay, pi-cursor-sdk skips only the conflicting wrapper and uses the scrubbed Cursor activity transcript for that tool instead.

Disable native replay registration entirely:

```bash
PI_CURSOR_NATIVE_TOOL_DISPLAY=0 pi --model cursor/composer-2-5
```

`PI_CURSOR_REGISTER_NATIVE_TOOLS=0` is also accepted as a registration-only opt-out.
