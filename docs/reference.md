# Cursor SDK reference

Detailed installation, authentication, model controls, local storage, Cloud, tool boundaries, usage and troubleshooting. For a first run, start with the [README](../README.md). Maintainer checks and release procedures live in [Development](development.md).

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
pi --model cursor/grok-4.6
```

3. In pi, run `/login`, choose `Use an API key`, choose `Cursor`, and paste your Cursor SDK API key.

If pi started without a key, run `/cursor-refresh-models` after `/login` to refresh the full live Cursor model catalog without restarting pi. Inside pi, use `/model` to choose another Cursor model.

## Requirements

- Node.js 24+
- pi-cursor-sdk 0.5.3 requires official Pi 0.87.1 or later. The latest stable official Pi and current `fitchmultz/pi` main are required compatibility targets, resolved once per workflow run; locked development Pi packages are reproducible snapshots, not validation targets
- optional Pi and TypeBox peer metadata uses `"*"` ranges per Pi package guidance
- a Cursor SDK API key saved through `/login`, available as `CURSOR_API_KEY`, or passed with pi's `--api-key`

No global `@cursor/sdk` install is required. This package depends on exact `@cursor/sdk@1.0.37`, so normal package installation brings in that SDK. The extension intentionally does not bundle `@cursor/sdk` or its platform packages, because packing from one maintainer OS can ship the wrong optional SDK binary for another OS. The SDK has used its current single-file/new-chunk package layout since 1.0.28. Pi hosts that pass transcript-only provider contexts are supported through Pi 0.87.1's required public replay helpers.

## Install

### Global install

```bash
pi install npm:pi-cursor-sdk
```

Alternative GitHub install:

```bash
pi install https://github.com/fitchmultz/pi-cursor-sdk
```

### Existing extension filters

The Pi entrypoint is `dist/index.js`. If you changed extension filters for 0.3.8's `src/index.ts` entrypoint, restore their compiled-entry equivalents: `+src/index.ts` → `+dist/index.js`, `-src/index.ts` → `-dist/index.js`, and `!src/**` → `!dist/**`.

To keep Cursor disabled across both entrypoints, retain both `-src/index.ts` and `-dist/index.js`. The package does not rewrite user or project settings.

### Project-local install

Use `-l` if you want the package recorded in the current project's `.pi/settings.json` instead of your global pi settings:

```bash
pi install -l npm:pi-cursor-sdk
```

Pi loads project-local extensions only after project trust is resolved, so this extension cannot observe that trust event. When a project-local install needs to read or write `.pi/cursor-sdk.json`, start every such run with explicit approval:

```bash
pi --approve --model cursor/grok-4.6
```

Without `--approve`, the project-local extension still runs after Pi trusts the project, but it ignores `.pi/cursor-sdk.json` and rejects `--save-project`; user config remains available.

### Try from a local checkout

For development from this repository:

```bash
npm install   # runs prepare, which compiles src/ into dist/ (the manifest entry pi loads)
pi --approve -e . --model cursor/grok-4.6
```

After editing `src/`, run `npm run build` before the next `pi -e .` run, or pi loads the previous build.

## Configure your Cursor SDK API key

`pi-cursor-sdk` passes an explicit API key to the Cursor SDK. It does **not** reuse Cursor Agent CLI login, Cursor Desktop login, or Cursor subscription/OAuth state shown by `agent status`.

Use either a user API key from Cursor Dashboard → API Keys or a service account API key from Team settings. Team Admin API keys are not supported by the Cursor SDK. Then configure the key with one of the methods below.

Preferred setup:

```bash
pi --model cursor/grok-4.6
```

Then, inside pi:

1. Run `/login`.
2. Select `Use an API key`.
3. Select `Cursor`.
4. Paste your Cursor SDK API key.
5. The key is saved in pi's native `~/.pi/agent/auth.json`.

If pi started without a key, known fallback Cursor models still register so `/login` and CLI model selection remain reachable. Native login, logout, key rotation, and runtime-key changes immediately resync the matching cached catalog or fallback in the same session, without making a catalog request. Run `/cursor-refresh-models` for the full live catalog without restarting pi.

Set `PI_CURSOR_HIDE_MODELS_WHEN_LOGGED_OUT=1` to hide unauthenticated Cursor models from the picker and `--list-models`. This is off by default. Known model identities remain CLI-selectable, including `pi --model cursor/grok-4.6 --api-key "your-key"`; `/login` stays reachable. Stored logout does not hide models or delete the matching cache when environment or `models.json` auth remains. Pi's native logout also removes its runtime key override.

The default fallback availability policy is not proof of a usable key. A real Cursor SDK API key is still required for Cursor runs.

Environment setup:

```bash
export CURSOR_API_KEY="your-key"
pi --model cursor/grok-4.6
```

One-shot setup:

```bash
pi --api-key "your-key" --model cursor/grok-4.6 --cursor-no-fast -p "Say ok only."
```

Pi owns CLI parsing and credential storage. Cursor's public native API-key auth honors runtime keys, stored keys or provider-scoped `env.CURSOR_API_KEY`, composed `models.json` keys, then ambient `CURSOR_API_KEY`. Unresolved placeholder values are not real keys, and unsupported stored credential types do not fall through to ambient auth. Discovery receives the effective native key explicitly; it never reads an unrelated default auth file. Provider turns keep Pi's resolved request key. Environment or `models.json` changes take effect on the next native registry refresh (for example opening `/model`); there is no auth-file watcher.

### Model catalog cache

The discovered catalog is cached at `~/.pi/agent/cursor-sdk-model-list.json` (written `0600`, keyed by an API-key fingerprint — the key itself is never stored). Startup and native auth mutations are always cache-only: a matching cache, even if expired, or the bundled fallback supplies known models with zero catalog/network calls. The SDK remains in the static extension graph for compiled-Bun loading; cache-only does not mean zero SDK module evaluation. Pi may separately request a network-allowed refresh; fresh matching caches then skip the request. `/cursor-refresh-models` requests a forced native live refresh and reports cancellation or failure truthfully. Authenticated errors prefer the matching cached catalog over the generic fallback.

Only an accepted native generation can update the catalog, selection metadata, cache, and fallback warning. An effective no-auth refresh removes only the extension's valid regular-file orphaned catalog. Cancelled, superseded, or shut-down refreshes cannot install late results. SDK 1.0.37 catalog requests have no public caller-abort option, so cancellation rejects their late publication rather than promising to stop the underlying request.

Known host limitation: official Pi 1.0.4 and 1.1.0 have a demonstrated startup refresh-admission/readiness race that can temporarily leave fallback models and an incorrect missing-key warning despite a matching authenticated cache. The shared-owner repair is merged in `fitchmultz/pi` via [#190](https://github.com/fitchmultz/pi/pull/190); this is not an official-host fix. See [#337](https://github.com/fitchmultz/pi-cursor-sdk/pull/337). It is separate from Cursor service authentication failures and the compiled-loader repair.

```bash
# Cache lifetime in milliseconds (default 86400000 = 24h).
PI_CURSOR_SDK_MODEL_CACHE_TTL_MS=3600000 pi --model cursor/grok-4.6

# Disable cache reads/writes; cache-only phases still use the fallback.
PI_CURSOR_SDK_DISABLE_MODEL_CACHE=1 pi --model cursor/grok-4.6
```

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
pi --model cursor/grok-4.6 --cursor-no-fast --no-session --mode json \
  -p "Reply exactly PI_CURSOR_MODEL_OK and nothing else."
```

Expected: the final assistant text is `PI_CURSOR_MODEL_OK`. If auth is missing or invalid, pi should tell you to configure a Cursor SDK API key via `/login`, `CURSOR_API_KEY`, or `--api-key`.

## Choosing a model

Choose Cursor models interactively with `/model`, or pass a model on the command line:

```bash
pi --model cursor/grok-4.6
pi --model cursor/gpt-5.5@1m
pi --model cursor/gpt-5.5@272k
pi --model cursor/claude-opus-4-8@300k
```

How to read model IDs:

- `cursor/...` is the Cursor provider registered by this extension
- `@1m`, `@272k`, and `@300k` are context-window variants
- `:medium`, `:high`, `:xhigh`, and `:max` are pi thinking-level suffixes for models where the Cursor SDK exposes the corresponding pi-controllable thinking parameter
- unambiguous latest-style Cursor aliases returned by `Cursor.models.list()` are registered too, using the same context suffixes when the target model has context variants; aliases shared by multiple base models or colliding with a base model ID are skipped because their SDK resolution and displayed metadata can diverge

Examples with pi thinking controls:

```bash
pi --model cursor/gpt-5.5@1m:medium
pi --model cursor/gpt-5.5@272k:xhigh
pi --model cursor/claude-opus-4-7@1m:max
pi --model cursor/gpt-5.5@1m --thinking medium
```

Cursor `context` becomes a pi-visible model variant because it changes pi's native `contextWindow`. For models that expose Cursor's boolean `fast` parameter, the extension also registers virtual `:fast` and `:slow` model aliases such as `cursor/grok-4.6:slow` and `cursor/gpt-5.5@1m:fast`. Those aliases are selection-only controls for subagents and workflow-spawned agents: they send the same Cursor SDK model ID plus an explicit `fast=true` or `fast=false` param, and they take precedence over saved `/cursor-fast` session/global defaults. Cursor SDK conversation mode remains extension state, not model identity. Alias model IDs use their selected SDK ID for Cursor-only state such as fast defaults, with read fallback for older defaults keyed by the underlying Cursor base model.

## Thinking support

All Cursor SDK models should be treated as thinking-capable Cursor models. The `thinking` column in `pi --list-models` is narrower: it only means pi can control a Cursor SDK thinking parameter for that model.

For models where Cursor exposes `reasoning`, `effort`, `reasoning_effort`, or boolean `thinking` parameters, pi's native thinking controls map to Cursor SDK params:

- `reasoning=none|low|medium|high|extra-high`
- `effort=low|medium|high|xhigh|max`
- `reasoning_effort=low|medium|high|xhigh|max` where exposed by the catalog
- `thinking=false|true` for boolean thinking models

Pi `xhigh` maps to Cursor `xhigh` or `extra-high`; Pi `max` maps only to a distinct Cursor `max` value. Gemini 3.8 Flash exposes only `low`, `medium`, and `high` through `reasoning_effort`; its SDK default remains `high`.

For Claude models with boolean `thinking` and either `effort` or `reasoning_effort`, enabled pi levels send `thinking=true` and the mapped effort value; `off` sends `thinking=false` and omits the effort parameter. Haiku 5.5 exposes all five enabled effort levels (`low`, `medium`, `high`, `xhigh`, `max`) at both `@300k` and `@1m`.

### Why some Cursor models show `thinking=no`

In `pi --list-models`, `thinking=no` means pi cannot control the model's thinking level with `--thinking`, a final `:medium` model suffix, or shift+tab. It does not mean the Cursor model cannot think.

Some Cursor SDK models do not expose a `reasoning`, `effort`, `reasoning_effort`, or `thinking` parameter for the extension to set. Cursor thinking is still enabled/supported by the model, and Cursor may still emit thinking deltas. The extension surfaces those deltas through pi's native thinking rendering when the SDK emits them.

## Fast mode

Use `/cursor-fast` to persistently toggle fast mode for the selected unsuffixed Cursor model when the model supports Cursor's `fast` parameter.

Fast preferences are remembered per selected Cursor SDK model ID or alias and stored:

- in the current session with `pi.appendEntry()`
- globally in `~/.pi/agent/cursor-sdk.json`

For one run, force fast on or off without changing saved defaults:

```bash
pi --model cursor/gpt-5.5@1m --cursor-fast -p "Say ok only"
pi --model cursor/grok-4.6 --cursor-no-fast -p "Say ok only"
```

For per-agent control, select the virtual model alias instead of mutating the shared saved default:

```bash
pi --model cursor/grok-4.6:slow -p "Say ok only"
pi --model cursor/gpt-5.5@1m:fast -p "Say ok only"
```

The `:fast` and `:slow` aliases are available only for Cursor models whose catalog exposes a `fast` parameter. They override saved `/cursor-fast` session/global defaults while leaving `--cursor-fast` and `--cursor-no-fast` as explicit process-level force flags. `/cursor-fast` does not persist a new default while a virtual fast/slow alias is selected; switch to the unsuffixed model first.

Composer 2 and Composer 2.5 can default to fast. Use `--cursor-no-fast` or a `:slow` virtual alias for a one-shot no-fast Composer run. In print mode (`-p`), `--cursor-no-fast` is silent and does not write `~/.pi/agent/cursor-sdk.json`.

In interactive mode, the footer shows Cursor status only while a Cursor model is active. Set `PI_CURSOR_FOOTER=0` to hide this status; it is visible by default. This controls display only: runtime, mode, and transport selection and validation are unchanged. Fast-capable models show fast state explicitly, and fast and plan mode share one Cursor status value so they do not overwrite each other:

```text
cursor:local · fast:n/a
cursor:local · fast:n/a · plan
cursor:local · fast:off
cursor:local · fast:on
cursor:local · fast:off · plan
cursor:local · fast:on · plan
cursor:local · fast:on · http1
cursor:cloud · fast:n/a
```

`cursor:local` / `cursor:cloud` shows the selected Cursor runtime. `fast:off` means fast mode is off. `fast:n/a` means the active runtime/model does not expose a local fast toggle. `http1` appears when HTTP/1.1/SSE transport is enabled for local Cursor SDK agents. If you do not see `plan`, Cursor SDK mode is the default `agent` mode.

## Cursor SDK mode

Cursor SDK conversation mode is Cursor-only extension state. It is not a pi model variant, not pi thinking/reasoning, not a `:fast`/`:slow` virtual fast alias, and not pi's separate read-only plan-mode extension.

Default mode is `agent`. Start a one-shot run in a specific mode:

```bash
pi --model cursor/grok-4.6 --cursor-mode agent
pi --model cursor/grok-4.6 --cursor-mode plan
```

Change the session mode interactively:

```text
/cursor-mode agent
/cursor-mode plan
/cursor-mode
```

`/cursor-mode` with no argument reports the current mode and usage. The CLI flag does not persist to the session; slash-command changes are persisted with `pi.appendEntry()`.

Maintainers can run `/cursor-tools` in a Cursor model session to print bridge/manifest enablement, effective `PI_CURSOR_SETTING_SOURCES`, and the current registry's bridge exposure eligibility. This is not a live-run connection or invocation check; use the [bridge diagnostics](#cursor-provider-tool-contract) below for per-run observations. See [Cursor dogfood checklist](./cursor-dogfood-checklist.md).

For conversation agents, the extension seeds the mode through `Agent.create({ mode })` and sends it on each `agent.send(..., { mode })` so `/cursor-mode` and `--cursor-mode` remain the source of truth when a pooled agent is reused. LOCAL compaction/tree summary agents always use text-only `agent` mode.

Cursor SDK `plan` mode can produce plan-oriented output and Cursor todo/plan activity, but those replay cards remain display-only. They do not drive pi's plan-mode extension, pi todos, or active tool state.

## Cursor local agent config and safety controls

`/cursor-refresh-config` calls the current pooled SDK agent's `agent.reload()` so Cursor reloads its filesystem config such as local hooks, project MCP, and Cursor-managed subagents without restarting pi. Extension `cursor-sdk.json` definitions below are captured on the next ordinary turn; changed definitions recreate the pooled agent instead of relying on SDK reload.

**Hook enforcement is not qualified by settings loading or replay cards.** SDK 1.0.37 source retains Shell `preToolUse` command-rewrite plumbing. The retained SDK 1.0.36 offline probe executed a rewritten command using private lexical bindings and permissive approval; it is not an executed SDK 1.0.37 canary. That is not an end-to-end Pi/rtk or security-policy guarantee. Replay may show the original model arguments before the SDK applies a rewrite. Verify the hook decision and actual executed command together when relying on hooks; the reported native-Agent/Pi discrepancy remains open in [#173](https://github.com/fitchmultz/pi-cursor-sdk/issues/173).

Cursor SDK local safety controls stay off by default. Enable them explicitly for one run:

```bash
PI_CURSOR_AUTO_REVIEW=1 PI_CURSOR_SANDBOX=1 pi --model cursor/grok-4.6
pi --model cursor/grok-4.6 --cursor-auto-review --cursor-sandbox
```

For manual stuck-run recovery only, explicitly force-expire the active persisted local SDK run before sending:

```bash
PI_CURSOR_LOCAL_FORCE=1 pi --model cursor/grok-4.6
pi --model cursor/grok-4.6 --cursor-local-force
```

This maps to the next actual `agent.send(..., { local: { force: true } })` only. SDK load, agent acquire, prompt preparation, or a pre-send abort does not consume it. A consumed CLI flag is not rearmed by session reload/tree lifecycle events; the environment override remains once per process. It is not a retry loop and does not cancel another live process's existing run handle; use it only when you know the persisted local run is wedged.

Branch-scoped local resume reattaches to recorded local SDK agents after a pi restart. It is on by default for local runtime and records agent IDs plus their SDK store identity only in pi session custom entries, never user/project config. Independently of resume, each local agent whose send is initiated is also recorded once per native pi session as a best-effort non-resumable `cursor-sdk-agent-lineage` custom entry at the `Agent.send()` boundary for forensic lineage; cloned/forked sessions record their own lineage under their new pi session ID. Disable resume per run with CLI/env, or persist an opt-out in config:

```bash
pi --model cursor/grok-4.6 --cursor-no-local-resume
PI_CURSOR_LOCAL_RESUME=0 pi --model cursor/grok-4.6
```

Resume is strict: the current pi session file/id, branch path prefix, cwd/repo root, model/API/tool-surface pool key, SDK store identity, and compaction generation must match. By default, each persisted pi session gets a SQLite store under `<getDefaultSdkStateRoot(cwd)>/pi-sessions/<session-hash>/`, and that same store is used for create/resume, transcript reads, checkpoint lookup, and exact-ID cleanup so parallel pi sessions do not contend on one workspace `index.db`. Fileless sessions use a unique OS-temporary store per acquisition, remove it on graceful disposal, and start a fresh agent after invalidation instead of reopening a disposed temporary store. With default storage selected, legacy resume entries still try the SDK's default workspace store; if that resume fails or the agent is later replaced, the new agent moves to the per-session store. A trailing user message already present at process startup is crash-ambiguous and invalidates the old handle; only a user message appended in the current process may span a recorded handle, preventing restart from resending an already-submitted prompt. A successful process reattachment bootstraps the current pi transcript once while retaining the resumed Cursor agent's native state; later in-process turns remain incremental. If `Agent.resume()` fails, pi bootstraps a new local Cursor agent from the current transcript and streams one display-only continuity note. Superseded local agents can be cleaned up explicitly with `/cursor-local-resume-cleanup --dry-run` and `/cursor-local-resume-cleanup --yes`; cleanup only deletes exact recorded `agent-*` IDs from their recorded store. Cloud resume remains disabled; `/cursor-cloud list|archive|delete` only manages recorded cloud agents.

If a default local-store error names a rejected link or non-directory, make that SDK-owned prefix/component a real directory without discarding its data, or relocate via a link at a higher ancestor such as `~/.cursor/projects` instead. Custom roots reject user-controlled ancestor links too.

### Custom local SQLite root

For persistent LOCAL conversations, set `PI_CURSOR_SDK_STATE_ROOT` or user `~/.pi/agent/cursor-sdk.json`:

```json
{ "local": { "storeRoot": "/absolute/private/cursor-state" } }
```

Environment wins over user; blank values are absent. Project, session, CLI and built-in settings cannot select a root. With neither set, SDK-default storage/migration is unchanged. Selection is captured once per turn and at explicit cleanup entry, not reread after asynchronous work.

Custom layout: `<canonical-root>/<sha256(resolve(cwd))[0:32]>/pi-sessions/<session-hash>/`. Only extension SQLite/checkpoints move—not auth, settings/rules, model caches or IDE data. Fileless and LOCAL compaction/tree stores ignore persistent selection entirely, even when its path is unusable.

Use a fully qualified native absolute path, not a filesystem/share root, relative/device path, or a path with explicit `.`/`..` components. No tilde/environment expansion occurs. Invalid winning paths fail closed, never falling back to default. POSIX ancestors must be root/current-user owned and not group/other writable, except trusted sticky system temporary directories; after shared directories, components must belong to the current user. Owned destinations are private (0700). User-controlled links/junctions and linked/nonregular fixed SQLite files are rejected; verified root-owned system aliases such as macOS `/var` are supported.

On Windows, choose a user-controlled, ACL-protected location. Node-visible links/junctions, type, identity and writability are checked, but ACLs are not hardened and not every reparse-point type is guaranteed to be rejected. The SDK opens by pathname, including lazy checkpoints; these checks are not a sandbox against malicious same-user processes or administrators.

Changing root replaces a live pooled agent on the next turn and bootstraps from the Pi transcript. Custom resume/cleanup admits only the exact current custom **session** identity; identity-less legacy, SDK-default, other-root and other-session addresses are never reinterpreted. Old data is retained: no copy, migration, merge or automatic deletion. Run explicit cleanup **before** relocating if desired: cleanup at B can durably mark A's candidates non-retryable, and returning to A does not revive them. Manually retained state remains your responsibility after retiring its sessions and stopping their processes.

Config can also set non-secret defaults in `~/.pi/agent/cursor-sdk.json` or trusted `.pi/cursor-sdk.json`. Project config activates only when Pi's project-trust flow reached this extension and approved the project, or the run started with explicit `--approve`; Pi's implicit trust for a project with no recognized resources is not enough. Because project-local package extensions load after the trust event, `pi install -l` users must pass `--approve` on every run that reads or writes `.pi/cursor-sdk.json`. A trust resource added after trust resolution requires restarting pi. `/cursor-runtime ... --save-project` requires the same trust provenance and does not create Pi trust resources automatically. Explicit runtime, fast-default, and HTTP transport saves preserve unrecognized fields, reject malformed or non-object JSON without rewriting it, and serialize concurrent writers. A completed global preference write is retained if Pi's subsequent session-journal append fails, because Pi may already have mutated the in-memory branch; the command reports that partial journal failure and ignores the uncertain session entry until a later successful save or session restart. If a process is force-killed during the tiny update window, the next save reports the `.lock` path; remove it only after confirming no pi process is writing that config.

```json
{
  "runtime": "local",
  "local": {
    "autoReview": true,
    "sandboxOptions": { "enabled": true },
    "resume": true
  }
}
```

### SDK-native custom agents

Define named Cursor delegates in user `~/.pi/agent/cursor-sdk.json` or trusted project `.pi/cursor-sdk.json`:

```json
{
  "subagents": {
    "reviewer": {
      "description": "Review code changes for correctness and maintainability.",
      "prompt": "Inspect the changes and report concrete findings without editing.",
      "model": "grok-4.6:slow",
      "thinking": "high",
      "fast": false
    },
    "helper": {
      "description": "Investigate a focused question.",
      "prompt": "Research the question and return concise evidence.",
      "model": "inherit"
    }
  }
}
```

- Names follow this extension's policy: 1–64 characters, starting with an ASCII letter, then letters, digits, `.`, `_`, or `-`. Required `description` and `prompt` must be nonblank strings; text is trimmed. Invalid entries are skipped individually. Invalid optional `model`, `thinking`, or `fast` values are omitted; unsupported fields, including per-entry MCP, are not forwarded.
- A trusted project with any valid definitions replaces the **whole** user set, not individual names. Empty/all-invalid project sets fall back to user definitions. No CLI, environment, or session override exists. Keep definitions non-secret.
- `model` uses a registered Cursor model ID **without** the `cursor/` provider prefix; set thinking separately to `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Omitted model and explicit `inherit` both inherit the parent model in SDK 1.0.37; `thinking`/`fast` do not override inherited models.
- Explicit models use catalog metadata for aliases, context and thinking. `:fast`/`:slow` wins over the entry's `fast`; unsuffixed models use entry `fast`, otherwise the catalog default. Parent thinking, `/cursor-fast`, saved fast defaults and process fast flags do not affect the definition. Unknown IDs pass through unchanged without invented parameters or a catalog request.
- **SDK 1.0.37 LOCAL ceiling:** its converter sends only the selected model ID or `inherit`, dropping all thinking/fast/context parameters. Thus `grok-4.6:slow` resolves to `grok-4.6`, but does not enforce child slow mode locally. Cloud conversion preserves the full selection; service acceptance/honoring of those parameters is not qualified here. Resource inheritance (`local.subagentInherit`) is not a model-parameter workaround.
- Definitions are passed through public SDK `agents` on ordinary create/resume and cloud creation. Changed resolved content replaces the local pooled agent on the next turn and rejects stale resume handles, bootstrapping from the Pi transcript; equivalent reordered content reuses it. Resume keys contain only a digest, not definition text. Removing all definitions restores the original no-feature key.

This is Cursor SDK-native delegation by configured name, not a second Pi subagent implementation. When exposed, `pi__subagent` remains preferred. LOCAL compaction/tree summary agents receive no definitions, tools, settings or MCP; bug-report streams retain ordinary capabilities.

### Cloud runtime and acknowledgement

Cloud/runtime keys are minimal and explicit. Defaults stay local runtime with the loopback MCP bridge as the sole Pi-tool transport, no inline cloud MCP, and no local-state/env-file forwarding. SDK `customTools` remains deferred pending SDK cancellation/deadline support. Invalid non-empty `--cursor-runtime`, `--cursor-cloud-context`, `PI_CURSOR_RUNTIME`, or `PI_CURSOR_CLOUD_CONTEXT` values fail closed instead of falling through to lower-precedence config.

If `runtime` is explicitly set to `cloud` with `--cursor-runtime cloud`, `PI_CURSOR_RUNTIME=cloud`, `/cursor-runtime cloud`, or config, the provider starts a Cursor cloud agent after preflight instead of silently running local.

On first interactive use, `/cursor-runtime cloud` shows one confirmation covering remote execution, fresh context by default (explicit bootstrap opt-in), unavailable Pi-local tools/bridge and Pi env forwarding, Cursor's ability to branch/commit/push/open PRs, retained cloud agents, and Max Mode billing at Cursor API pricing (including possible spend-limit setup). Cancelling that first-use confirmation writes no session or config state.

Use `/cursor-runtime cloud --save-user` for a persistent personal acknowledgement or `--cursor-cloud-ack` / `PI_CURSOR_CLOUD_ACK=1` for non-interactive runs; acknowledged CLI, environment, session, or user state is not prompted again.

Project config may save a cloud runtime default but not first-use acknowledgement or repo/branch/env/context/direct-push/PR-control/local-state preferences.

### Cloud pull-request controls

Cursor Cloud pull-request controls are strictly opt-in. Omit them to preserve the Cursor SDK's default behavior; when omitted, the extension sends neither SDK field.

```bash
pi --model cursor/grok-4.6 --cursor-runtime cloud --cursor-cloud-ack \
  --cursor-cloud-repo https://github.com/your-org/your-repo \
  --cursor-cloud-branch main \
  --cursor-cloud-auto-create-pr --cursor-cloud-skip-reviewer-request

PI_CURSOR_CLOUD_ACK=1 \
PI_CURSOR_CLOUD_REPO=https://github.com/your-org/your-repo \
PI_CURSOR_CLOUD_BRANCH=main \
PI_CURSOR_CLOUD_AUTO_CREATE_PR=1 \
PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST=1 \
pi --model cursor/grok-4.6 --cursor-runtime cloud
```

User config uses `cloud.autoCreatePR` and `cloud.skipReviewerRequest`:

```json
{
  "runtime": "cloud",
  "cloud": {
    "autoCreatePR": true,
    "skipReviewerRequest": true
  }
}
```

The resolver follows cloud precedence (CLI, environment, session, then user) with user safety denials; project config is excluded. The current public inputs are CLI/environment one-shot controls and user config—there is no PR-control session command.

### Cloud repository and local-state validation

An explicit `--cursor-cloud-branch` / `PI_CURSOR_CLOUD_BRANCH` requires an explicit `--cursor-cloud-repo` / `PI_CURSOR_CLOUD_REPO` because the SDK exposes `startingRef` only on `cloud.repos` entries. Repository values must be HTTPS repository URLs without userinfo, query parameters, or fragments; invalid values fail before `Agent.create()`, and error scrubbing removes URL/SCP-style userinfo.

When an explicit cloud repo matches local Git state, preflight requires exactly one remote whose effective fetch and push URLs identify that target plus a locally observable, non-symbolic remote-tracking ref uniquely covered by that remote's fetch refspec for the requested branch. Local HTTPS remotes can match the same HTTPS identity; equivalent GitHub SSH and scp-style remotes can also match. Other hosts retain transport-specific identity, and host/path matching remains conservative with GitHub-specific case and lowercase `.git` normalization.

`refs/heads/<branch>` is normalized to `<branch>` for both inspection and SDK options; invalid Git branch names and other `refs/*` forms are rejected. An explicit repo without `startingRef` is unverifiable locally because the server default is unknown. Inside a Git worktree, full commit SHAs remain unverified and require the explicit local-state override because local tracking refs do not prove which matching remote contains that commit.

Mismatch, ambiguity, missing refs, or Git errors fail closed. This is local tracking evidence rather than a fetch, so fetch before starting cloud work when remote state may have changed.

Inspection ignores ambient Git repository/index/config environment redirection; ordinary user/system URL and refspec config may veto, but never authorize, a target match. It disables replacement-object ancestry and fails closed when local replacement or graft metadata makes ancestry ambiguous. File-mode forcing is POSIX-only. Sparse checkouts intentionally fail closed because skip-worktree entries require `--cursor-cloud-allow-local-state`. Stashes are intentionally outside validation because they are not active worktree, index, or `HEAD` state.

Without an explicit repo, the current branch's locally observable remote-tracking upstream remains the comparison ref only when that remote's effective fetch and push URLs identify one repository and its fetch refspec uniquely owns that tracking ref. `--cursor-cloud-allow-local-state` / `PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE=1` is the explicit override for accepting unverifiable, dirty, or unpushed local state; when active, launch skips local Git inspection while still validating the configured cloud repo/ref.

### Cloud context and managed environments

Cloud runs use fresh context by default; pass `--cursor-cloud-context=bootstrap` / `PI_CURSOR_CLOUD_CONTEXT=bootstrap` to include prior pi context.

Pass `--cursor-cloud-env-type=cloud|pool|machine` plus optional `--cursor-cloud-env-name=<name>` (or `PI_CURSOR_CLOUD_ENV_TYPE` / `PI_CURSOR_CLOUD_ENV_NAME`) to select a Cursor-managed cloud environment without forwarding local env values. Named `cloud` environments fail closed when combined with `--cursor-cloud-repo`; omit the repo or use a pool/machine environment.

### Cloud reporting and durable lifecycle

When a pi session has a title, cloud agents are created with that title for easier dashboard/list matching.

At cloud run completion, pi streams display-only cloud telemetry when Cursor reports it: agent/run IDs, pushed branch, repository and PR URL, passive artifact paths, and raw cloud usage.

Cloud runtime requires a persisted pi session and rejects `--no-session` before `Agent.send()`.

Immediately after `Agent.create()` returns—and before debug work or abort checks—Pi appends a branch-local lifecycle entry, fsyncs the existing Pi session JSONL anchor through a read-write descriptor, and then fsyncs a newline-framed sidecar keyed by the stable pi session ID (POSIX mode `0600`; Windows inherits the user session directory ACL) in the session directory.

Existing session files use the exact lifecycle entry ID as the branch anchor; a fileless first turn uses an orphan marker so a restart with the same session ID can claim the record onto exactly one matching or replacement branch after its new timestamped JSONL is created. That durable claim then restores normal sibling-branch isolation. It adds the returned run ID before post-send abort handling or waiting and enriches successful runs with branch/PR metadata. Readers skip individually truncated records so one interrupted append cannot hide later valid cleanup IDs.

If the agent intent cannot be persisted, pi does not send; if the returned run cannot be persisted, pi requests bounded cancellation. Both paths fail closed and direct you to the Cursor Cloud dashboard for manual cleanup.

`/cursor-cloud list`, `/cursor-cloud archive <bc-agentId>`, and `/cursor-cloud delete <bc-agentId> --yes` only accept exact recorded `bc-` cloud IDs.

Archive/delete require resolved Cursor auth and unchanged originating session/branch authority before SDK work, fsync a durable intent before the mutation, and fsync its actual success result afterward. Once started, the result stays in the original journal even if that owner changes branch, reloads, or shuts down; it is not mirrored into a replacement branch. An unresolved intent blocks retries and directs manual dashboard inspection instead of guessing whether an irreversible request completed.

### Cloud boundaries

Raw cloud usage is not copied into pi message usage, context occupancy, compaction, or cost totals. The pi bridge is local-only, and pi env forwarding is not implemented yet, so `--cursor-cloud-env` forwarding-name config fails closed with Cursor-native environment setup guidance.

Cloud lifecycle commands are explicit and session-branch scoped:

```bash
/cursor-cloud list
/cursor-cloud archive <bc-agentId>
/cursor-cloud delete <bc-agentId> --yes
```

They only accept cloud agent IDs recorded in the current session branch or its branch-bound durable sidecar; agent intents are fsynced before send and returned run IDs are recorded before abort handling or waiting so rejected, failed, cancelled, or first-turn-crashed sends remain cleanup-eligible. Persistence failures fail closed with Cursor Cloud dashboard cleanup guidance.

Local resume cleanup is explicit and session-ledger scoped:
```bash
/cursor-local-resume-cleanup --dry-run
/cursor-local-resume-cleanup --yes
```

With SDK-default storage selected, SDK 1.0.37 retains SDK 1.0.36's workspace-root derivation with SHA256 instead of MD5 and may rename the entire old workspace root on first use. Pi admits only exact cwd/session-derived old or current identities. After a rename, it verifies the recorded agent and cwd in the derived destination before resuming or cleaning up. If both roots exist, recorded legacy identities stay with the legacy store; nothing is merged. Failed renames retain the old store. Same-cwd acquisitions share atomic in-flight root derivation and retain ownership through resume/cleanup admission and open-store disposal; only then may the SDK retry. User-managed links/junctions above the SDK-owned `sdk-agent-store` prefix (such as `~/.cursor` or `~/.cursor/projects`) remain supported. Owned prefix and old/current workspace components are checked before the SDK getter can migrate history; links/non-directories within the owned layout fail closed. Recorded identities must match exact derived roots before any path walk; malformed paths fall back on resume or are durably non-retryable for cleanup. Stop other processes using old SDK state before upgrading; this in-process ownership guard is not a cross-process migration lock.

It only deletes superseded local `agent-*` IDs that this extension recorded as cleanup candidates, one exact ID at a time through the Cursor SDK using the candidate's recorded store identity (or, only with default storage selected, the SDK default workspace store for legacy candidates without one), and protects agents still resumable from any session-tree branch. Before SDK deletion it verifies and fsyncs an exact intent in the Pi session JSONL, then verifies and fsyncs the result; a missing or non-durable intent prevents deletion, while a missing or non-durable result leaves the durable intent—and a conservative current-process marker—blocking automatic retry. A candidate with a recorded store identity that is invalid for the current session is durably marked non-retryable and excluded from later cleanup attempts. It does not sweep any SDK store or call lower-level empty delete filters. Removing a pi session file does not automatically remove its persisted store directory. After permanently retiring that session and confirming no pi process is using it, a recorded root may be removed manually only when it is the exact cwd/session-derived current or surviving legacy `pi-sessions/<session-hash>/` directory. Do not remove a stale recorded MD5 path after migration: resolve and verify the actual owning directory first. Never manually remove the SDK default workspace root, which legacy entries may record and other sessions may share.

Only enabled local safety values are passed to `Agent.create({ local })`; false/default values are omitted to preserve the current local-agent behavior. Local force is one-shot/manual-only through CLI/env and is passed only to the next `Agent.send({ local: { force: true } })`. Local resume is enabled by default for local runtime; opt out with `local.resume: false`, `--cursor-no-local-resume`, or `PI_CURSOR_LOCAL_RESUME=0`. Changes take effect on the next turn without recreating a healthy pooled agent.

## Images

For request-equivalent native session inputs, images from the latest pending native user message are forwarded to Cursor, even when hidden model-visible notices follow it. Those notices travel as background context alongside the request, and the pending input group remains required under transcript budgeting. A custom-only continuation does not resubmit an old request or attachment. Request-local transforms that change payload/order lack canonical origin and retain conservative last-converted-user selection. Historical images are kept out of the transcript and appear only as `[image omitted from transcript]` placeholders, so follow-up questions about an earlier image should reattach the image or include a textual description. The extension advertises `text` and `image` input for Cursor models because Cursor's SDK accepts image messages and Cursor models are expected to support them.


## Context, compaction, and Cursor usage

Pi's default footer and `/stats` remain native. Assistant usage components are additive and describe the current context; cumulative Cursor billing never drives Pi's overflow or compaction checks. When fresh LOCAL SDK usage is unavailable, a historical occupancy floor is used only if the owning native projection matches the actual request and the same-model measurement follows the latest native compaction or context edit. Quoted summary text and wall-clock timestamps do not establish a boundary.

LOCAL compaction and tree summaries use a fresh text-only SDK agent: `tools: []`, no ambient settings or MCP, no pi bridge, no tool manifest/replay, `agent` mode even when the conversation uses `plan`, and a temporary store removed on completion, cancellation, or failure. Ordinary turns retain their configured capabilities. Cloud does not support the same tool restriction; bug-report streams have no public purpose hook and retain ordinary capabilities rather than being guessed from their text. Direct and summary cancellation depends on SDK settlement; SDK 1.0.37 provides no public completion deadline, so a controller that never settles can leave cancellation waiting.

Use the separate accounting view for recorded Cursor facts:

```text
/cursor-usage
/cursor-usage refresh
/cursor-usage export cursor-usage.json
/cursor-usage help
```

- **View:** current-branch corrected LOCAL raw turns, original SDK telemetry, terminal status, and whole-agent public billing observations. Raw turns, wait/handle snapshots, and bills overlap; they are never added together. Cloud raw normalization remains unqualified.
- **Refresh:** public `Agent.getUsage()` only, up to 32 recorded agents with a five-second limit each; no model sends or automatic polling. An unavailable endpoint remains unavailable—there is no private dashboard fallback.
- **Export:** creates a new private JSON file without replacing existing files. It contains IDs, lineage, usage, configured pricing, and observation status, not prompts or tool content. Inspect local paths/identifiers before sharing.
- **Honest limits:** observations may lag or revise; they are not final invoices. Known aggregate usage/cost stays visible even when inherited run history is incomplete; full run snapshots and aggregate-only remainders are withheld rather than invented. Unavailable refreshes retain explicitly labeled latest-known observations. LOCAL client run IDs do not join billing UUIDs. Resumed history without a known creation record is marked unknown; shared-lineage and multiple-origin observations are not billed to the current branch. Current official Pi has no public extension API for complete native invoice totals.

Before a send, the extension records a unique public native branch claim and a validated, fsynced intent. Usage journals live beside the Pi session JSONL as `cursor-usage-<session-id-hash>.journal`; they retain late facts for the original owner without writing a switched session or sibling branch. Fileless sessions are explicitly ephemeral. Missing or torn inherited journals remain explicitly incomplete. Known claims outside the current branch are shown as other-branch facts; same-directory, same-ID recovery with a lost initial claim is shown as unclaimed history. Neither is newly recognized current-branch spend. If every origin reference is lost after moving directories, the extension cannot discover that history without unsafe scanning.

Each origin journal has a **16 MiB ceiling**. Persistence failure before a send prevents that send. Later failure may warn once while the original owner is current; `/cursor-usage` exposes incomplete accounting without changing the response's outcome. For a torn trailing frame, view/export preserves the validated prefix and reports the incomplete journal; further appends fail closed without changing its bytes. For ceiling or torn-tail recovery, export and retain the old session/journal, then fork the conversation into a new native session or start a new session. Do not delete or truncate the journal to continue an old agent lineage. `/cursor-usage help` also documents this recovery.

## Cursor provider tool contract

See [Cursor tool surfaces in pi](./cursor-tool-surfaces.md) for a concise guide to callable vs display-only tools, MCP catalog limits, JSONL ID patterns, and how pi toggles differ from Cursor ambient MCP.

Local Cursor runs use two separate tool surfaces:

- **Cursor-native surface:** Cursor local-agent tools, Cursor settings, plugins, and configured Cursor MCP servers. These remain owned by the Cursor SDK local agent path. Pi CLI tool toggles such as `--no-tools`, `--tools`, and `--exclude-tools` do not disable this Cursor-native surface.
- **pi bridge surface:** pi-cursor-sdk exposes bridgeable active pi tools through a per-run local loopback MCP bridge when the bridge is enabled and the current pi tool registry has exposed tools. Pi CLI tool toggles affect this bridge surface because they change pi's active tool registry.

The bridge uses stable MCP v2 with `@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/hono@2.0.2`, `hono@4.13.13`, and `@hono/node-server@2.1.3`, bundled as its runtime closure. It binds only to loopback and validates Hono `Host` and `Origin` headers.

Bridge capabilities are snapshotted from `pi.getActiveTools()` and `pi.getAllTools()` for each Cursor run, including per-tool prompt guidelines when pi exposes them. Cursor sees active bridgeable pi tools as collision-safe MCP names such as `pi__sem_reindex` only when they are exposed in that current run. When exposed, Cursor is instructed to prefer `pi__mcp` for MCP work and `pi__subagent` for delegation; Cursor-configured MCP and Cursor-native subagents are fallbacks when the matching pi tool is not exposed or is unavailable. Pi session output, tool cards, confirmations, hooks, renderers, history, and abort behavior use the real pi tool name, such as `sem_reindex`. The bridge queues Cursor's MCP call, emits a normal pi `toolCall`, waits for the matching pi `toolResult`, and resolves that result back into the same live Cursor SDK run without creating a new `Agent`, unless the run was disposed, aborted, or cancelled. The bridge does not call pi tool `execute()` handlers directly.

Overlapping built-in pi tools (`read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`) are hidden by default because Cursor local agents already have native equivalents. Extension/custom tools and non-overlapping active tools present in pi's active tool registry normally remain exposed. The bridge also exposes `cursor_ask_question` as `pi__cursor_ask_question` when `PI_CURSOR_ASK_QUESTION=1`. It is off by default so Cursor does not block on questionnaires. For local runtime, when pi has visible Agent Skills loaded, the extension rewrites pi's skill catalog for Cursor and exposes `cursor_activate_skill` as `pi__cursor_activate_skill`; Cursor should call that bridge tool with a listed skill name to load the full `SKILL.md` and bundled resource list before applying the skill. If the local bridge is disabled, the catalog remains available and instructs Cursor to fall back to reading the listed `SKILL.md` path directly. Cloud runtime preserves Pi project instructions but omits Pi's local skill catalog and keeps `cursor_activate_skill` inactive because the bridge and local absolute skill paths are unavailable there.

Cursor-native tool replay is separate from the bridge. Replay cards are display-only recorded Cursor SDK activity. They never re-run Cursor-side commands, reapply Cursor edits, call MCP servers, or mutate pi state. See [Cursor native tool replay](./cursor-native-tool-replay.md).

Footer display control: `PI_CURSOR_FOOTER=0` hides the Cursor status without hiding Pi's model or usage footer. Like other boolean controls, it accepts `0`, `false`, `off`, `none`, `no`, and `disabled` to hide; `1`, `true`, `on`, `yes`, and `enabled` to show (case-insensitive). Unset, blank, or unrecognized values keep the default visible status.

Bridge controls:

```bash
# Opt in to Cursor's interactive question tool through pi UI.
PI_CURSOR_ASK_QUESTION=1 pi --model cursor/grok-4.6

# Roll back to Cursor SDK tools/settings/MCP only; do not expose active pi tools through the bridge.
PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/grok-4.6

# Opt in to also expose overlapping pi tool names through the bridge.
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 pi --model cursor/grok-4.6

# Override Cursor SDK MCP tool-call timeout, including bridged pi tools and configured Cursor MCP servers.
PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS=7200 pi --model cursor/grok-4.6
PI_CURSOR_MCP_TOOL_TIMEOUT_MS=7200000 pi --model cursor/grok-4.6

# Fail a stranded pi bridge CallTool sooner than the effective MCP tool timeout.
PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS=120000 pi --model cursor/grok-4.6

# Override known MCP initialize/listTools timeouts on first send (default 10s).
PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS=5 pi --model cursor/grok-4.6
PI_CURSOR_MCP_CONNECT_TIMEOUT_MS=5000 pi --model cursor/grok-4.6

# Force Cursor SDK local-agent backend streams to HTTP/1.1/SSE instead of HTTP/2.
env 'PI_CURSOR_HTTP_1_1=true' pi --model cursor/grok-4.6
# Or toggle it inside an interactive Cursor session.
/cursor-http on

# Disable bootstrap callable-surface manifest (on by default).
PI_CURSOR_TOOL_MANIFEST=0 pi --model cursor/grok-4.6

# Emit scrubbed bridge diagnostics as JSONL to stderr with prefix [pi-cursor-sdk:bridge].
PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1 pi --model cursor/grok-4.6
```

On bootstrap sends, a compact **callable tool surfaces** block is injected into the Cursor prompt by default. It reminds the model that Cursor host/configured MCP tools are controlled by Cursor, while pi tool toggles only affect pi tools/bridge exposure; when bridge tools are exposed, it lists the current `pi__*` names. Disable with `PI_CURSOR_TOOL_MANIFEST=0`.

`PI_CURSOR_ASK_QUESTION=1` enables only `cursor_ask_question`, leaving the rest of the pi bridge available; it is off by default. `PI_CURSOR_PI_TOOL_BRIDGE=0` is the supported rollback flag and disables the bridge entirely. Both flags treat `false`, `off`, `none`, `no`, and `disabled` as off; `1`, `true`, `on`, `yes`, and `enabled` as on. `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1` opts in to exposing overlapping pi tool names that Cursor already has native equivalents for. The installed Cursor SDK uses a 60-second MCP protocol default with no public per-server timeout option. pi-cursor-sdk overrides that seam in two directions by default: MCP `callTool` requests are extended to 3600 seconds for long-running local MCP tools (including the pi bridge and configured Cursor MCP servers), and known MCP initialize/listTools requests on first send are shortened to 10 seconds so unavailable configured MCP servers fail fast instead of blocking for a full minute. Unknown Cursor SDK MCP protocol timeout stacks keep the SDK default instead of being shortened. Override tool-call timeouts with `PI_CURSOR_MCP_TOOL_TIMEOUT_MS` or `PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS`, and first-send initialize/listTools timeouts with `PI_CURSOR_MCP_CONNECT_TIMEOUT_MS` or `PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS`. Bridged calls also have a local fail-closed deadline that defaults to the effective MCP tool timeout; lower it with `PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS` when a lost pi result should fail sooner. On expiry, the bridge rejects and removes the pending call and aborts active pi execution when available. The bridge's `listTools` handler returns its snapshot synchronously, so a Cursor UI label such as `GetMcpTools` does not by itself identify a `listTools` deadlock; the durable bridge waiter is `CallTool` awaiting its matching pi result.

Pending pi bridge calls keep their owning local Cursor live run active, including queued calls, long-running tools, and questions awaiting human input. After the last owned call settles and the provider drain lease ends, the full idle cleanup window (five minutes by default) restarts—even if cleanup was requested before the lease. A pending call in another session does not delay cleanup. This is not an answer timeout: explicit abort/shutdown/reset/compaction and the fail-closed MCP/bridge deadline (one hour by default) still clean up pending work. Abandoned display-only native replay retains its idle expiry.

`PI_CURSOR_LIVE_RUN_IDLE_DISPOSE_MS` sets that window for eligible retained local replay runs. It defaults to `300000` (five minutes); only decimal digits representing an integer from `1` through `2147483647` are accepted. Unset, blank, malformed (including surrounding whitespace), and out-of-range values fall back to five minutes. For example, `PI_CURSOR_LIVE_RUN_IDLE_DISPOSE_MS=900000 pi --model cursor/grok-4.6` selects fifteen minutes. The full configured window restarts after the last owned pending call settles and the provider drain lease ends. This environment-only setting does not change bridge/MCP deadlines or explicit abort/shutdown cleanup, and is not a fix for backend authentication, transport, or lost-executor failures.

`PI_CURSOR_HTTP_1_1=true` maps to the Cursor SDK `Cursor.configure({ local: { useHttp1ForAgent: true } })` compatibility mode for corporate VPN/proxy environments where HTTP/2 streams fail. In interactive sessions, `/cursor-http on`, `/cursor-http off`, and `/cursor-http toggle` set the branch-scoped session preference and save the user default as `local.useHttp1ForAgent` in `~/.pi/agent/cursor-sdk.json`; `/cursor-http` with no argument reports the effective state. Precedence is session command/history, explicit `PI_CURSOR_HTTP_1_1`, user config, then the built-in unset default; project config is ignored for this user-level compatibility choice. Unset performs no SDK configuration, preserving the existing default path. Session shutdown clears extension-owned SDK transport state before module reload. Changing the effective setting splits the local agent pool so an agent created under another transport is not reused. When enabled, the local Cursor footer shows `http1` (for example `cursor:local · fast:on · http1`); cloud status never does. This affects Cursor SDK local-agent backend streams only; it does not configure HTTP proxies, TLS certificates, or HTTP/3. SDK 1.0.37 vendors its patched Node ConnectRPC client; its HTTP/2 default ping interval is 59 seconds and idle connection timeout is 29 seconds. Those are connection settings, not a model-turn deadline or a promise of service recovery.

`PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` is off by default and emits typed, allowlisted, scrubbed single-line JSONL records to `process.stderr`. These records are operational diagnostics, not anonymous telemetry: they intentionally include tool names, safe correlation IDs, bridge run state, exposed pi↔MCP name pairs, queued requests, result resolution, rejection, cancellation, and pending counts. They must not include endpoint URLs, endpoint path components, endpoint tokens, raw args/results, stdout/stderr payloads, file contents, Cursor settings output, API keys, bearer tokens, cookies, session credentials, or secrets. Do not enable or share bridge debug logs where tool names themselves are sensitive.

Interpret the bridge diagnostic records by their boundary:

- `run_created` / `tools_exposed`: bridge exposure, not a client connection.
- `mcp_initialized`: the server received a validated `notifications/initialized`.
- `mcp_tools_list`: the catalog handler produced `toolCount` tools after request validation, not proof the client received or model consumed them.
- `request_queued` / `request_resolved` / `request_rejected`: actual bridge call handling.

These server observations do not identify the client as Cursor or prove ongoing connection health. Missing receipts do not diagnose why a client/model made no request. `/cursor-tools` cannot inspect an already captured run's surface. See [Cursor tool surfaces](./cursor-tool-surfaces.md#diagnosing-advertised-but-unused-bridge-tools).

## Fallback models

If no matching cached catalog is available in a cache-only phase, auth is missing, or live discovery fails or returns no models, the extension retains known bundled fallback identities and notifies interactive users when possible. By default these models remain available without auth. With `PI_CURSOR_HIDE_MODELS_WHEN_LOGGED_OUT=1`, unauthenticated picker/list availability is empty, but known CLI selection and native login remain functional. Pi owns `--api-key` parsing.

The fallback snapshot includes Grok 4.6, Composer 2.5 (`composer-2.5` and `composer-2-5`), Composer 2, Cursor's GPT-5.6 Luna/Sol/Terra models, Claude, Gemini, Grok 4.5, Kimi, and other model IDs exposed by the reviewed `Cursor.models.list()` output. Recommended local/smoke runs use `cursor/grok-4.6`. Pi's separate `openai-codex` catalog is owned by Pi itself and includes native `gpt-5.6-luna`, `gpt-5.6-sol`, and `gpt-5.6-terra` support. The exact checked-in Cursor snapshot lives in `src/cursor-fallback-models.generated.ts`; its generator provenance records SDK 1.0.37 and 46 models from the authenticated catalog-only refresh on 2026-10-07. That refresh added Claude Haiku 5.5 (`claude-haiku-5-5`), preserving all 45 prior model records from the SDK 1.0.36 capture on 2026-10-06. The 33 bundled checkpoint-derived entries were unchanged; no Agent/model turn or Cloud run was performed. A dated maintainer capture documents the assistant-visible [Cursor system prompts and tool guidance](https://github.com/fitchmultz/pi-cursor-sdk/blob/main/docs/evidence/cursor-system-prompts-2026-08-02/README.md) for Grok 4.5, Opus 5, Fable 5, and the GPT-5.6 Sol/Terra/Luna family.

Actual Cursor runs still need a key from `/login`, `CURSOR_API_KEY`, or `--api-key`. If you add auth after startup, run `/cursor-refresh-models` to refresh the full live Cursor model catalog without restarting pi.

## Limits

- **Commit/PR attribution has no supported opt-out.** SDK 1.0.37 exposes neither attribution control through public create/local/send/configure options. CLI-file edits and SDK-internal patches are not supported extension settings; [#302](https://github.com/fitchmultz/pi-cursor-sdk/issues/302) tracks both controls.

- **Cloud runtime is explicit and minimal.** Local remains the default. Cloud runs create Cursor cloud agents only after first-use acknowledgement and safety preflight, use fresh context by default, do not expose the pi bridge or local MCP, do not forward pi env vars, support explicit Cursor-managed environment selection, name agents from the pi session title when available, stream display-only agent/run/branch/PR/artifact/raw-usage telemetry when available, and record only explicit session-branch lifecycle commands for cleanup (`/cursor-cloud list|archive|delete`).
- **The pi tool bridge is local and MCP-backed.** Bridgeable active pi tools are exposed to local Cursor agents through a tokenized `127.0.0.1` MCP endpoint; internal Cursor replay activity names are excluded, and overlapping built-in pi tools are hidden by default. Set `PI_CURSOR_PI_TOOL_BRIDGE=0` to disable it or `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1` to expose overlapping built-ins too.
- **Cursor native tool replay is display-only.** Replay renders recorded Cursor SDK activity and never re-runs Cursor-side commands, reapplies Cursor edits, calls MCP servers, or mutates pi state. Workflow tools such as Cursor mode/task/todo/plan activity are not pi workflow controls. See [Cursor native tool replay](./cursor-native-tool-replay.md) for supported replay cards, ordering, conflict handling, and opt-out flags.
- **Cursor run state can span tool-use turns.** Within a pi session, the extension reuses one Cursor SDK agent across compatible follow-up turns and sends incremental prompts when context still matches. It recreates the agent when context diverges, after compaction or `/tree` navigation, on API key changes, after send errors, or on session shutdown. For bridged pi tools, the matching pi `toolResult` resolves into the same live Cursor SDK run without creating a new `Agent`, unless the run was disposed, aborted, or cancelled. Replay can also split one live Cursor SDK run across pi `toolUse` turns for display.
- **Final assistant text is the last non-empty text part.** Composer responses can produce one assistant message with early progress `text`, thinking/tool metadata, and a later final `text` report. Consumers that need a final answer should scan assistant message content from the end and use the last non-empty `text` part, not the first. Cursor `thinking` deltas are shown as thinking traces when the SDK emits them; those traces can include draft answers or copied exact-output targets and are intentionally not collapsed by this extension.
- **Cursor setting sources default to all.** The extension passes `local.settingSources: ["all"]` by default so configured Cursor MCP servers, plugin tools, project/user settings, and related Cursor-native capabilities are available like they are in Cursor. To narrow loading, set a comma-separated list such as `PI_CURSOR_SETTING_SOURCES=project,user,plugins`. To disable ambient setting sources, set `PI_CURSOR_SETTING_SOURCES=none`. Verified framed SDK inventory/rules/skills completion logs and exact hook-compatibility notices are filtered without changing settings, hooks, plugin trust, or parser enforcement. An outside-root local-plugin symlink rejection or the exact native-parser-unavailable warning instead produces a bounded native notice with recovery guidance, recorded as non-model session data without raw paths. Outside the retained creation-only mute around `Agent.create()`, other failures (including hook symlink refusals, ignore-mapping errors, and missing ripgrep configuration) retain their original output. The two recognized capability notices escape that creation mute.
- **AGENTS.md / CLAUDE.md are not duplicated on Cursor models when Cursor loads the same rules.** Pi discovers global and project context files (`AGENTS.md`, `CLAUDE.md`, and case variants) unless you start with `-nc`. On `cursor/*` models the extension removes only `<project_instructions>` blocks that overlap Cursor `settingSources` via the `before_agent_start` hook: `user` for `~/.pi/agent/AGENTS.md`, `project` for repo/parent `AGENTS.md` and `CLAUDE.md` (verified Cursor behavior: local agents load project `AGENTS.md` and `CLAUDE.md` alongside Cursor rules). `~/.pi/agent/CLAUDE.md` is not stripped (Cursor user rules use `~/.claude/CLAUDE.md`, not pi's agent dir). With `PI_CURSOR_SETTING_SOURCES=none` or `plugins`-only, pi context is left intact. Set `PI_CURSOR_PRESERVE_PI_AGENTS_MD=1` to keep duplicate injection.
- **Max Mode is not a manual pi variant.** Cursor's SDK may enable Max Mode automatically for models that require it. This extension only advertises exact context-window variants that the SDK catalog exposes and otherwise uses conservative SDK-derived default/non-Max context windows.
- **Output token limits are conservative.** Cursor SDK model metadata does not currently expose output token limits directly.
- **Local token usage uses Cursor SDK data when safely attributable.** In-time LOCAL raw `turn-ended` usage keeps full-prompt input with cache as a partition: pi maps `input = inputTokens - cacheRead - cacheWrite`, retains the cache fields, and sets `totalTokens = inputTokens + outputTokens`. Fallback components and total describe the same estimated current context. Late SDK usage is not retroactively applied to an emitted pi message, but every raw turn remains separately recorded by the [Cursor usage ledger](#context-compaction-and-cursor-usage). Raw Cloud telemetry is retained without assuming LOCAL normalization.
- **Configured cost is separate from Cursor billing.** Discovered models register zero rates. `models.json` per-million `cost` overrides, including tiers, use pi's native pricing helper on each emitted message's coherent context components. Fallback has no inferred cache split; split-message estimates can differ from actual internal request pricing. Public `getUsage()` billed input/cache/output categories are already disjoint—cache is not subtracted again—and optional `cost.rawCostCents` / `cost.chargedCents` are retained separately in floating-point cents. Neither these revisable observations nor native configured estimates promise invoice reconciliation.

## Troubleshooting

### I can see Cursor models, but runs fail

You may be seeing fallback startup models or a missing/invalid Cursor SDK API key. Cursor Agent CLI/Desktop login is not reused by this extension. In interactive pi, run `/login`, choose `Use an API key`, choose `Cursor`, paste the key, then run `/cursor-refresh-models`.

When a Cursor run fails after auth is configured, pi surfaces scrubbed provider detail instead of only `Cursor SDK run failed`. Structured errors retain bounded name, code, message, and up to two nested causes; headers and other object fields are not displayed. Generic completed-run failures include safe run metadata such as model id, a short run id prefix, and duration when available, and are phrased as pi retryable provider errors so automatic retry/backoff can recover transient SDK failures. Unknown startup failures, module-loading errors, and ambiguous session authentication errors are not diagnosed as invalid API keys. Explicit missing, invalid, or revoked API-key errors still show key setup guidance.

Aborted runs now include a likely cause when determinable, for example `Cancelled: prompt interrupted.` for user cancel or `Cancelled: Cursor SDK run was cancelled.` for SDK-side cancellation.

SDK 1.0.37 source preserves SDK 1.0.36's client bearer refresh and unauthenticated handling, but those mechanisms do not establish the cause of [#247](https://github.com/fitchmultz/pi-cursor-sdk/issues/247)'s historical idle failure. Reloading filesystem config is not a public auth-reset API. No guessed idle TTL or extension-level automatic resend is added: resending can duplicate executed tool effects.

Network failures from the Cursor SDK connect layer (for example `ConnectError: read ETIMEDOUT` or `ConnectError: [aborted] read ECONNRESET`) surface as scrubbed `Network error` messages instead of crashing pi, matching pi's native auto-retry classifier. The SDK-provenance `WriteIterableClosedError: WritableIterable is closed` race remains guarded for the Pi session lifecycle; Connect/network suppression remains active-turn scoped; raw Cursor SDK `AbortError` DOMExceptions are suppressed while any provider turn or session process-error guard is active. Unrelated failures remain fatal. The old raw child-stdin EPIPE workaround was removed because Cursor SDK fixed that path by 1.0.27. Persistent failures may indicate a transient Cursor service or network issue.

You can also restart pi with a key in the same shell or launcher that starts pi:

```bash
export CURSOR_API_KEY="your-key"
pi --model cursor/grok-4.6
```

Or run a one-shot command:

```bash
pi --api-key "your-key" --model cursor/grok-4.6 -p "Say ok only"
```

### Embedded sessions report concurrent Cursor turns

In-process sessions using independent `ModelRuntime` instances (the SDK default on supported Pi hosts) support concurrent turns, children launched inside parent tools, and direct compaction/tree/bug-report summaries. Each provider registration captures its own session, bridge, storage, and debug scope. Fork-inherited tool-result IDs cannot drain a parent's live run; replay wrappers reject foreign-owner or wrong-tool results without consuming the original card or executing work. Native request-header receipts verify the calling session before SDK/storage work, including auxiliary streams. Explicitly sharing a `ModelRuntime` overwrites its Cursor registration: requests from another session fail closed rather than entering the sibling's scope. Use independent runtimes, or reload the intended session to restore its registration; catalog refresh does not replace a sibling's provider. A not-yet-bound or shut-down provider closure cannot send. **Migration from 0.4.0:** bare `ctx.modelRegistry.complete(...)` and `ctx.modelRegistry.streamSimple(...)` calls lack the native receipt and are unsupported for Cursor, including custom compaction integrations; bind/refresh/reload does not fix that path. Use the owning AgentSession's stream path or an independent child AgentSession. CLI flags and their one-shot local-force consumption remain owned by each embedded session runtime across reload. Cursor SDK HTTP/1.1 transport configuration and environment/user defaults remain process-global; branch preferences are session-scoped, not independent SDK transport configurations. See [multi-session embedding semantics](./cursor-model-ux-spec.md#multi-session-embedding).

Independent SessionManagers opening the same persisted file have separate transient Cursor pools, generations and live-run ownership. Reload/tree/shutdown of one manager does not invalidate the other's resources. Durable store/resume/lineage identities remain unchanged; an atomic process-local agent claim prevents a sibling from resuming or deleting a still-owned handle. Failed or timed-out SDK disposal retains that claim until successful disposal or process exit. This fixes a reproduced same-file `Cursor session agent scope is closed` trigger, not every cause reported in [#282](https://github.com/fitchmultz/pi-cursor-sdk/issues/282). It is not a cross-process lock or qualification of concurrent real SQLite/journal writes to one file; use native forks or separate files for independent conversations.

### Native shell parsing or module loading fails

Before loading the SDK, the extension resolves the installed `@cursor/sdk-<platform>-<arch>` package relative to `@cursor/sdk` and supplies its `vendor` directory through the SDK's `CURSOR_TREE_SITTER_VENDOR_DIR`. This lets native Bash parsing work when Pi's launcher and extension live in separate installation trees. The platform package must be installed; the extension does not download or bundle replacement native binaries.

An explicitly set `CURSOR_TREE_SITTER_VENDOR_DIR` is left untouched. Use an absolute path to a vendor directory containing both `tree-sitter` and `tree-sitter-bash`, or unset it to use package-relative discovery. Empty and relative overrides are also preserved; the SDK decides whether to use them or its own fallback lookup.

The automatically selected path is process-wide and inherited by bash commands and child Pi processes. A child running another extension install or worktree treats that inherited value as an explicit override, even if the parent's install has moved or been deleted. To rediscover the child's own parser package, launch it with `env -u CURSOR_TREE_SITTER_VENDOR_DIR pi -e .` (or remove the variable from the child environment on Windows). Alternatively, set an absolute vendor path for the child's install. Inherited overrides are not validated or replaced automatically.

A `ResolveMessage`, missing module, or missing `protoBase64` export is a loader problem, not evidence of a bad API key. The static SDK and bridge imports in 0.5.1 also repair the compiled-Bun extension graph. A packed installation reached expected invalid-key handling in official compiled Pi 1.0.3 on macOS arm64. The retained SDK 1.0.36 installed-package probe showed its nested Connect 1.7.0 / Protobuf 1.10.0 graph linking normally; forcing its Protobuf import to the root 2.16.0 package reproduces the exact missing export. That does not establish the unnamed Windows hosts' resolution in [#233](https://github.com/fitchmultz/pi-cursor-sdk/issues/233); their importer-relative paths and bootstrap remain necessary. The credential-free real-SDK first-send test reaches a blocked key-exchange boundary, not authenticated inference or every embedded loader.

SDK 1.0.37 source retains the parser-unavailable branch returning `parsingFailed`; the retained SDK 1.0.36 private package probe still executed the command. It does not itself establish why Pi received SIGTERM in the non-Cursor/opencode report [#339](https://github.com/fitchmultz/pi-cursor-sdk/issues/339). Warning text alone cannot identify the emitting artifact or signal sender.

### `pi --list-models cursor` shows no Cursor models

With `PI_CURSOR_HIDE_MODELS_WHEN_LOGGED_OUT=1`, this is expected until Cursor has effective native auth. Run `/login`, supply `CURSOR_API_KEY` or pi's `--api-key`, or unset the flag to restore default fallback availability. Known CLI model selection remains available either way.

If the flag is not the cause, confirm the package is installed:

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

The Cursor footer appears only while a Cursor model is active and `PI_CURSOR_FOOTER` is enabled (the default). Remove `PI_CURSOR_FOOTER=0` or set it to `1` to restore the status. Fast-capable local models show `cursor:local · fast:on` or `cursor:local · fast:off`; Cursor models without a fast parameter show `cursor:local · fast:n/a`. Cloud runtime shows `cursor:cloud · fast:n/a`. Cursor SDK mode is the default `agent` mode when `plan` is absent. When both are active, pi shows one combined Cursor status such as `cursor:local · fast:on · plan` or `cursor:cloud · fast:n/a · plan`.

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

pi extension toggles and pi's MCP catalog do not control Cursor ambient MCP. Local Cursor agents load MCP servers from Cursor setting sources (`PI_CURSOR_SETTING_SOURCES=all` by default), including `~/.cursor/mcp.json`. To remove a server, edit or clear that file (or Cursor MCP settings) and restart the pi session, or narrow/disable sources with `PI_CURSOR_SETTING_SOURCES=none` or a comma-separated subset. See [Cursor tool surfaces in pi](./cursor-tool-surfaces.md).
### Cursor does not call my pi extension tool

The local pi bridge only exposes tools that are active in the current pi session and present in pi's tool registry at Cursor run start. By default, it does not expose overlapping pi tool names that Cursor already has native equivalents for (`read`, `bash`, `write`, `edit`, `grep`, `find`, and `ls`). Opt in if you intentionally want Cursor to see both the Cursor-native tool and an overlapping built-in pi tool:

```bash
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 pi --model cursor/grok-4.6
```

To disable the bridge for rollback or isolation, start pi with:

```bash
PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/grok-4.6
```

### First Cursor message is slow (10+ seconds)

The extension loads Cursor setting sources with `PI_CURSOR_SETTING_SOURCES=all` by default, which includes user MCP servers from `~/.cursor/mcp.json`. On the first send of a session, the Cursor SDK connects to each configured MCP server before streaming a reply. pi-cursor-sdk shortens the known MCP initialize/listTools timeout path to **10 seconds by default** (the raw Cursor SDK default is 60 seconds), so a dead server should fail fast instead of blocking for a full minute. Unknown MCP protocol timeout stacks keep the SDK default instead of being shortened. A slow or unavailable server can still add roughly that connect timeout before the first reply. Tighten further with:

```bash
PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS=5 pi --model cursor/grok-4.6
PI_CURSOR_MCP_CONNECT_TIMEOUT_MS=5000 pi --model cursor/grok-4.6
```

Workarounds if you do not need user-level MCP in pi:

```bash
PI_CURSOR_SETTING_SOURCES=project,plugins,team pi --model cursor/grok-4.6
```

Or fix/disable the slow MCP server in Cursor settings. Maintainer timing probe: `npm run debug:mcp-coldstart`.

### A Cursor MCP tool times out

The extension raises Cursor SDK's MCP tool-call timeout from 60 seconds to 3600 seconds by default for Cursor SDK MCP `callTool` requests, including the local pi bridge and configured Cursor MCP servers. For longer local MCP tools, set one override:

```bash
PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS=7200 pi --model cursor/grok-4.6
PI_CURSOR_MCP_TOOL_TIMEOUT_MS=7200000 pi --model cursor/grok-4.6
```

A bridged pi call additionally uses a local deadline capped by that effective MCP timeout. To fail a stranded bridge call sooner without shortening other MCP servers:

```bash
PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS=120000 pi --model cursor/grok-4.6
```

### Tool calls appear as a plain text list instead of pi tool cards

This usually needs session JSONL to classify. Common cases:

- **Model text echo:** Assistant `text` blocks contain lines like `Tool call`, `Cursor activity`, or `call cursor-replay-…` without matching `toolCall` blocks — narration is not tool execution. Structured history now uses `Historical tool request/result/error` labels, retaining arguments, IDs and errors without implying an unmatched request completed. This reduces an imitable template; it does not prevent model narration or strip legitimate prose/code examples. Raw assistant history is preserved and prose is never converted into tool calls or automatically resent. See [Tool calls listed as plain text (#40 triage)](./cursor-testing-lessons.md#tool-calls-listed-as-plain-text-40-triage).
- **Stale replay routing / plan-strip:** Error `toolResult` or error assistant messages contain `Tool grep/cursor/find/ls not found`, or provider debug shows `inactive_trace` after plan-mode execute stripped active tools — tracked in **#52** (distinct from model text echo and #55).
- **Replay vs execution:** `cursor-replay-*` IDs and neutral **Cursor MCP** activity cards are display-only recorded Cursor results; they do not re-run browser/MCP work. See [Cursor native tool replay](./cursor-native-tool-replay.md).
- **Run failure / discarded tools:** A red toast with scrubbed detail may indicate an SDK failure (#55). Started-but-never-completed Cursor tools surface neutral **Cursor … did not complete** activity cards with a bounded reason when the run failed/aborted, produced no assistant text, or involved external/side-effectful tools. Incomplete fast local discovery starts (`read`, `grep`, `glob`, `ls`) are debug-only after a successful text-producing run so stale SDK start events do not create red post-answer cards; maintainer debug for the same gap remains in **#52** (`PI_CURSOR_SDK_EVENT_DEBUG=1`).
- **Hard SDK crash:** pi exited with an uncaught Cursor SDK `ConnectError` or `WriteIterableClosedError` instead of showing a normal run error — capture the stack/session tail as a process-guard regression, not #40 text echo.

Shell correlation accepts legacy names (`shell`, `bash`, `run_terminal_cmd`) with different IDs only when exactly one pending shell has identical arguments; exact IDs take precedence. This is compatibility handling, not evidence that SDK 1.0.37 emits alias-changing callback pairs. Its public shell payload uses `type: "shell"`; retained SDK 1.0.36 installed-accumulator evidence shows `onStep` preserving that completed ToolCall without adding a step ID. Assistant text or stdout progress alone does not establish completion; unmatched shell starts still remain visible and debug capture is unchanged.

Capture `pi --version`, extension version, model, flags, the exact prompt, and a redacted session dir before filing bugs.

### Cursor native tool cards conflict with another extension

Cursor native replay is a display enhancement for TUI sessions and structured JSON/RPC consumers. It replays recorded Cursor SDK activity without re-running tools, and print mode remains text-first. See [Cursor native tool replay](./cursor-native-tool-replay.md) for conflict behavior and opt-out flags.

