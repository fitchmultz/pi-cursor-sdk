# Cursor tool surfaces in pi

pi-cursor-sdk runs Cursor models through the local `@cursor/sdk` agent runtime by default. A local pi session can expose **three related but different** tool namespaces. This page is the user-facing guide; maintainer replay details live in [Cursor native tool replay](./cursor-native-tool-replay.md).

## The three surfaces

| Surface | Who owns it | Callable by Cursor? | What pi shows |
| --- | --- | --- | --- |
| **Cursor SDK host tools** | Cursor local agent | Yes | Native replay cards (`read`, `bash`, …) or neutral Cursor activity. Representative ToolType list: [SDK ToolType replay matrix](./cursor-native-tool-replay.md#sdk-tooltype-replay-matrix). |
| **Configured Cursor MCP** | Cursor settings / `~/.cursor/mcp.json` | Yes (when loaded) | Neutral **Cursor MCP** activity cards on replay |
| **Pi bridge (`pi__*`)** | pi-cursor-sdk loopback MCP | Yes, when exposed | Real pi tool names (`cursor_ask_question`, `cursor_activate_skill`, extension tools, …) |

Pi CLI tool toggles apply at the pi tool-registry boundary. `--no-tools`, `--tools`, and `--exclude-tools` can remove pi bridge exposure, but they do **not** disable Cursor SDK host tools or configured Cursor MCP servers.

**Not callable:** `cursor-replay-*` IDs in JSONL, pi history tool names used only for display, and transcript labels. Cursor must call exposed `pi__*` MCP names for bridged pi tools, not the pi card name.

## Discoverability

- **MCP `listTools`** (and pi's MCP catalog when present) lists **MCP servers only** — for example `pi_tools` with `pi__cursor_ask_question`. It does **not** enumerate Cursor SDK host tools such as `Read` or `Shell`.
- **Bootstrap prompts** include a short **Cursor SDK tool boundary** block plus a compact **callable tool surfaces** manifest by default (disable manifest with `PI_CURSOR_TOOL_MANIFEST=0`). The manifest reminds the model that Cursor host/configured MCP tools are controlled by Cursor, while pi tool toggles only affect pi tools/bridge exposure; when bridge tools are exposed, it lists the current `pi__*` names. MCP `listTools` entries for bridged pi tools point back to the bootstrap prompt instead of repeating the full contract.
- **Incremental prompts** omit the full boundary block but keep a short tail guard (including an explicit shell `cd` hint); the session agent retains prior bootstrap context.
- **In-session debug:** `/cursor-tools` prints bridge enablement, manifest enablement, effective `PI_CURSOR_SETTING_SOURCES`, and the current callable-surface snapshot.

## Pi bridge vs Cursor native

Default behavior:

- Cursor host tools handle files, shell, grep, and edits.
- When exposed, `pi__mcp` is preferred for MCP work and `pi__subagent` is preferred for delegation. Cursor-configured MCP and Cursor-native subagents are fallbacks when the matching pi tool is not exposed or is unavailable.
- The pi bridge exposes **active pi tools** as `pi__*` MCP names when `PI_CURSOR_PI_TOOL_BRIDGE` is enabled (default on).
- Overlapping pi builtins (`read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`) are **hidden** from the bridge unless `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1`.

`pi-cursor-sdk` registers `cursor_ask_question` for Cursor models when the bridge is on and `PI_CURSOR_ASK_QUESTION` is enabled (the default); Cursor sees `pi__cursor_ask_question`. Set `PI_CURSOR_ASK_QUESTION=0` to remove only this tool while preserving the rest of the bridge. Pending bridged calls use a local deadline capped by the effective MCP tool timeout; `PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS` can lower it. When pi has visible Agent Skills loaded, the extension also rewrites pi's skill catalog for Cursor and activates `cursor_activate_skill`; Cursor sees `pi__cursor_activate_skill` and should call it with a listed skill name before applying that skill. The activation result returns the full `SKILL.md`, the skill directory for relative paths, and a bounded list of bundled `scripts/`, `references/`, and `assets/` files without eagerly reading those resources.

```bash
# Disable only Cursor's interactive question tool
PI_CURSOR_ASK_QUESTION=0 pi --model cursor/composer-2-5

# Disable pi bridge entirely
PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/composer-2-5

# Expose overlapping pi builtins through the bridge
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 pi --model cursor/composer-2-5

# Fail a stranded bridge call sooner than the effective MCP tool timeout
PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS=120000 pi --model cursor/composer-2-5

# Disable bootstrap tool manifest
PI_CURSOR_TOOL_MANIFEST=0 pi --model cursor/composer-2-5
```

## Runtime and transport policy

Current defaults:

- Local runtime is the default.
- The pi bridge uses loopback MCP and is the sole implemented Pi-tool transport for local Cursor agents.
- SDK `local.customTools` remains deferred and needs SDK cancellation/deadline support before it can replace the loopback MCP bridge; no transport config is exposed.
- Explicit cloud runtime selection requires first-use acknowledgement (`/cursor-runtime cloud`, `/cursor-runtime cloud --save-user`, `--cursor-cloud-ack`, or `PI_CURSOR_CLOUD_ACK=1`) plus preflight. Project config may save a cloud runtime default but not the acknowledgement. Cloud runs use fresh context by default and do **not** get local pi tools through loopback MCP or `local.customTools`; cloud Pi-tool access would require a separate secure remote bridge and a new product decision.
- Inline cloud MCP is not exposed in the initial cloud runtime because live probes showed first-run/replacement/resume behavior was not deterministic enough.

## Cursor settings vs pi toggles

Disabling or removing an MCP server **only in pi** does not remove Cursor ambient MCP loaded from Cursor config.

| Control | Effect |
| --- | --- |
| `pi --no-tools` | Disables pi built-in/extension/custom tools and therefore removes pi bridge exposure; Cursor SDK host tools still remain callable. |
| `pi --tools ...` / `pi --exclude-tools ...` | Narrows pi's active tool registry and therefore the pi bridge snapshot; Cursor SDK host tools and configured Cursor MCP are unchanged. |
| `PI_CURSOR_SETTING_SOURCES=all` (default) | Loads user/project Cursor MCP, plugins, rules (`~/.cursor/mcp.json`, etc.) |
| `PI_CURSOR_SETTING_SOURCES=none` | Disables ambient Cursor setting sources for local agents |
| `PI_CURSOR_SETTING_SOURCES=project,plugins` | Narrows which layers load |
| Empty or edited `~/.cursor/mcp.json` | Changes which user MCP servers Cursor connects to |

To reproduce a **minimal** surface (pi-cursor-sdk + Cursor host only), use extension-only install, empty user MCP config, and `PI_CURSOR_SETTING_SOURCES=none` when you do not need Cursor rules/MCP from disk.

## JSONL ID patterns (debugging)

| ID prefix | Meaning |
| --- | --- |
| `cursor-replay-*` | Display-only replay of Cursor SDK activity |
| `cursor-pi-bridge-run-*` | Live pi execution via bridge |

Example mistake: treating `cursor-replay-…` as a tool to invoke. Replay never re-runs work.

## Related docs

- [README — Cursor provider tool contract](../README.md#cursor-provider-tool-contract)
- [Cursor native tool replay](./cursor-native-tool-replay.md)
- [Cursor model UX spec](./cursor-model-ux-spec.md)
