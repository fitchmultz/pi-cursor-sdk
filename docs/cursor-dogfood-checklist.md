# Cursor dogfood checklist

Short maintainer checklist for **minimal-surface** validation after prompt, bridge, replay, or manifest changes. This is the fast path from pi-cursor-composer dogfood sessions—not a substitute for the required [platform smoke gate](./platform-smoke.md).

## Minimal environment

- Build first after any `src/` edit: `npm run build` (the pi manifest loads compiled `dist/`)
- Extension only: `pi --approve -e . --cursor-no-fast --model cursor/grok-4.6`
- Fresh session dir: `--session-dir /tmp/pi-cursor-dogfood-<id>`
- Baseline surface (no ambient Cursor MCP/rules):
  - `PI_CURSOR_SETTING_SOURCES=none`, **or**
  - empty / minimal `~/.cursor/mcp.json` when you need to verify user MCP config separately
- Optional: `PI_CURSOR_TOOL_MANIFEST=0` to confirm bootstrap behavior without the manifest block

## One-turn exercise

1. **Native Cursor host tool** — one `read` or `shell` call (Cursor SDK host tools; not listed in MCP `listTools`).
2. **Pi bridge** (if enabled) — one bridged call via exposed `pi__*` MCP name, e.g. `pi__cursor_ask_question` when active.
3. **Configured MCP** (optional) — only when you intentionally load Cursor MCP via settings; skip for minimal baseline.

`pi --no-tools` is a pi-registry toggle, not a Cursor SDK host-tool kill switch. In dogfood, expect it to remove pi bridge exposure while Cursor host tools can still run.

In-session debug: `/cursor-tools` prints bridge enablement, bootstrap manifest enablement, effective `PI_CURSOR_SETTING_SOURCES`, and the callable-surface manifest snapshot for the current session.

## CLI spot-check

`pi --approve -e . --list-models cursor` should exit 0 and show a Cursor model table. On pi 0.79.x that table can land on stderr in automation, so capture both streams or redirect `2>&1` before treating empty stdout as a discovery failure.

## JSONL spot-check

Inspect the session JSONL under the temp `--session-dir`:

| Pattern | Meaning |
| --- | --- |
| `cursor-replay-*` | Display-only replay of Cursor SDK activity—not callable |
| `cursor-pi-bridge-run-*` (run) / `cursor-pi-bridge-<32 hex>-t<counter>` (tool) | Live pi execution via bridge |
| Callable tools | Cursor SDK host + MCP `listTools` + exposed `pi__*` only |

Common mistake: treating `cursor-replay-*` IDs or pi transcript tool labels as tools to invoke.

## Bootstrap prompt

First send (bootstrap) should include:

- Short **Cursor SDK tool boundary** block
- **Callable tool surfaces this run** manifest (unless `PI_CURSOR_TOOL_MANIFEST=0`)
- Tail guard with shell `cd` hint

Incremental sends omit the full boundary; tail guard remains.

## Activity replay — Cursor edit card

After a Cursor **edit** tool call, confirm the activity card:

- `details.diffString` present on the replay record
- Collapsed diff preview with colored add/remove lines in the TUI

Canonical visual evidence: `npm run smoke:visual` (see [Cursor native tool visual audit](./cursor-native-tool-visual-audit.md)).

## Related docs

- [Cursor tool surfaces in pi](./cursor-tool-surfaces.md) — three namespaces and discoverability
- [Platform smoke gate](./platform-smoke.md) — required cross-platform release gate
- [Cursor live smoke checklist](./cursor-live-smoke-checklist.md) — inner-loop/manual debug checks
- [Cursor testing lessons](./cursor-testing-lessons.md) — auth, JSONL scans, plan-mode traps
