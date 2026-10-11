# pi-cursor-sdk

Use Cursor models in [Pi](https://pi.dev) with Cursor's local SDK agent, tools, and settings. This extension adds Cursor to Pi's model picker and keeps Pi's login, sessions, thinking controls, and tool UI available while Cursor runs its agent loop.

![Pi sends prompts through pi-cursor-sdk to a local Cursor SDK agent, which uses Cursor tools and can call active Pi tools through a loopback MCP bridge; replies and activity return to Pi.](.github/readme/cursor-in-pi.png)

*Pi handles your session; Cursor's local agent handles model requests and tools. Model requests still go to Cursor.*

## Quick start

You need **Node.js 24+**, **Pi 0.87.1+**, and a **Cursor SDK API key**. Cursor Desktop and Agent CLI login are separate from SDK authentication; use a user key from Cursor Dashboard → API Keys or a service-account key from Team settings. Team Admin keys are unsupported.

```bash
pi install npm:pi-cursor-sdk
pi --model cursor/grok-4.6
```

Inside Pi:

1. Run `/login` → **Use an API key** → **Cursor**, then paste your key.
2. Run `/cursor-refresh-models` to load the live model catalog.
3. Ask a question about your project. Use `/model` to choose another Cursor model.

The package installs `@cursor/sdk` for you. You can also [install from GitHub or for one project](docs/reference.md#install).

**Next:** [choose a model](#choose-a-model), [understand the tools](#tools-and-settings), or [configure defaults](docs/reference.md#cursor-local-agent-config-and-safety-controls).

## Choose a model

Use `/model` interactively, or select a model when starting Pi:

```bash
pi --model cursor/grok-4.6
pi --model cursor/gpt-5.5@1m --thinking medium
pi --model cursor/grok-4.6:slow
```

- `cursor/` selects this provider.
- `@1m` selects a catalog-supported context window.
- `--thinking` uses Pi's thinking controls where Cursor exposes a configurable parameter.
- `:fast` and `:slow` choose a speed preference for models that support Cursor's `fast` parameter.

Model availability and supported controls come from Cursor's catalog. Run `pi --list-models cursor` to see your choices. Startup can show a cached or fallback catalog, so seeing a model does not prove that your API key works.

See the [model and thinking reference](docs/reference.md#choosing-a-model) for aliases, context variants, and parameter mappings.

## Everyday controls

Run these commands inside Pi:

| Command | What it does |
| --- | --- |
| `/cursor-fast` | Toggles and saves a fast preference for the selected model, when supported. Select the unsuffixed model to change its default. |
| `/cursor-mode plan` | Uses Cursor SDK plan mode for this session; `/cursor-mode agent` switches back. |
| `/cursor-refresh-models` | Refreshes the live Cursor model catalog. |
| `/cursor-refresh-config` | Reloads filesystem Cursor config in the current pooled SDK agent. |
| `/cursor-http on` | Enables and saves HTTP/1.1/SSE compatibility for local Cursor streams. |
| `/cursor-usage` | Shows recorded Cursor usage and billing observations for the current branch. |

For a single run, use `--cursor-fast`, `--cursor-no-fast`, or `--cursor-mode plan`. Saved preferences and CLI overrides are explained in the [reference](docs/reference.md#fast-mode).

The footer shows the selected runtime and fast state, such as `cursor:local · fast:off`; `plan` and `http1` appear when enabled. `PI_CURSOR_FOOTER=0` hides the Cursor status.

Cursor SDK plan mode can show Cursor plans and todos. Those cards are display-only and do not control Pi's separate plan-mode extension or todos.

## Tools and settings

Local runs have two callable tool surfaces:

- **Cursor tools:** files, shell, edits, and configured Cursor MCP servers. Cursor owns their execution and loads setting sources by default.
- **Pi tools:** active extension/custom tools exposed through a local loopback MCP bridge as `pi__*` names. The bridge is enabled by default; overlapping Pi built-ins are hidden because Cursor has native equivalents.

**Pi's `--no-tools`, `--tools`, and `--exclude-tools` affect the Pi bridge. They do not disable Cursor's native tools or configured MCP servers.** Local auto-review and sandbox controls are off by default; see [safety controls](docs/reference.md#cursor-local-agent-config-and-safety-controls) before relying on them. Hook enforcement has an [open qualification limit](docs/reference.md#cursor-local-agent-config-and-safety-controls).

```bash
# Use Cursor tools without the Pi tool bridge.
PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/grok-4.6

# Skip ambient Cursor settings, rules, plugins, and MCP configuration.
PI_CURSOR_SETTING_SOURCES=none pi --model cursor/grok-4.6
```

Cursor activity cards replay recorded SDK results; they never re-run a shell command or apply an edit again. Some activity, including web search, appears only after the SDK run finishes or may be unavailable to replay.

Read [Tool surfaces](docs/cursor-tool-surfaces.md) for bridge controls, skill activation, optional questions, and MCP diagnostics, or [Native replay](docs/cursor-native-tool-replay.md) for supported activity cards.

## Sessions, images, and usage

Compatible local follow-up turns reuse a Cursor agent. Persisted Pi sessions can resume recorded local agents after a restart; if reattachment fails, the extension starts a new agent from the current Pi transcript and shows a continuity note. [Resume, custom storage, and exact-ID cleanup](docs/reference.md#cursor-local-agent-config-and-safety-controls) have additional safeguards and recovery instructions.

Images attached to the current user request are sent to Cursor. Earlier images are replaced by transcript placeholders; reattach an image when asking about it again.

Pi's default footer and `/stats` track native context usage. Cursor billing is recorded separately:

```text
/cursor-usage
/cursor-usage refresh
/cursor-usage export cursor-usage.json
```

Refresh queries public billing without sending a model prompt. Export creates a new private JSON file; it does not overwrite an existing file. Billing observations can lag or change and are not final invoices. Inspect paths and identifiers before sharing an export. See [usage and journal recovery](docs/reference.md#context-compaction-and-cursor-usage).

## Optional Cursor Cloud

Local is the default. In interactive Pi, `/cursor-runtime cloud` offers a first-use confirmation before remote execution. Cloud can branch, commit, push, and open PRs, and uses Max Mode billing at Cursor API pricing.

Cloud starts with fresh context by default, requires a persisted Pi session, and has no local Pi tool bridge or Pi environment forwarding. Cloud agents are retained until you explicitly manage them with `/cursor-cloud list`, `/cursor-cloud archive`, or `/cursor-cloud delete ... --yes`.

Read the [Cloud setup, acknowledgement, and cleanup reference](docs/reference.md#cloud-runtime-and-acknowledgement) before starting a remote run.

## If something goes wrong

- **Models appear but a run fails:** run `/login` with a Cursor SDK key, then `/cursor-refresh-models`. Desktop/CLI login is not used. You can also set `CURSOR_API_KEY` in the shell that starts Pi; keep secrets out of config files and logs.
- **First reply is slow:** Cursor connects to configured MCP servers on first send. Fix or disable a slow server in Cursor settings, or [narrow the setting sources](docs/reference.md#first-cursor-message-is-slow-10-seconds).
- **Streams fail behind a VPN or proxy:** try `/cursor-http on`. It changes local SDK transport, not proxy or certificate configuration.
- **A tool is missing or only appears as text:** compare [tool surfaces](docs/cursor-tool-surfaces.md) and [replay troubleshooting](docs/reference.md#tool-calls-appear-as-a-plain-text-list-instead-of-pi-tool-cards).
- **Startup shows fallback models despite a saved key:** official Pi 1.0.4 and 1.1.0 have a [known startup refresh race](docs/reference.md#model-catalog-cache). The documented repair is in the maintained Pi fork.

For other issues, see [Troubleshooting](docs/reference.md#troubleshooting). [Report a bug](https://github.com/fitchmultz/pi-cursor-sdk/issues) with Pi/extension versions, model, flags, exact prompt, and a redacted session. Debug artifacts can contain prompts, tool results, paths, and secrets; inspect them before sharing.

## Read more

- [Full reference](docs/reference.md): authentication, installation, models, configuration, Cloud, storage, limits, and troubleshooting.
- [Development and releases](docs/development.md): offline checks, event capture, compatibility targets, model snapshots, and release procedures.
- [Model UX design](docs/cursor-model-ux-spec.md): maintainer design notes.
- [Changelog](CHANGELOG.md): version history.

If you need a generic OpenAI-compatible endpoint for other clients, see the [comparison](docs/reference.md#why-use-this-instead-of-an-openai-compatible-cursor-endpoint).

## License

[MIT](LICENSE) · Mitch Fultz
