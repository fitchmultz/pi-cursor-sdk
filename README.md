# pi-cursor-sdk

A pi provider extension that lets pi use Cursor models through the local `@cursor/sdk` agent runtime.

Use this extension if you want Cursor's model catalog inside pi while keeping pi's native model picker, thinking controls where the SDK exposes them, session restore, context display, and default footer UX.

## Quick start

1. Install the package:

```bash
pi install npm:pi-cursor-sdk
```

Or install from GitHub:

```bash
pi install https://github.com/fitchmultz/pi-cursor-sdk
```

2. Start pi with a Cursor model:

```bash
pi --model cursor/composer-2.5
```

3. In pi, run `/login`, choose `Use an API key`, choose `Cursor`, and paste your Cursor API key.

If pi started without a key, run `/cursor-refresh-models` after `/login` to refresh the full live Cursor model catalog without restarting pi. Inside pi, use `/model` to choose another Cursor model.

## Requirements

- Node.js 22.19+
- pi
- a Cursor API key saved through `/login`, available as `CURSOR_API_KEY`, or passed with pi's `--api-key`

No global `@cursor/sdk` install is required. This package depends on `@cursor/sdk`, so normal package installation brings in the SDK version this extension was built and tested against.

## Install

### Global install

```bash
pi install npm:pi-cursor-sdk
```

Alternative GitHub install:

```bash
pi install https://github.com/fitchmultz/pi-cursor-sdk
```

### Project-local install

Use `-l` if you want the package recorded in the current project's `.pi/settings.json` instead of your global pi settings:

```bash
pi install -l npm:pi-cursor-sdk
```

### Try from a local checkout

For development from this repository:

```bash
npm install
pi -e . --model cursor/composer-2.5
```

## Configure your Cursor API key

Preferred setup:

```bash
pi --model cursor/composer-2.5
```

Then, inside pi:

1. Run `/login`.
2. Select `Use an API key`.
3. Select `Cursor`.
4. Paste your Cursor API key.
5. The key is saved in pi's native `~/.pi/agent/auth.json`.

If pi started without a key, fallback Cursor models still register so `/login` is reachable. After `/login`, fallback model runs can use the stored key, and `/cursor-refresh-models` refreshes the full live Cursor model catalog discovered from the Cursor SDK without restarting pi.

Environment setup:

```bash
export CURSOR_API_KEY="your-key"
pi --model cursor/composer-2.5
```

One-shot setup:

```bash
pi --api-key "your-key" --model cursor/composer-2.5 --cursor-no-fast -p "Say ok only."
```

Discovery uses pi's native resolution order for this extension: `--api-key`, the stored `cursor` key in `~/.pi/agent/auth.json`, then `CURSOR_API_KEY`.

Do not store the API key in `~/.pi/agent/cursor-sdk.json`. That file is only for non-secret extension state such as Cursor fast defaults. `PATH` is only for executable lookup and should not contain the API key.

## Verify your setup

List Cursor models:

```bash
pi --list-models cursor
```

Expected behavior:

- with a valid key, Cursor models appear under the `cursor` provider
- if discovery cannot authenticate or reach Cursor, pi may still show fallback Cursor models; after adding auth with `/login`, fallback model runs can use the saved key, and `/cursor-refresh-models` refreshes the live catalog

Smoke test:

```bash
pi --model cursor/composer-2.5 --cursor-no-fast -p "Reply with: ok"
```

## Choosing a model

Choose Cursor models interactively with `/model`, or pass a model on the command line:

```bash
pi --model cursor/composer-2.5
pi --model cursor/gpt-5.5@1m
pi --model cursor/gpt-5.5@272k
pi --model cursor/claude-opus-4-7@300k
```

How to read model IDs:

- `cursor/...` is the Cursor provider registered by this extension
- `@1m`, `@272k`, and `@300k` are context-window variants
- `:medium`, `:high`, and `:xhigh` are pi thinking-level suffixes for models where the Cursor SDK exposes a pi-controllable thinking parameter
- unambiguous latest-style Cursor aliases returned by `Cursor.models.list()` are registered too, using the same context suffixes when the target model has context variants; aliases shared by multiple base models or colliding with a base model ID are skipped because their SDK resolution and displayed metadata can diverge

Examples with pi thinking controls:

```bash
pi --model cursor/gpt-5.5@1m:medium
pi --model cursor/gpt-5.5@272k:xhigh
pi --model cursor/gpt-5.5@1m --thinking medium
```

Cursor-only parameters are not encoded into pi model IDs. Cursor `context` becomes a pi-visible model variant because it changes pi's native `contextWindow`; Cursor `fast` is extension state, not model identity. Alias model IDs still share Cursor-only state, such as fast defaults, with their underlying Cursor base model.

## Thinking support

All Cursor SDK models should be treated as thinking-capable Cursor models. The `thinking` column in `pi --list-models` is narrower: it only means pi can control a Cursor SDK thinking parameter for that model.

For models where Cursor exposes `reasoning`, `effort`, or boolean `thinking` parameters, pi's native thinking controls map to Cursor SDK params:

- `reasoning=none|low|medium|high|extra-high`
- `effort=low|medium|high|xhigh|max`
- `thinking=false|true` for boolean thinking models

For Claude models with both `thinking` and `effort`, pi thinking `off` sends `thinking=false` and omits `effort`.

### Why some Cursor models show `thinking=no`

In `pi --list-models`, `thinking=no` means pi cannot control the model's thinking level with `--thinking`, a final `:medium` model suffix, or shift+tab. It does not mean the Cursor model cannot think.

Some Cursor SDK models do not expose a `reasoning`, `effort`, or `thinking` parameter for the extension to set. Cursor thinking is still enabled/supported by the model, and Cursor may still emit thinking deltas. The extension surfaces those deltas through pi's native thinking rendering when the SDK emits them.

## Fast mode

Use `/cursor-fast` to persistently toggle fast mode for the selected Cursor model when the model supports Cursor's `fast` parameter.

Fast preferences are remembered per Cursor base model and stored:

- in the current session with `pi.appendEntry()`
- globally in `~/.pi/agent/cursor-sdk.json`

For one run, force fast on or off without changing saved defaults:

```bash
pi --model cursor/gpt-5.5@1m --cursor-fast -p "Say ok only"
pi --model cursor/composer-2.5 --cursor-no-fast -p "Say ok only"
```

Composer 2 and Composer 2.5 can default to fast. Use `--cursor-no-fast` for a one-shot no-fast Composer run. In print mode (`-p`), `--cursor-no-fast` is silent and does not write `~/.pi/agent/cursor-sdk.json`.

In interactive mode, the footer only shows fast mode when fast is enabled:

```text
cursor fast
```

If you do not see `cursor fast`, fast mode is off.

## Images

Images from the latest user message are forwarded to Cursor. Historical images are kept out of the transcript and appear only as `[image omitted from transcript]` placeholders, so follow-up questions about an earlier image should reattach the image or include a textual description. The extension advertises `text` and `image` input for Cursor models because Cursor's SDK accepts image messages and Cursor models are expected to support them.


## Tools and local pi bridge

Cursor runs use local Cursor SDK agents. Cursor's own local-agent tools, Cursor settings, plugins, and configured Cursor MCP servers remain available through the SDK.

In addition, pi-cursor-sdk exposes the current pi session's bridgeable active tools to Cursor through a local loopback MCP bridge by default. The bridge snapshots `pi.getActiveTools()` and `pi.getAllTools()` for each Cursor run, excludes internal Cursor replay activity names, and hides overlapping built-in pi tools (`read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`) by default because Cursor local agents already have native equivalents. Non-overlapping active tools and extension/custom tools present in pi's active tool registry are exposed as MCP tools with collision-safe names such as `pi__sem_reindex`, and calls map back to the real pi tool names. When Cursor calls a bridged tool, pi executes it through the normal pi tool path, so confirmations, tool hooks, renderers, session history, and abort behavior stay pi-native. The bridge also exposes `cursor_ask_question` as `pi__cursor_ask_question` when enabled, allowing Cursor to ask the user through pi UI instead of silently choosing a default. The bridge does not call tool `execute()` handlers directly.

Bridge controls:

```bash
# Roll back to Cursor SDK tools/settings/MCP only; do not expose active pi tools through the bridge.
PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/composer-2.5

# Opt in to also expose overlapping pi tool names through the bridge.
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 pi --model cursor/composer-2.5

# Override Cursor SDK MCP tool-call timeout, including bridged pi tools and configured Cursor MCP servers.
PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS=7200 pi --model cursor/composer-2.5
PI_CURSOR_MCP_TOOL_TIMEOUT_MS=7200000 pi --model cursor/composer-2.5
```

`PI_CURSOR_PI_TOOL_BRIDGE=0` is the supported rollback flag and disables the bridge entirely. The bridge also treats `false`, `off`, `none`, `no`, and `disabled` as off; `1`, `true`, `on`, `yes`, and `enabled` as on. `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1` opts in to exposing overlapping pi tool names that Cursor already has native equivalents for (`read`, `bash`, `write`, `edit`, `grep`, `find`, and `ls`). By default those names are hidden even when pi's Cursor replay wrapper has registered them as extension tools. The Cursor MCP timeout override defaults to 3600 seconds because the installed Cursor SDK has a 60-second MCP request default that is too short for some local MCP tools, including bridged pi tools and configured Cursor MCP servers.

Cursor-native tool replay is separate from the bridge. Replay only displays completed Cursor SDK tool activity as pi-native-looking cards with recorded results, using pi's normal success/error card shell for neutral Cursor activity too. It never re-runs Cursor-side commands, reapplies Cursor edits, calls MCP servers, or mutates pi state. See [Cursor native tool replay](docs/cursor-native-tool-replay.md).

## Fallback models

If no key is available from `/login`, `CURSOR_API_KEY`, or `--api-key`, model discovery fails, or discovery returns no models, the extension registers a bundled fallback snapshot of the latest reviewed Cursor SDK model catalog and notifies interactive users when possible.

The fallback snapshot includes Composer 2.5 (`composer-2.5` and `composer-2-5`), Composer 2, GPT, Claude, Gemini, Grok, Kimi, and other model IDs exposed by the reviewed `Cursor.models.list()` output. The exact checked-in snapshot lives in `src/cursor-fallback-models.generated.ts`.

Actual Cursor runs still need a key from `/login`, `CURSOR_API_KEY`, or `--api-key`. If you add auth after startup, run `/cursor-refresh-models` to refresh the full live Cursor model catalog without restarting pi.

## Limits

- **Local Cursor SDK agents only.** This extension does not use Cursor cloud agents. Cloud pi tool bridging is out of scope because it needs a separate auth, transport, lifetime, and remote trust design.
- **The pi tool bridge is local and MCP-backed.** Bridgeable active pi tools are exposed to local Cursor agents through a tokenized `127.0.0.1` MCP endpoint; internal Cursor replay activity names are excluded, and overlapping built-in pi tools are hidden by default. Set `PI_CURSOR_PI_TOOL_BRIDGE=0` to disable it or `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1` to expose overlapping built-ins too.
- **Cursor native tool replay is display-only.** Replay renders recorded Cursor SDK activity and never re-runs Cursor-side commands, reapplies Cursor edits, calls MCP servers, or mutates pi state. Workflow tools such as Cursor `SwitchMode` and Cursor todo state are not pi workflow controls. See [Cursor native tool replay](docs/cursor-native-tool-replay.md) for supported replay cards, ordering, conflict handling, and opt-out flags.
- **Cursor run state can span tool-use turns.** A new Cursor SDK agent starts for a new provider run. When Cursor calls bridged pi tools or emits replayed Cursor tool activity, the same Cursor SDK run can stay alive across pi `toolUse` turns so results resume in the original Cursor run.
- **Cursor setting sources default to all.** The extension passes `local.settingSources: ["all"]` by default so configured Cursor MCP servers, plugin tools, project/user settings, and related Cursor-native capabilities are available like they are in Cursor. To narrow loading, set a comma-separated list such as `PI_CURSOR_SETTING_SOURCES=project,user,plugins`. To disable ambient setting sources, set `PI_CURSOR_SETTING_SOURCES=none`. Direct Cursor SDK startup logs are suppressed so setting/skill loading messages do not pollute the TUI.
- **Max Mode is not a manual pi variant.** Cursor's SDK may enable Max Mode automatically for models that require it. This extension only advertises exact context-window variants that the SDK catalog exposes and otherwise uses conservative SDK-derived default/non-Max context windows.
- **Output token limits are conservative.** Cursor SDK model metadata does not currently expose output token limits directly.
- **Token usage is approximate in pi.** Cursor SDK usage events include internal agent/tool/cache work, so the extension reports an approximate replayable pi prompt/output size for context display and compaction decisions.

## Troubleshooting

### I can see Cursor models, but runs fail

You may be seeing fallback startup models or a missing/invalid key. In interactive pi, run `/login`, choose `Use an API key`, choose `Cursor`, paste the key, then run `/cursor-refresh-models`.

You can also restart pi with a key in the same shell or launcher that starts pi:

```bash
export CURSOR_API_KEY="your-key"
pi --model cursor/composer-2.5
```

Or run a one-shot command:

```bash
pi --api-key "your-key" --model cursor/composer-2.5 -p "Say ok only"
```

### `pi --list-models cursor` shows no Cursor models

Confirm the package is installed:

```bash
pi list
```

Then reinstall if needed:

```bash
pi install npm:pi-cursor-sdk
```

### `pi --list-models` shows `thinking=no`

That does not mean the model cannot think. It means the Cursor SDK does not expose a pi-controllable thinking parameter for that model. The model may still think internally and may still emit thinking deltas that pi renders natively.

### I do not see `cursor fast` in the footer

Fast mode is currently off. The footer only shows `cursor fast` when fast mode is enabled.

### My Cursor app settings or rules do not seem to apply

Cursor setting sources are loaded with `PI_CURSOR_SETTING_SOURCES=all` by default. To narrow loading, set `PI_CURSOR_SETTING_SOURCES=project,user,plugins` or another comma-separated list. If you explicitly disabled sources with `PI_CURSOR_SETTING_SOURCES=none`, remove that override.

### Cursor does not call my web search MCP/tool

Cursor SDK local agents load MCP servers from Cursor setting sources and inline SDK config. This extension enables all Cursor setting sources by default, so a missing web search tool usually means it is not configured in Cursor or the run was started with a narrowing/disable override such as `PI_CURSOR_SETTING_SOURCES=none`.

### Cursor does not call my pi extension tool

The local pi bridge only exposes tools that are active in the current pi session and present in pi's tool registry at Cursor run start. By default, it does not expose overlapping pi tool names that Cursor already has native equivalents for (`read`, `bash`, `write`, `edit`, `grep`, `find`, and `ls`). Opt in if you intentionally want Cursor to see both the Cursor-native tool and an overlapping built-in pi tool:

```bash
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 pi --model cursor/composer-2.5
```

To disable the bridge for rollback or isolation, start pi with:

```bash
PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/composer-2.5
```

### A Cursor MCP tool times out

The extension raises Cursor SDK's MCP tool-call timeout from 60 seconds to 3600 seconds by default for Cursor SDK MCP `callTool` requests, including the local pi bridge and configured Cursor MCP servers. For longer local MCP tools, set one override:

```bash
PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS=7200 pi --model cursor/composer-2.5
PI_CURSOR_MCP_TOOL_TIMEOUT_MS=7200000 pi --model cursor/composer-2.5
```

### Cursor native tool cards conflict with another extension

Cursor native replay is a UI enhancement for interactive TTY sessions. See [Cursor native tool replay](docs/cursor-native-tool-replay.md) for conflict behavior and opt-out flags.

## Development

Run checks:

```bash
npm test
npm run typecheck
```

Refresh the reviewable Cursor fallback catalog before releases or after Cursor model changes:

```bash
CURSOR_API_KEY="your-key" npm run refresh:cursor-snapshots -- --write
```

Refresh the bundled default/non-Max context-window snapshot only when checkpoint-derived context windows have been collected from live local runs:

```bash
CURSOR_API_KEY="your-key" npm run refresh:cursor-snapshots -- --write \
  --context-windows ~/.pi/agent/cursor-sdk-context-windows.json
```

The refresh script writes public model metadata only and scrubs known auth material from SDK errors. It must not be run with shell tracing that would echo API keys.

Local development run:

```bash
npm install
CURSOR_API_KEY="your-key" pi -e . --model cursor/composer-2.5
```

Maintainer design notes live in [`docs/cursor-model-ux-spec.md`](docs/cursor-model-ux-spec.md).

## License

MIT
