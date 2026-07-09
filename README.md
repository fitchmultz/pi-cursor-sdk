# pi-cursor-sdk

A pi provider extension that lets pi use Cursor models through the local-by-default `@cursor/sdk` agent runtime, with explicit minimal Cursor Cloud opt-in.

Use this extension if you primarily use Cursor models inside pi and want Cursor's SDK agent loop preserved while pi adds native model selection, auth, thinking/context controls, session behavior, replay UI, optional local pi tool bridging, and explicit cloud runs when requested.

## Why use this instead of an OpenAI-compatible Cursor endpoint?

Use `pi-cursor-sdk` when you primarily want to use Cursor models **inside pi**.

This extension runs Cursor models through `@cursor/sdk` and keeps Cursor's agent loop intact. Local remains the default; explicit cloud runtime starts Cursor Cloud after acknowledgement and preflight. pi integrates around that loop: model discovery, model selection, context-window variants, thinking controls where Cursor exposes them, fast/slow aliases, Cursor mode, session handling, native replay cards, and the optional local pi tool bridge.

OpenAI-compatible Cursor proxies are useful when you want a generic `/v1/chat/completions` or `/v1/responses` endpoint for many clients such as curl, the OpenAI SDK, OpenCode, or other tools. That compatibility comes from translating Cursor behavior into OpenAI-shaped requests, responses, and tool calls.

For pi users, that translation is usually the wrong abstraction. `pi-cursor-sdk` is pi-specific on purpose: it lets Cursor remain Cursor while making it feel native in pi.

| If you want... | Prefer |
| --- | --- |
| First-class Cursor usage inside pi | `pi-cursor-sdk` |
| Cursor's local SDK agent loop preserved, not replaced by an OpenAI-shaped adapter | `pi-cursor-sdk` |
| pi model picker, `/login`, `/model`, sessions, context display, footer/status UX | `pi-cursor-sdk` |
| Cursor SDK local-agent tools, settings, MCP, and native replay surfaced in pi | `pi-cursor-sdk` |
| pi extension tools exposed to Cursor through a local MCP bridge | `pi-cursor-sdk` |
| A generic OpenAI-compatible localhost `/v1` API for non-pi clients | An OpenAI-compatible Cursor proxy |
| One Cursor-ish endpoint shared across several unrelated tools | An OpenAI-compatible Cursor proxy |

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
pi --model cursor/composer-2-5
```

3. In pi, run `/login`, choose `Use an API key`, choose `Cursor`, and paste your Cursor SDK API key.

If pi started without a key, run `/cursor-refresh-models` after `/login` to refresh the full live Cursor model catalog without restarting pi. Inside pi, use `/model` to choose another Cursor model.

## Requirements

- Node.js 22.19+
- pi 0.80.3 or newer recommended; pi core peer metadata is intentionally unpinned so newer pi releases are not blocked
- a Cursor SDK API key saved through `/login`, available as `CURSOR_API_KEY`, or passed with pi's `--api-key`

No global `@cursor/sdk` install is required. This package depends on exact `@cursor/sdk@1.0.23`, so normal package installation brings in the SDK version this extension was built and tested against. Cursor SDK 1.0.23 declares its Node ConnectRPC transport dependency directly, so npm installs place `@connectrpc/connect-node` where the SDK can resolve it. The extension intentionally does not bundle `@cursor/sdk` or its platform packages, because packing from one maintainer OS can otherwise ship the wrong optional SDK binary for another OS. Cursor SDK 1.0.23 keeps the older `sqlite3 -> node-gyp@8` dependency chain out of the runtime tree, so deprecated install warnings for `inflight`, `rimraf`, `glob@7`, `npmlog`, `gauge`, `are-we-there-yet`, and `tar@6` from that chain are not expected. This package follows pi package guidance by declaring pi core package peers with `"*"` ranges, so users who update pi before this extension is republished are not blocked by peer metadata. The current recommended and validated pi baseline is 0.80.3 plus Cursor SDK 1.0.23; older pi compatibility paths are best-effort and older Cursor SDK compatibility paths are not maintained.

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
pi --approve -e . --model cursor/composer-2-5
```

## Configure your Cursor SDK API key

`pi-cursor-sdk` passes an explicit API key to the Cursor SDK. It does **not** reuse Cursor Agent CLI login, Cursor Desktop login, or Cursor subscription/OAuth state shown by `agent status`.

Use either a user API key from Cursor Dashboard → Integrations or a service account API key from Team settings. Team Admin API keys are not supported by the Cursor SDK. Then configure the key with one of the methods below.

Preferred setup:

```bash
pi --model cursor/composer-2-5
```

Then, inside pi:

1. Run `/login`.
2. Select `Use an API key`.
3. Select `Cursor`.
4. Paste your Cursor SDK API key.
5. The key is saved in pi's native `~/.pi/agent/auth.json`.

If pi started without a key, fallback Cursor models still register so `/login` is reachable. After `/login`, fallback model runs can use the stored key, and `/cursor-refresh-models` refreshes the full live Cursor model catalog discovered from the Cursor SDK without restarting pi.

Note: if `/login` shows `Cursor ✓ key in models.json` but you have not saved a Cursor key and `CURSOR_API_KEY` is unset, that status is a pi auth-status limitation. A real Cursor SDK API key is still required for Cursor runs.

Environment setup:

```bash
export CURSOR_API_KEY="your-key"
pi --model cursor/composer-2-5
```

One-shot setup:

```bash
pi --api-key "your-key" --model cursor/composer-2-5 --cursor-no-fast -p "Say ok only."
```

Discovery uses pi's native resolution order for this extension: `--api-key`, the stored `cursor` key in `~/.pi/agent/auth.json`, then `CURSOR_API_KEY`.

### Model catalog cache

To avoid a live `Cursor.models.list` network round-trip on every pi startup, the discovered catalog is cached on disk at `~/.pi/agent/cursor-sdk-model-list.json` (written `0600`, keyed by an API-key fingerprint — the key itself is never stored). Warm startups within the cache TTL skip the network call and avoid loading `@cursor/sdk` until a Cursor turn needs it; `/cursor-refresh-models` always bypasses the cache and refreshes the live catalog. If a refresh fails, a previously cached catalog is preferred over the generic bundled fallback.

```bash
# Cache lifetime in milliseconds (default 86400000 = 24h).
PI_CURSOR_SDK_MODEL_CACHE_TTL_MS=3600000 pi --model cursor/composer-2-5

# Disable the cache and always discover live.
PI_CURSOR_SDK_DISABLE_MODEL_CACHE=1 pi --model cursor/composer-2-5
```

Do not store the API key in `~/.pi/agent/cursor-sdk.json`. That file is only for non-secret extension state such as Cursor fast defaults. `PATH` is only for executable lookup and should not contain the API key.

## Verify your setup

List Cursor models:

```bash
pi --list-models cursor
```

Expected behavior:

- with a valid key, Cursor models appear under the `cursor` provider
- on pi 0.79.x, the model table may be written to stderr in automation; treat exit 0 plus a table on either stdout or stderr as success
- if discovery cannot authenticate or reach Cursor, pi may still show fallback Cursor models; after adding auth with `/login`, fallback model runs can use the saved key, and `/cursor-refresh-models` refreshes the live catalog

Smoke test:

```bash
pi --model cursor/composer-2-5 --cursor-no-fast --no-session --mode json \
  -p "Reply exactly PI_CURSOR_MODEL_OK and nothing else."
```

Expected: the final assistant text is `PI_CURSOR_MODEL_OK`. If auth is missing or invalid, pi should tell you to configure a Cursor SDK API key via `/login`, `CURSOR_API_KEY`, or `--api-key`.

## Choosing a model

Choose Cursor models interactively with `/model`, or pass a model on the command line:

```bash
pi --model cursor/composer-2-5
pi --model cursor/gpt-5.5@1m
pi --model cursor/gpt-5.5@272k
pi --model cursor/claude-opus-4-8@300k
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

Cursor `context` becomes a pi-visible model variant because it changes pi's native `contextWindow`. For models that expose Cursor's boolean `fast` parameter, the extension also registers virtual `:fast` and `:slow` model aliases such as `cursor/composer-2-5:slow` and `cursor/gpt-5.5@1m:fast`. Those aliases are selection-only controls for subagents and workflow-spawned agents: they send the same Cursor SDK model ID plus an explicit `fast=true` or `fast=false` param, and they take precedence over saved `/cursor-fast` session/global defaults. Cursor SDK conversation mode remains extension state, not model identity. Alias model IDs use their selected SDK ID for Cursor-only state such as fast defaults, with read fallback for older defaults keyed by the underlying Cursor base model.

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

Use `/cursor-fast` to persistently toggle fast mode for the selected unsuffixed Cursor model when the model supports Cursor's `fast` parameter.

Fast preferences are remembered per selected Cursor SDK model ID or alias and stored:

- in the current session with `pi.appendEntry()`
- globally in `~/.pi/agent/cursor-sdk.json`

For one run, force fast on or off without changing saved defaults:

```bash
pi --model cursor/gpt-5.5@1m --cursor-fast -p "Say ok only"
pi --model cursor/composer-2-5 --cursor-no-fast -p "Say ok only"
```

For per-agent control, select the virtual model alias instead of mutating the shared saved default:

```bash
pi --model cursor/composer-2-5:slow -p "Say ok only"
pi --model cursor/gpt-5.5@1m:fast -p "Say ok only"
```

The `:fast` and `:slow` aliases are available only for Cursor models whose catalog exposes a `fast` parameter. They override saved `/cursor-fast` session/global defaults while leaving `--cursor-fast` and `--cursor-no-fast` as explicit process-level force flags. `/cursor-fast` does not persist a new default while a virtual fast/slow alias is selected; switch to the unsuffixed model first.

Composer 2 and Composer 2.5 can default to fast. Use `--cursor-no-fast` or a `:slow` virtual alias for a one-shot no-fast Composer run. In print mode (`-p`), `--cursor-no-fast` is silent and does not write `~/.pi/agent/cursor-sdk.json`.

In interactive mode, the footer shows Cursor status only while a Cursor model is active. Fast-capable models show fast state explicitly, and fast and plan mode share one Cursor status value so they do not overwrite each other:

```text
cursor:local · fast:n/a
cursor:local · fast:n/a · plan
cursor:local · fast:off
cursor:local · fast:on
cursor:local · fast:off · plan
cursor:local · fast:on · plan
cursor:cloud · fast:n/a
```

`cursor:local` / `cursor:cloud` shows the selected Cursor runtime. `fast:off` means fast mode is off. `fast:n/a` means the active runtime/model does not expose a local fast toggle. If you do not see `plan`, Cursor SDK mode is the default `agent` mode.

## Cursor SDK mode

Cursor SDK conversation mode is Cursor-only extension state. It is not a pi model variant, not pi thinking/reasoning, not a `:fast`/`:slow` virtual fast alias, and not pi's separate read-only plan-mode extension.

Default mode is `agent`. Start a one-shot run in a specific mode:

```bash
pi --model cursor/composer-2-5 --cursor-mode agent
pi --model cursor/composer-2-5 --cursor-mode plan
```

Change the session mode interactively:

```text
/cursor-mode agent
/cursor-mode plan
/cursor-mode
```

`/cursor-mode` with no argument reports the current mode and usage. The CLI flag does not persist to the session; slash-command changes are persisted with `pi.appendEntry()`.

Maintainers can run `/cursor-tools` in a Cursor model session to print the current bridge enablement, bootstrap manifest enablement, effective `PI_CURSOR_SETTING_SOURCES`, and callable-surface snapshot (host tools summary plus current `pi__*` names). See [Cursor dogfood checklist](docs/cursor-dogfood-checklist.md).

When a new local Cursor SDK agent is created, the extension seeds the mode through `Agent.create({ mode })`. The extension also sends the effective Cursor mode on every `agent.send(..., { mode })` call so `/cursor-mode` and `--cursor-mode` remain the source of truth even when a pooled SDK agent is reused.

Cursor SDK `plan` mode can produce plan-oriented output and Cursor todo/plan activity, but those replay cards remain display-only. They do not drive pi's plan-mode extension, pi todos, or active tool state.

## Cursor local agent config and safety controls

`/cursor-refresh-config` calls the current pooled SDK agent's `agent.reload()` so Cursor reloads filesystem config such as local hooks, project MCP, and subagents without restarting pi. If no Cursor agent exists yet, the next Cursor run loads config normally.

Cursor SDK local safety controls stay off by default. Enable them explicitly for one run:

```bash
PI_CURSOR_AUTO_REVIEW=1 PI_CURSOR_SANDBOX=1 pi --model cursor/composer-2-5
pi --model cursor/composer-2-5 --cursor-auto-review --cursor-sandbox
```

For manual stuck-run recovery only, explicitly force-expire the active persisted local SDK run before sending:

```bash
PI_CURSOR_LOCAL_FORCE=1 pi --model cursor/composer-2-5
pi --model cursor/composer-2-5 --cursor-local-force
```

This maps to the next `agent.send(..., { local: { force: true } })` only. It is not a retry loop and does not cancel another live process's existing run handle; use it only when you know the persisted local run is wedged.

Branch-scoped local resume reattaches to recorded local SDK agents after a pi restart. It is on by default for local runtime and records agent IDs only in pi session custom entries, never user/project config. Disable it per run with CLI/env, or persist an opt-out in config:

```bash
pi --model cursor/composer-2-5 --cursor-no-local-resume
PI_CURSOR_LOCAL_RESUME=0 pi --model cursor/composer-2-5
```

Resume is strict: the current pi session file/id, branch path prefix, cwd/repo root, model/API/tool-surface pool key, and compaction generation must match. If `Agent.resume()` fails, pi bootstraps a new local Cursor agent from the current transcript and streams one display-only continuity note. Superseded local agents can be cleaned up explicitly with `/cursor-local-resume-cleanup --dry-run` and `/cursor-local-resume-cleanup --yes`; cleanup only deletes exact recorded `agent-*` IDs. Cloud resume remains disabled; `/cursor-cloud list|archive|delete` only manages recorded cloud agents.

Config can also set non-secret defaults in `~/.pi/agent/cursor-sdk.json` or trusted `.pi/cursor-sdk.json`:

```json
{
  "runtime": "local",
  "toolTransport": "mcp",
  "local": {
    "autoReview": true,
    "sandboxOptions": { "enabled": true },
    "resume": true
  }
}
```

Cloud/runtime keys are minimal and explicit. Defaults stay local runtime, `toolTransport: "mcp"`, no inline cloud MCP, no local-state/env-file forwarding, and no customTools migration. If `runtime` is explicitly set to `cloud` with `--cursor-runtime cloud`, `PI_CURSOR_RUNTIME=cloud`, `/cursor-runtime cloud`, or config, the provider starts a Cursor cloud agent after preflight instead of silently running local. `/cursor-runtime cloud` records session acknowledgement; use `/cursor-runtime cloud --save-user` for a persistent personal acknowledgement or `--cursor-cloud-ack` / `PI_CURSOR_CLOUD_ACK=1` for non-interactive runs. Project config may save a cloud runtime default but not first-use acknowledgement or repo/branch/env/context/direct-push/local-state preferences. Cloud runs use fresh context by default; pass `--cursor-cloud-context=bootstrap` / `PI_CURSOR_CLOUD_CONTEXT=bootstrap` to include prior pi context. Pass `--cursor-cloud-env-type=cloud|pool|machine` plus optional `--cursor-cloud-env-name=<name>` (or `PI_CURSOR_CLOUD_ENV_TYPE` / `PI_CURSOR_CLOUD_ENV_NAME`) to select a Cursor-managed cloud environment without forwarding local env values. Named `cloud` environments fail closed when combined with `--cursor-cloud-repo`; omit the repo or use a pool/machine environment. When a pi session has a title, cloud agents are created with that title for easier dashboard/list matching. At cloud run completion, pi streams display-only cloud telemetry when Cursor reports it: agent/run IDs, pushed branch and PR URL with a fetch/checkout hint, passive artifact paths, and raw cloud usage. The same successful report records a session-branch lifecycle ledger used by `/cursor-cloud list`, `/cursor-cloud archive <bc-agentId>`, and `/cursor-cloud delete <bc-agentId> --yes`; archive/delete only accept exact recorded `bc-` cloud IDs. Raw cloud usage is not copied into pi message usage, context occupancy, compaction, or cost totals. The pi bridge is local-only, and pi env forwarding is not implemented yet, so `--cursor-cloud-env` forwarding-name config fails closed with Cursor-native environment setup guidance.

Cloud lifecycle commands are explicit and session-branch scoped:

```bash
/cursor-cloud list
/cursor-cloud archive <bc-agentId>
/cursor-cloud delete <bc-agentId> --yes
```

They only accept cloud agent IDs recorded by successful runs in the current session branch.

Local resume cleanup is explicit and session-ledger scoped:

```bash
/cursor-local-resume-cleanup --dry-run
/cursor-local-resume-cleanup --yes
```

It only deletes superseded local `agent-*` IDs that this extension recorded as cleanup candidates, one exact ID at a time through the Cursor SDK. It does not sweep the SDK store or call lower-level empty delete filters.

Only enabled local safety values are passed to `Agent.create({ local })`; false/default values are omitted to preserve the current local-agent behavior. Local force is one-shot/manual-only through CLI/env and is passed only to the next `Agent.send({ local: { force: true } })`. Local resume is enabled by default for local runtime; opt out with `local.resume: false`, `--cursor-no-local-resume`, or `PI_CURSOR_LOCAL_RESUME=0`.

## Images

Images from the latest user message are forwarded to Cursor. Historical images are kept out of the transcript and appear only as `[image omitted from transcript]` placeholders, so follow-up questions about an earlier image should reattach the image or include a textual description. The extension advertises `text` and `image` input for Cursor models because Cursor's SDK accepts image messages and Cursor models are expected to support them.


## Cursor provider tool contract

See [Cursor tool surfaces in pi](docs/cursor-tool-surfaces.md) for a concise guide to callable vs display-only tools, MCP catalog limits, JSONL ID patterns, and how pi toggles differ from Cursor ambient MCP.

Local Cursor runs use two separate tool surfaces:

- **Cursor-native surface:** Cursor local-agent tools, Cursor settings, plugins, and configured Cursor MCP servers. These remain owned by the Cursor SDK local agent path. Pi CLI tool toggles such as `--no-tools`, `--tools`, and `--exclude-tools` do not disable this Cursor-native surface.
- **pi bridge surface:** pi-cursor-sdk exposes bridgeable active pi tools through a per-run local loopback MCP bridge when the bridge is enabled and the current pi tool registry has exposed tools. Pi CLI tool toggles affect this bridge surface because they change pi's active tool registry.

Bridge capabilities are snapshotted from `pi.getActiveTools()` and `pi.getAllTools()` for each Cursor run, including per-tool prompt guidelines when pi exposes them. Cursor sees active bridgeable pi tools as collision-safe MCP names such as `pi__sem_reindex` only when they are exposed in that current run. Pi session output, tool cards, confirmations, hooks, renderers, history, and abort behavior use the real pi tool name, such as `sem_reindex`. The bridge queues Cursor's MCP call, emits a normal pi `toolCall`, waits for the matching pi `toolResult`, and resolves that result back into the same live Cursor SDK run without creating a new `Agent`, unless the run was disposed, aborted, or cancelled. The bridge does not call pi tool `execute()` handlers directly.

Overlapping built-in pi tools (`read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`) are hidden by default because Cursor local agents already have native equivalents. Extension/custom tools and non-overlapping active tools present in pi's active tool registry normally remain exposed. The bridge also exposes `cursor_ask_question` as `pi__cursor_ask_question` when enabled, allowing Cursor to ask the user through pi UI instead of silently choosing a default. When pi has visible Agent Skills loaded, the extension rewrites pi's skill catalog for Cursor and exposes `cursor_activate_skill` as `pi__cursor_activate_skill`; Cursor should call that bridge tool with a listed skill name to load the full `SKILL.md` and bundled resource list before applying the skill. If the bridge is disabled, the catalog remains available and instructs Cursor to fall back to reading the listed `SKILL.md` path directly.

Cursor-native tool replay is separate from the bridge. Replay cards are display-only recorded Cursor SDK activity. They never re-run Cursor-side commands, reapply Cursor edits, call MCP servers, or mutate pi state. See [Cursor native tool replay](docs/cursor-native-tool-replay.md).

Bridge controls:

```bash
# Roll back to Cursor SDK tools/settings/MCP only; do not expose active pi tools through the bridge.
PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/composer-2-5

# Opt in to also expose overlapping pi tool names through the bridge.
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 pi --model cursor/composer-2-5

# Override Cursor SDK MCP tool-call timeout, including bridged pi tools and configured Cursor MCP servers.
PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS=7200 pi --model cursor/composer-2-5
PI_CURSOR_MCP_TOOL_TIMEOUT_MS=7200000 pi --model cursor/composer-2-5

# Override known MCP initialize/listTools timeouts on first send (default 10s).
PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS=5 pi --model cursor/composer-2-5
PI_CURSOR_MCP_CONNECT_TIMEOUT_MS=5000 pi --model cursor/composer-2-5

# Disable bootstrap callable-surface manifest (on by default).
PI_CURSOR_TOOL_MANIFEST=0 pi --model cursor/composer-2-5

# Emit scrubbed bridge diagnostics as JSONL to stderr with prefix [pi-cursor-sdk:bridge].
PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1 pi --model cursor/composer-2-5
```

On bootstrap sends, a compact **callable tool surfaces** block is injected into the Cursor prompt by default. It reminds the model that Cursor host/configured MCP tools are controlled by Cursor, while pi tool toggles only affect pi tools/bridge exposure; when bridge tools are exposed, it lists the current `pi__*` names. Disable with `PI_CURSOR_TOOL_MANIFEST=0`.

`PI_CURSOR_PI_TOOL_BRIDGE=0` is the supported rollback flag and disables the bridge entirely. The bridge also treats `false`, `off`, `none`, `no`, and `disabled` as off; `1`, `true`, `on`, `yes`, and `enabled` as on. `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1` opts in to exposing overlapping pi tool names that Cursor already has native equivalents for. The installed Cursor SDK uses a 60-second MCP protocol default with no public per-server timeout option. pi-cursor-sdk overrides that seam in two directions by default: MCP `callTool` requests are extended to 3600 seconds for long-running local MCP tools (including the pi bridge and configured Cursor MCP servers), and known MCP initialize/listTools requests on first send are shortened to 10 seconds so unavailable configured MCP servers fail fast instead of blocking for a full minute. Unknown Cursor SDK MCP protocol timeout stacks keep the SDK default instead of being shortened. Override tool-call timeouts with `PI_CURSOR_MCP_TOOL_TIMEOUT_MS` or `PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS`, and first-send initialize/listTools timeouts with `PI_CURSOR_MCP_CONNECT_TIMEOUT_MS` or `PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS`. `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` is off by default and emits typed, allowlisted, scrubbed single-line JSONL records to `process.stderr`. These records are operational diagnostics, not anonymous telemetry: they intentionally include tool names, safe correlation IDs, bridge run state, exposed pi↔MCP name pairs, queued requests, result resolution, rejection, cancellation, and pending counts. They must not include endpoint URLs, endpoint path components, endpoint tokens, raw args/results, stdout/stderr payloads, file contents, Cursor settings output, API keys, bearer tokens, cookies, session credentials, or secrets. Do not enable or share bridge debug logs where tool names themselves are sensitive.

### Maintainer platform smoke release gate

For Cursor provider/runtime changes, the canonical local release and pre-commit gate is the local platform smoke gate in [Platform smoke](docs/platform-smoke.md): run `npm run smoke:platform:all`, which runs doctor before the target matrix. Cloud-runtime changes must also run `npm run smoke:cloud`. The platform gate validates macOS, Ubuntu, and Windows native through Crabbox using packed installs, PTY/ConPTY ANSI capture, host-rendered xterm/PNG evidence, JSONL assertions, bridge diagnostics, usage/cache checks, abort cleanup, artifact manifests, and redaction scans. After each platform run, `.artifacts/platform-smoke/latest.json` points to the latest useful evidence paths. Do not mark a release ready with optional, deferred, mostly-passing, or unobserved platform smoke checks outstanding.

The older live smoke helpers remain useful for inner-loop debugging and focused visual audits, not as the release gate. Use [Cursor live smoke checklist](docs/cursor-live-smoke-checklist.md), `npm run smoke:visual`, `npm run smoke:live`, or direct `pi --approve -e . --cursor-no-fast --model cursor/composer-2-5` runs when iterating on a specific TUI/card/runtime issue before the full platform gate. `npm run smoke:visual` captures an offscreen PTY rendered through browser/xterm and saved as PNG screenshots with Playwright, or with `agent_browser` from the generated HTML when available. Its default matrix is native replay only: native replay registration is forced on, Cursor setting sources are disabled, the pi bridge is off, overlapping built-in pi tools are not exposed, and inherited Cursor SDK event-debug artifact env is cleared; `--event-debug` writes to a deterministic debug directory under the visual output directory. The visible TUI/output, rendered screenshots, scrubbed diagnostics, and persisted JSONL must agree. See [Cursor testing lessons](docs/cursor-testing-lessons.md) for auth.json seeding, isolated `/tmp` harness layout, JSONL replay-error scans, and other regression traps.

### Maintainer Cursor SDK event capture

Use `npm run debug:sdk-events` to capture timestamped `run.stream()`, `onDelta`, and `onStep` timelines for one direct `@cursor/sdk` run.

Use `npm run debug:provider-events` to capture the same `onDelta`/`onStep` payloads **through pi's Cursor provider** (session agent reuse, bridge, native replay, send planning). Artifacts default under gitignored `.debug/cursor-sdk-events/`. Interactive multi-turn pi sessions group turns under `.debug/cursor-sdk-events/sessions/<session-slug>/turn-NNN-.../` with a `session.json` index. You can also opt in during any pi run with `PI_CURSOR_SDK_EVENT_DEBUG=1`; capture is file-only by default so the pi TUI stays normal.

See [Cursor testing lessons](docs/cursor-testing-lessons.md#cursor-sdk-event-capture-probe) for usage, artifact layout, and safety notes.

## Fallback models

If no key is available from `/login`, `CURSOR_API_KEY`, or `--api-key`, model discovery fails, or discovery returns no models, the extension registers a bundled fallback snapshot of the latest reviewed Cursor SDK model catalog and notifies interactive users when possible.

The fallback snapshot includes Composer 2.5 (`composer-2.5` and `composer-2-5`), Composer 2, GPT, Claude, Gemini, Grok, Kimi, and other model IDs exposed by the reviewed `Cursor.models.list()` output. The exact checked-in snapshot lives in `src/cursor-fallback-models.generated.ts`.

Actual Cursor runs still need a key from `/login`, `CURSOR_API_KEY`, or `--api-key`. If you add auth after startup, run `/cursor-refresh-models` to refresh the full live Cursor model catalog without restarting pi.

## Limits

- **Cloud runtime is explicit and minimal.** Local remains the default. Cloud runs create Cursor cloud agents only after first-use acknowledgement and safety preflight, use fresh context by default, do not expose the pi bridge or local MCP, do not forward pi env vars, support explicit Cursor-managed environment selection, name agents from the pi session title when available, stream display-only agent/run/branch/PR/artifact/raw-usage telemetry when available, and record only explicit session-branch lifecycle commands for cleanup (`/cursor-cloud list|archive|delete`).
- **The pi tool bridge is local and MCP-backed.** Bridgeable active pi tools are exposed to local Cursor agents through a tokenized `127.0.0.1` MCP endpoint; internal Cursor replay activity names are excluded, and overlapping built-in pi tools are hidden by default. Set `PI_CURSOR_PI_TOOL_BRIDGE=0` to disable it or `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1` to expose overlapping built-ins too.
- **Cursor native tool replay is display-only.** Replay renders recorded Cursor SDK activity and never re-runs Cursor-side commands, reapplies Cursor edits, calls MCP servers, or mutates pi state. Workflow tools such as Cursor mode/task/todo/plan activity are not pi workflow controls. See [Cursor native tool replay](docs/cursor-native-tool-replay.md) for supported replay cards, ordering, conflict handling, and opt-out flags.
- **Cursor run state can span tool-use turns.** Within a pi session, the extension reuses one Cursor SDK agent across compatible follow-up turns and sends incremental prompts when context still matches. It recreates the agent when context diverges, after compaction or `/tree` navigation, on API key changes, after send errors, or on session shutdown. For bridged pi tools, the matching pi `toolResult` resolves into the same live Cursor SDK run without creating a new `Agent`, unless the run was disposed, aborted, or cancelled. Replay can also split one live Cursor SDK run across pi `toolUse` turns for display.
- **Final assistant text is the last non-empty text part.** Composer responses can produce one assistant message with early progress `text`, thinking/tool metadata, and a later final `text` report. Consumers that need a final answer should scan assistant message content from the end and use the last non-empty `text` part, not the first. Cursor `thinking` deltas are shown as thinking traces when the SDK emits them; those traces can include draft answers or copied exact-output targets and are intentionally not collapsed by this extension.
- **Cursor setting sources default to all.** The extension passes `local.settingSources: ["all"]` by default so configured Cursor MCP servers, plugin tools, project/user settings, and related Cursor-native capabilities are available like they are in Cursor. To narrow loading, set a comma-separated list such as `PI_CURSOR_SETTING_SOURCES=project,user,plugins`. To disable ambient setting sources, set `PI_CURSOR_SETTING_SOURCES=none`. Direct Cursor SDK bootstrap logs (settings, skills, hook-load compatibility warnings, and similar) are suppressed so they do not pollute the TUI.
- **AGENTS.md / CLAUDE.md are not duplicated on Cursor models when Cursor loads the same rules.** Pi discovers global and project context files (`AGENTS.md`, `CLAUDE.md`, and case variants) unless you start with `-nc`. On `cursor/*` models the extension removes only `<project_instructions>` blocks that overlap Cursor `settingSources` via the `before_agent_start` hook: `user` for `~/.pi/agent/AGENTS.md`, `project` for repo/parent `AGENTS.md` and `CLAUDE.md` (verified Cursor behavior: local agents load project `AGENTS.md` and `CLAUDE.md` alongside Cursor rules). `~/.pi/agent/CLAUDE.md` is not stripped (Cursor user rules use `~/.claude/CLAUDE.md`, not pi's agent dir). With `PI_CURSOR_SETTING_SOURCES=none` or `plugins`-only, pi context is left intact. Set `PI_CURSOR_PRESERVE_PI_AGENTS_MD=1` to keep duplicate injection.
- **Max Mode is not a manual pi variant.** Cursor's SDK may enable Max Mode automatically for models that require it. This extension only advertises exact context-window variants that the SDK catalog exposes and otherwise uses conservative SDK-derived default/non-Max context windows.
- **Output token limits are conservative.** Cursor SDK model metadata does not currently expose output token limits directly.
- **Token usage uses Cursor SDK data when safely attributable.** For turns with in-time SDK usage, pi records the latest per-turn `inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`; SDK-backed `totalTokens` stays `inputTokens + outputTokens` so cache reads do not inflate context occupancy. If the SDK reports no usage in time, the extension falls back to local `input/output` activity estimates while setting `totalTokens` to the current replayable context estimate so the footer/compaction percentage does not collapse after split tool turns. Later usage for that live run is ignored rather than risk applying stale usage to the wrong pi turn. Cursor SDK cost is not exposed, so pi cost remains zero/absent.

## Troubleshooting

### I can see Cursor models, but runs fail

You may be seeing fallback startup models or a missing/invalid Cursor SDK API key. Cursor Agent CLI/Desktop login is not reused by this extension. In interactive pi, run `/login`, choose `Use an API key`, choose `Cursor`, paste the key, then run `/cursor-refresh-models`.

When a Cursor run fails after auth is configured, pi now surfaces scrubbed provider detail instead of only `Cursor SDK run failed`. Generic SDK failures include safe run metadata such as model id, a short run id prefix, and duration when available, and are phrased as pi retryable provider errors so automatic retry/backoff can recover transient SDK failures.

Aborted runs now include a likely cause when determinable, for example `Cancelled: prompt interrupted.` for user cancel or `Cancelled: Cursor SDK run was cancelled.` for SDK-side cancellation.

Network failures from the Cursor SDK connect layer (for example `ConnectError: read ETIMEDOUT` or `ConnectError: [aborted] read ECONNRESET`) surface as scrubbed `Network error` messages instead of crashing pi, matching pi's native auto-retry classifier. Persistent failures may indicate a transient Cursor service or network issue.

You can also restart pi with a key in the same shell or launcher that starts pi:

```bash
export CURSOR_API_KEY="your-key"
pi --model cursor/composer-2-5
```

Or run a one-shot command:

```bash
pi --api-key "your-key" --model cursor/composer-2-5 -p "Say ok only"
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

### I do not see `cursor:local` / `cursor:cloud` or `plan` in the footer

The Cursor footer appears only while a Cursor model is active. Fast-capable local models show `cursor:local · fast:on` or `cursor:local · fast:off`; Cursor models without a fast parameter show `cursor:local · fast:n/a`. Cloud runtime shows `cursor:cloud · fast:n/a`. Cursor SDK mode is the default `agent` mode when `plan` is absent. When both are active, pi shows one combined Cursor status such as `cursor:local · fast:on · plan` or `cursor:cloud · fast:n/a · plan`.

### My Cursor app settings or rules do not seem to apply

Cursor setting sources are loaded with `PI_CURSOR_SETTING_SOURCES=all` by default. To narrow loading, set `PI_CURSOR_SETTING_SOURCES=project,user,plugins` or another comma-separated list. If you explicitly disabled sources with `PI_CURSOR_SETTING_SOURCES=none`, remove that override.

### Cursor does not call my web search MCP/tool

Cursor SDK local agents load MCP servers from Cursor setting sources and inline SDK config. This extension enables all Cursor setting sources by default, so a missing web search tool usually means it is not configured in Cursor or the run was started with a narrowing/disable override such as `PI_CURSOR_SETTING_SOURCES=none`.

### I do not see Cursor web search or web fetch in pi's tool UI

pi shows **Cursor web search** / **Cursor web fetch** activity cards only when the installed `@cursor/sdk` reports completed replayable tool data. Supported sources are SDK `mcp` completions whose `toolName` is `WebSearch` / `web_search` / `WebFetch` / similar, host tool names that normalize to those labels, and local Cursor transcript `webSearchToolCall` / `webFetchToolCall` records available through `Agent.messages.list()` after the run. This is separate from SDK `semSearch`, which is semantic **codebase** search.

Known SDK boundary: some local Cursor web search activity is not emitted through live `onDelta`, `onStep`, or `run.stream()` tool events. When that happens, pi can only reconstruct a card from the local agent transcript after `run.wait()` finishes, so the **Cursor web search** card may appear after assistant text rather than as a live in-progress card. Buffering all assistant text until `run.wait()` would make the ordering prettier but would break normal streaming, so pi does not do that.

Known SDK boundary: Cursor SDK `task` activity is shown as **Cursor subagent** because it represents Cursor-spawned child-agent work, but the SDK does not always emit a live nested subagent action stream. Pi shows the subagent start, final output, kind/model/short-ID metadata, and any `conversationSteps` tool-call summaries Cursor returns. If Cursor only returns final subagent text, pi cannot show the subagent's internal read/shell/MCP steps.

Many runs never expose web activity as replayable SDK tool completions or local transcript web tool records. The model may still answer from internal Cursor web tooling or only mention search in assistant text/thinking. In that case pi cannot render a tool card because there is no completed SDK tool-call payload to replay. Capture a run with `npm run debug:provider-events` when investigating; if `on-delta.jsonl`, `on-step.jsonl`, `stream-events.jsonl`, `coordinator-events.jsonl`, and `display-decisions.jsonl` have no completed or transcript web tool data, the limitation is on the Cursor SDK surface, not pi replay registration.

**Web fetch:** `pi-cursor-sdk` can display `webFetchToolCall` transcript records and web-fetch-shaped MCP/host completions when Cursor reports them. It cannot make Cursor expose or execute a `WebFetch` tool. If Cursor's current local SDK tool set does not include WebFetch, pi cannot fetch a URL through Cursor web fetch; use an allowed browser/shell/MCP tool instead.

### I disabled MCP in pi but Cursor still has extra tools

pi extension toggles and pi's MCP catalog do not control Cursor ambient MCP. Local Cursor agents load MCP servers from Cursor setting sources (`PI_CURSOR_SETTING_SOURCES=all` by default), including `~/.cursor/mcp.json`. To remove a server, edit or clear that file (or Cursor MCP settings) and restart the pi session, or narrow/disable sources with `PI_CURSOR_SETTING_SOURCES=none` or a comma-separated subset. See [Cursor tool surfaces in pi](docs/cursor-tool-surfaces.md).

### Cursor does not call my pi extension tool

The local pi bridge only exposes tools that are active in the current pi session and present in pi's tool registry at Cursor run start. By default, it does not expose overlapping pi tool names that Cursor already has native equivalents for (`read`, `bash`, `write`, `edit`, `grep`, `find`, and `ls`). Opt in if you intentionally want Cursor to see both the Cursor-native tool and an overlapping built-in pi tool:

```bash
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 pi --model cursor/composer-2-5
```

To disable the bridge for rollback or isolation, start pi with:

```bash
PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/composer-2-5
```

### First Cursor message is slow (10+ seconds)

The extension loads Cursor setting sources with `PI_CURSOR_SETTING_SOURCES=all` by default, which includes user MCP servers from `~/.cursor/mcp.json`. On the first send of a session, the Cursor SDK connects to each configured MCP server before streaming a reply. pi-cursor-sdk shortens the known MCP initialize/listTools timeout path to **10 seconds by default** (the raw Cursor SDK default is 60 seconds), so a dead server should fail fast instead of blocking for a full minute. Unknown MCP protocol timeout stacks keep the SDK default instead of being shortened. A slow or unavailable server can still add roughly that connect timeout before the first reply. Tighten further with:

```bash
PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS=5 pi --model cursor/composer-2-5
PI_CURSOR_MCP_CONNECT_TIMEOUT_MS=5000 pi --model cursor/composer-2-5
```

Workarounds if you do not need user-level MCP in pi:

```bash
PI_CURSOR_SETTING_SOURCES=project,plugins,team pi --model cursor/composer-2-5
```

Or fix/disable the slow MCP server in Cursor settings. Maintainer timing probe: `npm run debug:mcp-coldstart`.

### A Cursor MCP tool times out

The extension raises Cursor SDK's MCP tool-call timeout from 60 seconds to 3600 seconds by default for Cursor SDK MCP `callTool` requests, including the local pi bridge and configured Cursor MCP servers. For longer local MCP tools, set one override:

```bash
PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS=7200 pi --model cursor/composer-2-5
PI_CURSOR_MCP_TOOL_TIMEOUT_MS=7200000 pi --model cursor/composer-2-5
```

### Tool calls appear as a plain text list instead of pi tool cards

This usually needs session JSONL to classify. Common cases:

- **Model text echo:** Assistant `text` blocks contain lines like `Tool call`, `Cursor activity`, or `call cursor-replay-…` without matching `toolCall` blocks — the Cursor model narrated pi prompt transcript format instead of invoking SDK tools. See [Tool calls listed as plain text (#40 triage)](docs/cursor-testing-lessons.md#tool-calls-listed-as-plain-text-40-triage).
- **Stale replay routing / plan-strip:** Error `toolResult` or error assistant messages contain `Tool grep/cursor/find/ls not found`, or provider debug shows `inactive_trace` after plan-mode execute stripped active tools — tracked in **#52** (distinct from model text echo and #55).
- **Replay vs execution:** `cursor-replay-*` IDs and neutral **Cursor MCP** activity cards are display-only recorded Cursor results; they do not re-run browser/MCP work. See [Cursor native tool replay](docs/cursor-native-tool-replay.md).
- **Run failure / discarded tools:** A red toast with scrubbed detail may indicate an SDK failure (#55). Started-but-never-completed Cursor tools surface neutral **Cursor … did not complete** activity cards with a bounded reason when the run failed/aborted, produced no assistant text, or involved external/side-effectful tools. Incomplete fast local discovery starts (`read`, `grep`, `glob`, `ls`) are debug-only after a successful text-producing run so stale SDK start events do not create red post-answer cards; maintainer debug for the same gap remains in **#52** (`PI_CURSOR_SDK_EVENT_DEBUG=1`).
- **Hard network crash:** pi exited with an uncaught Cursor SDK `ConnectError` instead of showing a scrubbed retry/auth error — capture the stack/session tail as a process-guard regression, not #40 text echo.

Capture `pi --version`, extension version, model, flags, the exact prompt, and a redacted session dir before filing bugs.

### Cursor native tool cards conflict with another extension

Cursor native replay is a display enhancement for TUI sessions and structured JSON/RPC consumers. It replays recorded Cursor SDK activity without re-running tools, and print mode remains text-first. See [Cursor native tool replay](docs/cursor-native-tool-replay.md) for conflict behavior and opt-out flags.

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
CURSOR_API_KEY="your-key" pi --approve -e . --model cursor/composer-2-5
```

Maintainer design notes live in [`docs/cursor-model-ux-spec.md`](docs/cursor-model-ux-spec.md).

## License

MIT
