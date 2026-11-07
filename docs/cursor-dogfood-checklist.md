# Cursor dogfood checklist

Short maintainer menu for **legacy/hybrid native-replay dogfood**, including the Pi bridge and callable-surface manifest. This is an explicit `PI_CURSOR_LEAN=0` exercise, **not the product's default lean policy**. Start with offline/faux checks and reuse exact-input retained evidence. Only changed behavior needing new real-service proof warrants a selected exercise on one representative environment; docs/metadata-only changes need no paid runs. The [platform smoke matrix](./platform-smoke.md) is optional, not a routine ship step. No full paid campaign replay or automatic paid retries. No paid Cloud testing for generic PRs/releases; only explicitly Cursor Cloud-focused PRs/issues may select necessary focused Cloud proof. Automated Cursor PR reviews continue unchanged.

## Minimal environment

- Explicit legacy surface on every Pi launch: `PI_CURSOR_LEAN=0`. Default lean disables native host tools and replay wrappers, so it cannot satisfy this checklist's native assertions.
- Native host exercises require native tools permitted by policy. Preserve `PI_CURSOR_NATIVE_TOOLS=0` if present; report native evidence unavailable under that restriction rather than overriding it or claiming a pass. Replay-card checks also require native display/registration not explicitly disabled; a bridge check requires the bridge enabled.
- Build first after any `src/` edit: `npm run build` (the pi manifest loads compiled `dist/`)
- Checkout run: `PI_CURSOR_LEAN=0 pi --approve -e . --cursor-no-fast --model cursor/grok-4.6` (use an isolated profile if other installed providers/extensions would affect the exercise)
- Fresh session dir: `--session-dir /tmp/pi-cursor-dogfood-<id>`
- For a baseline without ambient Cursor MCP/rules, set `PI_CURSOR_SETTING_SOURCES=none`. If verifying user MCP loading separately, intentionally select the required setting sources and use an empty/minimal `~/.cursor/mcp.json`; editing that file alone does not disable Cursor rules or other setting layers.
- Optional: `PI_CURSOR_TOOL_MANIFEST=0` to confirm bootstrap behavior without the manifest block

## One-turn exercise

1. **Native Cursor host tool** — one `read` or `shell` call (Cursor SDK host tools; not listed in MCP `listTools`).
2. **Pi bridge** (if enabled) — one bridged call using an actually exposed `pi__*` name and its declared schema. Do not assume a particular delegation, MCP, or question tool is active.
3. **Configured MCP** (optional) — only when you intentionally load Cursor MCP via settings; skip for minimal baseline.

**Only for this legacy exercise**, `PI_CURSOR_LEAN=0 pi --no-tools ...` removes Pi bridge exposure without disabling otherwise permitted Cursor host tools. It can also remove replay wrappers, so host execution alone is not replay-card proof. In product-default lean mode, native host tools are already disabled and `--no-tools` leaves a text-only surface; do not apply the legacy expectation there.

In-session debug: `/cursor-tools` prints bridge/manifest enablement, effective `PI_CURSOR_SETTING_SOURCES`, and current-registry exposure eligibility. It is not an already captured run's catalog, connection/health check, or invocation proof.

## CLI spot-check

`PI_CURSOR_LEAN=0 pi --approve -e . --list-models cursor` should exit 0 and show a Cursor model table. Capture both stdout and stderr before treating empty stdout as a discovery failure. The list can be cached/fallback data; it does not prove authentication or the callable tool surface.

## JSONL spot-check

Inspect the session JSONL under the temp `--session-dir`:

| Pattern | Meaning |
| --- | --- |
| `cursor-replay-*` | Display-only replay of Cursor SDK activity—not callable |
| `cursor-pi-bridge-run-*` (run) / `cursor-pi-bridge-<32 hex>-t<counter>` (tool) | Live pi execution via bridge |
| Callable tools in this legacy exercise | Policy-permitted Cursor host tools, configured MCP from the selected setting sources, and currently exposed Pi `pi__*` tools; MCP `listTools` does not list host tools |

Common mistake: treating `cursor-replay-*` IDs or pi transcript tool labels as tools to invoke.

For claimed successful native execution/replay, require an actual assistant `toolCall` with a `cursor-replay-*` ID and a later non-error `toolResult` with that same ID and tool name in the same session file. Narration, a final success marker, or an unpaired/failed call is not proof. For a selected native `read`, the existing validator's `--replay-errors-only --require-native-read` options enforce that read pair; they do not establish shell, edit, or other tool-category coverage.

## Bootstrap prompt

First send (bootstrap) should include:

- Short **Cursor SDK tool boundary** block
- **Callable tool surfaces this run** manifest (unless `PI_CURSOR_TOOL_MANIFEST=0`)
- Tail guard with shell `cd` hint

Incremental sends omit the full boundary; tail guard remains.

## Activity replay — Cursor edit card

With `PI_CURSOR_LEAN=0`, native tools permitted, and replay display/registration enabled, select a Cursor **edit** that reports a recorded diff and confirm the activity card:

- `details.diffString` present on the replay record
- Collapsed diff preview with colored add/remove lines in the TUI

For selected changes needing new real-TUI proof, `npm run smoke:visual` supplies the explicit legacy/native replay pins (see [Cursor native tool visual audit](./cursor-native-tool-visual-audit.md)). Do not treat a default lean run or a native-disabled capture as native replay evidence.

## Related docs

- [Cursor tool surfaces in pi](./cursor-tool-surfaces.md) — three namespaces and discoverability
- [Platform smoke](./platform-smoke.md) — focused selection and optional comprehensive matrix
- [Cursor live smoke checklist](./cursor-live-smoke-checklist.md) — inner-loop/manual debug checks
- [Cursor testing lessons](./cursor-testing-lessons.md) — auth, JSONL scans, plan-mode traps
