# Cursor tool surfaces in pi

pi-cursor-sdk runs Cursor models through the local `@cursor/sdk` agent runtime by default. Default lean mode exposes only Pi tools; legacy mode can expose **three related but different** tool namespaces. This page is the user-facing guide; maintainer replay details live in [Cursor native tool replay](./cursor-native-tool-replay.md).

## Pi-tools-only mode

Lean mode is enabled by default (`PI_CURSOR_LEAN` unset or `1`). Only the Pi bridge is callable. Pi built-ins declared in the model request are included automatically; native Cursor tools (including web search and subagents) and ambient Cursor MCP/settings are disabled. Both create and resume use SDK `tools: ["mcp"]` with a nonempty bridge, or text-only `tools: []` with an empty bridge, and `local.settingSources: []`. Only the internal Pi MCP endpoint is supplied.

Pi's own instructions, skills, and `AGENTS.md` / `CLAUDE.md` context remain intact without duplicate Cursor loading. The extension does not add replay, question, or skill-activation wrappers or rewrite the skill catalog. Pi tool toggles and native request projection control direct exposure: only active, request-declared tools are bridged. An empty request tool list means no bridge tools. A permitted Pi/MCP tool can still execute arbitrary work; this is not a sandbox or OS security boundary.

### Built-in CodeMode and MCP

Pi's built-in `codemode`, `tool_search`, and MCP extension keep their native execution and permission checks. The bridge intersects the model's tool declarations with Pi's active registry, preserving projected descriptions and schemas. In CodeMode `only` mode, nested tools such as `bash` are not separately exposed as direct `pi__*` tools; the `codemode` description retains Pi's nested catalog.

Cursor calls `pi__codemode` with JSON arguments `{"code":"<JavaScript source>"}`, even though Pi's native description asks for raw JavaScript. Inside the script, use native Pi names such as `tools.bash(...)` and `tools.mcp__server__tool(...)`, not `pi__*` names. Use `await searchTools(query)`, `await describeTool(name)`, `await describeNamespace(server)`, or `ALL_TOOLS` for discovery, and `text(value)` or `return` for output.

Pi's MCP exposure settings determine which tools are direct, nested, deferred, or hidden. Hidden tools stay unavailable. Nested calls still pass through Pi's normal permission pipeline, and Pi records nested calls and CodeMode store entries in its session. A missing direct bridge name does not imply a tool is unavailable inside CodeMode. Configure these built-ins and MCP servers in Pi, not Cursor's ambient MCP configuration.

Lean mode overrides `PI_CURSOR_PI_TOOL_BRIDGE=0`, `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=0`, and `PI_CURSOR_SETTING_SOURCES`. `PI_CURSOR_NATIVE_TOOLS=1` cannot re-enable native tools in lean mode. Lean requires local runtime and rejects Cloud before agent creation or lifecycle side effects. Set `PI_CURSOR_LEAN=0` at startup to restore the legacy hybrid surface or use Cloud; **restart Pi when changing the flag**. Boolean parsing is canonical: explicit false/off values disable lean, while blank/unrecognized/unset keeps it on. See [Pi-tools-only mode](../README.md#pi-tools-only-mode) for setup. Legacy-only behavior is labeled below; bridge execution and diagnostics apply to both modes.

## The three surfaces

The following table describes legacy mode (`PI_CURSOR_LEAN=0`). Default lean mode exposes only the Pi bridge described above.

**Version boundary:** the MCP-only opt-out (`PI_CURSOR_NATIVE_TOOLS`) and `/cursor-abort` require **0.5.4 or later**, including [#372](https://github.com/fitchmultz/pi-cursor-sdk/pull/372). Published **0.5.3 ignores the flag and has no such command**. Verify the installed version before relying on these controls; a development version label alone does not prove availability.

| Surface | Who owns it | Callable by Cursor? | What pi shows |
| --- | --- | --- | --- |
| **Cursor SDK host tools** | Cursor local agent | Yes by default; disabled with `PI_CURSOR_NATIVE_TOOLS=0` | Native replay cards (`read`, `bash`, …) or neutral Cursor activity. Representative ToolType list: [SDK ToolType replay matrix](./cursor-native-tool-replay.md#sdk-tooltype-replay-matrix). |
| **Configured Cursor MCP** | Cursor settings / `~/.cursor/mcp.json` | Yes (when loaded) | Neutral **Cursor MCP** activity cards on replay |
| **Pi bridge (`pi__*`)** | pi-cursor-sdk loopback MCP | Yes, when exposed | Real pi tool names (`cursor_ask_question`, `cursor_activate_skill`, extension tools, …) |

Pi CLI tool toggles apply at the Pi tool-registry boundary. In legacy mode they can remove Pi bridge exposure, but do **not** disable Cursor SDK host tools or configured Cursor MCP servers. Lean has already disabled those native/ambient surfaces, so Pi's direct request declarations and nested-tool policies control what remains.

**Not callable:** `cursor-replay-*` IDs in JSONL, pi history tool names used only for display, and transcript labels. Cursor must call exposed `pi__*` MCP names for bridged pi tools, not the pi card name.

## Opt-in MCP-only local turns

This legacy-only section requires `PI_CURSOR_LEAN=0` and the supporting installed version described above; the controls are not available in published npm 0.5.3. Lean already uses a stricter Pi-only surface.

`PI_CURSOR_NATIVE_TOOLS=0` restricts **ordinary LOCAL** agents through the public SDK `AgentOptions.tools: ["mcp"]`, independently of whether the Pi bridge is empty. SDK 1.0.40's `mcp` group permits the entire MCP family, not just Pi's endpoint. All other main-agent tools are omitted, including native `task`/subagents (whose own curated toolsets do not inherit a main-loop restriction). Unset, blank, unrecognized, or enabled values preserve the SDK's default toolset. The canonical boolean parser accepts `0`, `false`, `off`, `none`, `no`, and `disabled` as off, and `1`, `true`, `on`, `yes`, and `enabled` as on, case-insensitively with surrounding whitespace ignored.

To send file/shell work through Pi's normal execution and `tool_call` hook boundary instead of native Cursor tools:

```bash
# Verify the installed version supports these controls (0.5.3 ignores the flag).
PI_CURSOR_LEAN=0 PI_CURSOR_NATIVE_TOOLS=0 PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 PI_CURSOR_SETTING_SOURCES=none pi --model cursor/grok-4.6
```

The builtin-exposure flag is still required; disabling native tools does **not** silently expose Pi builtins. Pi's active tool registry and hooks still decide which bridged tools are available or blocked. Disabling the bridge as well leaves no Pi tools callable, but does not by itself disable configured Cursor MCP.

**MCP-only is not Pi-only or a sandbox.** The SDK `mcp` capability group retains configured Cursor MCP and the Pi bridge. Ambient configured MCP remains unless setting sources are narrowed or disabled (`PI_CURSOR_SETTING_SOURCES=none`). Non-Pi MCP calls do not pass through Pi's `tool_call` hooks. A permitted Pi or MCP tool can itself run a shell, access files/network, or delegate arbitrary work; this is no OS/process security boundary.

**Native replay cannot enforce a pre-execution policy.** Native Cursor work runs before its recorded result is replayed into Pi. Pi `tool_call` hooks may block a bridged Pi call before its real `execute()`, but blocking or rewriting native replay cannot prevent or transform the original Cursor command. `PI_CURSOR_NATIVE_TOOL_DISPLAY=0`, `PI_CURSOR_REGISTER_NATIVE_TOOLS=0`, Pi tool toggles, and `PI_CURSOR_PI_TOOL_BRIDGE=0` are not native execution controls. Use the SDK tool-surface opt-out rather than fabricated pre-execution callbacks.

The policy is captured before drain/acquisition and forwarded identically to create and resume (SDK tool restrictions are not persisted by Cursor). Lean and legacy native-opt-out agents have distinct pooled/durable compatibility identities; unrestricted legacy agents retain historical identity bytes. Changing policy replaces the agent at acquisition instead of reusing/resuming one with the opposite policy. Before draining a pending run, the provider checks its captured policy under the drain lease and rejects an opposite-policy continuation without delivering Pi results back to that SDK run. Ordinary mismatch does not cancel the old run: restore the prior policy to finish it, or invoke `/cursor-abort` to release the exact pending local run owned by this session before retrying. This command sends no model turn. If its owned run has an active Cursor Pi turn, it also invokes that turn's public abort before release; it does not abort a non-Cursor Pi turn or release sibling sessions or Cloud agents. Pi's normal abort only signals an active Pi turn; once the mismatch error has fully settled, idle Pi abort cannot reach that older Cursor waiter. Explicit active provider abort still releases its exact scoped pending run even when the signal was aborted before preparation. No recovery path undoes already-executed work. Fresh text-only LOCAL compaction/tree summary agents continue using `tools: []`, independently of this flag. Cloud with explicit native tools disabled fails before SDK creation or lifecycle side effects rather than silently ignoring the control.

## Discoverability

- **MCP `listTools`** lists MCP tools — for example tools from `pi_tools` using their current `pi__*` bridge names. It does **not** enumerate Cursor SDK host tools such as `Read` or `Shell`.
- **Bootstrap prompts** include a short **Cursor SDK tool boundary** block plus a compact **callable tool surfaces** manifest by default (disable the manifest with `PI_CURSOR_TOOL_MANIFEST=0`). The manifest describes the captured mode/policy and current bridge names. Lean advertises only Pi tools; legacy distinguishes available Cursor host/configured MCP tools and their separate controls. Native-disabled policies do not advertise host tools as available. MCP `listTools` entries point back to the bootstrap prompt instead of repeating the full contract.
- **Incremental prompts** omit the full boundary block but keep a policy-aware tail guard; legacy native-shell guidance includes an explicit `cd` hint. The session agent retains prior bootstrap context. Invariant Pi system instructions are omitted; changed instructions force bootstrap with the new section.
- **CodeMode routing:** built-in `codemode` uses the routing above. Any additional extension routing is conditional on its actual exposed tools and schemas; no historical aliases are required. CodeMode's catalog determines nested availability; registration alone does not make a tool callable.
- **In-session debug:** `/cursor-tools` prints bridge/manifest enablement, effective `PI_CURSOR_SETTING_SOURCES`, and current-registry exposure eligibility, including the builtin-exposure setting. Native request projection can further hide direct tools. This report is not a live-run catalog or health check.

## Diagnosing advertised but unused bridge tools

Enable `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` before the turn. The existing scrubbed stderr records correlate observations by safe run ID:

| Record | What it establishes |
| --- | --- |
| `run_created` / `tools_exposed` | Run exposure and pi↔MCP name mapping, not connection |
| `mcp_initialized` | Server receipt of validated `notifications/initialized` |
| `mcp_tools_list` | Catalog-handler output after request validation, with `toolCount` |
| `request_queued` / `request_resolved` / `request_rejected` | Actual bridge call handling |

Initialization/catalog receipts are server observations, not Cursor-client identity, response delivery, model consumption or ongoing health. Absence does not explain why no request occurred. `/cursor-tools` reflects the registry now, not an earlier run's captured surface; exposure alone is not invocation proof. These diagnostics do not enumerate Cursor-configured MCP connections. Do not share logs where tool names are sensitive; endpoint credentials and raw args/results are excluded.

For an advertised-but-unused Pi delegation tool, use its actual exposed name and first identify the active provider/version (especially with multiple Cursor providers installed), then compare the run's exposure, initialization/catalog and call records with persisted pi `toolCall`/`toolResult` rows. Bash-spawned Pi is not evidence of bridged `subagent` execution. The original Windows/two-provider report remains open in [#206](https://github.com/fitchmultz/pi-cursor-sdk/issues/206).

## Pi bridge vs Cursor native

Legacy behavior (`PI_CURSOR_LEAN=0`):

- Cursor host tools handle files, shell, grep, and edits.
- Prefer exposed `pi__*` tools for the capabilities described by their current schemas and prompt guidelines, including delegation or MCP work. Use Cursor-configured MCP or Cursor-native subagents only when no matching exposed Pi tool is available; do not assume a particular delegation tool name is registered.
- The pi bridge exposes **active pi tools** as `pi__*` MCP names when `PI_CURSOR_PI_TOOL_BRIDGE` is enabled (default on).
- Overlapping pi builtins (`read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`) are **hidden** from the bridge unless `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1`.

`pi-cursor-sdk` registers `cursor_ask_question` for Cursor models when the bridge is on and `PI_CURSOR_ASK_QUESTION=1`; Cursor sees `pi__cursor_ask_question`. The tool is sequential and emits `pi-cursor-sdk:ask-question:blocked` `{ active }` while awaiting UI input. It is off by default so Cursor proceeds with a stated assumption instead of prompting. Pending bridged calls use a local deadline capped by the effective MCP tool timeout; `PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS` can lower it. When pi has visible Agent Skills loaded, the extension also rewrites pi's skill catalog for Cursor and activates `cursor_activate_skill`; Cursor sees `pi__cursor_activate_skill` and should call it with a listed skill name before applying that skill. The activation result returns the full `SKILL.md`, the skill directory for relative paths, and a bounded list of bundled `scripts/`, `references/`, and `assets/` files without eagerly reading those resources.

```bash
# Enable Cursor's interactive question tool
PI_CURSOR_LEAN=0 PI_CURSOR_ASK_QUESTION=1 pi --model cursor/grok-4.6

# Disable pi bridge entirely
PI_CURSOR_LEAN=0 PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/grok-4.6

# Expose overlapping pi builtins through the bridge
PI_CURSOR_LEAN=0 PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 pi --model cursor/grok-4.6

# Fail a stranded bridge call sooner than the effective MCP tool timeout
PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS=120000 pi --model cursor/grok-4.6

# Announce the bridge URL as localhost and listen on a port or range (for example for a Cursor team MCP allowlist such as http://localhost:800*/mcp).
PI_CURSOR_PI_TOOL_BRIDGE_HOST=localhost PI_CURSOR_PI_TOOL_BRIDGE_PORT=8000-8009 pi --model cursor/grok-4.6

# Disable bootstrap tool manifest
PI_CURSOR_TOOL_MANIFEST=0 pi --model cursor/grok-4.6
```

For `localhost`, the bridge owns both `127.0.0.1` and `::1` on the selected port before advertising its URL; a conflict on either family skips the port, and missing IPv6 fails closed. The default remains IPv4-only. Host/port settings are captured for the shared server lifetime, not changed under active runs; dispose all its runs before changing them.

## Runtime and transport policy

Current defaults:

- Local runtime is the default.
- The pi bridge uses loopback MCP and is the sole implemented Pi-tool transport for local Cursor agents.
- SDK `local.customTools` remains deferred and needs SDK cancellation/deadline support before it can replace the loopback MCP bridge; no transport config is exposed.
- Cloud requires opting out of lean mode (`PI_CURSOR_LEAN=0`) and leaving native tools enabled. Explicit cloud runtime selection then requires first-use acknowledgement (`/cursor-runtime cloud`, `/cursor-runtime cloud --save-user`, `--cursor-cloud-ack`, or `PI_CURSOR_CLOUD_ACK=1`) plus preflight. Project config may save a cloud runtime default but not the acknowledgement. Cloud runs use fresh context by default and do **not** get local pi tools through loopback MCP or `local.customTools`; cloud Pi-tool access would require a separate secure remote bridge and a new product decision.
- Inline cloud MCP is not exposed in the initial cloud runtime because live probes showed first-run/replacement/resume behavior was not deterministic enough.

## Cursor settings vs pi toggles

Default lean disables ambient Cursor MCP. In legacy mode, disabling or removing an MCP server **only in Pi** does not remove Cursor ambient MCP loaded from Cursor config.

| Control | Effect |
| --- | --- |
| `PI_CURSOR_LEAN` unset / `1` (default) | Only active, request-declared Pi bridge tools; nested availability follows Pi. Forces bridge/built-in exposure on and Cursor setting sources off. Local-only; no replay/question/skill wrappers. |
| `PI_CURSOR_LEAN=0` | Restore the legacy hybrid policy; restart Pi to change modes. |
| `pi --no-tools` | Removes Pi bridge exposure. Lean becomes text-only; legacy Cursor host/configured MCP tools remain subject to their own controls. |
| `pi --tools ...` / `pi --exclude-tools ...` | Narrows Pi's active registry and bridge snapshot. Lean also intersects the request declarations; nested tools follow Pi's own exposure policy. Legacy Cursor host/configured MCP tools are unchanged. |
| `PI_CURSOR_NATIVE_TOOLS=0` | In legacy mode, ordinary LOCAL main-agent tools are MCP-only, including disabling native task/subagents; does not force built-in exposure or remove ambient MCP. Cloud fails closed. Cannot relax lean. |
| `PI_CURSOR_PI_TOOL_BRIDGE=0` | Disables the bridge only in legacy mode; lean overrides it. |
| `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1` | Exposes overlapping Pi built-ins in legacy mode; lean already includes them. |
| `PI_CURSOR_SETTING_SOURCES=all` | Legacy default: load user/project Cursor MCP, plugins, rules (`~/.cursor/mcp.json`, etc.). Lean overrides to `[]`. |
| `PI_CURSOR_SETTING_SOURCES=none` | Disables ambient Cursor setting sources for legacy local agents; already forced in lean. |
| `PI_CURSOR_SETTING_SOURCES=project,plugins` | Narrows layers in legacy mode; ignored by lean. |
| Empty or edited `~/.cursor/mcp.json` | Changes legacy user MCP loading; lean does not load this file. |

To reproduce a **minimal legacy** surface (pi-cursor-sdk + Cursor host only), start with `PI_CURSOR_LEAN=0 PI_CURSOR_PI_TOOL_BRIDGE=0 PI_CURSOR_SETTING_SOURCES=none pi --model cursor/grok-4.6` using an extension-only install. This is not a Pi-only surface or a sandbox.

## JSONL ID patterns (debugging)

| ID prefix | Meaning |
| --- | --- |
| `cursor-replay-*` | Display-only replay of Cursor SDK activity |
| `cursor-pi-bridge-run-*` (run) / `cursor-pi-bridge-<32 hex>-t<counter>` (tool) | Live pi execution via bridge |

Example mistake: treating `cursor-replay-…` as a tool to invoke. Replay never re-runs work.

## Related docs

- [Reference — Cursor provider tool contract](reference.md#cursor-provider-tool-contract)
- [Cursor native tool replay](./cursor-native-tool-replay.md)
- [Cursor model UX spec](./cursor-model-ux-spec.md)
