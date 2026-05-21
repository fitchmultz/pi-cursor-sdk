# Cursor SDK + Dynamic pi Tool Bridge: Plan

## Goal

Plan the path from display-only Cursor SDK replay to a Cursor provider architecture where Cursor keeps its SDK agent loop and native tools, gains dynamic access to the current pi session's active tools/extensions, and renders Cursor-native activity close to native pi output without exposing synthetic replay names to model-facing context or user-visible cards.

## Background

- The extension registers the `cursor` provider through `src/index.ts:8-22`; session cwd capture, fast controls, native replay display, model discovery, and provider registration are wired in `src/index.ts:23-60`.
- `streamCursor` is the provider stream handler. It first checks for a pending replay run, then creates a local Cursor SDK agent with `Agent.create({ apiKey, model, local: { cwd, settingSources } })`, builds the Cursor prompt from pi context, and calls `agent.send(...)` (`src/cursor-provider.ts:599-675`, `src/cursor-provider.ts:979-982`).
- Current Cursor prompt conversion is intentionally defensive: prior pi tool calls/results are text transcript, thinking is omitted, and the prompt says pi tool names, replay tool names, and transcript names are context only, not callable capabilities (`src/context.ts:60-105`, `src/context.ts:167-178`, `src/context.ts:191-195`).
- Current Cursor SDK event handling is centralized in `src/cursor-provider.ts`: replay run state and pending events (`src/cursor-provider.ts:67-102`), native tool-use turn emission and pending-run replay (`src/cursor-provider.ts:501-602`), completed tool routing (`src/cursor-provider.ts:856-889`), delta/step handling (`src/cursor-provider.ts:893-963`), and abort cancellation through `run.cancel()` (`src/cursor-provider.ts:969-986`).
- Current replay splits one Cursor run into pi-style assistant/tool-result turns. It emits `toolcall_start`, `toolcall_delta`, and `toolcall_end` blocks with recorded display payloads, stops the turn with `toolUse`, then resumes the same pending Cursor run on the next provider invocation (`src/cursor-provider.ts:501-529`, `src/cursor-provider.ts:548-602`).
- Cursor tool normalization lives in `src/cursor-tool-transcript.ts`. Cursor read/shell/grep/glob/ls normalize to native-looking pi read/bash/grep/find/ls cards, while Cursor edit/write/delete/lints/todos/task/image/MCP activity currently maps to replay-only names such as `cursor_edit`, `cursor_write`, and `cursor_mcp` (`src/cursor-tool-transcript.ts:843-1061`).
- Replay wrapper registration is fixed, not dynamic. `src/cursor-native-tool-display.ts:38-96` stores recorded replay payloads by tool-call ID; `wrapNativeCursorTool()` returns recorded results and only falls back to the current pi tool when no recorded result exists (`src/cursor-native-tool-display.ts:107-130`). Replay-only tools fail closed when no recorded Cursor result exists (`src/cursor-native-tool-display.ts:440-463`). Registration skips non-builtin tool conflicts and syncs replay-only active tools for Cursor models (`src/cursor-native-tool-display.ts:487-543`).
- Before this plan's bridge work, the source of truth said this was not a pi tool bridge: Cursor used Cursor SDK's local-agent tool surface plus configured Cursor settings, plugins, and MCP servers, and pi-side tools were not passed to Cursor as callable schemas. Replay remains display-only and must not re-run commands, apply edits, call MCP, update pi state, or mutate files (`docs/cursor-native-tool-replay.md`).
- Visual parity has a documented audit path: replay-card changes should be checked with screenshots, JSONL/tool facts, and local validation before claiming parity (`docs/cursor-native-tool-visual-audit.md:3-5`, `docs/cursor-native-tool-visual-audit.md:168-177`).
- Prior work is replay-focused: `d71bacd` introduced replay-only edit/write cards; `73c6ee7`, `b5cf881`, `d2d11c7`, and `7122a14` polished native replay ordering/display. `docs/completed/` is absent; this file is the active bridge plan.
- Installed pi docs say dynamic tools can be registered after startup; newly registered tools refresh in the same session, appear in `pi.getAllTools()`, and are callable without `/reload` (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1217-1229`). The installed `dynamic-tools.ts` example registers a session tool and runtime command-added tools (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/dynamic-tools.ts:24-73`).
- `pi.getActiveTools()`, `pi.getAllTools()`, and `pi.setActiveTools()` manage built-in and dynamic tools. `pi.getAllTools()` returns `name`, `description`, `parameters`, and `sourceInfo`, with built-in, SDK, and extension source metadata (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1483-1507`). This is the repo-visible source for a per-session bridge surface without hardcoded extension names.
- pi's normal tool path includes provider-emitted `toolcall_*` blocks, `tool_execution_start`, `tool_call`, actual tool execution, `tool_result`, `tool_execution_end`, and final tool-result messages. `tool_call` can mutate or block inputs before execution; `tool_result` can patch content/details/error state; abort-aware nested work should use `ctx.signal` (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:672-748`).
- Installed custom-provider docs define provider-side tool-call events as `toolcall_start`, `toolcall_delta`, and `toolcall_end`, which form assistant `toolCall` blocks for pi execution/rendering (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md:430-494`). The docs do not expose a generic extension API equivalent to `executeActiveTool(name, args)`.
- Tool rendering is tool-owned in pi: `renderCall` and `renderResult` render cards, default output is boxed unless `renderShell: "self"`, and renderer context includes partial/error/expanded/tool-call metadata (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1977-2007`). Built-in tool override examples show delegating to built-in implementations and reusing renderers when schema/result shapes stay compatible.
- Cursor SDK local types in this repo expose inline MCP registration through `AgentOptions.mcpServers?: Record<string, McpServerConfig>`, with stdio and HTTP/SSE server shapes (`node_modules/@cursor/sdk/dist/esm/options.d.ts:18-33`, `node_modules/@cursor/sdk/dist/esm/options.d.ts:122-140`). Local agents also load ambient Cursor settings through `local.settingSources` (`node_modules/@cursor/sdk/dist/esm/options.d.ts:80-89`).
- Cursor SDK stream messages expose generic `tool_call` lifecycle events with `call_id`, `name`, `status`, optional `args`, `result`, and truncation flags (`node_modules/@cursor/sdk/dist/esm/messages.d.ts:41-53`), and runs support `stream()`, `wait()`, `conversation()`, and `cancel()` (`node_modules/@cursor/sdk/dist/esm/run.d.ts:27-43`).
- External Cursor SDK docs describe SDK agents as using the same harness as Cursor desktop/CLI/web and supporting MCP through `.cursor/mcp.json` or inline configuration (https://cursor.com/blog/typescript-sdk, https://cursor.com/changelog/sdk-release). As of 2026-05-20, this repo depends on `@cursor/sdk` `^1.0.13` (`package.json:44-46`).

## Approach

Build this as a **local-Cursor-first, MCP-backed provider path that is default-on once implemented and validated**. Cursor keeps its SDK `Agent` loop, native tools, settings, plugins, and ambient Cursor MCP. The new bridge adds a per-run, loopback pi MCP surface generated from the current pi session's active tools.

The key decision is that the MCP bridge does **not** execute pi tools directly. It queues a request, `streamCursor()` emits a real pi `toolCall` block with the real pi tool name, pi executes that tool through its normal path exactly once, and the next provider invocation resolves the waiting MCP call back into the same Cursor SDK run.

```text
Cursor MCP tool call
→ bridge queues request
→ streamCursor emits pi toolCall with real pi tool name
→ pi executes normally
→ next streamCursor invocation sees the matching toolResult
→ bridge resolves the MCP call
→ same Cursor SDK run continues
```

This uses the existing provider-emitted tool-call seam instead of waiting for a direct extension-side `executeActiveTool(name, args)` API. That preserves confirmations, `tool_call`/`tool_result` hooks, validation, mutation queues, renderers, abort behavior, session entries, and native output cards.

### Technical assumptions to verify first

Before building the bridge body, run a bounded spike against the installed Cursor SDK and pi runtime to confirm:

- Cursor SDK allows an MCP tool call to remain pending while `streamCursor()` yields a pi `toolUse` turn and later resumes the same SDK run.
- Cursor SDK keepalive/timeout for a pending MCP call is long enough for realistic pi tool execution, or exposes a supported progress/keepalive path.
- Inline HTTP or SSE MCP config works for a loopback server in the current process.
- pi `toolResult` messages for provider-emitted tool calls can be found reliably by `toolCallId` in the next `Context`.

If the first assumption fails, the implementation must stop and redesign the bridge around a single-turn callback or a new pi execution API. Do not fake bridge execution by calling tool `execute()` directly.

### Scope and rollout

- First bridge milestone is local Cursor only.
- Once the bridge passes the verification gates in this plan, local Cursor provider runs expose the bridge by default when active pi tools exist.
- `PI_CURSOR_PI_TOOL_BRIDGE=0` disables it; aliases such as `false`, `off`, and `none` are acceptable but not the key design point.
- `PI_CURSOR_PI_TOOL_BRIDGE=1` remains useful during implementation and tests before default-on release behavior lands.
- Cloud Cursor agents are out of scope for this plan; they need a separate auth, transport, lifetime, and remote trust design.
- Existing Cursor setting sources and Cursor-native MCP remain enabled; the pi bridge is additive.
- Existing Cursor-native replay stays recorded-result-only and fail-closed.

### Bridge seam and transport

Add `src/cursor-pi-tool-bridge.ts` as the bridge module/service. It owns:

- `ExtensionAPI` registration from `src/index.ts`.
- a loopback HTTP/SSE MCP server in the current pi process.
- per-run tokenized MCP endpoint registration.
- active pi tool snapshot and MCP-name mapping.
- `mcpCallId ↔ bridgeCallId ↔ piToolCallId` correlation state.
- queued bridge tool requests.
- result resolution from pi `toolResult` messages.
- cancellation/disposal of pending MCP calls.

Choose HTTP/SSE loopback over stdio for the first implementation because the bridge must live in the current pi process to access current session tools and resolve provider-turn results. Use `@modelcontextprotocol/sdk` as a production dependency unless implementation finds a smaller maintained primitive already exposed by Cursor or pi. Do not hand-roll the MCP protocol.

Security constraints:

- Bind only to `127.0.0.1`.
- Use a random per-run token in the MCP URL/path.
- Never call a pi tool `execute()` method from the MCP handler.
- The MCP handler only validates, queues, waits, and resolves/rejects.
- Dispose per-run registrations on done, error, abort, idle expiry, and session replacement.

### Bridge run contract

Keep the public bridge surface small but explicit enough to avoid correlation guesswork:

```ts
interface CursorPiToolBridgeRun {
  id: string;
  enabled: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  takeQueuedToolRequests(): CursorPiBridgeToolRequest[];
  resolveToolResultsFromContext(context: Context): void;
  isBridgeMcpToolCall(toolCall: unknown): boolean;
  cancel(reason: string): void;
  dispose(): Promise<void>;
}

interface CursorPiBridgeToolRequest {
  runId: string;
  bridgeCallId: string;
  cursorMcpCallId?: string;
  piToolCallId: string;
  piToolName: string;
  mcpToolName: string;
  args: Record<string, unknown>;
}
```

`CursorPiToolBridgeRun` owns the correlation maps. The MCP handler writes the request before it returns a pending promise. `streamCursor()` drains queued requests and emits pi tool calls using `piToolCallId`. The next provider invocation calls `resolveToolResultsFromContext(context)`, which searches for matching `toolResult` blocks by `piToolCallId` and resolves the original MCP promise. The provider live-run state stores the bridge run; it should not maintain a separate, competing correlation table.

### Tool exposure rules

At Cursor run creation:

1. Read `pi.getActiveTools()`.
2. Read `pi.getAllTools()`.
3. Keep only tools whose names are active and present in all-tools metadata.
4. Always exclude legacy replay/internal Cursor activity names: `cursor_edit`, `cursor_write`, `cursor_read_lints`, `cursor_delete`, `cursor_update_todos`, `cursor_task`, `cursor_create_plan`, `cursor_generate_image`, and `cursor_mcp`.
5. Do not call `pi.setActiveTools()` from the bridge.
6. Do not hardcode third-party extension names.
7. Use pi tool `parameters` as MCP `inputSchema`.
8. Preserve pi tool descriptions, but add bridge-owned MCP naming that avoids collision.

MCP tool names should be stable and collision-safe, for example `pi__bash`, `pi__read`, or `pi__sem_reindex`. Maintain an internal `mcpToolName -> piToolName` map. pi session output must use the real pi tool name, not the MCP bridge name.

### Provider lifecycle changes

Generalize current pending replay state in `src/cursor-provider.ts` into a live Cursor run state that can carry both replay events and bridge requests. This is an explicit refactor step, not incidental glue.

Provider flow:

1. Push `start`.
2. If the current context belongs to a pending Cursor run:
   - resolve bridge tool results from matching `toolResult` messages.
   - continue the existing Cursor SDK run.
   - do not create a new `Agent`.
3. If no pending run exists:
   - resolve API key, cwd, setting sources, fast state, and model selection.
   - create a bridge run when the bridge is enabled and the active tool snapshot is non-empty.
   - pass bridge `mcpServers` into `Agent.create({ ..., mcpServers })`.
   - build prompt with bridge-aware wording.
   - call `agent.send(...)`.
4. When the bridge MCP handler queues a request:
   - enqueue a bridge tool event.
   - notify the live run waiter.
5. When emitting a bridge tool turn:
   - close open thinking/text blocks.
   - emit `toolcall_start`, `toolcall_delta`, and `toolcall_end`.
   - use `piToolName` and MCP args.
   - do not call `recordCursorNativeToolDisplay()`.
   - stop the turn with `toolUse`.
   - keep the Cursor run alive.
6. On the next provider invocation:
   - resolve the pending MCP promise through the bridge run.
   - wait for Cursor to continue.
7. On done/error/abort/idle disposal:
   - cancel or reject pending bridge calls.
   - dispose bridge run state.
   - dispose the Cursor agent once.

If a pending Cursor run is gone after pi already executed a bridged tool, do not re-execute the tool. Start a new Cursor run from the transcript and rely on the recorded pi tool result.

### Duplicate replay suppression

Cursor SDK may report the bridge call as a generic Cursor `mcp` tool event. Those events must not also render as Cursor MCP replay. `isBridgeMcpToolCall()` should match only against the current bridge run's known MCP names/call IDs:

- If Cursor reports a direct MCP tool name, match `toolCall.name` against the run's `mcpToolName` set.
- If Cursor reports a generic `mcp` wrapper, inspect reported args/result fields for a tool name matching the run's `mcpToolName` map or a `cursorMcpCallId` matching bridge correlation state.
- Do not suppress non-bridge Cursor MCP events.

Apply this check in both completed delta handling and step fallback.

### Synthetic-name policy

Synthetic replay names are implementation details, not user-facing or model-facing API. The plan should remove or rename them from new session artifacts as well as prompt text.

Rules:

- No literal replay-only names such as `cursor_edit`, `cursor_write`, or `cursor_mcp` in model-facing prompt text.
- No literal replay-only names in user-visible card titles, labels, or docs for the final architecture.
- New replay artifacts should use native tool names when renderer-compatible, or a neutral Cursor activity display surface that does not imply a callable pi tool.
- Legacy persisted sessions may still contain old names; prompt/context code must rewrite them to safe labels, and render code should display safe titles when reading old artifacts.
- Internal constants may retain old names only long enough to migrate compatibility tests and avoid breaking old sessions.

### Visual parity layer

Prioritize native-looking replay for Cursor file mutations, while explicitly preserving the schema-mismatch safety concern from current docs:

- replay Cursor `write` as native-looking `write`.
- replay Cursor `StrReplace`, `edit`, and notebook edits as native-looking `edit`.
- use pi's native renderers only where the adapter can produce truthful built-in-compatible arguments/details.
- otherwise use custom renderers that visually match pi cards while preserving Cursor-specific recorded details.
- never execute replayed mutations; replay returns recorded Cursor results only.
- keep bridged pi `edit` and `write` separate: those execute through pi and therefore render as actual native tool calls.

The target is native-looking edit/write output without unsafe schema coercion or real mutation replay.

### Shared replay/activity module

Create `src/cursor-tool-names.ts` or `src/cursor-tool-activity.ts` for:

- internal Cursor activity source names.
- legacy replay-only name detection.
- prompt-safe labels.
- display-safe labels.
- bridge exclusion rules.

Use it from `src/context.ts`, `src/cursor-native-tool-display.ts`, `src/cursor-tool-transcript.ts`, and `src/cursor-pi-tool-bridge.ts`.

## Work Items

### Item 1 — Bridge feasibility spike

**Goal:** Verify the cross-turn MCP bridge contract before building the implementation around it.

**Done when:** a minimal local probe proves or disproves: pending MCP calls can survive a pi `toolUse` turn and resume the same Cursor SDK run; loopback HTTP/SSE inline MCP works; the SDK timeout is acceptable or has a keepalive path; matching pi `toolResult` blocks by `toolCallId` works in the next `Context`. If any point fails, update this plan before implementing Items 4–11.

**Key files:** `src/cursor-provider.ts`, `src/cursor-pi-tool-bridge.ts`, `test/cursor-provider.test.ts`, local Cursor SDK type/docs references.

**Dependencies:** None.

**Size:** M.

**Spike result — 2026-05-20:** Feasibility confirmed except for Cursor SDK's bundled MCP 60s request timeout. **Bridge-unblocker status — 2026-05-20:** timeout blocker is addressed for installed `@cursor/sdk` 1.0.13 by a guarded runtime override that extends Cursor SDK MCP `callTool` default timers to 3600s by default.

Evidence gathered:

- `@cursor/sdk` `1.0.13` accepts inline loopback Streamable HTTP MCP config: `Agent.create({ local: { cwd, settingSources: [] }, mcpServers: { pi_bridge_spike: { type: "http", url } } })` connected to a `127.0.0.1` tokenized MCP endpoint built with `@modelcontextprotocol/sdk` `1.29.0`.
- A live MCP call held pending for 5 seconds left the same Cursor SDK run open: `run.wait()` did not settle while the tool promise was unresolved, then the same run finished after the host released the MCP result. Cursor reported the bridge call as generic `mcp` activity with the SDK `callId`.
- Current `streamCursor()` replay flow already proves the provider can emit a pi `toolUse` turn, keep a Cursor SDK run alive, and resume that same run on the next provider invocation without another `Agent.create()`.
- pi `Context.messages` has stable `toolResult` messages with `toolCallId`; current provider replay tests already construct the next `Context` with provider-emitted tool calls and matching `toolResult.toolCallId`. A bridge resolver can match exact `toolCallId` values in the next `Context`.
- The timeout/keepalive assumption failed for general pi tool execution. The bundled MCP protocol code has `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`, and Cursor's `McpSdkClient.callTool()` calls `client.callTool({ name, arguments })` without a custom timeout or `resetTimeoutOnProgress`. A live 70-second pending MCP call completed as model-visible text `MCP error -32001: Request timed out`, even though the host released the tool after 70 seconds.

Timeout unblocker outcome before Item 4:

1. Installed-code source of truth remains: Cursor SDK 1.0.13's bundled MCP protocol has `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`, and Cursor's bundled `McpSdkClient.callTool()` path calls `client.callTool({ name, arguments })` without request options such as `timeout`, `resetTimeoutOnProgress`, or `maxTotalTimeout`. Public `McpServerConfig`/`AgentOptions.mcpServers` types expose no timeout knob.
2. `src/cursor-mcp-timeout-override.ts` installs an idempotent, process-local runtime override for `setTimeout` that only changes the installed Cursor SDK MCP `callTool` stack when it schedules the bundled 60s default timeout. The replacement timeout defaults to 3600s, can be configured with `PI_CURSOR_MCP_TOOL_TIMEOUT_MS` or `PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS`, and is clamped to Node's maximum safe timer delay.
3. `src/cursor-provider.ts` installs the override before creating local Cursor SDK agents, so future bridge MCP `tools/call` requests are no longer constrained by the SDK's 60s default timer.
4. `test/cursor-mcp-timeout-override.test.ts` locks the installed SDK source seam and proves the override extends the Cursor SDK MCP `callTool` timeout path while leaving unrelated 60s timers unchanged.
5. Items 4–11 are unblocked from the timeout issue, but still need their planned bridge implementation, correlation lifecycle, duplicate MCP replay suppression, abort cleanup, and default-on release validation. A live >70s MCP probe should be rerun during bridge integration when a loopback bridge server and Cursor API key are available; seam tests are the current proof for this unblocker.
6. Keep the no-direct-`execute()` rule unless a new pi-owned execution API is added; do not fake bridge execution from the MCP handler.

### Item 2 — Cursor activity naming and synthetic-name hiding

**Goal:** Centralize Cursor activity source names and remove literal replay-only `cursor_*` names from model-facing prompts and user-visible replay artifacts while preserving legacy session compatibility.

**Done when:** replay/display modules, prompt filtering, and bridge exposure rules use the same source of truth; tests prove history containing legacy `cursor_edit`, `cursor_write`, and `cursor_mcp` produces prompt text and rendered labels with safe names; new replay output does not create user-visible `cursor_*` cards.

**Key files:** `src/cursor-tool-names.ts` or `src/cursor-tool-activity.ts`, `src/context.ts`, `src/cursor-native-tool-display.ts`, `src/cursor-tool-transcript.ts`, `test/context.test.ts`, `test/index.test.ts`, `test/cursor-tool-transcript.test.ts`.

**Dependencies:** None.

**Size:** M.

**Status — 2026-05-20:** Complete. Added shared Cursor replay/activity naming, sanitized legacy replay-only names from Cursor-facing prompt text and user-visible labels, kept legacy tools for old-session compatibility, and verified with `npm test -- test/context.test.ts test/cursor-tool-transcript.test.ts test/index.test.ts test/cursor-provider.test.ts` plus `npm run typecheck`.

### Item 3 — Native-looking replay for Cursor write/edit/notebook edits

**Goal:** Make Cursor file mutation replay visually match native pi write/edit output without replaying mutations or lying about schema compatibility.

**Done when:** Cursor `write` replays as native-looking write; Cursor `StrReplace`, `edit`, and notebook edits replay as native-looking edit; screenshots/JSONL show no synthetic card names; tests cover truthful argument/result/detail mapping and recorded-result-only execution.

**Key files:** `src/cursor-tool-transcript.ts`, `src/cursor-native-tool-display.ts`, `test/cursor-tool-transcript.test.ts`, `test/cursor-provider.test.ts`, `docs/cursor-native-tool-visual-audit.md`.

**Dependencies:** Item 2.

**Size:** L.

**Status — 2026-05-20:** Complete. Cursor `write` now replays through pi-facing native-looking `write`; Cursor `edit`, `StrReplace`, and notebook edit aliases replay through pi-facing native-looking `edit`; wrappers return recorded Cursor results only and fail closed for missing recorded mutation replay IDs. Unit render evidence covers native-looking edit/write output with no synthetic card names, including written content with blank lines and trailing-newline line counts. Verified with `npm test -- test/cursor-tool-transcript.test.ts test/cursor-provider.test.ts test/index.test.ts`, `npm run typecheck`, and full `npm test`. Live visual audit was not run in this local pass because it requires a live Cursor/pi TUI run with credentials; unit render, provider event, and recorded-result execution tests were used as the closest available evidence.

### Item 4 — Bridge registration scaffold and release flag semantics

**Goal:** Add the bridge module and register it with default-on local semantics plus an explicit opt-out, while keeping the implementation inactive until the provider integration exists.

**Done when:** bridge state is registered; `PI_CURSOR_PI_TOOL_BRIDGE=0` disables it; `PI_CURSOR_PI_TOOL_BRIDGE=1` forces it for tests; local provider runs are wired so the default can flip only after final verification; no new `pi.setActiveTools()` calls exist.

**Key files:** `src/index.ts`, `src/cursor-pi-tool-bridge.ts`, `test/index.test.ts`.

**Dependencies:** Items 1–2.

**Size:** M.

**Status — 2026-05-20:** Complete. Added `src/cursor-pi-tool-bridge.ts`, registered bridge state from `src/index.ts`, kept provider live-run injection out of scope, implemented default-on `PI_CURSOR_PI_TOOL_BRIDGE` semantics with explicit opt-out/force values, and verified the bridge does not call `pi.setActiveTools()`.

### Item 5 — Active tool snapshot and MCP schema mapping

**Goal:** Convert current active pi tools into bridge-exposed MCP tools without hardcoded extension names.

**Done when:** active extension tools are included dynamically, inactive tools are excluded, the explicit legacy replay/internal name list is excluded, schemas/descriptions come from `pi.getAllTools()`, and MCP names map back to real pi names.

**Key files:** `src/cursor-pi-tool-bridge.ts`, `test/cursor-pi-tool-bridge.test.ts`.

**Dependencies:** Items 2 and 4.

**Size:** M.

**Status — 2026-05-20:** Complete. The bridge snapshots `pi.getActiveTools()` against `pi.getAllTools()`, dynamically includes active extension tools, excludes inactive/missing tools and shared Cursor replay/internal names, preserves pi schemas/descriptions as MCP metadata, and maps stable `pi__*` MCP names back to real pi tool names.

### Item 6 — Loopback MCP server lifecycle

**Goal:** Provide a loopback HTTP/SSE MCP endpoint usable by Cursor SDK inline `mcpServers`.

**Done when:** `@modelcontextprotocol/sdk` is added if needed, the server binds only to `127.0.0.1`, per-run endpoints are tokenized, per-run registrations clean up, empty tool snapshots skip MCP injection, and abort/session cleanup rejects pending MCP waits.

**Key files:** `src/cursor-pi-tool-bridge.ts`, `package.json`, `package-lock.json`.

**Dependencies:** Item 5.

**Size:** L.

**Status — 2026-05-20:** Complete. Added `@modelcontextprotocol/sdk`, implemented a tokenized per-run Streamable HTTP MCP endpoint bound to `127.0.0.1`, skipped MCP injection for disabled/empty snapshots, cleaned up per-run endpoints and the shared loopback server, and rejected pending MCP waits on abort/session cleanup. Provider `Agent.create()` injection remains intentionally deferred to Item 7.

### Item 7 — Agent.create MCP injection

**Goal:** Pass bridge MCP config into local `Agent.create()` while preserving model selection, cwd, and setting sources.

**Done when:** tests assert `Agent.create()` receives existing `local` options plus bridge `mcpServers` when enabled and exposed tools exist; disabled or empty snapshots preserve current behavior.

**Key files:** `src/cursor-provider.ts`, `test/cursor-provider.test.ts`.

**Dependencies:** Item 6.

**Size:** M.

**Status — 2026-05-20:** Complete. Provider creation now creates a bridge run when registered, active, and non-empty; passes `mcpServers.pi_tools` into `Agent.create()` while preserving `local.cwd` and `local.settingSources`; disposes inactive bridge runs; and omits MCP injection when `PI_CURSOR_PI_TOOL_BRIDGE=0` or the active snapshot only contains excluded Cursor replay/internal names.

### Item 8 — Live-run state and correlation refactor

**Goal:** Generalize pending Cursor run state so replay events, bridge requests, and bridge correlation share one lifecycle owner.

**Done when:** `CursorPiToolBridgeRun` owns `mcpCallId ↔ bridgeCallId ↔ piToolCallId` maps; provider live-run state stores the bridge run; replay disposal still clears recorded display payloads; tests cover multiple bridge calls in one Cursor run without ID collisions.

**Key files:** `src/cursor-provider.ts`, `src/cursor-pi-tool-bridge.ts`, `test/cursor-provider.test.ts`.

**Dependencies:** Item 7.

**Size:** M.

**Status — 2026-05-20:** Complete. `CursorLiveRun` now carries an optional `bridgeRun`, while `CursorPiToolBridgeRun` owns MCP call ID, bridge call ID, and pi tool-call ID maps. The provider queues bridge requests through the same live-run event/waiter lifecycle used for Cursor replay, keeps recorded replay payload cleanup intact, and tests cover multiple bridge calls in one Cursor run without ID collisions.

### Item 9 — Bridge request to pi tool-use turn

**Goal:** Emit queued MCP bridge requests as real pi tool calls.

**Done when:** a fake bridge request produces `toolcall_*` events with the actual pi tool name and the bridge-owned `piToolCallId`, ends the assistant turn with `toolUse`, does not record replay display payloads, and lets pi execute the active tool through its normal path.

**Key files:** `src/cursor-provider.ts`, `src/cursor-pi-tool-bridge.ts`, `test/cursor-provider.test.ts`.

**Dependencies:** Item 8.

**Size:** L.

**Status — 2026-05-20:** Complete. Queued MCP bridge requests now emit provider `toolcall_start`, `toolcall_delta`, and `toolcall_end` events with the real pi tool names and bridge-owned pi tool-call IDs, stop the assistant turn with `toolUse`, and do not record Cursor replay display payloads. Tests assert emitted `read`/`bash` calls use the requested arguments and leave native replay payload count at zero.

### Item 10 — Resolve pi tool results back to Cursor MCP

**Goal:** Resume the same Cursor SDK run after pi executes a bridged tool.

**Done when:** the next `streamCursor()` invocation resolves the matching `toolResult` through `CursorPiToolBridgeRun`, no new `Agent.create()` occurs, and Cursor continues streaming text or tool activity from the same run.

**Key files:** `src/cursor-provider.ts`, `src/cursor-pi-tool-bridge.ts`, `test/cursor-provider.test.ts`.

**Dependencies:** Item 9.

**Size:** L.

**Status — 2026-05-20:** Complete. Pending live-run replay now resolves matching pi `toolResult` messages through the stored bridge run before continuing the same Cursor SDK run. Tests verify the MCP client receives the pi result content, `Agent.create()` and `agent.send()` are each called once, and Cursor final text streams from the original run.

### Item 11 — Duplicate MCP replay suppression and cleanup hardening

**Goal:** Prevent bridge MCP calls from rendering twice and make pending bridge calls safe under aborts, abandoned runs, and session lifecycle edges.

**Done when:** Cursor SDK MCP events for bridge tool names/call IDs are ignored by replay routing; non-bridge Cursor MCP events still render as safe Cursor activity; abort cancels the Cursor run, rejects pending MCP waits, disposes bridge state, removes recorded replay payloads, leaves no pending live runs, and never re-executes already completed pi tools after run loss.

**Key files:** `src/cursor-provider.ts`, `src/cursor-pi-tool-bridge.ts`, `test/cursor-provider.test.ts`, `test/cursor-tool-transcript.test.ts`.

**Dependencies:** Item 10.

**Size:** M.

**Status — 2026-05-20:** Complete. Bridge MCP events are suppressed by known bridge MCP tool names/call IDs and generic MCP wrapper args, while non-bridge Cursor MCP activity still appears through safe Cursor activity transcript output. Abort, idle disposal, and session shutdown reject pending bridge waits, dispose bridge endpoints/state, and clear live-run state without re-executing pi tools.

### Item 12 — Default-on release flip and docs

**Goal:** Make the verified local bridge the default Cursor provider behavior and update public docs without weakening recorded-replay safety claims.

**Done when:** local Cursor runs expose the bridge by default when active pi tools exist; `PI_CURSOR_PI_TOOL_BRIDGE=0` is documented and tested as rollback; README and docs distinguish Cursor-native tools, the local pi MCP bridge, display-only replay, cloud out-of-scope status, troubleshooting, and the no-synthetic-user-facing-names rule.

**Key files:** `README.md`, `docs/cursor-native-tool-replay.md`, `docs/cursor-model-ux-spec.md`, `docs/plans/cursor-pi-tool-bridge-2026-05-20.md`, `src/cursor-pi-tool-bridge.ts`, `test/index.test.ts`.

**Dependencies:** Items 1–11.

**Size:** M.

**Status — 2026-05-20:** Complete in this pass. README, Cursor native replay docs, and the maintainer UX spec now describe the default local pi MCP bridge, separate Cursor-native tools/settings/MCP, display-only replay safety, cloud out-of-scope status, rollback with `PI_CURSOR_PI_TOOL_BRIDGE=0`, MCP timeout overrides, troubleshooting, and the synthetic-name policy. Validation evidence is recorded under Item 13.

### Item 13 — Final validation pass

**Goal:** Prove the final default-on behavior, safety model, and visual parity before declaring bridge work complete.

**Done when:** `npm test` passes; `npm run typecheck` passes; the targeted bridge tests pass; visual/JSONL audit confirms bridged pi tool calls render as native pi tools; visual/JSONL audit confirms Cursor write/edit replay looks native and shows no synthetic card names; JSONL shows no duplicate MCP replay for bridge calls; docs match observed flags and behavior.

**Key files:** `test/**/*.test.ts`, `docs/cursor-native-tool-visual-audit.md`, `README.md`.

**Dependencies:** Item 12.

**Size:** S.

**Status — 2026-05-20:** Complete for local validation. Evidence gathered in this pass:

- Re-read installed pi docs/examples before relying on API assumptions: dynamic tools and active/all tools (`extensions.md` lines 1217-1229 and 1483-1507), provider-emitted `toolcall_*` events (`custom-provider.md` lines 430-494), tool hooks/results (`extensions.md` lines 672-748), tool rendering (`extensions.md` lines 1977-2007), and examples `dynamic-tools.ts`, `built-in-tool-renderer.ts`, and `tool-override.ts`.
- Targeted Item 13 bridge/provider/replay tests passed: `npx vitest run test/cursor-pi-tool-bridge.test.ts test/cursor-provider.test.ts test/cursor-tool-transcript.test.ts test/context.test.ts test/index.test.ts` → 5 files, 126 tests.
- Full local gate passed: `npm test` → 10 files, 193 tests.
- TypeScript gate passed: `npm run typecheck` (`tsc --noEmit`).
- Added focused assertions for the Item 13 validation gaps found during review: `PI_CURSOR_PI_TOOL_BRIDGE=0` is honored at the extension registration path; bridge MCP activity reported through `onStep` and started-only bridge MCP events are suppressed from Cursor replay/incomplete-start output.
- Docs/code alignment checked and corrected for default-on bridge wording, replay/internal tool-name exclusions, bridge-specific JSONL audit checks, and the plan background that still described the pre-bridge state as current.
- Live offscreen visual/JSONL audit ran with an already available `CURSOR_API_KEY` environment value, without printing the key. Prompt: `Use the local pi MCP bridge read tool to read README.md. Do not use Cursor native file tools, shell, grep, glob, find, ls, edit, or write. After the tool result, print exactly BRIDGE_READ_DONE and stop.` Evidence artifacts:
  - PNG: `/tmp/pi-visual-harness/item13-20260520T191812/item13-bridge-read.png`
  - TXT: `/tmp/pi-visual-harness/item13-20260520T191812/item13-bridge-read.txt`
  - JSONL: `/Users/mitchfultz/.pi/agent/sessions/--Users-mitchfultz-Projects-AI-pi-semantic-code-intelligence--/2026-05-21T01-18-13-799Z_019e481c-9726-7e37-8321-7834543fff69.jsonl`
  - Visual result: the TUI displayed a native `read README.md` card and final `BRIDGE_READ_DONE` text.
  - JSONL facts: exactly one assistant `toolCall` named `read` with ID `cursor-pi-bridge-fcb55267-eb69-4918-97ad-26638c4857f0-tool-1`, exactly one matching `toolResult` named `read`, `isError=false`, no `pi__*`, `mcp`, or `cursor` tool-call/result names, proving no duplicate bridge MCP replay in the persisted session.
- Live edit/write replay visual audit was skipped in this pass because forcing Cursor-native edit/write activity can mutate files and is not needed to prove the default-on bridge safety model. Substitute evidence is the targeted/unit coverage for native-looking edit/write replay and fail-closed recorded-result-only execution in `test/cursor-tool-transcript.test.ts`, `test/cursor-provider.test.ts`, and `test/index.test.ts`, plus the existing replay-card visual audit workflow now updated with bridge-specific JSONL checks.

## Post-smoke follow-ups — 2026-05-20

Smoke session reviewed: `/Users/mitchfultz/.pi/agent/sessions/--Users-mitchfultz-Projects-AI-pi-cursor-sdk--/2026-05-21T01-26-05-844Z_019e4823-cb14-7b91-b584-c17f94a62c09.jsonl`.

- [x] **Follow-up A — Hide overlapping pi tool names from the bridge by default.**
  - Goal: reduce duplicate Cursor-native vs bridged pi tool choices while keeping pi's active tools unchanged.
  - Done when: bridge snapshots exclude overlapping tool names such as `read`, `bash`, `write`, `edit`, `grep`, `find`, and `ls` by default, including when pi's Cursor replay wrapper has registered those names as extension tools; non-overlapping active tools remain exposed; an explicit opt-in exposes all tools; docs/tests cover default and opt-in behavior.
  - Key files: `src/cursor-pi-tool-bridge.ts`, `test/cursor-pi-tool-bridge.test.ts`, `test/cursor-provider.test.ts`, `README.md`, `docs/cursor-native-tool-replay.md`.
  - Status — 2026-05-20: Complete. Bridge snapshots now hide overlapping pi tool names by default, including replay-wrapped tool entries that no longer report `sourceInfo.source === "builtin"`; non-overlapping active tools remain exposed, and `PI_CURSOR_PI_TOOL_BRIDGE_BUILTINS=1` opts in to exposing all otherwise bridgeable active tools. Verified with `npm test -- test/cursor-pi-tool-bridge.test.ts test/cursor-provider.test.ts`, `npm run typecheck`, and full `npm test`.

- [x] **Follow-up B — Fix Cursor native edit/notebook replay validation.**
  - Goal: replayed Cursor `edit`, `StrReplace`, and notebook edit activity must not fail pi `edit` schema validation before the recorded-result replay path can run.
  - Done when: the exact smoke shape with replay `edit` arguments containing only `path` no longer yields `Validation failed for tool "edit"`; incomplete mutation replay either uses schema-valid native-looking edit arguments or falls back to neutral Cursor activity; tests cover recorded-result-only behavior and no real mutation replay.
  - Key files: `src/cursor-tool-transcript.ts`, `src/cursor-native-tool-display.ts`, `test/cursor-tool-transcript.test.ts`, `test/cursor-provider.test.ts`.
  - Status — 2026-05-20: Complete. Path-only Cursor `edit` replay now emits neutral `cursor` activity instead of pi `edit`, so the exact smoke shape `{ "path": ... }` no longer hits pi edit schema validation. Cursor `StrReplace`/schema-complete edits still replay as native-looking pi `edit` with truthful `{ path, edits }` arguments; notebook edit activity falls back to neutral Cursor activity. Neutral Cursor edit summaries use the path only so rendered cards do not duplicate `edit` as `Cursor edit edit ...`. Recorded-result-only safety remains covered, including a regression that missing recorded mutation replay IDs do not execute real file mutations. Verified with `npm test -- test/cursor-tool-transcript.test.ts test/cursor-provider.test.ts`, `npm run typecheck`, full `npm test`, and `git diff --check -- <touched files>`.

- [x] **Follow-up C — Use pi's default card shell for neutral Cursor replay activity.**
  - Goal: neutral Cursor activity such as diagnostics, delete, task, image, and non-bridge MCP replay should visually match pi's normal tool cards, including green success and red error backgrounds.
  - Done when: replay-only Cursor activity tools use pi's default tool shell rather than a custom plain-text shell; tests cover the shell choice; docs identify that neutral Cursor activity uses the default success/error shell.
  - Key files: `src/cursor-native-tool-display.ts`, `test/index.test.ts`, `README.md`, `docs/cursor-native-tool-replay.md`, `docs/cursor-model-ux-spec.md`.
  - Status — 2026-05-20: Complete. Removed the `renderShell: "self"` opt-out from replay-only Cursor activity tools so `ToolExecutionComponent` applies the same default `toolSuccessBg`/`toolErrorBg` wrapper used by native pi tools. Verified with `npm test -- test/index.test.ts test/cursor-tool-transcript.test.ts test/cursor-provider.test.ts`, full `npm test`, `npm run typecheck`, and `git diff --check`.

- [x] **Follow-up D — Improve core file replay highlighting.**
  - Goal: Cursor replay for core file operations should feel first-class inside the card, not just inside the card shell.
  - Done when: replayed edit diffs use pi's native added/removed/context diff color tokens; replayed write previews use path-inferred syntax highlighting when available, with a safe tool-output fallback; tests cover the themed renderer output.
  - Key files: `src/cursor-native-tool-display.ts`, `test/index.test.ts`, `docs/cursor-native-tool-replay.md`, `docs/cursor-model-ux-spec.md`.
  - Status — 2026-05-20: Complete. Cursor edit replay now uses `toolDiffAdded`, `toolDiffRemoved`, and `toolDiffContext` styling for compact numbered diff lines; Cursor write replay attempts pi `highlightCode()` based on `getLanguageFromPath()` and falls back safely when no language/theme is available. Verified with `npm test -- test/index.test.ts`.

## Open Questions

None blocking after the mid-flow checkpoint, design critique, and post-smoke review. The current follow-ups are concrete implementation tasks from live smoke evidence.

## References

- `docs/cursor-native-tool-replay.md`
- `docs/cursor-native-tool-visual-audit.md`
- `docs/cursor-model-ux-spec.md`
- `README.md`
- `src/index.ts`
- `src/context.ts`
- `src/cursor-provider.ts`
- `src/cursor-tool-transcript.ts`
- `src/cursor-native-tool-display.ts`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/dynamic-tools.ts`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/tool-override.ts`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/built-in-tool-renderer.ts`
- https://cursor.com/blog/typescript-sdk
- https://cursor.com/changelog/sdk-release
- https://github.com/cursor/plugins/blob/main/cursor-sdk/skills/cursor-sdk/SKILL.md
