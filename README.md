# pi-cursor-sdk

Use Cursor models from [Pi](https://pi.dev)'s terminal UI. `pi-cursor-sdk` runs Cursor's SDK agent loop and connects it to Pi's model picker, sessions, and extension tools.

![Pi sends prompts through pi-cursor-sdk to a local Cursor SDK agent, which uses Cursor tools and can call active Pi tools through a loopback MCP bridge; replies and activity return to Pi.](.github/readme/cursor-in-pi.png)

*The agent runs locally. It sends model requests to Cursor and brings replies and tool activity back into Pi.*

## Quick start

You'll need Node.js 24+, Pi 0.87.1+, and a Cursor SDK API key. Get a user key from Cursor Dashboard → API Keys or a service-account key from Team settings. Team Admin keys won't work. Cursor Desktop and Agent CLI login don't supply the SDK key.

```bash
pi install npm:pi-cursor-sdk
pi --model cursor/grok-4.6
```

Inside Pi:

1. Run `/login` → **Use an API key** → **Cursor**, then paste your key.
2. Run `/cursor-refresh-models` to load the live model catalog.
3. Ask a question about your project. Use `/model` to choose another Cursor model.

The package installs `@cursor/sdk` for you. [GitHub and project-local installs](docs/reference.md#install) are also available.

Start with the controls below, or go to the [configuration reference](docs/reference.md#cursor-local-agent-config-and-safety-controls) to set defaults.

## Choose a model

Use `/model` inside Pi, or choose a model when you start it:

```bash
pi --model cursor/grok-4.6
pi --model cursor/gpt-5.5@1m --thinking medium
pi --model cursor/grok-4.6:slow
```

The `cursor/` prefix selects this provider. `@1m` chooses a context window listed in Cursor's catalog. `--thinking` adjusts the thinking level when Cursor exposes that control. Models that support Cursor's `fast` parameter also have `:fast` and `:slow` choices.

Run `pi --list-models cursor` to see what's available. Startup can use a cached or fallback catalog, so seeing a model in the list doesn't mean your key works. See the [model reference](docs/reference.md#choosing-a-model) for the full selection rules.

## Everyday controls

Run these commands inside Pi:

| Command | What it does |
| --- | --- |
| `/cursor-fast` | Toggles and saves a fast preference when the model supports it. Choose the model without `:fast` or `:slow` to change its default. |
| `/cursor-mode plan` | Uses Cursor's plan mode for this session. `/cursor-mode agent` switches back. |
| `/cursor-refresh-models` | Refreshes the live Cursor model catalog. |
| `/cursor-refresh-config` | Reloads filesystem settings in the current Cursor agent. |
| `/cursor-http on` | Enables and saves HTTP/1.1/SSE compatibility for local Cursor streams. |
| `/cursor-usage` | Shows recorded Cursor usage and billing observations for the current branch. |

For one run, pass `--cursor-fast`, `--cursor-no-fast`, or `--cursor-mode plan`. The [reference](docs/reference.md#fast-mode) explains which overrides win over saved preferences.

The footer shows status such as `cursor:local · fast:off`, with `plan` or `http1` when enabled. Set `PI_CURSOR_FOOTER=0` to hide the Cursor status.

Cursor's plan and todo cards show what Cursor did. They don't control Pi's separate plan-mode extension or Pi todos.

## Tools and settings

Cursor handles files, shell commands, edits, and its configured MCP servers. Your active Pi extension tools are also available through a local MCP bridge as `pi__*` names. That bridge is on by default. Pi's matching built-ins stay hidden because Cursor already provides them.

**Pi's `--no-tools`, `--tools`, and `--exclude-tools` only change the Pi tools exposed through the bridge. Cursor's native tools and configured MCP servers remain available.**

Local runs don't enable Cursor auto-review or sandboxing by default. Read the [safety controls](docs/reference.md#cursor-local-agent-config-and-safety-controls) to turn them on. If you rely on Cursor hooks to change or block commands, check the known hook limits on that page.

```bash
# Use Cursor tools without the Pi tool bridge.
PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/grok-4.6

# Skip Cursor settings, rules, plugins, and MCP configuration loaded from disk.
PI_CURSOR_SETTING_SOURCES=none pi --model cursor/grok-4.6
```

Cursor activity cards display recorded SDK results. They never re-run a command or apply an edit again. Some activity, including web search, only appears after the run finishes; the SDK doesn't always provide enough data to show a card.

[Tool surfaces](docs/cursor-tool-surfaces.md) explains bridge settings, skill loading, optional questions, and MCP diagnostics. [Native replay](docs/cursor-native-tool-replay.md) lists the supported activity cards.

## Sessions, images, and usage

When you continue a compatible local conversation, the extension keeps the same Cursor agent. It can reconnect to a recorded agent after a Pi restart. If that fails, it starts a new agent from your current Pi transcript and shows a continuity note. See [resume and storage](docs/reference.md#cursor-local-agent-config-and-safety-controls) for the matching rules and cleanup commands.

Images attached to your current request go to Cursor. Earlier images become placeholders in the transcript, so reattach an image if you ask about it again.

Pi's default footer and `/stats` keep their native context accounting. To see Cursor billing separately, use:

```text
/cursor-usage
/cursor-usage refresh
/cursor-usage export cursor-usage.json
```

Refresh asks for public billing data without sending a model prompt. Export creates a new private JSON file and won't overwrite an existing file. These observations can lag or change; they aren't final invoices. Check the paths and identifiers before sharing an export. [Usage and journal recovery](docs/reference.md#context-compaction-and-cursor-usage) covers the details.

## Optional Cursor Cloud

Local is the default. Run `/cursor-runtime cloud` inside Pi to see the first-use confirmation before remote execution. Cloud can branch, commit, push, and open PRs. It uses Max Mode billing at Cursor API pricing.

Cloud starts with fresh context by default and needs a persisted Pi session. It has no local Pi tool bridge or Pi environment forwarding. Cloud agents remain in Cursor until you explicitly archive or delete them; `/cursor-cloud list` shows the agents recorded for your session branch.

Read the [Cloud setup and cleanup guide](docs/reference.md#cloud-runtime-and-acknowledgement) before starting a remote run.

## Troubleshooting

If models appear but a run fails, run `/login` with a Cursor SDK key, then `/cursor-refresh-models`. You can also set `CURSOR_API_KEY` in the shell that starts Pi. Keep keys out of config files and logs.

A slow first reply can come from Cursor connecting to a configured MCP server. Fix or disable that server in Cursor settings, or [narrow the setting sources](docs/reference.md#first-cursor-message-is-slow-10-seconds). For streaming failures behind a VPN or proxy, try `/cursor-http on`; it doesn't configure your proxy or certificates.

If a tool is missing or only appears as text, check [tool surfaces](docs/cursor-tool-surfaces.md) and [replay troubleshooting](docs/reference.md#tool-calls-appear-as-a-plain-text-list-instead-of-pi-tool-cards). Official Pi 1.0.4 and 1.1.0 also have a [startup refresh race](docs/reference.md#model-catalog-cache) that can leave fallback models visible despite a saved key. The documented repair is in the maintained Pi fork.

There's more in the [troubleshooting reference](docs/reference.md#troubleshooting). When [reporting a bug](https://github.com/fitchmultz/pi-cursor-sdk/issues), include Pi/extension versions, the model, flags, exact prompt, and a redacted session. Debug artifacts can contain prompts, tool results, paths, and secrets. Check them before sharing.

## Reference and development

The [full reference](docs/reference.md) holds detailed configuration and limits. For checks, model snapshots, and release procedures, see [Development](docs/development.md). Maintainer design notes are in the [model UX spec](docs/cursor-model-ux-spec.md); version history is in the [Changelog](CHANGELOG.md).

If you need an OpenAI-compatible endpoint for other clients, the [comparison](docs/reference.md#why-use-this-instead-of-an-openai-compatible-cursor-endpoint) explains that choice.

## License

[MIT](LICENSE) · Mitch Fultz
