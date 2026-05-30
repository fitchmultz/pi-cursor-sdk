# Cursor Model UX Spec

> Maintainer note: this is an internal design and behavior spec for pi-cursor-sdk. If you are trying to install or use the extension, start with the main [README](../README.md) instead.

## Status

Implemented design target. This file describes the intended Cursor model UX and should stay aligned with the current code in `src/`.

Current implementation notes:

- Cursor context variants use `base@context` pi model IDs.
- Cursor `reasoning`, `effort`, and boolean `thinking` parameters are driven by pi native thinking when the Cursor SDK exposes those controls.
- Cursor `fast` is extension state, not model identity.
- Cursor SDK `mode` (`agent` or `plan`) is extension session state, not model identity, pi thinking, Cursor `fast`, or pi's separate plan-mode extension.
- Cursor status uses one coordinated `ctx.ui.setStatus("cursor", ...)` value for fast and non-default plan mode; the default pi footer remains intact.
- Installed `@cursor/sdk` user messages accept images, and Cursor models are treated as image-capable; registered input metadata is `text` plus `image`.
- Image payload forwarding sends images only from the latest user message. If the latest user turn is plain text after an earlier image turn, the transcript keeps an `[image omitted from transcript]` placeholder but no image bytes are sent to Cursor. The prompt explicitly tells Cursor that prior image bytes are unavailable and to ask the user to reattach or describe a prior image when needed. Carrying images forward across turns remains a future product decision because it affects token cost, privacy, stale visual context, and expected multimodal follow-up behavior.
- Exact `@cursor/sdk@1.0.16` is a package dependency of this extension; users should not need a global SDK install. pi 0.78.0 is the current validation baseline, while published pi peer dependencies are minimum-only `>=0.76.0` ranges with no upper bound. Newer pi versions are allowed to attempt loading this extension before a matching extension release exists; compatibility is best-effort until validated.
- Cursor auth uses pi-native API-key resolution for provider `cursor`: CLI `--api-key`, stored `~/.pi/agent/auth.json` API key from `/login`, then `CURSOR_API_KEY`. The extension config file stores only non-secret Cursor-only state such as fast defaults.
- Local agents pass `settingSources: ["all"]` by default so Cursor MCP servers, plugin tools, project/user settings, and related Cursor-native capabilities are available. Users can narrow loading with a comma-separated list such as `PI_CURSOR_SETTING_SOURCES=project,user,plugins`, or disable ambient setting sources with `PI_CURSOR_SETTING_SOURCES=none`. The provider suppresses direct Cursor SDK bootstrap stdout/stderr/console noise (including late first-send workspace loading such as hook compatibility warnings) so it does not pollute pi's TUI.
- On `cursor/*` models, pi-cursor-sdk removes only pi-generated `<project_instructions>` blocks that overlap the effective Cursor `settingSources`: `user` for `~/.pi/agent/AGENTS.md`; `project` for discovered repo/parent `AGENTS.md` and `CLAUDE.md` (verified Cursor behavior: local agents load project `AGENTS.md` and `CLAUDE.md`). `~/.pi/agent/CLAUDE.md` is not removed (Cursor user layer uses `~/.claude/CLAUDE.md`). Blocks are removed by exact pi serialization match from structured `contextFiles` via the `before_agent_start` hook, not in `buildCursorPrompt` sanitization. Suppression is skipped with `-nc`, `PI_CURSOR_SETTING_SOURCES=none`, narrowed sources such as `plugins` that omit the matching layer, or `PI_CURSOR_PRESERVE_PI_AGENTS_MD=1`. Switching away from a Cursor model restores pi's full context block on the next user message.
- Cursor SDK models are treated as thinking-capable even when pi reports `thinking=no`; that pi column only means the SDK did not expose a pi-controllable thinking parameter for that model.
- Cursor-side thinking remains visible through pi's native thinking rendering when the Cursor SDK emits thinking or summary deltas.
- Local Cursor agents get two tool surfaces. First, Cursor keeps the Cursor SDK local-agent tool surface plus configured Cursor settings, plugins, and Cursor MCP servers. Second, pi-cursor-sdk exposes active pi tools through a default-on, tokenized loopback MCP bridge when bridgeable tools exist.
- `buildCursorPiToolBridgeSnapshot()` is the runtime capability source for pi bridge tools. It snapshots `pi.getActiveTools()` and `pi.getAllTools()`, carries pi 0.77+ per-tool `promptGuidelines` into bridge MCP descriptions, filters internal replay names, hides overlapping built-in pi tools (`read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`) unless `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1`, and creates collision-safe MCP names such as `pi__sem_reindex`. Cursor discovers the current run's exposed bridge tools through MCP `listTools`. Bootstrap prompts include a compact callable-surface manifest from `buildCursorToolManifestText()` by default (`PI_CURSOR_TOOL_MANIFEST=1`); disable with `PI_CURSOR_TOOL_MANIFEST=0`. There is no per-turn visible tool list, status manifest, or footer manifest. User-facing summary: [Cursor tool surfaces in pi](./cursor-tool-surfaces.md).
- Prompt text is the primary provider/bridge contract. Bootstrap prompts carry a short boundary block plus the callable-surface manifest by default (`PI_CURSOR_TOOL_MANIFEST=1`). MCP `listTools` descriptions use a one-line pointer to the bootstrap prompt instead of repeating the full contract (`buildCursorPiBridgeMcpToolDescription()`). Cursor must call the exposed `pi__*` MCP name, not the real pi tool name shown in pi history or transcripts. Pi emits and executes the real pi tool name. Maintainer debug: `/cursor-tools` prints bridge/manifest enablement, effective `PI_CURSOR_SETTING_SOURCES`, and the current callable-surface snapshot.
- The provider also registers `cursor_ask_question` for Cursor models when the bridge is enabled. Cursor sees it as `pi__cursor_ask_question`, and pi executes it through the normal tool path so interactive users can choose options from pi UI. In non-UI modes it reports that UI is unavailable so Cursor can state a default assumption instead. `PI_CURSOR_PI_TOOL_BRIDGE=0` disables the local bridge, including question bridging. Cloud Cursor agents remain out of scope for the bridge.
- The bridge queues MCP calls, emits provider `toolcall_*` events, waits for matching pi `toolResult` messages by `toolCallId`, resolves the result back into the same live Cursor SDK run without creating a new `Agent`, and never calls tool `execute()` handlers directly. The same-run resume invariant holds unless the run was disposed, aborted, or cancelled.
- Cursor SDK MCP tool calls use a guarded timeout override because installed `@cursor/sdk` 1.0.16 has a 60-second MCP request default with no public per-server timeout option. The extension extends the verified Cursor SDK MCP `callTool` timeout path to 3600 seconds by default and shortens the verified first-send MCP initialize/listTools timeout paths to 10 seconds by default so unavailable configured MCP servers do not block the first reply for a full minute; unknown MCP protocol timeout stacks keep the SDK default. Users can override tool-call timeouts with `PI_CURSOR_MCP_TOOL_TIMEOUT_MS` or `PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS`, and initialize/listTools timeouts with `PI_CURSOR_MCP_CONNECT_TIMEOUT_MS` or `PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS`.
- Bridge diagnostics are opt-in only: `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` writes typed, allowlisted, scrubbed single-line JSONL records to `process.stderr` with prefix `[pi-cursor-sdk:bridge]`. Diagnostics are scrubbed operational logs, not anonymous telemetry. They intentionally include tool names, safe correlation IDs, run lifecycle, exposed pi↔MCP name pairs, queued requests, result resolution, rejection, cancellation, and pending counts. Correlation IDs are generated independently from the tokenized endpoint path, and Cursor MCP call IDs are hashed before serialization. Diagnostics must not include endpoint paths/URLs/path components/tokens, API keys, bearer tokens, cookies, session credentials, raw args/results, stdout/stderr payloads, file contents, Cursor settings output, or local private session paths in tracked docs, and they must not call pi UI status, notification, or footer APIs. If tool names themselves are unacceptable for a release target, bridge debug diagnostics are not safe for shared logs under the current contract.
- This repo does not provide a generic desktop-automation, browser-driver, or CDP recipe. Provider docs should describe pi-cursor-sdk's Cursor provider/bridge contract only.
- Cursor internal tool activity is recorded from SDK events and scrubbed. Maintainer reference for all 16 `@cursor/sdk@1.0.16` `ToolType` values, runtime alias normalization, and intentional mapping/fallback rules: [Cursor native tool replay — SDK ToolType replay matrix](./cursor-native-tool-replay.md#sdk-tooltype-replay-matrix) (official SDK docs: https://cursor.com/docs/sdk/typescript). In interactive TTY sessions, supported completed `read`, `bash`, `grep`, `find`, `ls`, `edit`, `write`, diagnostics, delete, todo/plan, task, image generation, MCP, semantic search, and screen recording activity is replayed through pi's native tool-call rendering path with recorded Cursor results, so the TUI can show native-looking cards without rerunning Cursor's reads/shell commands/file edits. Cursor `glob` activity is replayed through native `find` cards. Cursor write activity is replayed through native-looking `write` cards, and Cursor StrReplace/edit activity uses native-looking `edit` only when recorded arguments truthfully satisfy pi's `edit` schema; path-only Cursor edit and notebook edit replay falls back to neutral Cursor activity before pi validation. Diagnostics, delete, todos/plans, task, image, and MCP activity use neutral Cursor activity cards with pi's default success/error shell. Neutral Cursor activity calls include `activityTitle` and, when available, `activitySummary` so partial/collapsed cards preserve identity such as `Cursor plan`, `Cursor todos`, `Cursor MCP`, or `Cursor edit`. For long-running or externally meaningful Cursor tools (`task`, `shell`, `mcp`, `generateImage`, `recordScreen`, `semSearch`, web search/fetch, plan/todo), the provider may surface one low-noise deferred in-progress thinking line such as `Cursor MCP: external_search` from bounded, scrubbed SDK args; fast local tools (`read`, `grep`, `glob`, and similar) skip lifecycle lines when completion follows immediately, and pi bridge MCP calls are excluded because pi already shows real pi tool execution ([lifecycle visibility](./cursor-native-tool-replay.md#low-noise-tool-lifecycle-visibility)). Replay-only tools display recorded Cursor results, normalize workspace-local paths/diff headers for display, use pi diff colors for edit previews and path-inferred syntax highlighting for write previews, and fail closed if called without a recorded result. Native replay wrappers are registered only for tool names not already owned by another extension; conflicting tools use the bounded scrubbed transcript fallback. Cursor workflow tools such as mode/task/todo/plan activity are not pi workflow controls; reported todo/plan events are displayed as Cursor activity only. Plan/todo replay cards can be followed by Cursor's final plan text, selected from `run.wait().result` when Cursor provides one and trimmed against already-emitted text. Started Cursor SDK tool calls that never receive a completion event are surfaced with bounded user-visible labels/traces (neutral activity cards when native replay routing allows, otherwise the same inactive or transcript trace fallbacks used for completed replay) instead of being silently discarded when the run failed/aborted, produced no assistant text, or involved external/side-effectful tools; incomplete fast local discovery starts (`read`, `grep`, `glob`, `ls`) remain maintainer-debug-only after successful text-producing runs so stale SDK start events do not create red post-answer cards. Explicit failures remain visible when Cursor reports them through completed tool calls or step results. Pi bridge MCP starts remain excluded from duplicate incomplete Cursor cards because pi already shows real pi tool execution. `PI_CURSOR_NATIVE_TOOL_DISPLAY=0` disables native replay, and `PI_CURSOR_REGISTER_NATIVE_TOOLS=0` is a registration-only opt-out that keeps the transcript fallback without shadowing pi tool names. When bridge or native replay cards are emitted, the provider mirrors Codex's turn shape as Cursor SDK activity arrives: assistant `toolUse`, pi `toolResult`s, live post-tool Cursor thinking/text, any later tool batches as further `toolUse` turns, then Cursor's final assistant answer. For shell replay, completed `stdout` / `stderr` are primary; unambiguous `shell-output-delta` data is used only as display-only fallback for empty successful shell completions, and overlapping shell calls drop ambiguous deltas instead of guessing. Non-interactive runs keep bounded scrubbed transcript output instead, preserving `pi -p` assistant text output. Cursor text deltas stream live when no live-run turn split is active.
- Synthetic replay names are internal compatibility details. New model-facing prompt text and user-visible cards use native tool names when renderer-compatible, or neutral Cursor activity labels when not. Legacy sessions containing old internal replay names are sanitized before prompt/display. Bridge MCP names such as `pi__sem_reindex` are MCP-only; pi session output uses real pi tool names.
- Cursor SDK usage events report cumulative internal agent/tool/cache work, not the replayable pi prompt context. The extension does not copy raw Cursor SDK usage into pi usage or compaction. For Cursor assistant messages, `usage.input`/`usage.output` are approximate pi session activity components: initial Cursor prompt input is counted once, consumed split-run tool results are counted as deduped input on the following assistant turn, and assistant output includes visible text/thinking/tool-call content. `usage.totalTokens` is the replayable Cursor prompt/context estimate derived from the same `buildCursorPrompt()` path used for `Agent.send`; it may differ from `input + output` and is the context-safe value for display/compaction. `src/cursor-usage-accounting.ts` owns this usage policy, and `src/cursor-live-run-accounting.ts` owns prompt-once and consumed-tool-result accounting so provider usage and bridge result resolution share the same matched tool-result boundary.
- Audit observation, 2026-05-19, superseded by the 2026-05-21 replay pass and #68 incomplete visibility, then narrowed by the 2026-05-26 fast-local suppression: a missing-file read with Composer 2.5 emitted `tool-call-started` for Cursor `read`, then streamed final text `Error: File not found`, but did not emit `tool-call-completed` or an `onStep` `toolCall` error result. Leftover external/side-effectful started calls are surfaced at run completion through the same native replay routing as completed tools (activity cards when allowed, otherwise inactive/transcript traces), while fast local discovery starts are debug-only after a successful text-producing run. Cursor-reported completed/step errors remain visible.
- Maintainer visual verification for replay-card changes should follow [Cursor Native Tool Visual Audit Workflow](./cursor-native-tool-visual-audit.md): offscreen PTY-driven pi run, xterm.js/Playwright screenshot rendering, and JSONL inspection before accepting commits or PRs.
- Cursor provider/runtime releases should follow [Cursor Live Smoke Checklist](./cursor-live-smoke-checklist.md) with real `pi -e . --cursor-no-fast --model cursor/composer-2.5` invocations, manual observation, temporary session dirs, diagnostics scans, and persisted JSONL inspection. See [Cursor testing lessons](./cursor-testing-lessons.md) for auth.json seeding, isolated smoke harnesses, and replay JSONL scans. Assume every runtime surface is in scope. A release is not ready when any live check is optional, deferred, mostly passing, or unobserved.
- For models without a catalog `context` parameter, context windows are not hardcoded. The extension ships a bundled SDK-derived default/non-Max cache generated from `createAgentPlatform().checkpointStore.loadLatest(agentId).tokenDetails.maxTokens`. Successful runs can update a local override cache, but model discovery does not probe models at startup.
- Max Mode context windows are distinct from default/non-Max context windows. `@cursor/sdk` 1.0.16 documentation says the SDK may enable Max Mode automatically when a selected model requires it, but the public local-agent `ModelSelection` path still does not expose a manual Max Mode selector. Do not advertise Max Mode context windows unless the SDK catalog exposes an exact parameter/variant or the SDK public API adds a Max Mode selector that the extension actually sends.
- The installed `@cursor/sdk` exposes latest-style `ModelListItem.aliases`. The extension registers only unambiguous aliases as pi model IDs (with the same context suffixes when applicable) and sends the alias back in `ModelSelection.id`, while sharing Cursor-only state such as fast defaults with the underlying catalog `id`. Aliases shared by multiple base models, such as generic family aliases, are skipped because the pi row metadata would otherwise imply one base model while Cursor may resolve the alias to another.
- Session-scoped Cursor SDK agent pooling reuses one live `@cursor/sdk` agent across compatible follow-up turns within the same pi session scope. `planCursorSessionSend()` in `src/cursor-session-send-policy.ts` decides whether the next turn sends a full bootstrap prompt or an incremental follow-up, whether the SDK agent must be recreated, and why. `computeCursorContextFingerprint()` and `shouldBootstrapCursorContext()` remain the context-only bootstrap signal. The pool recreates the agent when context diverges, when branch or compaction summaries appear after `/tree` navigation or compaction, after 20 completed incremental sends, when the API key identity changes, after send errors, on `session_shutdown`, and when `session_before_tree` / `session_tree` invalidate the active branch. Incremental sends omit the full Cursor SDK tool boundary block because the session agent retains prior bootstrap context, but every send ends with a short tool tail guard placed after the latest user request (including an explicit shell `cd` hint).
- Pi steering/follow-up delivery can arrive while a split live Cursor SDK run is still active. The provider resolves pending live runs by scanning trailing `toolResult` messages while skipping trailing `user` messages, tracks the active live run per session scope, and resumes the in-flight run instead of calling `Agent.send()` again. When the context ends with steering user text after tool results, the provider releases the prior live run and chains an incremental `Agent.send()` for the latest user message in the same provider turn; if the prior run emits more text or tool requests after steering arrives, that stale activity is cancelled instead of surfacing another old-run tool turn and losing the new user input. A pre-send guard waits for or resumes any still-active scoped live run before starting a fresh send so `@cursor/sdk` `AgentBusyError` (`already has active run`) does not surface to pi users. Pooled session agents mark busy as soon as live/direct `run.wait()` tracking starts (`trackRunCompletion` on the session lease), and `acquireSessionCursorAgent()` awaits that busy state before returning a lease so send planning, transcript offsets, and later `Agent.send()` do not race the prior turn's SDK run completion (for example pi auto-compaction summarization). `session_before_compact` calls `prepareCursorSessionForCompaction()` to release scoped live-run drain state and reset the pooled agent before summarization streams. Tracked completions and send commits are scoped to the pooled agent `instanceId` so disposal/replacement drops stale tracking and ignores late commits from disposed agents.

## Goal

Make Cursor models feel native in pi by leaning on pi's existing model, thinking, footer, and session behavior instead of building a parallel Cursor parameter system.

Main outcomes:

- `pi --list-models` shows pi-native Cursor models with accurate `contextWindow`, pi-controllable thinking metadata, and conservative defaults where the Cursor SDK does not expose limits or capabilities.
- `shift+tab` is pi's native thinking control and drives Cursor `reasoning` or `effort`.
- Cursor context options are represented as pi-visible model variants when they change native model metadata.
- Cursor-only state (`fast` and Cursor SDK `mode`) is controlled by extension flags/commands and shown through native status text only when non-default.
- The default pi footer remains intact.
- Model capabilities are discovered from the Cursor SDK, not hardcoded per model.

Native tradeoff: context-capable Cursor models intentionally use context-qualified pi model IDs. This gives up one completely clean row per Cursor base model, but it lets pi's native `contextWindow`, footer context usage, context overflow checks, compaction behavior, session restore, model selection, and `--list-models` metadata stay accurate.

## Non-goals

Not building now:

- verbosity support
- custom UI panels
- generic pi model-parameter system for all providers
- full custom footer replacement
- independent Claude `thinking` toggle separate from pi thinking
- multi-parameter CLI suffixes such as `--model cursor/gpt-5.5:medium:272k:fast`

## Source of Truth

Cursor SDK is the source of truth for Cursor model IDs and Cursor-supported parameters.

At startup, the extension calls:

```ts
Cursor.models.list({ apiKey });
```

Discovery resolves `apiKey` in this order:

1. CLI `--api-key`.
2. Stored pi auth for provider `cursor` from `AuthStorage.create().getApiKey("cursor", { includeFallback: false })`.
3. `CURSOR_API_KEY`.

Users can persist the stored key through `/login` -> `Use an API key` -> `Cursor`. If auth is added after startup, fallback models can run once pi resolves the saved key for provider requests, and `/cursor-refresh-models` refreshes the full live Cursor model catalog without restarting pi.

For each model, use:

- `model.id`
- `model.aliases`
- `model.displayName`
- `model.parameters`
- `model.variants`
- default variant: `variant.isDefault === true`, else first variant

This means new Cursor models and changed Cursor parameters are picked up after `/cursor-refresh-models`, reload, or restart.

Pi model metadata is also a source of truth for pi-native behavior:

- `ProviderModelConfig.id`
- `ProviderModelConfig.name`
- `ProviderModelConfig.reasoning`: means pi-controllable thinking, not whether a Cursor model is thinking-capable
- `ProviderModelConfig.thinkingLevelMap`
- `ProviderModelConfig.contextWindow`
- `ProviderModelConfig.maxTokens`
- `ProviderModelConfig.input`

If a Cursor parameter changes any of those pi-native fields, model registration must expose that change to pi.

### Refresh Current Cursor Matrix

Run this whenever Cursor releases or changes models, and before releases that may ship stale fallback metadata:

```bash
CURSOR_API_KEY="your-key" npm run refresh:cursor-snapshots -- --write
```

That command refreshes `src/cursor-fallback-models.generated.ts` only. If live local Cursor runs have collected checkpoint-derived context windows, merge them into the bundled default/non-Max snapshot too:

```bash
CURSOR_API_KEY="your-key" npm run refresh:cursor-snapshots -- --write \
  --context-windows ~/.pi/agent/cursor-sdk-context-windows.json
```

The script calls `Cursor.models.list({ apiKey })`, writes `src/cursor-fallback-models.generated.ts`, and updates `src/bundled-context-windows.ts` only when `--context-windows` is provided. It prints model IDs/counts only and scrubs known auth material from SDK errors; it must not print or store API keys. Review the generated diff before committing because Cursor can change aliases, defaults, and parameter meanings.

## Design Direction

Use native pi abstractions wherever possible:

| Concern | Representation |
|---|---|
| Cursor base model | pi provider model |
| Cursor `context` | pi-visible model variant because it changes `contextWindow` |
| Cursor `reasoning` | pi native thinking via `thinkingLevelMap` |
| Cursor `effort` | pi native thinking via `thinkingLevelMap` |
| Cursor `thinking=false` | pi native `off` |
| Cursor `fast` | extension state, not model identity |
| Cursor SDK `mode` | extension session state; `agent` by default, `plan` via SDK-native mode |
| Footer | default pi footer plus optional extension status |

Reason:

- pi already persists model and thinking selection.
- pi already clamps unsupported thinking levels from `thinkingLevelMap`.
- pi context display, context overflow, and compaction depend on `contextWindow`.
- extension APIs can replace the whole footer but cannot partially mutate the default model text.

## Model Registration

Register a `cursor` provider with `pi.registerProvider()`.

Rules:

- Register one pi model for each Cursor base model and each unambiguous SDK alias when there is no Cursor `context` parameter.
- Register one pi model per Cursor `context` value for each Cursor base model and each unambiguous SDK alias when the model exposes a `context` parameter.
- Skip SDK aliases that collide with another base model ID or are shared by multiple base models; those aliases can resolve differently from the pi row metadata.
- Do not encode `reasoning`, `effort`, `thinking`, `fast`, or Cursor SDK `mode` into pi model IDs.
- Prefer stable, readable `@<context>` suffixes that do not conflict with pi's final `:<thinking>` suffix parser.
- Sort Cursor models by base ID, then context value in Cursor SDK order before calling `pi.registerProvider()`. Registration order matters for `/model` display and model cycling; `--list-models` sorts output separately.

Recommended context-variant ID format:

```text
cursor/gpt-5.5@1m
cursor/gpt-5.5@272k
cursor/claude-opus-4-8@1m
cursor/claude-opus-4-8@300k
cursor/composer-2.5
```

Avoid colon-based context IDs in the first implementation unless this spec is intentionally changed:

```text
cursor/gpt-5.5:1m
cursor/gpt-5.5:1m:medium
```

Those can work technically because pi parses only the final `:<thinking>` suffix, but they overload pi's documented thinking shorthand.

Avoid this old parameter encoding:

```text
cursor/gpt-5.5:context=1m;fast=false;reasoning=medium
cursor/claude-opus-4-8:context=1m;effort=xhigh;thinking=true
```

Reason:

- `@1m` keeps context visually separate from pi's native `:medium` thinking suffix.
- Context variants make `contextWindow` accurate in `--list-models`, the native footer, context overflow checks, and compaction logic.
- `fast` is intentionally not a model variant because it does not affect pi model metadata and would double list noise.

### Metadata Per Registered Model

Each registered model must set:

- `id`: context-qualified pi model ID when needed. For SDK aliases, this uses the alias as the pi-visible ID and the alias is sent back to Cursor as `ModelSelection.id`.
- `name`: human-readable Cursor display name plus context when useful.
- `reasoning`: `true` only if a Cursor `reasoning`, `effort`, or `thinking` parameter can map to pi thinking. This controls pi's thinking UI and `pi --list-models` `thinking` column; it must not be used to claim whether the Cursor model can think internally. Cursor SDK models are thinking-capable even when this is `false`.
- `thinkingLevelMap`: model-specific pi-to-Cursor mapping for pi UI, clamping, persistence, and footer display.
- `contextWindow`: parsed from context variant, else conservative fallback.
- `maxTokens`: conservative explicit value until Cursor SDK exposes output limits.
- `input`: supported input types. The installed Cursor SDK accepts `SDKUserMessage.images`, and Cursor models are expected to support image input, so advertise `["text", "image"]`.
- `cost`: zeroed unless reliable Cursor costs are available.

The extension stores runtime metadata in an internal map keyed by registered pi model ID. That map records the Cursor base catalog model ID, the Cursor selection model ID (base ID or alias), selected context param, default params, and discovered capabilities. `ProviderModelConfig` has no dedicated metadata field, so do not rely on hidden custom fields for this state.

## Dynamic Capabilities

No per-model hardcoded control list.

Infer behavior from discovered params:

| Cursor param | Extension behavior |
|---|---|
| `context` with values | register pi-visible context variants |
| `reasoning` | populate `thinkingLevelMap` |
| `effort` | populate `thinkingLevelMap` |
| `thinking` with `true/false` | map `false` to pi `off`; map `true` to the enabled pi level chosen for boolean-only thinking |
| `fast` with `true/false` | enable fast extension setting |

Unsupported Cursor-only actions are no-op plus a short notification.

Example:

```text
Fast mode not supported by gemini-3.1-pro
```

## Keybindings And Commands

Native pi keybindings:

| Action | Keybinding | Owner |
|---|---:|---|
| Cycle thinking / reasoning / effort | `shift+tab` | pi native `app.thinking.cycle` |
| Select model / context variant | `/model`, `ctrl+l`, scoped model cycling | pi native model selection |

Cursor extension controls:

| Action | Preferred control | Applies when |
|---|---:|---|
| Toggle fast | `/cursor-fast` | model has `fast` |
| Set SDK mode | `/cursor-mode agent\|plan` | Cursor model selected |
| Show tool surfaces (maintainer) | `/cursor-tools` | Cursor model selected |

Do not register a shortcut for `shift+tab`. Pi reserves the native thinking keybinding, and the extension should only influence it through model metadata.

Do not add a context-cycle shortcut in the first pass. Context is a pi model variant, so users should change it through native model selection/cycling.

## Thinking / Reasoning / Effort Mapping

Important distinction:

- **Cursor thinking support** applies to all Cursor SDK models. The extension should assume Cursor models can think and may emit thinking deltas.
- **Pi-controllable thinking** means Cursor exposes a `reasoning`, `effort`, or `thinking` parameter that the extension can set from pi's native thinking level. These models register `reasoning: true` and show `thinking=yes` in `pi --list-models`.
- **Cursor SDK thinking-control gap** means the model can still think, but the SDK does not expose a user-controllable thinking parameter for that model. These models register `reasoning: false` and show `thinking=no` in `pi --list-models` because pi cannot control a level for them. The extension still surfaces Cursor `thinking-delta` and summary events through pi's native thinking rendering when they are emitted.

Do not mark a model `reasoning: true` only because it can think. That would make pi show controls such as `--thinking`, `:medium`, and shift+tab even though the extension cannot translate them into Cursor SDK params.

Pi levels:

```text
off, minimal, low, medium, high, xhigh
```

Cursor values vary by model. Build `thinkingLevelMap` from the values Cursor exposes.

Mapping rules:

| pi level | Cursor value preference |
|---|---|
| `off` | `none`, else `off`, else `false`, else unsupported |
| `minimal` | `minimal`, else unsupported |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high`, else `true` for boolean-only thinking |
| `xhigh` | `xhigh`, else `max`, else `extra-high` |

Important details:

- Use `null` for unsupported pi levels so pi hides/skips/clamps them natively.
- Include `xhigh` only when Cursor exposes a real value for it.
- Prefer exact `xhigh` over `max`. Cursor currently exposes both on some Claude models, and exact `xhigh` is the closer native mapping.
- If Cursor exposes `reasoning=none`, map pi `off` to `none`.
- If Cursor exposes `thinking=false`, map pi `off` to `false`.
- `thinkingLevelMap` does not create Cursor SDK params by itself. It only controls pi-native behavior. The Cursor stream implementation must use the active pi thinking level plus the extension's discovered Cursor metadata to build `ModelSelection.params` for `Agent.create()`.

For boolean-only `thinking`, unsupported pi levels must be explicit `null`; otherwise pi treats omitted non-`xhigh` levels as supported. Use this shape unless Cursor exposes richer values:

```ts
{
  off: "false",
  minimal: null,
  low: null,
  medium: null,
  high: "true",
  xhigh: null,
}
```

## Claude Behavior

Some Claude models support both:

```text
thinking=true|false
effort=low|medium|high|xhigh|max
```

Rules:

- Pi `off` sends `thinking=false`.
- Pi enabled levels send `thinking=true` and the mapped `effort`.
- `shift+tab` changes pi thinking, which changes Cursor `effort`.
- There is no separate `thinking` toggle.

Reason:

- This matches pi's single thinking mental model.
- It avoids an independent Cursor `thinking` state that the native footer, CLI, and session thinking persistence cannot represent.
- Users can still disable Claude thinking with pi `off`.

## Context Behavior

If a Cursor model supports `context`, register one pi model variant per context value.

Examples:

```text
cursor/gpt-5.5@272k
cursor/gpt-5.5@1m

cursor/claude-opus-4-8@300k
cursor/claude-opus-4-8@1m

cursor/grok-4.3@200k
cursor/grok-4.3@1m
```

Each variant must:

- have an entry in the extension metadata map that points back to the same Cursor base model ID,
- include the selected Cursor `context` param when calling `Agent.create()`,
- set pi `contextWindow` from that context value,
- share the same `thinkingLevelMap` as the base model unless Cursor reports otherwise.

Reason:

- pi context display and overflow logic must match the actual Cursor context.
- pi has no generic provider-parameter system that can change `contextWindow` while keeping the same model ID.

## Fast Behavior

If a model supports `fast`:

```text
fast=false <-> fast=true
```

Rules:

- `fast` is extension state, not pi model identity.
- Toggle with `/cursor-fast`.
- Store per-session and global per-base-model preferences.
- When calling `Agent.create()`, include the selected `fast` value in Cursor model params.
- Show `fast` through `ctx.ui.setStatus()` when enabled.
- Support a first-pass CLI flag, `--cursor-fast`, to force fast mode for one run when the selected model supports it.

Reason:

- `fast` does not affect pi `contextWindow`, thinking levels, or input support.
- Registering fast/non-fast variants would make `--list-models` noisy without improving native pi behavior.

Status example:

```text
cursor fast
```

## Cursor SDK Mode Behavior

Cursor SDK 1.0.16 exposes SDK-native conversation mode:

```ts
type AgentModeOption = "agent" | "plan";
```

Rules:

- Default mode is `agent`.
- Supported modes are exactly `agent` and `plan`.
- Mode is extension session state, not a model variant, not pi thinking/reasoning, not Cursor `fast`, and not pi's separate plan-mode extension.
- `--cursor-mode agent|plan` sets a one-run CLI override and does not append session state.
- `/cursor-mode agent` and `/cursor-mode plan` persist session mode with `pi.appendEntry()`.
- `/cursor-mode` with no args reports current mode and usage.
- Invalid CLI values fail non-UI runs and notify interactive users before the provider rejects the run.
- New SDK agents are seeded with `Agent.create({ mode })`.
- Every SDK send passes the effective mode through `agent.send(..., { mode })` so `/cursor-mode` and `--cursor-mode` remain the source of truth.
- Mode is not part of the session-agent pool key because Cursor SDK supports SDK-native per-send mode switches.
- Cursor plan/todo/task/mode activity remains display-only Cursor activity unless pi itself exposes a native state path. Replay cards do not mutate pi plan/todo state or active tools.

Status examples:

```text
cursor plan
cursor fast · plan
```

## Footer Behavior

Hard requirement:

- Leave pi's default footer intact.
- Do not use `ctx.ui.setFooter()` for the first pass.
- Use `ctx.ui.setStatus()` only for Cursor-only state that pi cannot show natively, such as `fast` and non-default Cursor SDK `plan` mode.
- Non-cursor models must have no Cursor status.

Reason:

- `ctx.ui.setFooter()` replaces the entire built-in footer.
- pi has no public extension API to mutate only the model text in the default footer.
- Reimplementing the default footer would create drift with pi's native footer behavior.

Expected native footer behavior:

- provider/model is shown by pi from the selected `cursor` model,
- thinking level is shown by pi when `reasoning` is true,
- context usage is computed from `contextWindow`,
- extension status adds only Cursor-only text such as `cursor fast`, `cursor plan`, or `cursor fast · plan`.

`ctx.ui.setStatus()` adds an extension status line in the default footer. It does not patch the built-in model segment. The native shape is closer to:

```text
...                                      (cursor) gpt-5.5@1m • medium
cursor fast · plan
```

not:

```text
(cursor) gpt-5.5 • 1M • medium • fast
```

## State And Persistence

Match pi's native mental model:

### Native pi state

Let pi persist:

- selected model, including context variant,
- selected thinking level,
- session model restore,
- global default thinking behavior.

### Extension state

The extension persists only Cursor-only state:

- `fast` per session,
- `fast` global default per Cursor base model,
- Cursor SDK `mode` per session,
- any future Cursor-only parameter that does not map to pi model metadata.

Use:

- `pi.appendEntry()` for session state that must survive resume/fork/reload,
- an extension-owned global config file for cross-session defaults,
- in-memory state only as a cache rebuilt from persisted state on `session_start`.

### New Install

Use Cursor default variants:

```text
gpt-5.5 -> cursor/gpt-5.5@1m, thinking medium, fast=false
composer-2.5 -> cursor/composer-2.5, fast=true
```

### Resume Session

Restore:

- pi model, including context variant,
- pi thinking level,
- session Cursor-only state such as `fast` and Cursor SDK `mode`.

### New Session

Use:

1. pi's selected/default model and thinking level,
2. global saved Cursor-only defaults for the selected base model,
3. else Cursor default variant params.

## CLI / Print Mode

Guaranteed first-pass support:

```bash
pi --model cursor/gpt-5.5@1m --thinking medium
pi --model cursor/gpt-5.5@1m --cursor-mode plan
pi --model cursor/gpt-5.5@1m:medium
pi --model cursor/gpt-5.5@272k:xhigh
```

These use pi's native thinking parser. `--thinking` wins over a `:<thinking>` suffix when both are present.

Not first-pass support:

```bash
pi --model cursor/gpt-5.5:medium:272k:fast
```

Reason:

- pi supports one final `:<thinking>` suffix.
- Cursor-only parameters are not generic pi CLI parameters.
- Context is already represented by the registered pi model ID.
- `fast` is controlled by saved extension defaults or the first-pass `--cursor-fast` extension flag.
- Cursor SDK `mode` is controlled by `/cursor-mode` session state or the first-pass `--cursor-mode` extension flag; it is never encoded in `--model`.

For print mode:

- no keybindings,
- use selected context model variant,
- use `--thinking` or `:medium` for reasoning/effort,
- use saved global `fast` defaults unless `--cursor-fast` is present,
- use Cursor SDK `agent` mode unless `/cursor-mode` session state or `--cursor-mode` overrides it.

Fast flag example:

```bash
pi --model cursor/gpt-5.5@1m --cursor-fast -p "Say ok only"
```

## Discovered Model Capability Examples

These examples document the capability shapes the extension handles, not an exhaustive live catalog. The exact Cursor catalog changes over time; use `pi -e . --list-models cursor` or `Cursor.models.list()` for the current model surface. When the SDK reports aliases, only unambiguous aliases are registered; shared generic aliases are skipped.

| Example model shape | Cursor controls | Pi representation |
|---|---|---|
| plain model, such as `default` or models with no exposed controls | none | plain model |
| Composer-style model such as `composer-2.5` or `composer-2` | fast | plain model + fast extension state |
| GPT-style reasoning model with context variants | context, reasoning, fast when exposed | context variants + native thinking + optional fast state |
| Claude-style thinking model with context variants | thinking, context, effort when exposed | context variants + native thinking + optional fast state |
| Claude-style thinking model without context variants | thinking and/or effort | plain model + native thinking |
| context-only model | context | context variants |
| unique latest alias for any shape | aliases | same pi rows as the base model shape, using the alias as `ModelSelection.id` |
| shared generic alias across multiple base models | aliases | skipped to avoid misleading pi rows |

If Cursor later adds `fast`, `context`, `reasoning`, `effort`, or aliases to a model, the extension picks up unambiguous capability changes dynamically.

## Detailed Examples

### Composer 2 / 2.5

Initial Cursor default for Composer 2.5:

```text
pi model: cursor/composer-2.5
Cursor params: fast=true
pi thinking: off
Cursor status: cursor fast
```

Toggle fast:

```text
Cursor params: fast=false
Cursor status: cleared
```

`shift+tab`: no-op because the model is not reasoning-capable.

### `gpt-5.5`

Initial Cursor default:

```text
pi model: cursor/gpt-5.5@1m
Cursor params: context=1m; reasoning=medium; fast=false
pi thinking: medium
Cursor status: cleared
```

After selecting the 272k variant:

```text
pi model: cursor/gpt-5.5@272k
Cursor params: context=272k; reasoning=medium; fast=false
pi contextWindow: 272000
```

After fast toggle:

```text
Cursor params: context=272k; reasoning=medium; fast=true
Cursor status: cursor fast
```

After `shift+tab` to xhigh:

```text
pi thinking: xhigh
Cursor params: context=272k; reasoning=extra-high; fast=true
```

### `gpt-5.3-codex`

Initial Cursor default:

```text
pi model: cursor/gpt-5.3-codex
Cursor params: reasoning=high; fast=true
pi thinking: high
Cursor status: cursor fast
```

After `shift+tab` to low:

```text
pi thinking: low
Cursor params: reasoning=low; fast=true
```

No context variant.

### `claude-opus-4-8`

Initial Cursor default:

```text
pi model: cursor/claude-opus-4-8@1m
Cursor params: thinking=true; context=1m; effort=xhigh
pi thinking: xhigh
```

After selecting the 300k variant:

```text
pi model: cursor/claude-opus-4-8@300k
Cursor params: thinking=true; context=300k; effort=xhigh
pi contextWindow: 300000
```

After `shift+tab` to high:

```text
pi thinking: high
Cursor params: thinking=true; context=300k; effort=high
```

After `shift+tab` to off:

```text
pi thinking: off
Cursor params: thinking=false; context=300k
```

### `grok-4.3`

Supports context only.

```text
cursor/grok-4.3@1m
cursor/grok-4.3@200k
```

Fast toggle: no-op.

`shift+tab`: no-op because the model is not reasoning-capable.

## Validation Plan

Before calling done:

1. Unit tests:
   - context-variant model IDs
   - dynamic capability discovery
   - context variant registration and decoding
   - fast extension state and status behavior
   - Cursor SDK mode session/CLI state and status behavior
   - `reasoning` mapping
   - `effort` mapping
   - boolean `thinking` maps to pi `off` / enabled levels
   - pi `xhigh` preference order: `xhigh`, then `max`, then `extra-high`
   - session restore for Cursor-only state
   - global default state for Cursor-only state
   - unsupported no-op notifications

2. Runtime checks:
   - `pi --list-models cursor`
   - confirm context variants show expected `context` column
   - launch interactive with Cursor
   - verify default pi footer remains unchanged
   - verify Cursor `fast` status appears only when enabled
   - verify Cursor `plan` status appears only in non-default mode and combines with fast as `cursor fast · plan`
   - verify non-cursor footer/status unchanged
   - verify `shift+tab` uses pi native thinking
   - verify context changes through native model selection
   - verify resume restores model, thinking, and Cursor-only state

3. Print mode:
   - `pi --model cursor/gpt-5.5@1m:medium -p "Say ok only"`
   - `pi --model cursor/gpt-5.5@272k --thinking xhigh -p "Say ok only"`
   - `pi --model cursor/gpt-5.5@1m --cursor-fast -p "Say ok only"`
   - `pi --model cursor/gpt-5.5@1m --cursor-mode plan -p "Say ok only"`
   - confirm requests use selected context, pi thinking, fast flag state, and SDK-native mode

4. Tool bridge and replay:
   - `npm test -- test/cursor-pi-tool-bridge.test.ts test/cursor-provider.test.ts test/cursor-mcp-timeout-override.test.ts`
   - confirm `Agent.create()` gets `mcpServers.pi_tools` when active pi tools exist and omits it when `PI_CURSOR_PI_TOOL_BRIDGE=0` or the active snapshot is empty
   - confirm bridged MCP requests emit real pi tool calls and resolve matching pi tool results back to the same live Cursor SDK run without creating a new `Agent`, unless the run was disposed, aborted, or cancelled
   - confirm bridge MCP activity is suppressed from Cursor replay while non-bridge Cursor MCP activity remains visible
   - confirm `PI_CURSOR_MCP_TOOL_TIMEOUT_MS` and `PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS` override the Cursor SDK MCP callTool timeout seam
   - confirm `PI_CURSOR_MCP_CONNECT_TIMEOUT_MS` and `PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS` override the Cursor SDK MCP initialize/listTools timeout seam while unknown protocol timeout stacks keep the SDK default
   - confirm `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` emits typed, allowlisted, scrubbed JSONL to `process.stderr` with prefix `[pi-cursor-sdk:bridge]`, omits endpoint URLs/path components/tokens, and unset/false leaves output unchanged
   - run the visual audit workflow when replay card visuals or bridge card visuals change; JSONL should show real pi tool names for bridged calls and no duplicate MCP replay for bridge calls
