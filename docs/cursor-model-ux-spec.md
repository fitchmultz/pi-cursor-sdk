# Cursor Model UX Spec

> Maintainer note: this is an internal design and behavior spec for pi-cursor-sdk. If you are trying to install or use the extension, start with the main [README](../README.md) instead.

## Status

Implemented design target. This file describes the intended Cursor model UX and should stay aligned with the current code in `src/`.

Current implementation notes:

- Cursor context variants use `base@context` pi model IDs.
- Cursor `reasoning`, `effort`, and boolean `thinking` parameters are driven by pi native thinking when the Cursor SDK exposes those controls.
- Cursor `fast` is extension state by default; models that expose `fast` also get selection-only `:fast` / `:slow` virtual aliases for per-agent overrides.
- Cursor SDK `mode` (`agent` or `plan`) is extension session state, not model identity, pi thinking, Cursor `fast`, or pi's separate plan-mode extension.
- Cursor status uses one coordinated `ctx.ui.setStatus("cursor", ...)` value for fast, non-default plan mode, and the local-only `http1` transport marker; the default pi footer remains intact.
- Installed `@cursor/sdk` user messages accept images, and Cursor models are treated as image-capable; registered input metadata is `text` plus `image`.
- Image payload forwarding sends images only from the latest user message. If the latest user turn is plain text after an earlier image turn, the transcript keeps an `[image omitted from transcript]` placeholder but no image bytes are sent to Cursor. The prompt explicitly tells Cursor that prior image bytes are unavailable and to ask the user to reattach or describe a prior image when needed. Carrying images forward across turns remains a future product decision because it affects token cost, privacy, stale visual context, and expected multimodal follow-up behavior.
- Exact `@cursor/sdk@1.0.27` is a package dependency of this extension; users should not need a global SDK install. Pi 0.84.0 is the minimum supported and current validation baseline, while optional published Pi core peer dependencies use `"*"` ranges per current Pi package guidance.
- After each finished SDK run, the provider calls `agent.getUsage()` (no `runId` on local agents; `runId` only for cloud `run-*` IDs) and maps billed spend into pi `usage` spend fields. Occupancy `totalTokens` uses only in-window local turn-ended occupancy below the latest compaction `tokensBefore`; billed rows never become occupancy, so footer/auto-compact stay aligned with the post-compact Cursor prompt.
- Startup discovery does not duplicate Pi CLI parsing: it uses stored `~/.pi/agent/auth.json` API-key auth from `/login`, then `CURSOR_API_KEY`, otherwise it registers the bundled fallback catalog. Provider turns keep Pi's resolved `options.apiKey`. `/cursor-refresh-models` and `/cursor-cloud` mutations resolve provider `cursor` through the command context's Pi ModelRegistry, then normalize placeholders through `CURSOR_API_KEY`. The extension config file stores only non-secret Cursor-only state such as fast defaults and the user-level local HTTP transport preference.
- Cursor Cloud repository overrides accept only HTTPS repository URLs without userinfo, query parameters, or fragments. Invalid values fail during preflight before `Agent.create()`, messages never echo the supplied URL, and shared provider/maintainer scrubbing removes URL/SCP-style userinfo defensively.
- Cursor Cloud requires a persisted pi session. Immediately after remote `Agent.create()` returns, before debug work or abort checks, the provider appends a branch-local pi lifecycle entry, fsyncs the existing Pi session JSONL anchor through a read-write descriptor, and then fsyncs a newline-framed sidecar keyed by the stable pi session ID (POSIX mode `0600`; Windows inherits the user session directory ACL) in the session directory. Journal creation is exclusive, and existing append/read opens reject symlinks and require matching regular-file descriptor/path identity before using the descriptor. Existing session files use the exact lifecycle entry ID as anchor; fileless first turns use an orphan marker that a same-session-ID restart durably claims onto exactly one matching or replacement branch, surviving the timestamped path change and later JSONL creation without granting sibling access; returned run IDs are fsynced before abort/wait handling, readers skip malformed/truncated lines independently, and branch-only history events are reduced after deduplicated sidecar history, and tombstones are tracked before records exist. A durable sidecar result remains authoritative if its optional Pi mirror append fails; if the sidecar result itself fails, the prior durable intent remains pending and blocks retry rather than claiming success. `--no-session` and durable-ledger failures fail closed before send, while post-send ledger failure requests bounded cancellation. `/cursor-cloud` always validates the embedded session ID, accepts only null anchors while truly fileless, and reconciles each orphan to one branch before listing or mutation. Successive record events merge run/branch metadata monotonically even when mirrored sources arrive out of order. Archive/delete require resolved Cursor auth, fsync a durable intent before the SDK call, and fsync a durable success result afterward; unresolved intent blocks repeat mutation and requires dashboard inspection.
- Local agents pass `settingSources: ["all"]` by default so Cursor MCP servers, plugin tools, project/user settings, and related Cursor-native capabilities are available. Users can narrow loading with a comma-separated list such as `PI_CURSOR_SETTING_SOURCES=project,user,plugins`, or disable ambient setting sources with `PI_CURSOR_SETTING_SOURCES=none`. `/cursor-refresh-config` calls the current pooled SDK agent's `agent.reload()` to refresh filesystem Cursor config without recreating the agent. The provider suppresses direct Cursor SDK bootstrap stdout/stderr/console noise (including late first-send workspace loading such as hook compatibility warnings) so it does not pollute pi's TUI.
- On `cursor/*` models, pi-cursor-sdk removes only pi-generated `<project_instructions>` blocks that overlap the effective Cursor `settingSources`: `user` for `~/.pi/agent/AGENTS.md`; `project` for discovered repo/parent `AGENTS.md` and `CLAUDE.md` (verified Cursor behavior: local agents load project `AGENTS.md` and `CLAUDE.md`). `~/.pi/agent/CLAUDE.md` is not removed (Cursor user layer uses `~/.claude/CLAUDE.md`). Blocks are removed by exact pi serialization match from structured `contextFiles` via the `before_agent_start` hook, not in `buildCursorPrompt` sanitization. Suppression is skipped with `-nc`, `PI_CURSOR_SETTING_SOURCES=none`, narrowed sources such as `plugins` that omit the matching layer, or `PI_CURSOR_PRESERVE_PI_AGENTS_MD=1`. Switching away from a Cursor model restores pi's full context block on the next user message.
- Cursor SDK models are treated as thinking-capable even when pi reports `thinking=no`; that pi column only means the SDK did not expose a pi-controllable thinking parameter for that model.
- Cursor-side thinking remains visible through pi's native thinking rendering when the Cursor SDK emits thinking or summary deltas.
- Local Cursor agents get two tool surfaces. First, Cursor keeps the Cursor SDK local-agent tool surface plus configured Cursor settings, plugins, and Cursor MCP servers. Second, pi-cursor-sdk exposes active pi tools through a default-on, tokenized loopback MCP bridge when bridgeable tools exist.
- `buildCursorPiToolBridgeSnapshot()` is the runtime capability source for pi bridge tools. It snapshots `pi.getActiveTools()` and `pi.getAllTools()`, carries pi 0.77+ per-tool `promptGuidelines` into bridge MCP descriptions, filters internal replay names, hides overlapping built-in pi tools (`read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`) unless `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1`, and creates collision-safe MCP names such as `pi__sem_reindex`. Cursor discovers the current run's exposed bridge tools through MCP `listTools`. Bootstrap prompts include a compact callable-surface manifest from `buildCursorToolManifestText()` by default (`PI_CURSOR_TOOL_MANIFEST=1`); disable with `PI_CURSOR_TOOL_MANIFEST=0`. There is no per-turn visible tool list, status manifest, or footer manifest. User-facing summary: [Cursor tool surfaces in pi](./cursor-tool-surfaces.md).
- Prompt text is the primary provider/bridge contract. Bootstrap prompts carry a short boundary block plus the callable-surface manifest by default (`PI_CURSOR_TOOL_MANIFEST=1`). MCP `listTools` descriptions use a one-line pointer to the bootstrap prompt instead of repeating the full contract (`buildCursorPiBridgeMcpToolDescription()`). Cursor must call the exposed `pi__*` MCP name, not the real pi tool name shown in pi history or transcripts. When exposed, `pi__mcp` takes preference over Cursor-configured MCP for MCP work and `pi__subagent` takes preference over Cursor-native subagents for delegation; the Cursor-native surfaces remain fallbacks when the matching pi bridge tool is absent or unavailable. Pi emits and executes the real pi tool name. Maintainer debug: `/cursor-tools` prints bridge/manifest enablement, effective `PI_CURSOR_SETTING_SOURCES`, and the current callable-surface snapshot.
- The provider also registers `cursor_ask_question` for Cursor models when the bridge and default-on `PI_CURSOR_ASK_QUESTION` control are enabled. While the tool awaits pi UI input it emits package event `pi-cursor-sdk:ask-question:blocked` with `{ active: true }` and clears `{ active: false }` in `finally`; the tool runs with `executionMode: "sequential"` so parallel sibling calls cannot overlap dialogs. Cursor sees it as `pi__cursor_ask_question`, and pi executes it through the normal tool path so interactive users can choose options from pi UI. `PI_CURSOR_ASK_QUESTION=0` removes only this tool while preserving the rest of the bridge. In non-UI modes it reports that UI is unavailable so Cursor can state a default assumption instead. When pi has visible Agent Skills loaded, the provider rewrites the skill catalog for Cursor and registers `cursor_activate_skill` as `pi__cursor_activate_skill`; pi executes it through the normal tool path so Cursor can load the full `SKILL.md` and skill resource list for the current pi-loaded skill source of truth. `PI_CURSOR_PI_TOOL_BRIDGE=0` disables the local bridge, including question and skill activation bridging. Cloud Cursor agents remain out of scope for the bridge.
- The bridge queues MCP calls, emits provider `toolcall_*` events, waits for matching pi `toolResult` messages by `toolCallId`, resolves the result back into the same live Cursor SDK run without creating a new `Agent`, and never calls tool `execute()` handlers directly. The same-run resume invariant holds unless the run was disposed, aborted, or cancelled.
- Cursor SDK MCP tool calls use a guarded timeout override because installed `@cursor/sdk` 1.0.27 still has a 60-second MCP request default with no public per-server timeout option. The extension extends the verified Cursor SDK MCP `callTool` timeout path to 3600 seconds by default and shortens the verified first-send MCP initialize/listTools timeout paths to 10 seconds by default so unavailable configured MCP servers do not block the first reply for a full minute; unknown MCP protocol timeout stacks keep the SDK default. Users can override tool-call timeouts with `PI_CURSOR_MCP_TOOL_TIMEOUT_MS` or `PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS`, and initialize/listTools timeouts with `PI_CURSOR_MCP_CONNECT_TIMEOUT_MS` or `PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS`. Bridged `CallTool` waits also have a local fail-closed deadline that defaults to and cannot exceed the effective MCP tool timeout; `PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS` can lower it, expiry or MCP cancellation aborts active pi execution when available, and expired bridge events are dropped before pi tool emission.
- Cursor SDK local safety controls are off by default. `--cursor-auto-review` / `PI_CURSOR_AUTO_REVIEW` and `--cursor-sandbox` / `PI_CURSOR_SANDBOX` pass only explicit enabled values into `Agent.create({ local })`; user or trusted project config can set `local.autoReview` and `local.sandboxOptions.enabled`; project config is active only when Pi's project-trust flow reached the extension and approved the project or the run used explicit `--approve`, and project saves require the same immutable trust provenance rather than creating Pi trust resources automatically. Pi 0.84.0 loads `pi install -l` project-local extensions after the trust event, so those installs require `--approve` on every run that reads or writes `.pi/cursor-sdk.json`. Explicit runtime, fast-default, and HTTP transport saves preserve unrecognized config fields, reject malformed or non-object JSON without rewriting it, and use one lock-protected read-modify-write path; fast saves mutate only the selected model key. Because Pi can mutate its in-memory session branch before a journal append throws, a completed global save is authoritative and the command reports the partial journal failure instead of attempting an ambiguous rollback; the new global value stays authoritative over stale branch entries until a later successful save or session restart.
- Local HTTP/1.1/SSE compatibility is strictly opt-in through `PI_CURSOR_HTTP_1_1`, `/cursor-http on|off|toggle`, or user `cursor-sdk.json` `local.useHttp1ForAgent`. Precedence is session, environment, user, then the built-in unset default; project config is excluded. Unset makes no `Cursor.configure()` call. Explicit values configure the installed SDK before local `Agent.create()`, extension-owned explicit state is cleared with the SDK's documented `null` reset when returning to unset and during session shutdown before module reload, and default/HTTP2/HTTP1 choices split pooled local agents. Pi's supported CLI/TUI/print/RPC lifecycle has one active session runtime per process; concurrent independent `AgentSession` embedding in one process is outside this transport toggle's contract because the installed SDK setting and executor cache are module-global. The footer adds `http1` only for enabled local runtime; cloud creation and status remain untouched.
- Bridge diagnostics are opt-in only: `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` writes typed, allowlisted, scrubbed single-line JSONL records to `process.stderr` with prefix `[pi-cursor-sdk:bridge]`. Diagnostics are scrubbed operational logs, not anonymous telemetry. They intentionally include tool names, safe correlation IDs, run lifecycle, exposed pi↔MCP name pairs, queued requests, result resolution, rejection, cancellation, and pending counts. Correlation IDs are generated independently from the tokenized endpoint path, and Cursor MCP call IDs are hashed before serialization. Diagnostics must not include endpoint paths/URLs/path components/tokens, API keys, bearer tokens, cookies, session credentials, raw args/results, stdout/stderr payloads, file contents, Cursor settings output, or local private session paths in tracked docs, and they must not call pi UI status, notification, or footer APIs. If tool names themselves are unacceptable for a release target, bridge debug diagnostics are not safe for shared logs under the current contract. Provider-facing bridge tool-call IDs use the run UUID without separators in the `cursor-pi-bridge-<32 hex>-t<counter>` shape and are capped at 64 characters; bridge run IDs and tool-call IDs remain distinct.
- This repo does not provide a generic desktop-automation, browser-driver, or CDP recipe. Provider docs should describe pi-cursor-sdk's Cursor provider/bridge contract only.
- Cursor internal tool activity is recorded from SDK events and scrubbed. Maintainer reference for `@cursor/sdk@1.0.27` `ToolType` values, runtime alias normalization, and intentional mapping/fallback rules: [Cursor native tool replay — SDK ToolType replay matrix](./cursor-native-tool-replay.md#sdk-tooltype-replay-matrix) (official SDK docs: https://cursor.com/docs/sdk/typescript). In TUI sessions and structured JSON/RPC modes, supported completed `read`, `bash`, `grep`, `find`, `ls`, `edit`, `write`, diagnostics, delete, todo/plan, task, image generation, MCP, semantic search, and screen recording activity is replayed through pi's native tool-call rendering path with recorded Cursor results, so users and JSON/RPC consumers can see native-looking cards/events without rerunning Cursor's reads/shell commands/file edits. Cursor `glob` activity is replayed through native `find` cards. Cursor write activity is replayed through native-looking `write` cards, and Cursor StrReplace/edit activity uses native-looking `edit` only when recorded arguments truthfully satisfy pi's `edit` schema; path-only Cursor edit and notebook edit replay falls back to neutral Cursor activity before pi validation. Diagnostics, delete, todos/plans, task/subagent, image, and MCP activity use neutral Cursor activity cards with pi's default success/error shell. Cursor SDK `task` activity is labeled **Cursor subagent** by default because it represents Cursor-spawned child-agent work; the card summary includes description plus subagent kind/model/short ID when Cursor reports them, and `PI_CURSOR_TASK_PRESENTATION=task` restores the older **Cursor task** wording for comparison. This is visibility over Cursor SDK task events, not a native pi subagent session: pi shows start/final output plus any `conversationSteps` tool-call summaries Cursor returns, but cannot show a live nested read/shell/MCP trail when the SDK only returns final subagent text. Neutral Cursor activity calls include `activityTitle` and, when available, `activitySummary` so partial/collapsed cards preserve identity such as `Cursor plan`, `Cursor todos`, `Cursor subagent`, `Cursor MCP`, or `Cursor edit`. For long-running or externally meaningful Cursor tools (`task`, `shell`, `mcp`, `generateImage`, `recordScreen`, `semSearch`, web search/fetch, plan/todo), the provider may surface one low-noise deferred in-progress thinking line such as `Cursor MCP: external_search` from bounded, scrubbed SDK args; fast local tools (`read`, `grep`, `glob`, and similar) skip lifecycle lines when completion follows immediately, and pi bridge MCP calls are excluded because pi already shows real pi tool execution ([lifecycle visibility](./cursor-native-tool-replay.md#low-noise-tool-lifecycle-visibility)). Replay-only tools display recorded Cursor results, normalize workspace-local paths/diff headers for display, use pi diff colors for edit previews and path-inferred syntax highlighting for write previews, and fail closed if called without a recorded result. Native replay wrappers are registered only for tool names not already owned by another extension; conflicting tools use the bounded scrubbed transcript fallback. Cursor workflow tools such as mode/task/todo/plan activity are not pi workflow controls; reported todo/plan events are displayed as Cursor activity only. Plan/todo replay cards can be followed by Cursor's final plan text, selected from `run.wait().result` when Cursor provides one and trimmed against already-emitted text. Started Cursor SDK tool calls that never receive a completion event are surfaced with bounded user-visible labels/traces (neutral activity cards when native replay routing allows, otherwise the same inactive or transcript trace fallbacks used for completed replay) instead of being silently discarded when the run failed/aborted, produced no assistant text, or involved external/side-effectful tools; incomplete fast local discovery starts (`read`, `grep`, `glob`, `ls`) remain maintainer-debug-only after successful text-producing runs so stale SDK start events do not create red post-answer cards. Explicit failures remain visible when Cursor reports them through completed tool calls or step results. Pi bridge MCP starts remain excluded from duplicate incomplete Cursor cards because pi already shows real pi tool execution. `PI_CURSOR_NATIVE_TOOL_DISPLAY=0` disables native replay, and `PI_CURSOR_REGISTER_NATIVE_TOOLS=0` is a registration-only opt-out that keeps the transcript fallback without shadowing pi tool names. When bridge or native replay cards are emitted, the provider mirrors Codex's turn shape as Cursor SDK activity arrives: assistant `toolUse`, pi `toolResult`s, live post-tool Cursor thinking/text, any later tool batches as further `toolUse` turns, then Cursor's final assistant answer. For shell replay, completed `stdout` / `stderr` are primary; unambiguous `shell-output-delta` data is also shown as bounded live progress while one shell call is active and used as display-only fallback for empty successful shell completions, while overlapping shell calls drop ambiguous deltas instead of guessing. Print mode keeps bounded scrubbed transcript output instead, preserving `pi -p` assistant text output. Cursor text deltas stream live when no live-run turn split is active.
- Cursor native replay uses one neutral replay tool name, `cursor`, plus native-compatible card names when renderer-compatible (`read`, `bash`, `grep`, `find`, `ls`, `edit`, `write`). Neutral replay identity lives in `activityTitle`, `activitySummary`, and typed replay details, not in extra registered tool names. Bridge MCP names such as `pi__sem_reindex` are MCP-only; pi session output uses real pi tool names.
- Local Cursor SDK usage events are used when the SDK reports them before the corresponding pi turn is emitted and the reported counts fit the selected pi model window. For each safe local SDK-attributed assistant turn, `usage.input`, `usage.output`, `usage.cacheRead`, and `usage.cacheWrite` come from the latest per-turn raw `turn-ended.usage` (not SDK `toTokenUsage`): observed local runtime keeps `inputTokens` as the full prompt with cache fields as a partition, even though published SDK `TokenUsage.totalTokens` sums all four fields. Pi maps that raw local shape to disjoint components (`input = inputTokens - cacheReadTokens - cacheWriteTokens`) and `usage.totalTokens = inputTokens + outputTokens` for occupancy/compaction only when that total is below the latest compaction `tokensBefore`; otherwise occupancy uses the post-compaction estimate floor. Cloud billed `getUsage()` rows map to spend fields only and never become occupancy. Approximate fallback never reports less occupancy than the last compatible same-model in-window assistant measurement in context. Cumulative `RunResult.usage` is never used for per-message occupancy. If the local SDK reports no usage in time, or reports full-agent-context-sized usage outside the selected model window, the provider falls back to local `input/output` activity estimates while setting `usage.totalTokens` to the current replayable context estimate so footer/compaction context does not collapse after split tool turns; after a split live-run turn times out waiting for SDK usage, later SDK usage for that live run is ignored rather than risk applying stale usage to the wrong pi turn. Cursor SDK cost is unavailable, so cost remains absent/zero. `src/cursor-usage-accounting.ts` owns this policy.
- Audit observation, 2026-05-19, superseded by the 2026-05-21 replay pass and #68 incomplete visibility, then narrowed by the 2026-05-26 fast-local suppression: a missing-file read with Composer 2.5 emitted `tool-call-started` for Cursor `read`, then streamed final text `Error: File not found`, but did not emit `tool-call-completed` or an `onStep` `toolCall` error result. Leftover external/side-effectful started calls are surfaced at run completion through the same native replay routing as completed tools (activity cards when allowed, otherwise inactive/transcript traces), while fast local discovery starts are debug-only after a successful text-producing run. Cursor-reported completed/step errors remain visible.
- Maintainer visual verification for replay-card changes should follow [Cursor Native Tool Visual Audit Workflow](./cursor-native-tool-visual-audit.md): offscreen PTY-driven pi run, xterm.js/Playwright screenshot rendering, and JSONL inspection before accepting commits or PRs.
- Cursor provider/runtime releases must pass the local [Platform Smoke Gate](./platform-smoke.md): `npm run smoke:platform:all`. Cloud-runtime changes must also pass `npm run smoke:cloud`. Use [Cursor Live Smoke Checklist](./cursor-live-smoke-checklist.md) only for focused inner-loop/debug runs with real `pi --approve -e . --cursor-no-fast --model cursor/grok-4.6` invocations, manual observation, temporary session dirs, diagnostics scans, and persisted JSONL inspection. See [Cursor testing lessons](./cursor-testing-lessons.md) for auth.json seeding, isolated smoke harnesses, and replay JSONL scans.
- For models without a catalog `context` parameter, context windows are not hardcoded. The extension ships a bundled SDK-derived default/non-Max cache generated from `createAgentPlatform().checkpointStore.loadLatest(agentId).tokenDetails.maxTokens`. Successful runs can update a local override cache, but model discovery does not probe models at startup.
- Max Mode context windows are distinct from default/non-Max context windows. `@cursor/sdk` 1.0.27 documentation says the SDK may enable Max Mode automatically when a selected model requires it, but the public local-agent `ModelSelection` path still does not expose a manual Max Mode selector. Do not advertise Max Mode context windows unless the SDK catalog exposes an exact parameter/variant or the SDK public API adds a Max Mode selector that the extension actually sends.
- The installed `@cursor/sdk` exposes latest-style `ModelListItem.aliases`. The extension registers only unambiguous aliases as pi model IDs (with the same context suffixes when applicable) and sends the alias back in `ModelSelection.id`. Cursor-only fast preferences are keyed by the selected SDK model ID/alias, with read fallback for older preferences keyed by the underlying catalog `id`. Aliases shared by multiple base models, such as generic family aliases, are skipped because the pi row metadata would otherwise imply one base model while Cursor may resolve the alias to another.
- Local restart resume treats user entries already present at `session_start` or selected by tree navigation as crash-ambiguous: an older SDK handle cannot span them because the prior process may already have submitted that prompt. A user entry appended after startup in the current process may span the last completed handle for the normal next send.
- Persisted pi sessions use a session-scoped Cursor SDK SQLite store at `<getDefaultSdkStateRoot(cwd)>/pi-sessions/<session-hash>/`; create/resume, transcript reads, checkpoint lookup, and exact-ID cleanup all receive that same store. Fileless acquisitions use unique OS-temporary stores that are removed on graceful disposal; invalidation starts a fresh agent instead of reopening a disposed temporary store. Resume entries version the store identity. Legacy entries still resume against the SDK default workspace store, then move to the per-session store after fallback or agent replacement. Removing a persisted pi session does not automatically remove its store directory; only a verified session-derived `pi-sessions/<session-hash>` root may be removed after no pi process uses it. The shared SDK default workspace root recorded by legacy entries must never be removed as session cleanup. Cloud agents are unchanged.
- Session-scoped Cursor SDK agent pooling reuses one live `@cursor/sdk` agent across compatible follow-up turns within the same pi session scope. Independently, each distinct local agent whose `Agent.send()` is initiated is best-effort recorded once per native pi session as a non-resumable `cursor-sdk-agent-lineage` custom entry (including failed/cancelled sends and when local resume is disabled). Cloned/forked sessions record lineage under their own pi session ID; donor entries do not suppress the new session. `planCursorSessionSend()` in `src/cursor-session-send-policy.ts` decides whether the next turn sends a full bootstrap prompt or an incremental follow-up, whether the SDK agent must be recreated, and why. `computeCursorContextFingerprint()` and `shouldBootstrapCursorContext()` remain the context-only bootstrap signal. The pool recreates the agent when context diverges, when branch or compaction summaries appear after `/tree` navigation or compaction, after 20 completed incremental sends, when the API key identity changes, after send errors, on `session_shutdown`, and when `session_before_tree` / `session_tree` invalidate the active branch. Incremental sends omit the full Cursor SDK tool boundary block because the session agent retains prior bootstrap context, but every send ends with a short tool tail guard placed after the latest user request (including an explicit shell `cd` hint). True incremental sends also omit invariant Pi system instructions; system-prompt changes are part of the context fingerprint and force a full context-divergence bootstrap that includes the updated system section.
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

Startup discovery resolves `apiKey` in this order:

1. Stored pi auth for provider `cursor` from `readStoredCredential("cursor")`, accepting only an `api_key` credential.
2. `CURSOR_API_KEY`.

Startup never parses `process.argv`; Pi remains the sole owner of CLI model/provider/key parsing. Provider turns keep Pi's resolved `options.apiKey`. Users can persist the stored key through `/login` -> `Use an API key` -> `Cursor`. If auth is added after startup, fallback models can run once Pi resolves the saved key for provider requests, and `/cursor-refresh-models` asks the command context's ModelRegistry for provider `cursor` and passes that normalized key explicitly to a forced live refresh.

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

Before releases, compare the generated fallback with the authenticated live catalog:

```bash
CURSOR_API_KEY="your-key" npm run check:cursor-snapshots
```

Run this whenever Cursor releases or changes models:

```bash
CURSOR_API_KEY="your-key" npm run refresh:cursor-snapshots -- --write
```

That command refreshes `src/cursor-fallback-models.generated.ts` only. If live local Cursor runs have collected checkpoint-derived context windows, merge them into the bundled default/non-Max snapshot too:

```bash
CURSOR_API_KEY="your-key" npm run refresh:cursor-snapshots -- --write \
  --context-windows ~/.pi/agent/cursor-sdk-context-windows.json
```

Both modes call `Cursor.models.list({ apiKey })` and use the same sanitizer and stable sort. `--check` byte-compares `src/cursor-fallback-models.generated.ts` without writing; `--write` refreshes it and updates `src/bundled-context-windows.ts` only when `--context-windows` is provided. Context-window inputs are limited to current selectable model IDs; redundant default `:fast`/`:slow` aliases collapse to one key, conflicting equivalent selections fail generation, and stale or ambiguous aliases are omitted. Generated provenance and command output record the installed `@cursor/sdk` version and model count. The script prints model IDs/counts only and scrubs known auth material from SDK errors; it must not print or store API keys. Review generated diffs before committing because Cursor can change aliases, defaults, and parameter meanings.

Dated evidence for Cursor's assistant-visible, model-specific system text and reconstructed tool guidance lives in [Cursor System Prompts and Tool Guidance — 2026-08-02](https://github.com/fitchmultz/pi-cursor-sdk/blob/main/docs/evidence/cursor-system-prompts-2026-08-02/README.md). Keep that evidence separate from pi-cursor-sdk's own bootstrap prompt: Cursor persists its base system message in the local SDK checkpoint, while this extension sends Pi context and bridge instructions as user content.

## Design Direction

Use native pi abstractions wherever possible:

| Concern | Representation |
|---|---|
| Cursor base model | pi provider model |
| Cursor `context` | pi-visible model variant because it changes `contextWindow` |
| Cursor `reasoning` | pi native thinking via `thinkingLevelMap` |
| Cursor `effort` | pi native thinking via `thinkingLevelMap` |
| Cursor `thinking=false` | pi native `off` |
| Cursor `fast` | extension state plus `:fast` / `:slow` virtual aliases for per-agent overrides |
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
- Do not encode `reasoning`, `effort`, `thinking`, or Cursor SDK `mode` into pi model IDs. For models with a Cursor `fast` parameter, also register selection-only `:fast` and `:slow` virtual model aliases that do not change pi-native metadata.
- Prefer stable, readable `@<context>` suffixes that do not conflict with pi's final `:<thinking>` suffix parser.
- Sort Cursor models by base ID, then context value in Cursor SDK order before calling `pi.registerProvider()`. Registration order matters for `/model` display and model cycling; `--list-models` sorts output separately.

Recommended context-variant ID format:

```text
cursor/gpt-5.5@1m
cursor/gpt-5.5@272k
cursor/claude-opus-4-8@1m
cursor/claude-opus-4-8@300k
cursor/composer-2-5
cursor/composer-2-5:fast
cursor/composer-2-5:slow
cursor/grok-4.6
cursor/grok-4.6:fast
cursor/grok-4.6:slow
cursor/gpt-5.5@1m:fast
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
- `:fast` / `:slow` are virtual aliases, not separate Cursor SDK base models: they keep the same context/thinking metadata and only force the outgoing Cursor `fast` param. They exist so subagents and workflow-spawned agents can choose fast/slow without mutating shared `/cursor-fast` defaults.

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
| Set local HTTP transport | `/cursor-http on\|off\|toggle` | local Cursor runtime |
| Refresh filesystem Cursor config | `/cursor-refresh-config` | Cursor model selected and an SDK agent may exist |
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
off, minimal, low, medium, high, xhigh, max
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
| `xhigh` | `xhigh`, else `extra-high` |
| `max` | `max` |

Important details:

- Use `null` for unsupported pi levels so pi hides/skips/clamps them natively.
- Include `xhigh` and `max` only when Cursor exposes real values for them.
- Keep `xhigh` and `max` distinct. Cursor exposes both on some models, while `extra-high` remains an `xhigh` alias.
- If Cursor exposes `reasoning=none`, map pi `off` to `none`.
- If Cursor exposes `thinking=false`, map pi `off` to `false`.
- `thinkingLevelMap` does not create Cursor SDK params by itself. It only controls pi-native behavior. The Cursor stream implementation must use the active pi thinking level plus the extension's discovered Cursor metadata to build `ModelSelection.params` for `Agent.create()`.

For boolean-only `thinking`, unsupported pi levels must be explicit `null`; otherwise pi treats omitted non-`xhigh`/`max` levels as supported. Use this shape unless Cursor exposes richer values:

```ts
{
  off: "false",
  minimal: null,
  low: null,
  medium: null,
  high: "true",
  xhigh: null,
  max: null,
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

- Unsuffixed models use extension state from `/cursor-fast`, per-session entries, and global defaults.
- `:fast` / `:slow` virtual model aliases force fast on/off for that selected agent and override saved defaults without writing state.
- Toggle unsuffixed models with `/cursor-fast`; do not persist a new default while a virtual fast alias is selected.
- Store per-session and global per-base-model preferences for unsuffixed models.
- When calling `Agent.create()` or `agent.send()`, include the selected `fast` value in Cursor model params.
- Show fast-capable local models as `cursor:local · fast:on` or `cursor:local · fast:off` through `ctx.ui.setStatus()` while a Cursor model is active; cloud runtime shows `cursor:cloud · fast:n/a`.
- Keep `--cursor-fast` and `--cursor-no-fast` as explicit process-level force flags.

Reason:

- `fast` does not affect pi `contextWindow`, thinking levels, or input support.
- The virtual aliases trade small `--list-models` noise for per-agent selection that works with subagents and dynamic workflows, where mutating a shared global fast default is the wrong abstraction.

Status examples:

```text
cursor:local · fast:off
cursor:local · fast:on
cursor:local · fast:on · http1
```

## Cursor SDK Mode Behavior

Current Cursor SDK exposes SDK-native conversation mode:

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
cursor:local · fast:n/a · plan
cursor:local · fast:off · plan
cursor:local · fast:on · plan
cursor:cloud · fast:n/a · plan
```

## Footer Behavior

Hard requirement:

- Leave pi's default footer intact.
- Do not use `ctx.ui.setFooter()` for the first pass.
- Use `ctx.ui.setStatus()` only while a Cursor model is active, showing Cursor-only state that pi cannot show natively, such as `cursor:local`, `cursor:cloud`, local `fast:on|off|n/a`, enabled local `http1`, and non-default Cursor SDK `plan` mode.
- Non-cursor models must have no Cursor status.

Reason:

- `ctx.ui.setFooter()` replaces the entire built-in footer.
- pi has no public extension API to mutate only the model text in the default footer.
- Reimplementing the default footer would create drift with pi's native footer behavior.

Expected native footer behavior:

- provider/model is shown by pi from the selected `cursor` model,
- thinking level is shown by pi when `reasoning` is true,
- context usage is computed from `contextWindow`,
- extension status adds only Cursor-only text such as `cursor:local · fast:n/a`, `cursor:local · fast:off`, `cursor:local · fast:on · http1`, `cursor:local · fast:on · plan`, or `cursor:cloud · fast:n/a`.

`ctx.ui.setStatus()` adds an extension status line in the default footer. It does not patch the built-in model segment. The native shape is closer to:

```text
...                                      (cursor) gpt-5.5@1m • medium
cursor:local · fast:off · plan
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
- `fast` global default per selected Cursor SDK model ID or alias,
- Cursor SDK `mode` per session,
- local HTTP transport per session and user default,
- any future Cursor-only parameter that does not map to pi model metadata.

Use:

- `pi.appendEntry()` for session state that must survive resume/fork/reload,
- an extension-owned global config file for cross-session defaults,
- in-memory state only as a cache rebuilt from persisted state on `session_start`.

### New Install

Use Cursor default variants:

```text
gpt-5.5 -> cursor/gpt-5.5@1m, thinking medium, fast=false
composer-2.5 -> cursor/composer-2-5, fast=true
grok-4.6 -> cursor/grok-4.6, fast=true
```

### Resume Session

Restore:

- pi model, including context variant,
- pi thinking level,
- session Cursor-only state such as `fast`, Cursor SDK `mode`, and local HTTP transport.

### New Session

Use:

1. pi's selected/default model and thinking level,
2. branch HTTP transport state, then explicit environment, then the user-level HTTP default,
3. global fast defaults for the selected SDK model ID or alias, falling back to older base-model keys,
4. else Cursor default variant params.

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
- `fast` is controlled by saved extension defaults, `:fast` / `:slow` virtual model aliases, or the `--cursor-fast` / `--cursor-no-fast` extension flags.
- Cursor SDK `mode` is controlled by `/cursor-mode` session state or the first-pass `--cursor-mode` extension flag; it is never encoded in `--model`.

For print mode:

- no keybindings,
- use selected context model variant,
- use `--thinking` or `:medium` for reasoning/effort,
- use saved global `fast` defaults unless a virtual `:fast` / `:slow` model alias or force flag is present,
- use Cursor SDK `agent` mode unless `/cursor-mode` session state or `--cursor-mode` overrides it.

Fast flag example:

```bash
pi --model cursor/gpt-5.5@1m --cursor-fast -p "Say ok only"
```

## Discovered Model Capability Examples

These examples document the capability shapes the extension handles, not an exhaustive live catalog. The exact Cursor catalog changes over time; use `pi --approve -e . --list-models cursor` or `Cursor.models.list()` for the current model surface. When the SDK reports aliases, only unambiguous aliases are registered; shared generic aliases are skipped.

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
pi model: cursor/composer-2-5
Cursor params: fast=true
pi thinking: off
Cursor status: cursor:local · fast:on
```

Toggle fast:

```text
Cursor params: fast=false
Cursor status: cursor:local · fast:off
```

`shift+tab`: no-op because the model is not reasoning-capable.

### `gpt-5.5`

Initial Cursor default:

```text
pi model: cursor/gpt-5.5@1m
Cursor params: context=1m; reasoning=medium; fast=false
pi thinking: medium
Cursor status: cursor:local · fast:off
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
Cursor status: cursor:local · fast:on
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
Cursor status: cursor:local · fast:on
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

### `grok-4.5`

Supports `effort=low|medium|high` and `fast=false|true`; it does not advertise context variants.

```text
cursor/grok-4.5
```

Fast toggle maps to the Cursor `fast` parameter.

`shift+tab` maps the available low, medium, and high levels to Cursor `effort`; levels without a catalog value do not invent one.

### `grok-4.6`

Supports `effort=low|medium|high|xhigh` and `fast=false|true`; it does not advertise context variants. The Cursor default variant is `effort=high` and `fast=true`.

```text
cursor/grok-4.6
cursor/grok-4.6:fast
cursor/grok-4.6:slow
```

Fast toggle maps to the Cursor `fast` parameter. `--cursor-no-fast` and `:slow` send `fast=false`.

`shift+tab` maps the available low, medium, high, and xhigh levels to Cursor `effort`; levels without a catalog value do not invent one.

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
   - pi `xhigh` preference order: `xhigh`, then `extra-high`
   - pi `max` maps only to Cursor `max`
   - session restore for Cursor-only state
   - global default state for Cursor-only state
   - unsupported no-op notifications

2. Runtime checks:
   - `pi --list-models cursor`
   - confirm context variants show expected `context` column
   - launch interactive with Cursor
   - verify default pi footer remains unchanged
   - verify Cursor status appears only for Cursor models
   - verify Cursor fast-capable local models show `cursor:local · fast:on` or `cursor:local · fast:off`
   - required `cursor-http1-live` platform lane proves an enabled local HTTP/1.1/SSE turn completes and shows `http1`; unit/default live lanes prove local-disabled and cloud statuses omit it
   - verify Cursor `plan` status appears only in non-default mode and combines with status as `cursor:local · fast:n/a · plan`, `cursor:local · fast:on · plan`, `cursor:local · fast:off · plan`, or `cursor:cloud · fast:n/a · plan`
   - verify non-cursor footer/status unchanged
   - verify `shift+tab` uses pi native thinking
   - verify context changes through native model selection
   - verify resume restores model, thinking, and Cursor-only state

3. Print mode:
   - `pi --model cursor/gpt-5.5@1m:medium -p "Say ok only"`
   - `pi --model cursor/gpt-5.5@272k --thinking xhigh -p "Say ok only"`
   - `pi --model cursor/claude-opus-4-7@1m --thinking max -p "Say ok only"`
   - `pi --model cursor/gpt-5.5@1m --cursor-fast -p "Say ok only"`
   - `pi --model cursor/gpt-5.5@1m --cursor-mode plan -p "Say ok only"`
   - confirm requests use selected context, pi thinking, fast flag state, and SDK-native mode

4. Tool bridge and replay:
   - `npm test -- test/cursor-pi-tool-bridge.test.ts test/cursor-pi-tool-bridge-call-timeout.test.ts test/cursor-provider-bridge-mcp.test.ts test/cursor-live-run-coordinator.test.ts test/cursor-mcp-timeout-override.test.ts`
   - confirm `Agent.create()` gets `mcpServers.pi_tools` when active pi tools exist and omits it when `PI_CURSOR_PI_TOOL_BRIDGE=0` or the active snapshot is empty
   - confirm bridged MCP requests emit real pi tool calls and resolve matching pi tool results back to the same live Cursor SDK run without creating a new `Agent`, unless the run was disposed, aborted, or cancelled
   - confirm bridge MCP activity is suppressed from Cursor replay while non-bridge Cursor MCP activity remains visible
   - confirm `PI_CURSOR_MCP_TOOL_TIMEOUT_MS` and `PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS` override the Cursor SDK MCP callTool timeout seam
   - confirm `PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS` can only lower the bridge deadline; expiry and cancellation clear pending state, abort active pi execution, suppress stale events/empty drain turns, and superseded registration handlers do not block replacement runs
   - confirm `PI_CURSOR_MCP_CONNECT_TIMEOUT_MS` and `PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS` override the Cursor SDK MCP initialize/listTools timeout seam while unknown protocol timeout stacks keep the SDK default
   - confirm `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` emits typed, allowlisted, scrubbed JSONL to `process.stderr` with prefix `[pi-cursor-sdk:bridge]`, omits endpoint URLs/path components/tokens, and unset/false leaves output unchanged
   - run the visual audit workflow when replay card visuals or bridge card visuals change; JSONL should show real pi tool names for bridged calls and no duplicate MCP replay for bridge calls
