# Desired outcomes vs verification

Reference model: native pi built-ins (`zai/glm-5.1` or any provider using pi `read` / `bash` / `ls` / `grep` / `find` / `write` / `edit`).

Cursor still runs SDK tools. pi only **replays recorded results** in interactive TTY (`PI_CURSOR_NATIVE_TOOL_DISPLAY=1`).

## Outcome categories

| Category | What “good” means |
|---|---|
| **Display** | Green native tool card (`.tool-execution`), same renderer as built-ins — not scrubbed thinking transcript |
| **Semantics** | `toolCall` / `toolResult` turn shape; session JSON stores structured tool results |
| **Safety** | Recorded results only; replay wrappers do not re-run file/shell/MCP operations |
| **Fidelity** | Card chrome matches pi: call header, collapsed/expanded body, labels — not merely “not Cursor write” |

## Per-tool desired outcomes

### read

| Desired | Verified |
|---|---|
| Green `read` card with relative path | Yes (`after-p1`) |
| pi `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` truncation + expand hint | Yes (code + screenshot) |
| Full Cursor-observed or labeled local preview in `toolResult` | Yes |
| Pre-tool `thinking` in same `toolUse` turn when SDK sends it | Code path yes; Composer often omits thinking |

### ls / bash

| Desired | Verified |
|---|---|
| Native `ls` / `bash` cards | Yes |
| No SDK `timeout` in displayed bash args | Yes |
| Workspace paths shortened in displayed commands | Yes |
| Command text may differ (`ls src` vs `ls -1 src`) — Cursor chooses command | Expected difference |

### grep

| Desired | Verified |
|---|---|
| **Not** plain markdown / thinking transcript for completed grep | Yes — `main` used transcript (`capture-p4-full`) |
| Native green **`grep`** card via `createGrepToolDefinition` replay | Yes (`after-p4`) |
| Call line: `grep /pattern/ in path` style | Yes (pi grep renderer) |
| Body: ripgrep-style match lines from **recorded** Cursor result | Yes; line format may differ from live pi `grep` execute |
| `main` did not register `grep` replay — regression guard | Yes — only 5 tools on `main` |

**PR wording:** “plain transcript → green grep card” is correct for **display class** (transcript fallback → native card). Desired outcome is not “identical ripgrep output to GLM” but “native grep tool UX with recorded matches.”

### find (glob)

| Desired | Verified |
|---|---|
| Native green **`find`** card (not transcript) | Yes (`after-p5`) |
| `glob` / `file_search` SDK names map to `find` replay | Yes (code) |

### write

| Desired | Verified |
|---|---|
| Title **`write`** + accent path — not `Cursor write` | Yes (`capture-write` before vs `composer-write` after) |
| pi write: **call** shows `write path`; **success result body empty** | **Gap fixed in this branch** — replay had been dumping `formatWrite` transcript + extra summary lines |
| SDK may implement “write” as `edit` with create diff | Session may show `cursor_edit` + diff — **faithful replay**, not wrong tool |
| Card matches GLM single-line header when SDK sends `write` | After render fix |

### edit

| Desired | Verified |
|---|---|
| Title **`edit`** + accent path — not `Cursor edit` | Yes (`capture-edit` before vs `composer-edit` after) |
| pi edit: call `edit path`; expanded body shows **colored unified diff** (`renderDiff`) | **Gap fixed** — replay had custom “updated … +1 -1” summary instead of pi diff renderer |
| `details.diff` / `diffString` from Cursor preserved for expand | Yes (code) |

### delete / readLints / mcp / other

| Desired | Verified |
|---|---|
| Green replay card (`cursor_delete`, `cursor_read_lints`, `cursor_mcp`, `cursor_tool`) | Code + unit tests |
| No transcript fallback for unknown tools | Yes (`cursor_tool` catch-all) |
| Live screenshot matrix | Not all re-captured in `pr-assets` (optional follow-up) |

## Functional turn shape (all tools)

| Desired | Verified |
|---|---|
| Assistant `toolUse` with `toolCall` blocks | Provider tests |
| pi `toolResult` with recorded content | Provider tests |
| Post-tool thinking/text as later assistant content | Provider tests |
| No second execution on replay `execute` | Replay-only tools throw without recorded id |

## What we should **not** claim

- Pixel-identical command strings inside bash/ls cards (Cursor chooses commands).
- Composer always emits pre-tool thinking (SDK-dependent).
- Every SDK tool name maps to a distinct pi builtin (edit-with-diff for create is still `cursor_edit`).
- “write” PR screenshots if the session actually replayed `cursor_edit` — label the card honestly.

## Regenerate evidence

```bash
cd experiments/visual-parity
bash capture-before-after.sh   # main vs branch, prompts 1–5
bash run-suite.sh              # includes write/edit + glm reference
node capture-html-tool-cards.mjs
node build-comparison-gallery.mjs
```
