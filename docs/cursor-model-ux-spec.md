# Cursor Model UX Spec

> Maintainer note: this is an internal design and behavior spec for pi-cursor-sdk. If you are trying to install or use the extension, start with the main [README](../README.md) instead.

## Status

Implemented design target. This file describes the intended Cursor model UX and should stay aligned with the current code in `src/`.

Current implementation notes:

- Cursor footer status is visible by default. `PI_CURSOR_FOOTER=0` clears the Cursor status on the next status refresh; provider runtime, mode, and transport validation remain active.

- Provider contexts support official Pi 0.87.1/latest and current `fitchmultz/pi` main, including transcript-only hosts. `cursor-pi-context.ts` directly imports Pi 0.87.1's required public replay helpers. Current instructions and tools are replayed natively, system deltas are fingerprinted, and system messages are excluded from Cursor conversation formatting and trailing-result scans. Fresh cloud context preserves current instructions while excluding history. Native replay uses the request tool snapshot (including empty); the pi bridge retains its separate registry-owned surface. XML prompt sections are sanitized/deduplicated alongside the stock format.

- Structured conversation history labels typed tool blocks `Historical tool request/result/error`, preserving arguments, IDs and errors without declaring unmatched requests completed. User/assistant prose and code fences remain unchanged. This removes the extension's literal `Tool call` template, not model-authored narration; no prose-to-tool conversion, stripping or automatic resend is performed (#257).
- Cursor context variants use `base@context` pi model IDs.
- Cursor `reasoning`, `effort`, `reasoning_effort`, and boolean `thinking` parameters are driven by pi native thinking when the Cursor SDK exposes those controls.
- Cursor `fast` is extension state by default; models that expose `fast` also get selection-only `:fast` / `:slow` virtual aliases for per-agent overrides.
- Cursor SDK `mode` (`agent` or `plan`) is extension session state, not model identity, pi thinking, Cursor `fast`, or pi's separate plan-mode extension.
- Cursor status uses one coordinated `ctx.ui.setStatus("cursor", ...)` value for fast, non-default plan mode, and the local-only `http1` transport marker; the default pi footer remains intact.
- Installed `@cursor/sdk` user messages accept images, and Cursor models are treated as image-capable; registered input metadata is `text` plus `image`.
- Native request receipts retain canonical source-role/order scalars from public `SessionManager.buildSessionProjection()` and `convertToLlm()`, not prompt text. Only exact equivalence with the actual provider request enables native input selection. Hidden `display:false` notices remain model-visible background context, never genuine user submissions. Pending native input travels together in bootstrap/incremental prompts and remains required under transcript budgeting. Custom-only continuation has no new user request or attachment; historical bootstrap requests are explicitly history. Cloud fresh prompts select the same pending input group without previous requests; bootstrap handoff preserves history with the same native-origin selection. Origin means the persisted native source, not a role-only rewrite yielding identical LLM content. If request-local transforms change payload/order (including blocked-image conversion), origin is unavailable: preserve conservative last-converted-user/reset behavior rather than guessing. This is not universal final-preconversion provenance.
- Image payload forwarding for request-equivalent native inputs sends images only from the latest pending native user message, even with trailing custom notices. Other/unmatched contexts retain last-converted-user selection. If the latest user turn is plain text after an earlier image turn, the transcript keeps an `[image omitted from transcript]` placeholder but no image bytes are sent to Cursor. The prompt explicitly tells Cursor that prior image bytes are unavailable and to ask the user to reattach or describe a prior image when needed. Carrying images forward across turns remains a future product decision because it affects token cost, privacy, stale visual context, and expected multimodal follow-up behavior.
- Shared SDK initialization resolves the native platform package relative to `@cursor/sdk` before import and sets `CURSOR_TREE_SITTER_VENDOR_DIR` only when unset and both vendored parser entrypoints exist. Explicit overrides remain SDK-owned. This repairs sibling-install native lookup. Static SDK and bridge imports additionally repair the compiled-Bun extension graph; the packed extension was qualified in official compiled Pi 1.0.3 on macOS arm64 with isolated empty credentials and a fake key. Embedded Windows missing-export behavior remains unqualified.
- The selected vendor path is process-wide and inherited by shell commands and child Pi processes. A child using another install/worktree preserves the inherited value as an explicit override, even when stale. Unset it in the child's environment to rediscover that install's parser, or provide its absolute vendor path; see [native parser troubleshooting](../README.md#native-shell-parsing-or-module-loading-fails).
- Provider and discovery errors retain bounded, scrubbed name/code/message/cause fields without serializing arbitrary error objects. Module-loading and ambiguous session-authentication failures do not imply a rejected API key. Explicit key rejection retains actionable setup guidance; no automatic reload or authentication recovery is performed.
- Exact `@cursor/sdk@1.0.37` is an unbundled package dependency; users do not need a global SDK install. Package 0.5.2 requires Node 24+ and official Pi 0.87.1+, while optional published Pi and TypeBox peer dependencies use `"*"` ranges per Pi guidance. Direct development Pi dependencies and their lockfile-resolved transitives are 1.0.4; nested host TypeBox remains 1.3.27; the extension's root TypeBox validation baseline is 1.3.36.
- Native usage contains coherent current-context components only. The origin-owned ledger records every raw turn, original wait/handle snapshots, terminal success/error/abort/abandon, and bounded public whole-agent `getUsage()` observations separately. Cumulative bills never enter native usage. Request floors use actual native source chronology and projection equivalence, not text or clocks; see [Context and accounting boundaries](#context-and-accounting-boundaries).
- Cursor owns one public native Provider with native API-key login and a small resolver for stored/provider-env, runtime, composed config, and ambient credentials. Startup and auth mutations are cache-only, retaining known cached/fallback identities. `PI_CURSOR_HIDE_MODELS_WHEN_LOGGED_OUT=1` hides only unauthenticated picker/list availability, not CLI selection or login. Discovery receives explicit effective native auth and never guesses a default auth store. `/cursor-refresh-models` uses native registry refresh/publication. Provider turns keep Pi's resolved `options.apiKey`; non-secret Cursor-only settings remain separate.
- Cursor Cloud repository overrides accept only HTTPS repository URLs without userinfo, query parameters, or fragments. Invalid values fail during preflight before `Agent.create()`, messages never echo the supplied URL, and shared provider/maintainer scrubbing removes URL/SCP-style userinfo defensively.
- Cursor Cloud requires a persisted pi session. Immediately after remote `Agent.create()` returns, before debug work or abort checks, the provider appends a branch-local pi lifecycle entry, fsyncs the existing Pi session JSONL anchor through a read-write descriptor, and then fsyncs a newline-framed sidecar keyed by the stable pi session ID (POSIX mode `0600`; Windows inherits the user session directory ACL) in the session directory. Journal creation is exclusive, and existing append/read opens reject symlinks and require matching regular-file descriptor/path identity before using the descriptor. Existing session files use the exact lifecycle entry ID as anchor; fileless first turns use an orphan marker that a same-session-ID restart durably claims onto exactly one matching or replacement branch, surviving the timestamped path change and later JSONL creation without granting sibling access; returned run IDs are fsynced before abort/wait handling, readers skip malformed/truncated lines independently, and branch-only history events are reduced after deduplicated sidecar history, and tombstones are tracked before records exist. A durable sidecar result remains authoritative if its optional Pi mirror append fails; if the sidecar result itself fails, the prior durable intent remains pending and blocks retry rather than claiming success. `--no-session` and durable-ledger failures fail closed before send, while post-send ledger failure requests bounded cancellation. `/cursor-cloud` always validates the embedded session ID, accepts only null anchors while truly fileless, and reconciles each orphan to one branch before listing or mutation. Successive record events merge run/branch metadata monotonically even when mirrored sources arrive out of order. Archive/delete require resolved Cursor auth, fsync a durable intent before the SDK call, and fsync a durable success result afterward; unresolved intent blocks repeat mutation and requires dashboard inspection.
- Local agents pass `settingSources: ["all"]` by default so Cursor MCP servers, plugin tools, project/user settings, and related Cursor-native capabilities are available. Users can narrow loading with a comma-separated list such as `PI_CURSOR_SETTING_SOURCES=project,user,plugins`, or disable ambient setting sources with `PI_CURSOR_SETTING_SOURCES=none`. `/cursor-refresh-config` calls the current pooled SDK agent's `agent.reload()` to refresh filesystem Cursor config without recreating the agent. The shared process sink filters complete, verified timestamp/INFO inventory and completion frames plus exact supported hook-compatibility notices, including pre-bound SDK console output during first send and unresolved live SDK completion across Pi bridge/replay turns. The same lease restores on completion/cancellation cleanup, not when a Pi tool-use stream ends. A new write invocation starts a frame after unrelated partial output has forwarded, so an unterminated native Pi footer/prompt does not admit the following SDK diagnostic. stdout/stderr framing is independent; outside the retained creation-only mute around `Agent.create()`, unrecognized output retains its original bytes, callbacks and delegated backpressure. Only possible diagnostic prefixes buffer (up to 16 KiB); undecided tails flush on final restoration and oversized candidates pass through. Outside-root local-plugin symlink rejection and the exact native-parser-unavailable warning escape the creation mute and route through the request's async owner to a bounded native notification (stderr in non-UI modes) and a `pi-cursor-sdk:capability-notice` non-model session entry, at most once per kind per request. Notices contain fixed recovery guidance, not raw paths or arbitrary SDK metadata. Unowned maintainer scripts retain these meaningful diagnostics. Outside the creation mute, real plugin/hook/config/parser/ripgrep failures stay visible; the plugin confinement guard, settings sources and native parser setup are unchanged. Text alone cannot distinguish an unrelated emitter printing an identical complete SDK frame; strict attribution requires a future public SDK logger/sink API.
- On `cursor/*` models, pi-cursor-sdk removes only pi-generated `<project_instructions>` blocks that overlap the effective Cursor `settingSources`: `user` for `~/.pi/agent/AGENTS.md`; `project` for discovered repo/parent `AGENTS.md` and `CLAUDE.md` (verified Cursor behavior: local agents load project `AGENTS.md` and `CLAUDE.md`). `~/.pi/agent/CLAUDE.md` is not removed (Cursor user layer uses `~/.claude/CLAUDE.md`). Blocks are removed by exact pi serialization match from structured `contextFiles` via the `before_agent_start` hook, not in `buildCursorPrompt` sanitization. Suppression is skipped with `-nc`, `PI_CURSOR_SETTING_SOURCES=none`, narrowed sources such as `plugins` that omit the matching layer, or `PI_CURSOR_PRESERVE_PI_AGENTS_MD=1`. Switching away from a Cursor model restores pi's full context block on the next user message.
- Cursor SDK models are treated as thinking-capable even when pi reports `thinking=no`; that pi column only means the SDK did not expose a pi-controllable thinking parameter for that model.
- Cursor-side thinking remains visible through pi's native thinking rendering when the Cursor SDK emits thinking or summary deltas.
- Local Cursor agents get two tool surfaces. First, Cursor keeps the Cursor SDK local-agent tool surface plus configured Cursor settings, plugins, and Cursor MCP servers. Second, pi-cursor-sdk exposes active pi tools through a default-on, tokenized loopback stable MCP v2 bridge when bridgeable tools exist. The bundled bridge runtime closure is `@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/hono@2.0.2`, `hono@4.13.13`, and `@hono/node-server@2.1.3`; it binds loopback and validates Hono `Host` and `Origin` headers.
- `buildCursorPiToolBridgeSnapshot()` is the runtime capability source for pi bridge tools. It snapshots `pi.getActiveTools()` and `pi.getAllTools()`, carries pi 0.77+ per-tool `promptGuidelines` into bridge MCP descriptions, filters internal replay names, hides overlapping built-in pi tools (`read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`) unless `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1`, and creates collision-safe MCP names such as `pi__sem_reindex`. Cursor discovers the current run's exposed bridge tools through MCP `listTools`. Bootstrap prompts include a compact callable-surface manifest from `buildCursorToolManifestText()` by default (`PI_CURSOR_TOOL_MANIFEST=1`); disable with `PI_CURSOR_TOOL_MANIFEST=0`. There is no per-turn visible tool list, status manifest, or footer manifest. User-facing summary: [Cursor tool surfaces in pi](./cursor-tool-surfaces.md).
- Prompt text is the primary provider/bridge contract. Bootstrap prompts carry a short boundary block plus the callable-surface manifest by default (`PI_CURSOR_TOOL_MANIFEST=1`). MCP `listTools` descriptions use a one-line pointer to the bootstrap prompt instead of repeating the full contract (`buildCursorPiBridgeMcpToolDescription()`). Cursor must call the exposed `pi__*` MCP name, not the real pi tool name shown in pi history or transcripts. When exposed, `pi__mcp` takes preference over Cursor-configured MCP for MCP work and `pi__subagent` takes preference over Cursor-native subagents for delegation; the Cursor-native surfaces remain fallbacks when the matching pi bridge tool is absent or unavailable. Pi emits and executes the real pi tool name. Maintainer debug: `/cursor-tools` prints bridge/manifest enablement, effective `PI_CURSOR_SETTING_SOURCES`, and current-registry exposure eligibility with builtin filtering, not a live-run surface or health check. The shared prompt tail retains GitHub issue/PR comment guidance on both bootstrap and incremental sends; this is model guidance, not an execution permission guard.
- The provider also registers `cursor_ask_question` for Cursor models when the bridge is on and `PI_CURSOR_ASK_QUESTION=1`. While the tool awaits pi UI input it emits package event `pi-cursor-sdk:ask-question:blocked` with `{ active: true }` and clears `{ active: false }` in `finally`; the tool runs with `executionMode: "sequential"` so parallel sibling calls cannot overlap dialogs. Cursor sees it as `pi__cursor_ask_question`, and pi executes it through the normal tool path. The control is off by default so Cursor states an assumption instead of prompting. In non-UI modes it reports that UI is unavailable so Cursor can state a default assumption instead. When pi has visible Agent Skills loaded, the provider rewrites the skill catalog for Cursor and registers `cursor_activate_skill` as `pi__cursor_activate_skill`; pi executes it through the normal tool path so Cursor can load the full `SKILL.md` and skill resource list for the current pi-loaded skill source of truth. `PI_CURSOR_PI_TOOL_BRIDGE=0` disables the local bridge, including question and skill activation bridging. Cloud Cursor agents remain out of scope for the bridge.
- The bridge queues MCP calls, emits provider `toolcall_*` events, waits for matching pi `toolResult` messages by `toolCallId`, resolves the result back into the same live Cursor SDK run without creating a new `Agent`, and never calls tool `execute()` handlers directly. The same-run resume invariant holds unless the run was disposed, aborted, or cancelled.
- Pending pi bridge calls keep their owning local Cursor live run active, including queued/emitted calls and pi execution awaiting human input. The last matching settlement restarts the full idle interval (five minutes by default) after the provider drain lease ends, including when cleanup was armed before the lease. Lease/queue/pending state is rechecked at expiry, and the per-run observer is detached on release/replacement. A pending call in another session does not delay cleanup. Explicit abort/shutdown/reset/compaction and the fail-closed MCP/bridge deadline (one hour by default) remain effective; display-only native replay abandonment is unchanged.

- Eligible local replay idle cleanup uses `PI_CURSOR_LIVE_RUN_IDLE_DISPOSE_MS`, default `300000` (five minutes). Accept only decimal digits representing `1`–`2147483647`; unset, blank, malformed (including surrounding whitespace), or out-of-range input uses the default. The existing explicit testing override takes precedence; reset returns to environment/default selection. Each timer arm selects the duration, and the full configured window starts after the last owned pending call settles and the provider drain lease ends. Bridge/MCP deadlines and explicit abort/shutdown release remain independent; this is not backend authentication, transport, or lost-executor recovery.

- Cursor SDK MCP tool calls use a guarded timeout override because `@cursor/sdk` 1.0.37 retains a 60-second MCP request default with no public per-server timeout option. The extension extends the verified Cursor SDK MCP `callTool` timeout path to 3600 seconds by default and shortens the verified first-send MCP initialize/listTools timeout paths to 10 seconds by default so unavailable configured MCP servers do not block the first reply for a full minute; unknown MCP protocol timeout stacks keep the SDK default. Users can override tool-call timeouts with `PI_CURSOR_MCP_TOOL_TIMEOUT_MS` or `PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS`, and initialize/listTools timeouts with `PI_CURSOR_MCP_CONNECT_TIMEOUT_MS` or `PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS`. Bridged `CallTool` waits also have a local fail-closed deadline that defaults to and cannot exceed the effective MCP tool timeout; `PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS` can lower it, expiry or MCP cancellation aborts active pi execution when available, and expired bridge events are dropped before pi tool emission.
- Cursor SDK local safety controls are off by default. `--cursor-auto-review` / `PI_CURSOR_AUTO_REVIEW` and `--cursor-sandbox` / `PI_CURSOR_SANDBOX` pass only explicit enabled values into `Agent.create({ local })`; user or trusted project config can set `local.autoReview` and `local.sandboxOptions.enabled`; project config is active only when Pi's project-trust flow reached the extension and approved the project or the run used explicit `--approve`, and project saves require the same immutable trust provenance rather than creating Pi trust resources automatically. Pi loads `pi install -l` project-local extensions after the trust event, so those installs require `--approve` on every run that reads or writes `.pi/cursor-sdk.json`. Explicit runtime, fast-default, and HTTP transport saves preserve unrecognized config fields, reject malformed or non-object JSON without rewriting it, and use one lock-protected read-modify-write path; fast saves mutate only the selected model key. Because Pi can mutate its in-memory session branch before a journal append throws, a completed global save is authoritative and the command reports the partial journal failure instead of attempting an ambiguous rollback; the new global value stays authoritative over stale branch entries until a later successful save or session restart.
- Local HTTP/1.1/SSE compatibility is strictly opt-in through `PI_CURSOR_HTTP_1_1`, `/cursor-http on|off|toggle`, or user `cursor-sdk.json` `local.useHttp1ForAgent`. Precedence is session, environment, user, then the built-in unset default; project config is excluded. Unset makes no `Cursor.configure()` call. Explicit values configure the installed SDK before local `Agent.create()`, extension-owned explicit state is cleared with the SDK's documented `null` reset when returning to unset and during session shutdown before module reload, and default/HTTP2/HTTP1 choices split pooled local agents. Pi's supported CLI/TUI/print/RPC lifecycle has one active session runtime per process; concurrent independent `AgentSession` embedding in one process is outside this transport toggle's contract because the installed SDK setting and executor cache are module-global. The footer adds `http1` only for enabled local runtime; cloud creation and status remain untouched.
- Bridge diagnostics are opt-in only: `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` writes typed, allowlisted, scrubbed single-line JSONL records to `process.stderr` with prefix `[pi-cursor-sdk:bridge]`. Diagnostics are scrubbed operational logs, not anonymous telemetry. They intentionally include tool names, safe correlation IDs, run lifecycle, exposed pi↔MCP name pairs, queued requests, result resolution, rejection, cancellation, and pending counts. Correlation IDs are generated independently from the tokenized endpoint path, and Cursor MCP call IDs are hashed before serialization. Diagnostics must not include endpoint paths/URLs/path components/tokens, API keys, bearer tokens, cookies, session credentials, raw args/results, stdout/stderr payloads, file contents, Cursor settings output, or local private session paths in tracked docs, and they must not call pi UI status, notification, or footer APIs. If tool names themselves are unacceptable for a release target, bridge debug diagnostics are not safe for shared logs under the current contract. Provider-facing bridge tool-call IDs use the run UUID without separators in the `cursor-pi-bridge-<32 hex>-t<counter>` shape and are capped at 64 characters; bridge run IDs and tool-call IDs remain distinct.
- Bridge `mcp_initialized` diagnostics record the installed MCP server's validated `notifications/initialized` callback; `mcp_tools_list` records catalog-handler output and `toolCount` after request validation. Both use only the safe run ID and existing opt-in sinks. These are server observations, not SDK/client identity, response delivery, model consumption or ongoing health. No connection cache or readiness gate is inferred. Exposure and receipt absence cannot diagnose the original Windows/two-provider #206 failure; see [bridge troubleshooting](./cursor-tool-surfaces.md#diagnosing-advertised-but-unused-bridge-tools).
- SDK 1.0.37 source retains the Shell hook pipeline that can apply `updated_input.command`. The retained SDK 1.0.36 private-lexical/permissive-approval canary executed the rewritten command with and without native parsing; it is not executed SDK 1.0.37 proof. This is not full Pi/rtk or policy-enforcement qualification (#173). The parser-unavailable warning returns `parsingFailed` and does not itself explain the non-Cursor/opencode SIGTERM report (#339). Attribution options for both commit and PR remain absent from SDK 1.0.37's public contract (#302). See [testing evidence boundaries](./cursor-testing-lessons.md#installed-sdk-vs-native-host-evidence).
- This repo does not provide a generic desktop-automation, browser-driver, or CDP recipe. Provider docs should describe pi-cursor-sdk's Cursor provider/bridge contract only.
- SDK 1.0.37 adds public `computerUse` output, handled by the existing bounded generic **Cursor computerUse** activity/summary fallback. There is no dedicated action/screenshot presentation or new public local execution option; see the [canonical replay matrix](./cursor-native-tool-replay.md#sdk-tooltype-replay-matrix).
- Cursor internal tool activity is recorded from SDK events and scrubbed. Maintainer reference for `@cursor/sdk@1.0.37` `ToolType` values, runtime alias normalization, and intentional mapping/fallback rules: [Cursor native tool replay — SDK ToolType replay matrix](./cursor-native-tool-replay.md#sdk-tooltype-replay-matrix) (official SDK docs: https://cursor.com/docs/sdk/typescript). In TUI sessions and structured JSON/RPC modes, supported completed `read`, `bash`, `grep`, `find`, `ls`, `edit`, `write`, diagnostics, delete, todo/plan, task, image generation, MCP, semantic search, and screen recording activity is replayed through pi's native tool-call rendering path with recorded Cursor results, so users and JSON/RPC consumers can see native-looking cards/events without rerunning Cursor's reads/shell commands/file edits. Cursor `glob` activity is replayed through native `find` cards. Cursor write activity is replayed through native-looking `write` cards, and Cursor StrReplace/edit activity uses native-looking `edit` only when recorded arguments truthfully satisfy pi's `edit` schema; path-only Cursor edit and notebook edit replay falls back to neutral Cursor activity before pi validation. Diagnostics, delete, todos/plans, task/subagent, image, and MCP activity use neutral Cursor activity cards with pi's default success/error shell. Cursor SDK `task` activity is labeled **Cursor subagent** by default because it represents Cursor-spawned child-agent work; the card summary includes description plus subagent kind/model/short ID when Cursor reports them, and `PI_CURSOR_TASK_PRESENTATION=task` restores the older **Cursor task** wording for comparison. This is visibility over Cursor SDK task events, not a native pi subagent session: pi shows start/final output plus any `conversationSteps` tool-call summaries Cursor returns, but cannot show a live nested read/shell/MCP trail when the SDK only returns final subagent text. Neutral Cursor activity calls include `activityTitle` and, when available, `activitySummary` so partial/collapsed cards preserve identity such as `Cursor plan`, `Cursor todos`, `Cursor subagent`, `Cursor MCP`, or `Cursor edit`. For long-running or externally meaningful Cursor tools (`task`, `shell`, `mcp`, `generateImage`, `recordScreen`, `semSearch`, web search/fetch, plan/todo), the provider may surface one low-noise deferred in-progress thinking line such as `Cursor MCP: external_search` from bounded, scrubbed SDK args; fast local tools (`read`, `grep`, `glob`, and similar) skip lifecycle lines when completion follows immediately, and pi bridge MCP calls are excluded because pi already shows real pi tool execution ([lifecycle visibility](./cursor-native-tool-replay.md#low-noise-tool-lifecycle-visibility)). Replay-only tools display recorded Cursor results, normalize workspace-local paths/diff headers for display, use pi diff colors for edit previews and path-inferred syntax highlighting for write previews, and fail closed if called without a recorded result. Native replay wrappers are registered only for tool names not already owned by another extension; conflicting tools use the bounded scrubbed transcript fallback. Cursor workflow tools such as mode/task/todo/plan activity are not pi workflow controls; reported todo/plan events are displayed as Cursor activity only. Plan/todo replay cards can be followed by Cursor's final plan text, selected from `run.wait().result` when Cursor provides one and trimmed against already-emitted text. Started Cursor SDK tool calls that never receive a completion event are surfaced with bounded user-visible labels/traces (neutral activity cards when native replay routing allows, otherwise the same inactive or transcript trace fallbacks used for completed replay) instead of being silently discarded when the run failed/aborted, produced no assistant text, or involved external/side-effectful tools; incomplete fast local discovery starts (`read`, `grep`, `glob`, `ls`) remain maintainer-debug-only after successful text-producing runs so stale SDK start events do not create red post-answer cards. Explicit failures remain visible when Cursor reports them through completed tool calls or step results. Pi bridge MCP starts remain excluded from duplicate incomplete Cursor cards because pi already shows real pi tool execution. `PI_CURSOR_NATIVE_TOOL_DISPLAY=0` disables native replay, and `PI_CURSOR_REGISTER_NATIVE_TOOLS=0` is a registration-only opt-out that keeps the transcript fallback without shadowing pi tool names. When bridge or native replay cards are emitted, the provider mirrors Codex's turn shape as Cursor SDK activity arrives: assistant `toolUse`, pi `toolResult`s, live post-tool Cursor thinking/text, any later tool batches as further `toolUse` turns, then Cursor's final assistant answer. For shell replay, completed `stdout` / `stderr` are primary; unambiguous `shell-output-delta` data is also shown as bounded live progress while one shell call is active and used as display-only fallback for empty successful shell completions, while overlapping shell calls drop ambiguous deltas instead of guessing. Print mode keeps bounded scrubbed transcript output instead, preserving `pi -p` assistant text output. Cursor text deltas stream live when no live-run turn split is active.
- Shell correlation prefers exact IDs and otherwise requires a unique pending shell with identical arguments, accepting legacy aliases as compatibility inputs. SDK 1.0.37's public shell ToolCall uses `type: "shell"`; retained SDK 1.0.36 installed-accumulator evidence shows the completed ToolCall in an ID-less `onStep` before the completed delta. Those offline contracts verify that producer shape and provider deduplication, not an observed alias-changing service pair or resolution of the reported stale-shell symptom. See [shell correlation evidence](./cursor-native-tool-replay.md#shell-correlation-and-evidence).
- Cursor native replay uses one neutral replay tool name, `cursor`, plus native-compatible card names when renderer-compatible (`read`, `bash`, `grep`, `find`, `ls`, `edit`, `write`). Neutral replay identity lives in `activityTitle`, `activitySummary`, and typed replay details, not in extra registered tool names. Bridge MCP names such as `pi__sem_reindex` are MCP-only; pi session output uses real pi tool names.
- In-time safe LOCAL raw `turn-ended.usage` maps full-prompt input into disjoint native components (`input = inputTokens - cacheReadTokens - cacheWriteTokens`), retaining caches and output; their sum equals `totalTokens = inputTokens + outputTokens`. Fresh usage supersedes historical floors. Fallback components describe the same estimated current context as total. Late SDK data never overwrites an emitted pi message, but raw events remain ledger facts independent of replay/display gating. `RunResult.usage`, Cloud raw data, and billed snapshots never become per-message occupancy. `src/cursor-usage-accounting.ts` owns native mapping; `src/cursor-usage-ledger.ts` owns durable telemetry.
- Discovery registers zero cost rates. `models.json` configured per-million rates and tiers use native `calculateCost(model, partial.usage)` on each emitted message's coherent context components. Fallback has no inferred cache split, and split-message estimates are not internal request pricing. Public billed usage already has disjoint uncached input/cache/output categories; it is not normalized like raw LOCAL full-prompt input. Optional `cost.rawCostCents` and `cost.chargedCents` remain separate, revisable floating-point-cent observations, never substituted for configured native costs.
- Audit observation, 2026-05-19, superseded by the 2026-05-21 replay pass and #68 incomplete visibility, then narrowed by the 2026-05-26 fast-local suppression: a missing-file read with Composer 2.5 emitted `tool-call-started` for Cursor `read`, then streamed final text `Error: File not found`, but did not emit `tool-call-completed` or an `onStep` `toolCall` error result. Leftover external/side-effectful started calls are surfaced at run completion through the same native replay routing as completed tools (activity cards when allowed, otherwise inactive/transcript traces), while fast local discovery starts are debug-only after a successful text-producing run. Cursor-reported completed/step errors remain visible.
- Maintainer visual verification for replay-card changes should follow [Cursor Native Tool Visual Audit Workflow](./cursor-native-tool-visual-audit.md): offscreen PTY-driven pi run, xterm.js/Playwright screenshot rendering, and JSONL inspection before accepting commits or PRs.
- Verification is offline/faux first, including cross-platform CI and native contracts. Reuse exact-input retained evidence. Only changed behavior that needs new real-service proof warrants the smallest meaningful live check on one representative environment; docs/metadata-only changes need no paid runs. No full paid campaign replay, matrix-only host coverage, or automatic paid retries. `npm run smoke:platform:all` is an optional comprehensive matrix, not an unconditional commit/release gate. No paid Cursor Cloud testing for generic PRs/releases; only explicitly Cursor Cloud-focused PRs/issues may select a necessary focused Cloud check, retaining run/evidence and cleanup contracts. Automated Cursor PR reviews, offline Cloud contracts, and Cloud product capabilities remain unchanged. See [Platform Smoke](./platform-smoke.md), [Cursor Live Smoke Checklist](./cursor-live-smoke-checklist.md), and [Cursor testing lessons](./cursor-testing-lessons.md).
- For models without a catalog `context` parameter, context windows are not hardcoded. The extension ships a bundled SDK-derived default/non-Max cache generated from `createAgentPlatform().checkpointStore.loadLatest(agentId).tokenDetails.maxTokens`. Successful runs can update a local override cache, but model discovery does not probe models at startup.
- Max Mode context windows are distinct from default/non-Max context windows. [SDK documentation](https://cursor.com/docs/sdk/typescript) says that on legacy request-based plans Cursor enables Max Mode automatically when a selected model requires it, but the public local-agent `ModelSelection` path still does not expose a manual Max Mode selector. Do not advertise Max Mode context windows unless the SDK catalog exposes an exact parameter/variant or the SDK public API adds a Max Mode selector that the extension actually sends.
- The installed `@cursor/sdk` exposes latest-style `ModelListItem.aliases`. The extension registers only unambiguous aliases as pi model IDs (with the same context suffixes when applicable) and sends the alias back in `ModelSelection.id`. Cursor-only fast preferences are keyed by the selected SDK model ID/alias, with read fallback for older preferences keyed by the underlying catalog `id`. Aliases shared by multiple base models, such as generic family aliases, are skipped because the pi row metadata would otherwise imply one base model while Cursor may resolve the alias to another.
- Local restart resume treats user entries already present at `session_start` or selected by tree navigation as crash-ambiguous: an older SDK handle cannot span them because the prior process may already have submitted that prompt. A user entry appended after startup in the current process may span the last completed handle for the normal next send.
- Persisted pi sessions use a session-scoped Cursor SDK SQLite store at `<getDefaultSdkStateRoot(cwd)>/pi-sessions/<session-hash>/` by default (see [custom roots](#local-store-migration-and-ownership)); create/resume, transcript reads, checkpoint lookup, and exact-ID cleanup all receive that same store. Fileless acquisitions use unique OS-temporary stores that are removed on graceful disposal; invalidation starts a fresh agent instead of reopening a disposed temporary store. Resume entries version the store identity. With default storage selected, legacy entries still resume against the SDK default workspace store, then move to the per-session store after fallback or agent replacement. Removing a persisted pi session does not automatically remove its store directory; only a verified session-derived `pi-sessions/<session-hash>` root may be removed after no pi process uses it. The shared SDK default workspace root recorded by legacy entries must never be removed as session cleanup. Cloud agents are unchanged.
- Session-scoped Cursor SDK agent pooling reuses one live `@cursor/sdk` agent across compatible follow-up turns within the same pi session scope. Independently, each distinct local agent whose `Agent.send()` is initiated is best-effort recorded once per native pi session as a non-resumable `cursor-sdk-agent-lineage` custom entry (including failed/cancelled sends and when local resume is disabled). Cloned/forked sessions record lineage under their own pi session ID; donor entries do not suppress the new session. `planCursorSessionSend()` in `src/cursor-session-send-policy.ts` decides whether the next turn sends a full bootstrap prompt or an incremental follow-up, whether the SDK agent must be recreated, and why. `computeCursorContextFingerprint()` and `shouldBootstrapCursorContext()` remain the context-only bootstrap signal. The pool recreates the agent when context diverges, when unmatched requests append model-visible input that cannot fit the conservative single-user incremental prompt, when branch or compaction summaries appear after `/tree` navigation or compaction, after 20 completed incremental sends, when the API key identity changes, after send errors, on `session_shutdown`, and when `session_before_tree` / `session_tree` invalidate the active branch. Pi's `!!` shell output remains excluded from model context, so an ordinary follow-up after `!!` stays incremental. Incremental sends omit the full Cursor SDK tool boundary block because the session agent retains prior bootstrap context, but every send ends with a short tool tail guard placed after the latest user request (including an explicit shell `cd` hint). True incremental sends also omit invariant Pi system instructions; system-prompt changes are part of the context fingerprint and force a full context-divergence bootstrap that includes the updated system section.
- Pi steering/follow-up delivery can arrive while a split live Cursor SDK run is still active. The provider resolves only the captured session scope's indexed live run against trailing `toolResult` messages while skipping trailing `user` messages, ignores inherited foreign-run IDs without scanning sibling runs, and resumes its own in-flight run instead of calling `Agent.send()` again. When the context ends with steering user text after tool results, the provider releases the prior live run and chains an incremental `Agent.send()` for the latest user message in the same provider turn; if the prior run emits more text or tool requests after steering arrives, that stale activity is cancelled instead of surfacing another old-run tool turn and losing the new user input. A pre-send guard waits for or resumes any still-active scoped live run before starting a fresh send so `@cursor/sdk` `AgentBusyError` (`already has active run`) does not surface to pi users. Pooled session agents mark busy as soon as live/direct `run.wait()` tracking starts (`trackRunCompletion` on the session lease), and `acquireSessionCursorAgent()` awaits that busy state before returning a lease so send planning, transcript offsets, and later `Agent.send()` do not race the prior turn's SDK run completion (for example pi auto-compaction summarization). `session_before_compact` calls `prepareCursorSessionForCompaction()` to release scoped live-run drain state and reset the pooled agent before summarization streams. Tracked completions and send commits are scoped to the pooled agent `instanceId` so disposal/replacement drops stale tracking and ignores late commits from disposed agents.

## Goal

Make Cursor models feel native in pi by leaning on pi's existing model, thinking, footer, and session behavior instead of building a parallel Cursor parameter system.

Main outcomes:

- `pi --list-models` shows pi-native Cursor models with accurate `contextWindow`, pi-controllable thinking metadata, and conservative defaults where the Cursor SDK does not expose limits or capabilities.
- `shift+tab` is pi's native thinking control and drives Cursor `reasoning`, `effort`, `reasoning_effort`, or `thinking`.
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

Startup registers a known cached/fallback baseline without catalog/network calls. The SDK remains in the static extension graph for compiled-Bun loading; cache-only does not promise zero SDK module evaluation. Native cache-only refresh follows real login/logout/rotation/runtime-key mutations; the genuine extension context supplies composed config auth once bound. There is no polling, replayed auth lifecycle event, or independent CLI parser.

Known host limitation: official Pi 1.0.4 has a demonstrated startup refresh-admission race that can temporarily leave fallback models and an incorrect missing-key warning despite a matching authenticated cache. The shared-owner repair is merged in `fitchmultz/pi` via [#190](https://github.com/fitchmultz/pi/pull/190); this is not an official-host fix. See [#337](https://github.com/fitchmultz/pi-cursor-sdk/pull/337). It is separate from Cursor service authentication failures and the compiled-loader repair.

Effective auth follows native precedence: runtime override, stored API-key credential (key then provider-scoped `env.CURSOR_API_KEY` then ambient), composed `models.json` key when no stored credential exists, then ambient `CURSOR_API_KEY`. Placeholder normalization does not shadow composed config. An unsupported stored credential type remains unconfigured. Native logout removes both stored credentials and the runtime override; surviving env/config auth prevents false orphan-cache deletion. Same-process environment/config changes are picked up by native registry refresh, not a watcher.

`PI_CURSOR_HIDE_MODELS_WHEN_LOGGED_OUT=1` is opt-in and affects `getAvailable` (picker/list) only. `getModels` retains known fallback/cached identities so native CLI selection can happen before `--api-key` is applied. The default no-auth fallback availability policy remains unchanged; it does not imply a usable Cursor key.

`/cursor-refresh-models` calls `ctx.modelRegistry.refresh({ providers: ["cursor"], allowNetwork: true, force: true, signal: ctx.signal })`. Cache-only phases never call the catalog or network, even when forced. Network-allowed discovery calls `Cursor.models.list({ apiKey })` with the explicit effective key. SDK 1.0.37's public `CursorRequestOptions` has no caller signal; cancellation protects publication, not underlying transport rollback. Pi 1.0.3's started OAuth refresh may outlive caller abort for up to 15 seconds to save rotated credentials; this API-key/catalog mechanism makes no OAuth rollback promise.

Discovery stages models and selection metadata. Native `context.publish({ update })` accepts the owning generation before synchronously applying models, metadata, best-effort cache persistence/owned orphan cleanup, and one replaceable/clearable fallback-warning state. Cancelled/superseded responses and closed bindings cannot mutate those surfaces. Effective no-auth cleanup removes only a valid extension catalog regular file, never a user-managed link. Authenticated errors still prefer a fingerprint-matching cache or the bundled fallback.

For each model, use:

- `model.id`
- `model.aliases`
- `model.displayName`
- `model.parameters`
- `model.variants`
- default variant: `variant.isDefault === true`, else first variant

New Cursor models and changed parameters are picked up by a network-allowed native refresh (explicitly `/cursor-refresh-models`); reload/restart restores cached or fallback identities without forcing live discovery.

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

The authenticated SDK 1.0.37 catalog-only refresh on 2026-10-07 returned 46 models, adding Claude Haiku 5.5 (`claude-haiku-5-5`) while preserving all 45 model records from the SDK 1.0.36 capture on 2026-10-06. The generated header records SDK 1.0.37 and the 46-model count. Haiku 5.5 exposes 20 variants across `thinking=false|true`, `context=300k|1m`, and `reasoning_effort=low|medium|high|xhigh|max`; its default is `thinking=true`, `context=1m`, `reasoning_effort=high`. The 33 bundled checkpoint-derived entries were unchanged; this refresh started no Agent/model turn or Cloud run and does not qualify effective checkpoint limits.

Dated evidence for Cursor's assistant-visible, model-specific system text and reconstructed tool guidance lives in [Cursor System Prompts and Tool Guidance — 2026-08-02](https://github.com/fitchmultz/pi-cursor-sdk/blob/main/docs/evidence/cursor-system-prompts-2026-08-02/README.md). Keep that evidence separate from pi-cursor-sdk's own bootstrap prompt: Cursor persists its base system message in the local SDK checkpoint, while this extension sends Pi context and bridge instructions as user content.

## Design Direction

Use native pi abstractions wherever possible:

| Concern | Representation |
|---|---|
| Cursor base model | pi provider model |
| Cursor `context` | pi-visible model variant because it changes `contextWindow` |
| Cursor `reasoning` | pi native thinking via `thinkingLevelMap` |
| Cursor `effort` | pi native thinking via `thinkingLevelMap` |
| Cursor `reasoning_effort` | pi native thinking via `thinkingLevelMap` |
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
- Do not encode `reasoning`, `effort`, `reasoning_effort`, `thinking`, or Cursor SDK `mode` into pi model IDs. For models with a Cursor `fast` parameter, also register selection-only `:fast` and `:slow` virtual model aliases that do not change pi-native metadata.
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
- `reasoning`: `true` only if a Cursor `reasoning`, `effort`, `reasoning_effort`, or `thinking` parameter can map to pi thinking. This controls pi's thinking UI and `pi --list-models` `thinking` column; it must not be used to claim whether the Cursor model can think internally. Cursor SDK models are thinking-capable even when this is `false`.
- `thinkingLevelMap`: model-specific pi-to-Cursor mapping for pi UI, clamping, persistence, and footer display.
- `contextWindow`: parsed from context variant, else conservative fallback.
- `maxTokens`: conservative explicit value until Cursor SDK exposes output limits.
- `input`: supported input types. The installed Cursor SDK accepts `SDKUserMessage.images`, and Cursor models are expected to support image input, so advertise `["text", "image"]`.
- `cost`: zero rates at registration; pi applies user-configured `models.json` overrides. SDK billed cents are separate from these rates.

The extension stores runtime metadata in an internal map keyed by registered pi model ID. That map records the Cursor base catalog model ID, the Cursor selection model ID (base ID or alias), selected context param, default params, and discovered capabilities. `ProviderModelConfig` has no dedicated metadata field, so do not rely on hidden custom fields for this state.

## Dynamic Capabilities

No per-model hardcoded control list.

Infer behavior from discovered params:

| Cursor param | Extension behavior |
|---|---|
| `context` with values | register pi-visible context variants |
| `reasoning` | populate `thinkingLevelMap` |
| `effort` | populate `thinkingLevelMap` |
| `reasoning_effort` | populate `thinkingLevelMap` |
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
| View, refresh, or export accounting | `/cursor-usage [refresh\|export <new-file.json>\|help]` | current branch has recorded Cursor facts |

Do not register a shortcut for `shift+tab`. Pi reserves the native thinking keybinding, and the extension should only influence it through model metadata.

Do not add a context-cycle shortcut in the first pass. Context is a pi model variant, so users should change it through native model selection/cycling.

## Thinking / Reasoning / Effort Mapping

Important distinction:

- **Cursor thinking support** applies to all Cursor SDK models. The extension should assume Cursor models can think and may emit thinking deltas.
- **Pi-controllable thinking** means Cursor exposes a `reasoning`, `effort`, `reasoning_effort`, or `thinking` parameter that the extension can set from pi's native thinking level. These models register `reasoning: true` and show `thinking=yes` in `pi --list-models`.
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
- Gemini 3.8 Flash maps `low`, `medium`, and `high` to the native `reasoning_effort` parameter. Its other pi levels are unsupported; direct provider selections of those levels retain the SDK's `high` default.
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

Some Claude models support boolean `thinking` plus an effort parameter:

```text
thinking=true|false
effort=low|medium|high|xhigh|max
# or reasoning_effort=low|medium|high|xhigh|max
```

Rules:

- Pi `off` sends `thinking=false` and omits the effort parameter.
- Pi enabled levels send `thinking=true` and the mapped `effort` or `reasoning_effort`, using only catalog-supported values.
- `shift+tab` changes pi thinking, which changes the model's effort parameter.
- There is no separate `thinking` toggle.

Haiku 5.5 uses `reasoning_effort`: both `@300k` and `@1m` expose native `off`, `low`, `medium`, `high`, `xhigh`, and `max`. `minimal` is unsupported; direct selections retain the catalog's `thinking=true`, `reasoning_effort=high` default without changing the selected context.

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
- include the selected Cursor `context` param when calling `Agent.create()`, except for the Grok 4.7 catalog-default compatibility rule below,
- set pi `contextWindow` from that context value,
- share the same `thinkingLevelMap` as the base model unless Cursor reports otherwise.

Reason:

- pi context display and overflow logic must match the actual Cursor context.
- pi has no generic provider-parameter system that can change `contextWindow` while keeping the same model ID.

### Grok 4.7 Default-context Compatibility

Grok 4.7 selections (including unambiguous SDK aliases and `:fast` / `:slow` variants) omit only an outgoing `context` equal to the base catalog's default-variant context.
The baseline comes from `isDefault`, falling back to the first variant, before applying the selected context or speed override.
If the catalog supplies no default context, no context is omitted.
Non-default contexts and all effort and fast values remain explicit, including catalog-default effort and speed.
Selected context metadata, native `contextWindow`, and catalog params are not changed, and other models keep their complete selections.

Retained LOCAL evidence with SDK 1.0.35 covered all 16 combinations of `256k` / `500k`, `low` / `medium` / `high` / `xhigh`, and fast on/off: all explicit `256k` selections succeeded and all explicit `500k` selections were rejected.
Separate SDK 1.0.35 checks succeeded with context omitted at medium and high effort with `fast=true`.
An unmodified SDK 1.0.36 build reproduced the rejection for explicit `context=500k`, `reasoning_effort=medium`, and `fast=true`.
The revised context-only builder is verified offline; this is not a successful live matrix on SDK 1.0.36 or Cloud qualification.

## SDK-native Custom Agent Definitions

`cursor-sdk.json` top-level `subagents` supplies public SDK `AgentOptions.agents` for ordinary LOCAL create/resume and Cloud creation. One usable trusted project set replaces the entire user set; empty/all-invalid sets do not shadow it. The existing immutable Pi project-trust provenance controls loading. CLI, environment, session and builtin overrides do not supply definitions.

The extension validates names with `/^[A-Za-z][A-Za-z0-9._-]{0,63}$/` (extension policy, not an SDK restriction), trims required nonblank description/prompt and optional model, accepts Pi thinking levels and boolean fast, skips unusable entries, and drops unsupported fields. Own-entry construction preserves names such as `constructor` as data. Existing unrelated config saves retain definitions.

`buildCursorCustomSubagentDefinitions()` keeps omitted model absent and explicit `inherit` literal; SDK 1.0.37 conversion makes both inherit the parent. Their thinking/fast fields cannot override that inheritance. Explicit models reuse canonical catalog selection, with registered fast/slow identity ahead of entry fast and catalog defaults otherwise. Parent/session/process fast settings and parent thinking are independent. Unknown IDs stay ID-only; no additional discovery request or fabricated SDK ID encoding occurs.

The full resolved selection is submitted for both runtimes. **SDK 1.0.37 LOCAL conversion retains only ID/inherit and drops thinking/fast/context params.** Cloud conversion retains params, not a qualified claim about delegated service acceptance. `local.subagentInherit` controls child resources, not model params.

Nonempty definitions add a SHA256 pool-key suffix over name-sorted fixed-shape content with sorted model params. Definition/property/param order does not affect identity; text/model/param/add/remove changes do. No-feature keys stay byte-identical. Each turn captures one definition set, including forced rebootstrap; next-turn config edits repool and exact persisted-key matching rejects stale resumes. Existing persistence stores the key digest only, not definition prompts.

LOCAL compact/tree summary constructors remain fresh, tool-free, definition-free and ephemeral, without conversation resume/lineage. Bug-report streams have no public summary-purpose hook and retain ordinary capabilities. Bridge snapshots/manifests/routing are unchanged and `pi__subagent` stays preferred when available. User configuration and limits: [SDK-native custom agents](../README.md#sdk-native-custom-agents).

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
- Every conversation send passes the effective mode through `agent.send(..., { mode })`; LOCAL compaction/tree summaries explicitly use text-only `agent` mode.
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

## Context and accounting boundaries

The default Pi footer and `/stats` use native coherent current-context usage and configured-price estimates, not complete Cursor invoice/session totals. Official supported extensions expose custom entries, not a native invoice-usage append API. Do not manufacture tool messages, mutate private session state, disable compaction, or inflate windows to hide billing-driven overflow.

`cursor-request-provenance.ts` captures the public native projection at `before_provider_headers`. An ordinary request may use the last visible compatible same-model in-window measurement only when the converted canonical projection is value-equivalent to the outgoing request and its raw source follows the latest compaction or context edit. Projected order, timestamps, quoted summary wrappers, and `tokensBefore` comparisons are not authority. Transformed requests and compaction/tree summaries receive no historical floor.

Compaction and tree purpose follows the owning operation's public `AbortSignal`, including sequential summary calls and native retries. LOCAL summaries use fresh non-pooled agents with `tools: []`, `local.settingSources: []`, no MCP/bridge/manifest/replay, `agent` mode, no normal resume/lineage writes, and an ephemeral store. Native instructions are preserved without coding-tool guards or conversation prompt budgets. Disposal is awaited before terminal emission so successful native operations return after temporary-store removal; failure/cancellation also disposes the agent/store. Cloud cannot use the same tool restriction, and bug reports lack a public purpose hook; neither is silently classified from text or empty Pi tool declarations.

`cursor-usage-ledger.ts` keeps distinct original raw/reported snapshots, qualified LOCAL corrected turns, terminal facts, run/request IDs, and validated public billed snapshots. The recorded LOCAL SDK 1.0.32 cache case is raw full input 4232 / cache read 4096 / output 3: corrected input 136 and total 4235, while original additive SDK wait/handle total 8331 is retained only as reported telemetry. Public billed categories already sum to 4235; subtracting cache again is wrong. Cloud raw normalization and invalid LOCAL partitions retain their original numeric fields with explicit unqualified/invalid status. Aggregate billed totals are not limited by one response's output cap or context window.

Before a send, a unique public native branch claim anchors a fsynced intent in a validated sidecar keyed by stable native session ID. Frames contain only IDs, lineage, model selection/pricing, counts, statuses, and observation times—not prompts, tool content, or credentials. Billed frames store aggregate usage/cost plus new/changed/removed UUID rows; unchanged historical rows are not recopied into every journal/session observation. Optional custom-entry mirrors cannot establish or advance recognition; the durable journal and unique native claim do. Late facts remain in the original journal, and mirrors are omitted after owner/session/branch changes. Same-ID recovery in the original directory exposes lost-claim records as unclaimed facts, distinct from valid claims on other branches of that native session. Cross-directory forks use exact inherited provenance and retain mirror facts with explicit gaps when a referenced journal is unavailable; no sibling scans or writes. Fileless sessions are ephemeral.

Snapshot append chronology owns revisions within each origin, never wall clocks. Reconstructed whole-agent snapshots retain changed/lower rows, optional costs, and aggregate-only remainders without adding overlapping raw/wait/handle/billed sources. Missing revision history is explicit: agent and per-origin `latestAggregate` preserve absolute observed usage/cost independently of run reconstruction, including after an unavailable attempt. Incomplete histories expose neither `wholeAgent` nor aggregate-only remainders; the view labels the remainder unknown because run history is incomplete, not absent SDK reporting. Multiple-origin agent totals stay ambiguous while per-origin aggregates remain visible. Unknown inherited history is not re-billed. LOCAL client run IDs do not join billing UUIDs, so whole-agent consumption is not attributed to a particular client turn or priced with its current model. Multiple origins have no qualified global revision order and remain explicitly ambiguous. All successful billing observations are pending settlement, not final invoices; an unavailable public endpoint stays unavailable without private fallback.

`/cursor-usage` renders the canonical current-branch view, including shared lineage, unavailable/pending data, journal gaps/torn tails, other-branch facts and genuinely unclaimed records. `refresh` takes bounded public snapshots for up to 32 agents (five seconds each), owned by the invoking branch, without model sends or polling. `export <new-file.json>` creates an exclusive private JSON export; non-UI output goes to stderr to preserve stdout/RPC framing. `help`, `-h`, and `--help` explain use and recovery. Journals have a 16 MiB per-origin ceiling and fail before spend when intent cannot persist; mid-run persistence failure leaves accounting incomplete without changing response success and may warn once while the origin is current. Validated prefixes of torn-tail journals remain readable/exportable while further appends fail closed. Export and retain old history, then fork into a new native session or start a new session; never truncate/delete a journal to continue an old SDK lineage. Losing every native reference after moving the origin directory is an explicit discovery limit, not permission to scan unrelated sessions.

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

### Local store migration and ownership

Persistent LOCAL storage selects `PI_CURSOR_SDK_STATE_ROOT > user local.storeRoot > undefined`, captured once before drain/acquisition or at explicit cleanup entry. Project/session/CLI/built-in roots are ignored. Invalid nonempty winners survive parsing and fail closed at persistent storage. Custom layout is `<canonical-root>/<sha256(resolve(cwd))[0:32]>/pi-sessions/<unchanged-session-hash>`. Auth/settings/rules/catalog caches/IDE data do not move. Root changes repool even with resume disabled; persisted pool-key bytes and identity version 1 are unchanged. Only the exact current custom session identity can resume or be cleaned up, with no custom legacy workspace/historical-root mapping. Wrong-root handles fall back with the existing one-shot transcript continuity notice. A/default history is retained when B is selected; cleanup under B can permanently exclude A candidates. Clean up before relocating if desired; returning to A does not undo durable exclusion.

Custom leases are keyed by raw cwd and captured normalized selected root and retained through admission/open/fallback/disposal. Creating/ready/busy reuse and same-key supersession compare storage compatibility too. Paths must be native fully qualified absolute non-root paths without explicit dot components or interpolation. POSIX ancestry rejects unowned/group/other-writable components except trusted sticky root-owned temporary ancestors; subsequent components must be current-user owned. Missing components are created individually (0700); only owned destinations are restricted through identity-checked no-follow directory descriptors. Verified root-owned system aliases may canonicalize; user-controlled ancestor/owned links are rejected. Bounded admission, fixed SQLite leaf checks and before/after-public-open identities protect the chain. This trusts current-user private contents, not hostile same-user/admin pathname races or arbitrary lazy checkpoint contents. Windows checks Node-visible links/junctions, identity/type and writability, not ACL hardening or every reparse tag; choose an ACL-protected location. Native Windows proof requires Windows execution, not POSIX platform mocks. Fileless and LOCAL compact/tree temporary paths bypass all persistent selection/validation/leases.

When default storage is selected, SDK 1.0.37 retains SDK 1.0.36's public default-root getter and MD5(cwd)-to-SHA256(cwd) whole-workspace rename; the inspected storage/root factories are byte-identical. Persisted Pi identities are admitted only as exact cwd/scope-derived roots below the SDK-owned prefix. A missing legacy workspace can map to the current root only when that precise destination contains the recorded agent with the same cwd. Existing legacy roots retain ownership, including when both stores exist; no merge or sweep occurs. Resume and recorded-ID cleanup share this admission. Persistent same-cwd callers acquire ownership synchronously before any await or public root derivation, share the pending derivation, and retain it through resume/cleanup admission and store open/disposal. Failed acquisition/disposal releases ownership; no permanent root cache or whole-turn serialization is introduced. Other processes must be stopped before upgrading because this is not a cross-process lock. User-managed links/junctions above the SDK-owned prefix remain supported. A small pure layout preflight, contract-verified against the installed SDK factory/public getter because no public read-only resolver exists, rejects links/non-directories in the owned prefix and old/current workspace components before the migration-capable getter. Post-getter/open/removal guards remain in place. Recorded identities must first match exact derived current/legacy roots; only admitted roots enter a normalized finite component walk. Malformed/outside/sibling identities fall back on resume or become durably non-retryable cleanup candidates. A layout failure after exact admission names the rejected owned component and remains retryable for cleanup after that component is repaired; dangling destination links are rejected before a missing destination can be mistaken for absent migration proof. Persistent opens require an already-active matching derived workspace lease; no caller-supplied root adoption or unleased mode exists. Cleanup requires a durable session file and recorded intent before opening persistent storage. Fileless turns and LOCAL compaction/tree summaries open unique temporary stores directly, without workspace derivation, preflight, migration or a workspace lease; they never resume and retain guarded removal on failure/disposal. Pool keys, branch resume admission and native usage journals/footer are unchanged.

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

### Multi-session embedding

Each ExtensionAPI registers its own provider closure. Its native header receipt captures immutable scope/projection provenance and the usage origin before deferred work; stream entry consumes that receipt and captures the owning bridge, replay state, and cloud recorder. Default SDK sessions create independent ModelRuntime instances on supported official Pi 0.87.1+ and the maintained fork. Concurrent sessions, children launched inside a parent's tool before `turn_end`, and direct manual/automatic compaction, tree summaries, and bug-report summaries retain their own pool/store, persisted lineage/resume entries, journals, and debug metadata. Ownership does not depend on turn/agent event windows. Inherited tool-result IDs cannot select a sibling's live run. Replay wrappers require both their owning display state and the normalized recorded tool name before consuming a result; a foreign-owner or wrong-tool ID is rejected without consuming the original card or executing native work.

Runtime scope keys combine the persistent identity with a process-local owner assigned to the real public SessionManager object. That manager is stable across native contexts/reload on the supported hosts; independent managers opening one file do not share generations, pools, live runs, branch caches or terminal tombstones. Durable scope keys, pool-compatibility bytes, store roots and persisted resume/lineage entries keep their prior identity. Atomic exact store-root/agent-ID claims prevent an already-owned handle from being resumed or deleted by another runtime; unavailable resume claims create a fresh agent, while cleanup refuses the occupied ID. Claims release only after successful SDK disposal, not a timeout/rejection. The native ownership regression proves same-file ordinary continuation and pending bridge survival across sibling reload/tree/shutdown, restart resume and simultaneous acquisition. It does not establish #282's original trigger, cross-process locking or concurrent real SQLite/journal-write safety.

Pi's SDK supplies a session-owned `before_provider_headers` callback for ordinary and auxiliary streams. The extension records ownership against the real headers object without modifying it; Pi forwards that same object to the registered provider. Stream entry consumes and checks this one-shot request receipt before touching SDK/storage state, then verifies actual request projection equivalence when resolving a fallback floor. Other extensions' header mutations are preserved. No turn windows, lifecycle scans, sibling graph, or cross-session queue are needed; the existing per-scope send queue remains unchanged.

An explicitly shared ModelRuntime still has only one Cursor registration. A request can run only when its receipt belongs to that registration's active session. Mismatched or missing receipts fail before SDK/storage work:

> Cursor provider ownership is unavailable: this request does not belong to the active Cursor registration. Reload this session's extensions to restore its Cursor registration; use independent ModelRuntime instances for sibling sessions.

Pre-bind and shutdown closures also fail closed. Refreshing A while an unstarted shared sibling exists cannot let that sibling enter A's registration, including bug-report streams without lifecycle events. Catalog refresh keeps the native registration's original closure and never re-registers over a sibling, including when auth resolution races a sibling registration. Bare calls to a registered provider without the native headers receipt, including extension calls to `ctx.modelRegistry.streamSimple`, or reuse of a consumed receipt, fail closed. Bind/refresh/reload cannot supply a receipt to that bare API: use the owning AgentSession's native stream path or an independent child AgentSession. Direct `streamCursor` callers must also supply captured ownership, request provenance, and a usage recorder; there is no unbound global fallback. Default independent ModelRuntime instances remain the embedding recommendation.

Branch mode, runtime/cloud acknowledgement, fast and HTTP preferences are session-scoped. CLI snapshots follow their owning ExtensionRuntime, including independent sibling flags and one-shot local-force consumption across rebinding/reload. Environment overrides and user defaults remain process-wide. Cursor SDK HTTP/1.1 transport configuration remains process-global; different branch preferences are not independent simultaneous SDK configurations. Shutdown clears the extension-owned transport override only after the last binding leaves, and a never-started child cannot reset or terminally dispose a parent's pool. Cloud commands capture the original public manager, session file/id, branch anchor, and lifecycle authority before auth/SDK awaits, then reject changed ownership or authority before writing an intent or starting the SDK mutation. Authenticated orphan reconciliation uses only that unchanged captured authority. After SDK start, actual completion is persisted in the original durable journal with its post-intent anchor even across branch changes, reload, or shutdown; the optional Pi mirror is omitted if the original context/branch is no longer current. General provider recording retains live before/after branch-anchor checks, and no-follow/fsync guards remain in force.

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

If Cursor later adds `fast`, `context`, `reasoning`, `effort`, `reasoning_effort`, or aliases to a model, the extension picks up unambiguous capability changes dynamically.

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

## Validation evidence criteria

The sections below are selectable evidence criteria, not a mandatory runtime/print/visual campaign. Start with offline/faux checks and reuse valid retained proof for unchanged tested inputs. Select criteria that protect the changed behavior; only a remaining need for real-service proof warrants the smallest meaningful existing live check on one representative environment. The print commands are examples, not five required paid turns. Docs/metadata-only changes need no paid testing. Do not automatically retry paid runs or add hosts merely for matrix coverage.

Preserve every selected check's assertions and truthful scope. Visual claims need matching rendered PNG and persisted JSONL evidence; session/resume/lifecycle claims need persisted session/debug evidence, not assistant text alone. Retain process, agent, repository and artifact cleanup requirements for selected runs. Cloud product capabilities remain supported, but paid Cloud testing is permitted only for a PR or issue explicitly focused on Cursor Cloud.

1. Unit tests:
   - context-variant model IDs
   - dynamic capability discovery
   - context variant registration and decoding
   - fast extension state and status behavior
   - Cursor SDK mode session/CLI state and status behavior
   - `reasoning` mapping
   - `effort` mapping
   - `reasoning_effort` mapping and unchanged SDK defaults for unsupported levels
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
   - the selected `cursor-http1-live` platform lane proves an enabled local HTTP/1.1/SSE turn completes and shows `http1`; offline status tests cover local-disabled and cloud status omission. Select this live lane only when changed behavior needs new real-service proof.
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
   - for changed replay/bridge card visuals, use offline rendering checks and valid exact-input retained visual proof first. Only if new real-TUI proof is still necessary, select the smallest meaningful visual audit on one representative environment; retain rendered PNG, persisted JSONL and cleanup evidence. JSONL should show real pi tool names for bridged calls and no duplicate MCP replay for bridge calls.
