# Cursor Testing Lessons

> **Cost-conscious verification:** Offline/faux checks first; reuse exact-input retained evidence. Only changed behavior needing new real-service proof warrants the smallest meaningful live check on one representative environment. Docs/metadata-only changes need no paid runs. No full paid campaign replay, matrix-only host coverage, or automatic paid retries. No paid Cloud testing for generic PRs/releases; only explicitly Cursor Cloud-focused PRs/issues may select a necessary focused Cloud check. Automated Cursor PR reviews continue unchanged. `npm run smoke:platform:all` is optional comprehensive coverage. See [the platform smoke runbook](./platform-smoke.md) and its [implementation reference](./platform-smoke-implementation.md#portability-to-other-pi-extensions).

## Purpose

This document records maintainer testing lessons for `pi-cursor-sdk`. It complements unit tests and the [Cursor live smoke checklist](./cursor-live-smoke-checklist.md). Use it when adding regression coverage, debugging false-green releases, or building isolated smoke harnesses.

For a **minimal one-session dogfood pass** (baseline env, one native + one bridge call, JSONL ID patterns, bootstrap manifest, edit diff card), use the [Cursor dogfood checklist](./cursor-dogfood-checklist.md) only when its selected changed behavior needs new live proof; do not follow it with a full paid matrix by default.

## Core lesson: integration-shaped bugs beat unit mocks

The native replay `Tool grep not found` failure was integration-shaped, not unit-shaped:

1. **Plan mode** calls `setActiveTools(["read", "bash", "edit", "write"])` when execution starts.
2. **pi-cursor-sdk** only re-synced native replay wrappers on `session_start` / `model_select`, not every turn.
3. **The provider** still emitted native replay `toolUse` for `grep` / `cursor`.
4. **pi's agent loop** looked up tools in `context.tools` and failed with `Tool grep not found`.

Passing hundreds of unit tests did not prove that chain was safe. Regression coverage now includes:

- `test/index.test.ts` — `before_agent_start` and `turn_start` resync after plan-style strip
- `test/cursor-native-replay-stress.test.ts` — plan strip → resync → grep replay; inactive-tool trace fallbacks
- `test/cursor-provider-replay-live-run.test.ts` — inactive replay tools emit trace instead of broken `toolUse`
- `test/cursor-native-replay-trace.test.ts` — shared inactive replay trace formatting
- `test/cursor-native-replay-routing.test.ts` — `resolveNativeReplayDisposition` and `partitionNativeToolsByActiveContext`
- `test/validate-smoke-jsonl.test.ts` — replay scan semantics (real errors vs doc mentions in successful reads)

When changing provider/runtime behavior, ask whether the bug spans **pi extension lifecycle**, **active tool state**, **provider streaming**, and **persisted JSONL**. If yes, add an integration-style unit test or live smoke coverage for that chain.

## Dual-check invariant: `context.tools` vs pi active tools

Native replay routing intentionally uses two layers:

1. **Extension resync** (`before_agent_start`, `turn_start`) updates pi's active tool set via `syncRegisteredNativeCursorToolsForModel`. This fixes the common case where plan-mode execute strips `grep`/`find`/`cursor` before the next turn.
2. **Provider routing** uses the **request tool snapshot** captured when `streamCursor()` starts (`getActiveContextToolNames` in `src/cursor-context-tools.ts`): legacy `context.tools` on stock Pi 0.84/0.85, or tools replayed by the host's public helpers on transcript-only Pi. An explicit empty snapshot is not an absent legacy snapshot. It does not read live `pi.getActiveTools()` mid-stream. The bridge intentionally retains its separate registry-owned surface.

`src/cursor-native-replay-routing.ts` centralizes provider-side routing against the same `context.tools` snapshot:

- **Turn coordinator** calls `resolveNativeReplayDisposition()` per completed SDK tool → `queue_replay` (queue native `toolUse`), `inactive_trace` (`formatInactiveCursorReplayTrace()`), or `transcript_trace`.
- **Live-run drain** calls `partitionNativeToolsByActiveContext()` on already-queued native tool batches → active tools become `toolUse`; inactive tools get trace only and the batch returns `"handled"` without `toolUse`.

Disposition outcomes:

- `queue_replay` — tool is in `context.tools` and a live run exists
- `inactive_trace` — native replay tool missing from `context.tools`
- `transcript_trace` — native replay off or non-native tool

If resync runs but `context.tools` is still stale (e.g. only `read` listed), the provider must **not** emit `toolUse` for inactive tools. `test/cursor-native-replay-stress.test.ts` covers that stale-snapshot path.

## Stock/transcript provider contract

`test/cursor-provider-pi-context.test.ts` drives real `ModelRuntime` / `ModelRegistry` requests into `streamCursor`, with only Cursor SDK execution mocked. Run it against each supported host with all Pi peer imports pinned to that host (including nested native imports); a top-level package version alone is not resolution evidence. Cover official Pi 0.87.1, official latest, and current `fitchmultz/pi` main. The direct development Pi packages are locked 1.0.4 snapshots, not qualification targets; resolve latest stable official Pi and current `fitchmultz/pi` main once per workflow run. Their actual nested resolution is recorded with each check, including host TypeBox 1.3.27.

The test covers bootstrap/incremental prompts, empty-vs-absent request tools, native replay/drain, cloud fresh/bootstrap selection, and actual host prompt serialization for context files and skills. `test/native-cursor-flow.test.mjs` additionally exercises the compiled extension through the real loader and registered Cursor provider, substituting only the external SDK transport/storage. It verifies actual bridge tool execution, pending-work idle/abort/shutdown/deadline ownership, replay without file access, persisted usage/lineage, tree, compaction, queued steering, abort and reload/disposal. `test/native-cursor-prompt.test.mjs` owns genuine native input, hidden notices, required-budget input, current attachments, custom-only continuation, equivalent conversion, payload/order-changing rejection, and GitHub comment soft guidance across bootstrap/incremental/custom-only sends. `test/native-cursor-ownership.test.mjs` owns concurrent-session contracts, including independently reopened managers for the same file, pending bridge survival across sibling reload/tree/shutdown, durable-key stability and atomic live-handle exclusion. These owners use `test/helpers/native-cursor-harness.mjs` and run in the explicit `check:compat` list and manual official-host compatibility route; the native-platform Vitest job is not execution evidence for these Node test owners. Explicit `tools` is now an allowlist, not merely an initial active set; use `defaultTools` for a native fixture that allows replay wrappers to activate. `test/native-provider.test.mjs` additionally verifies canonical `SessionManager.appendContextEdit()` plus `refreshContext()`, unchanged raw history, and conversation filtering that preserves system instructions, the current tool declaration, and explicit tool removal (the focused native slice from #271). It is offline contract evidence. Add live proof only for changed behavior that still needs real-service evidence under the cost policy above; do not rerun unchanged live lanes or infer full live coverage from offline tests.

## Installed SDK vs native host evidence

The native harness substitutes external Cursor SDK transport/storage. It qualifies Pi ownership, scheduling and persisted-session behavior, not real SDK request-time linking. `test/cursor-sdk-lazy-import.test.ts` separately drives public installed `Agent.create()` → `send()` → `run.wait()` with `JsonlLocalAgentStore`, an empty credential environment/private HOME, and pre-import Node network/process guards. The positive case reaches exactly one blocked key-exchange fetch; the negative case denies an SDK module only after creation and fails before network. This protects first-send linking beyond a successful static import. The guards are public Node API interception, not an OS sandbox, and neither case qualifies authenticated gRPC, compiled Pi or the original Windows embedded hosts.

For missing exports, inspect resolution **from the failing importer**, not a root-level import. The installed SDK 1.0.36 nested Connect 1.7.0 / Protobuf 1.10.0 graph links; forcing that import to root Protobuf 2.16.0 reproduces `protoBase64`'s absence. This establishes a mechanism, not #233's unnamed host mapping. SDK-declared ranges, installed dependency versions and vendored transport versions are distinct facts.

An installed-package research probe can isolate a mechanism but cannot certify the public runtime. Exact SDK 1.0.23 source already has settings-selected hook loading, config leases, and Shell/ShellStream `updated_input.command` rewriting. Its direct hook-payload transport depends on `hooks_stdin_transport` (false by default or if initialization fails); false still delivers JSON through a POSIX heredoc or Windows PowerShell here-string, not missing hooks or missing stdin payload. SDK 1.0.36 always selects the direct transport mode. These are source endpoints, not a verified change date or rtk repair. The current-only SDK 1.0.36 Shell-hook canary used private lexical bindings and a permissive approval collaborator: it read user hooks, passed the invocation ID, applied `updated_input.command`, and observed rewritten file output, with both native parsing and `parsingFailed`. It is not historical execution, Pi/rtk or security-policy proof and must not become production integration. Replay arguments may precede rewriting; require original input, hook decision and actual executed command for the same invocation before diagnosing #173. The parser-warning branch does not establish the emitter or SIGTERM sender in #339.

For #247, exact SDK 1.0.27 source caches the exchanged bearer until invalidation, without expiry-based refresh; SDK 1.0.36 adds JWT-aware refresh, a 30-minute fallback when expiry cannot be parsed, and raw-Unauthenticated stream invalidation without interceptor resend. These source endpoints establish neither a change date, backend TTL, the original failure cause nor service recovery. SDK 1.0.27 already distinguishes classified authentication errors from raw Connect retry, shares reference-counted executor leases, and limits `agent.reload()` to workspace reload—not an auth-reset API. Failed provider runs reset their owned pool, but disposing one agent need not dispose an executor leased elsewhere. Require the redacted error chain and agent/executor/run transitions around retry and reload; do not infer a safe resend or add a guessed TTL from sanitized text.

## Maintainer-only offline proof retention

Native SQLite fixtures should open the public `SqliteLocalAgentStore` from `@cursor/sdk/sqlite` with an explicit `stateRoot` under their temporary directory, pass it as `localStore` to `createAgentPlatform`, and await `dispose()` in `finally` before removing that directory. `scopedWorkspaceRef` filters agents; it does not relocate storage. Assert the owned `index.db` exists to guard isolation. A fresh missing-agent `checkpointStore.loadLatest()` returning `null` checks the lookup boundary, not per-agent checkpoint database I/O; see `test/cursor-sdk-lazy-import.test.ts`.

Two existing test flags retain raw proof in a **fresh private** directory outside the repository (or a gitignored scratch directory):

- `PI_CURSOR_TEST_EVIDENCE_DIR` retains native SessionManager JSONL with run/metadata/options sidecars, prompt payloads/roles/images, accepted catalog bytes, terminal/late usage facts and byte-preserving journals, and custom-agent resume proof.
- `PI_CURSOR_BOOTSTRAP_PROOF_DIR` retains installed SDK output-filter captures as `sdk-capture-{plain,ansi}.json`. Run `test/cursor-sdk-output-filter.test.ts` **before** `test/native-cursor-flow.test.mjs`: the latter consumes `sdk-capture-ansi.json` for its receipt/deferred-wait diagnostic checks. Do not invent capture payloads or reuse an old sealed run directory.

The lightweight `test/helpers/raw-test-evidence.mjs` owns only directory/file writes. Payload construction and explicit flag guards stay with each owning test; unset flags perform no evidence I/O. Existing filenames, JSON fields and raw JSONL/journal/Buffer bytes are retained, not converted into a uniform schema. Writes overwrite the same filename within an owned run.

For an installed development checkout, this example builds and runs only the offline owners, with Node 24+ and no inherited credentials/profile/host selectors:

```bash
NODE24="$(command -v node)" # must resolve to Node 24+
PROOF="$(mktemp -d "${TMPDIR:-/tmp}/cursor-offline-proof.XXXXXX")"
chmod 700 "$PROOF"
mkdir -p "$PROOF/home" "$PROOF/agent" "$PROOF/tmp" "$PROOF/xdg"
offline() {
  env -i PATH="$(dirname "$NODE24"):/usr/bin:/bin" \
    HOME="$PROOF/home" USERPROFILE="$PROOF/home" XDG_CONFIG_HOME="$PROOF/xdg" \
    PI_CODING_AGENT_DIR="$PROOF/agent" TMPDIR="$PROOF/tmp" \
    PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 PI_CURSOR_SETTING_SOURCES=none \
    PI_CURSOR_TEST_EVIDENCE_DIR="$PROOF/sessions" \
    PI_CURSOR_BOOTSTRAP_PROOF_DIR="$PROOF/bootstrap" "$NODE24" "$@"
}
offline scripts/build.mjs
offline node_modules/vitest/vitest.mjs run test/cursor-sdk-output-filter.test.ts \
  test/cursor-provider-stream-usage.test.ts test/cursor-provider-replay-live-run.test.ts \
  test/cursor-session-agent-local-resume.test.ts
offline --test test/native-provider.test.mjs test/native-cursor-flow.test.mjs \
  test/native-cursor-prompt.test.mjs test/native-cursor-ownership.test.mjs
```

These artifacts may include prompts, tool arguments/results, local paths and private session facts. Never print, commit or publish them; never supply real keys to this offline workflow. Inspect persisted joins and bytes privately, then retain or remove only your owned proof directory. Offline artifacts establish the tested local SDK/native contracts, **not** all-host/backend qualification or paid-service acceptance.

## Auth: use `auth.json`, not only env

pi resolves Cursor auth in this order:

1. pi `--api-key`
2. stored `cursor` key in `~/.pi/agent/auth.json` from `/login`
3. `CURSOR_API_KEY`

For live smoke and isolated harnesses:

- **Do not assume** `CURSOR_API_KEY` or `~/.secrets` alone is enough.
- **Do assume** pi reads auth from the active `HOME`, usually `~/.pi/agent/auth.json`.
- Isolated runs with `env -i HOME=/tmp/...` must **copy** `auth.json` into that temporary home before calling `pi`.

Example seed step used by `scripts/isolated-cursor-smoke.sh`:

```bash
mkdir -p "$HOME/.pi/agent"
cp "$REAL_HOME/.pi/agent/auth.json" "$HOME/.pi/agent/auth.json"
chmod 600 "$HOME/.pi/agent/auth.json"
```

Fallback when `auth.json` lacks a `cursor` provider entry:

```bash
export CURSOR_API_KEY="your-key"
```

Never commit, log, or paste `auth.json` contents, API keys, or session JSONL with secrets.

## Isolated directories: why and how

Use isolated `/tmp` trees when validating:

- packed tarball install (`npm pack` → extract → `pi install --approve -l`)
- clean `HOME` with no inherited shell profile state
- plan-mode-style tool stripping via a shim extension
- JSONL replay-error scans independent of stdout

Recommended layout:

```text
/tmp/pi-cursor-sdk-isolated-<timestamp>/
  home/                 # seeded ~/.pi/agent/auth.json
  pack/                 # npm pack output (*.tgz)
  extract/package/      # unpacked extension
  project/              # empty pi project for install -l
  sessions/
    basic/
    native-replay/
    plan-strip/
```

Commands:

```bash
# full isolated smoke (unit preflight + pack + live pi)
npm run smoke:isolated

# pack/unit only, no live Cursor calls
SKIP_LIVE=1 npm run smoke:isolated

# custom artifact root
ISOLATED=/tmp/pi-cursor-sdk-isolated-manual npm run smoke:isolated
```

Every live check should use its own `--session-dir` under the isolated tree. Do not reuse session dirs across scenarios.

## Harness traps we hit repeatedly

| Trap | What went wrong | Fix |
| --- | --- | --- |
| Clean `HOME` without auth | `pi` could not authenticate Cursor in isolated runs | Copy `~/.pi/agent/auth.json` into isolated `HOME` |
| `npm pack \| tail -1` | Captured npm notice text, not tarball path | Use `ls -t "$PACK_DIR"/*.tgz \| head -1` |
| Packed extension, no install | Provider never loaded in isolated project | Run `npm install --omit=dev` inside extracted package |
| Inherited shell env | mise/profile hooks hung or polluted runs | Use `env -i ... MISE_DISABLE=1` for isolated pi calls |
| No per-check timeout | One stuck prompt blocked entire harness | Wrap each live check with timeout/watchdog |
| stdout-only assertions | Missed replay failures persisted only in JSONL | Scan JSONL for `Tool grep/cursor/find/ls not found` |
| Unspecified “visible” marker source | Conversation recall became an empty-workspace search | Specify conversation history only, with no tools or file inspection; compare actual send payload and SDK events before blaming history loss |
| Naive JSONL substring scan | Successful `read` of docs mentioning replay errors looked like failures | `validate-smoke-jsonl.mjs` only flags error `toolResult` / error assistant messages |
| Plan strip only on first turn | Under-tested multi-turn resync | Shim strips on every `turn_start`; stress multi-turn separately |
| Assuming env auth equals pi auth | False "blocked" or false "pass" in CI-like shells | Check `auth.json` provider keys explicitly when needed |

## JSONL is the source of truth for replay regressions

Stdout can look fine while persisted tool results contain errors. Prefer structural JSONL scans over grepping terminal output.

Replay failure scan:

```bash
node scripts/validate-smoke-jsonl.mjs --replay-errors-only "$SESSION_DIR"
```

Combined usage + replay scan after broader smoke:

```bash
node scripts/validate-smoke-jsonl.mjs --replay-errors "$SMOKE_DIR"
```

### What counts as a replay failure

The scan fails only on **persisted error messages**, not arbitrary substring matches in session JSONL:

- error `toolResult` records (`isError: true`) whose text contains:
  - `Tool grep not found`
  - `Tool cursor not found`
  - `Tool find not found`
  - `Tool ls not found`
- error assistant messages (`stopReason: "error"` or `errorMessage`) containing those strings

Successful tool results are ignored even when file contents mention those strings (for example a `read` of `docs/cursor-testing-lessons.md` during plan-strip smoke).

## Usage and compaction JSONL lessons

Session summaries can hide per-message usage bugs. When investigating token or compaction regressions, inspect assistant message `usage` rows directly:

- Native `usage.input`, `output`, `cacheRead`, and `cacheWrite` must sum to `totalTokens` and describe the same current context. Native overflow reads prompt components, not only total; keeping a small total beside cumulative billed input/cache still triggers false compaction.
- Native configured-price estimates are per emitted message, not complete Cursor invoice totals. Recorded raw/reported/billed sources overlap and must not be summed.
- Distinguish observed LOCAL full-prompt `turn-ended.usage` from public billed `AgentUsage`: normalize raw input by subtracting its cache partition once. Billed input is already uncached. The captured SDK 1.0.32 case has raw 4232 input / 4096 cache read / 3 output, corrected 136 uncached / 4096 cache / 3 output = 4235; original additive wait/handle total 8331 remains reported telemetry only. Public getter transport coverage verifies the documented disjoint billed contract; do not invent successful live endpoint access when it was unavailable.
- No single assistant message should persist SDK/full-agent-context-sized usage outside the selected model window.
- Real bad-session evidence should be reduced to a sanitized fixture, like `test/fixtures/cursor-run-usage-compaction-poison.jsonl`, instead of committing raw session JSONL.

The compaction poison fixture mirrors the observed failure shape: one assistant message with `RunResult`-sized input/cache-read counts near 1M immediately before compaction. Regression coverage proves that such usage falls back to bounded pi estimates before reaching `AssistantMessage.usage`.

Use native registered-provider tests for the full scheduler boundary. `test/native-cursor-flow.test.mjs` covers large cumulative bills with no false compaction, genuine pressure still auto-compacting, and manual compaction persisting after reopen. Its floor controls exercise actual compaction/context-edit source chronology, future/equal clocks, quoted wrappers and request-local transformations without mocking Pi's scheduler, receipt or projection. `test/cursor-provider-binding.test.ts` additionally verifies actual native header/signal identity through sequential compaction summaries, retry and tree navigation.

For LOCAL summary isolation, inspect actual SDK create/send options and persisted lineage, not assistant text alone: tools/settings empty, no bridge/MCP/manifest, mode `agent`, fresh IDs, no ordinary resume writes, agent/store disposed. Materialize the fixture's temporary directory and assert it is removed **when the native operation returns**; merely observing `dispose()` or eventual removal misses a terminal-emission/cleanup race. SDK fixtures must honor `tools: []` instead of replaying historical marker-driven tool calls despite the restriction.

`test/cursor-usage-ledger.test.ts` uses real public SessionManager custom entries and bounded filesystem journals. It protects restart, optional mirror failure, backward/equal snapshot clocks, revised/aggregate-only/large bills, linear compact-revision storage, unavailable-to-late observations, abandon without a billing fetch, late abort, owner/sibling switches, inherited cross-directory gaps, lost native claims, pricing tiers, torn-tail prefix export/native-fork recovery and malformed/symlink files. Export is a canonical view of facts and uncertainty, not an invented client-run billing join. A failed durable append must not advance recognized accounting.

For supported official hosts without committing a repair, use `node scripts/ci-compatibility.mjs --working-tree --official-only --versions 0.87.1,0.99.1,1.0.3`. This hashes an isolated source snapshot, builds/packs it, tests package loading and runs real native session contracts. Keep matching host-peer resolution and exact source evidence; offline SDK transport substitution proves integration, not live service availability. See [context/accounting boundaries](./cursor-model-ux-spec.md#context-and-accounting-boundaries) for the operational ledger ceiling and public-API limits.

### False-positive edge case (2026-05-23)

Plan-strip live smoke can make Cursor `read` testing docs that *document* replay failure strings. A naive whole-record JSON scan reported four failures from one successful `read` toolResult (`isError: false`).

For changed replay scan logic, use offline checks and valid exact-input retained evidence first. These are selectable evidence criteria, not a mandatory paid checklist:

1. Update `scripts/validate-smoke-jsonl.mjs` for the intended scanner behavior.
2. Add/adjust cases in `test/validate-smoke-jsonl.test.ts` (error toolResult must still fail; successful read of doc text must pass).
3. Use offline packed-install checks (`SKIP_LIVE=1 npm run smoke:isolated`) or valid exact-input retained proof for packaging/replay evidence. Only if the changed behavior still needs real-service proof, select the smallest meaningful existing live check on one representative environment; do not automatically run the full paid `npm run smoke:isolated` sequence. Keep the selected check's replay assertions, persisted JSONL, visual proof when relevant, and cleanup intact.

## Plan-mode regression scenario

Simulate plan-mode execute stripping with the repo fixture:

- `scripts/fixtures/plan-strip-shim/index.ts`

It sets active tools to `read`, `bash`, `edit`, `write` on each `turn_start`. Run pi with:

```bash
pi --approve -e scripts/fixtures/plan-strip-shim --cursor-no-fast --model cursor/grok-4.6 \
  --session-dir "$SMOKE_DIR/plan-strip" \
  -p 'After reset, read README.md and answer PLAN_STRIP_OK=yes.'
```

Pass criteria:

- No replay `Tool * not found` entries in JSONL
- Native replay tools (`grep`, `find`, `read`, etc.) succeed after `turn_start` resync
- On non-Cursor model switch, native replay wrappers are removed except core pi tools

## Local validation ladder

Run offline checks first, then reuse retained proof whose tested inputs are unchanged. If changed behavior still needs real-service proof, choose one existing meaningful check on a representative environment. Do not run every command below as a paid ladder; docs/metadata-only changes need zero paid runs.

TypeScript 7 owns builds and type checks. Build and typecheck commands invoke `node_modules/typescript/bin/tsc` explicitly to avoid npm's shared `tsc` shim selecting a different compiler. `@typescript/typescript6` is dev-only for AST architecture and installed-SDK contract tests because TypeScript 7 has no stable compiler API. Vitest 5 defaults `clearMocks` to `true`.

```bash
npm test
npm run typecheck
npm pack --dry-run
SKIP_LIVE=1 npm run smoke:isolated # offline helper
```

Only when changed behavior requires new local service proof, select the relevant existing suite (example: restart) and one representative target:

```bash
node scripts/platform-smoke.mjs run --target macos --suite cursor-local-resume-restart
```

Optional comprehensive coverage, not a default ship step:

```bash
npm run smoke:platform:all
```

Only for a PR/issue explicitly focused on Cursor Cloud, and only if this coverage is necessary (the multi-lane matrix is not mandatory):

```bash
npm run smoke:cloud
```

After changing `scripts/validate-smoke-jsonl.mjs` or replay scan expectations, also run:

```bash
npm test -- test/validate-smoke-jsonl.test.ts
```

Use the [Cursor live smoke checklist](./cursor-live-smoke-checklist.md) as a menu for necessary changed-behavior proof the selected script does not cover, not a full paid campaign. Keep distinct behavior assertions, persisted evidence, visual inspection when relevant, and cleanup intact. Diagnose failures offline; no automatic paid retries.

## What belongs in CI vs platform/manual smoke

- **CI / default `npm test`:** mocked provider tests, extension lifecycle tests, JSONL validator tests, script syntax/help checks. No live Cursor calls.
- **Focused local live proof:** a necessary existing single-suite/single-target check for changed behavior only. Reuse valid retained proof instead of repeating unchanged lanes.
- **Comprehensive local matrix:** `npm run smoke:platform:all` (doctor first), optional rather than an unconditional commit/release gate.
- **Cloud testing exception:** no paid Cloud testing for generic PRs/releases. Only PRs/issues explicitly focused on Cursor Cloud may select a necessary focused Cloud check. Cloud file touch alone does not qualify; the multi-lane `npm run smoke:cloud` is not mandatory. Run/evidence and agent/repository cleanup contracts remain intact.
- **Automated Cursor PR reviews:** continue unchanged; do not disable them or introduce extra push/review churn for testing.
- **Manual helpers:** `smoke:isolated`, `smoke:live`, and selected checklist sections are available, but run only the smallest necessary check.

If a selected necessary live check lacks auth or setup, report that specific proof gap, not a pass. Optional unselected matrix lanes do not block landing.

## Cursor SDK event capture probe

When debugging TUI/progress/replay timing gaps, capture raw Cursor SDK surfaces side-by-side instead of writing a throwaway probe:

```bash
CURSOR_API_KEY=... npm run debug:sdk-events -- \
  --cwd ~/Projects \
  --model composer-2.5 \
  --prompt 'Scan all of my projects and give me ideas that would be great to add the Cursor SDK to' \
  --out /tmp/pi-cursor-sdk-sdk-events-manual
```

The script writes timestamped artifacts under `--out` (default `/tmp/pi-cursor-sdk-sdk-events-<timestamp>`):

- `stream-events.jsonl` — `run.stream()` messages
- `on-delta.jsonl` — `agent.send(..., { onDelta })` updates
- `on-step.jsonl` — `agent.send(..., { onStep })` steps
- `wait-result.json` — final `run.wait()` metadata
- optional `conversation.json` with `--include-conversation`
- `summary.json` — event counts and timing gaps

Stdout prints artifact paths and summary counts only. Raw payloads stay on disk and may contain local paths, project text, tool args/results, or secrets — do not commit or share them.

Hard repo rule: Cursor SDK behavior claims must come from the installed `@cursor/sdk` package and/or https://cursor.com/docs/sdk/typescript, not from memory or ad-hoc probes alone. Current validation targets Node 24+, exact `@cursor/sdk@1.0.36`, official Pi 0.87.1/latest, and current `fitchmultz/pi` main.

## Pi provider SDK event capture

When debugging pi parsing, replay routing, bridge timing, or send-plan behavior, capture the raw `onDelta`/`onStep` payloads **as the Cursor provider receives them** instead of using the direct SDK probe above.

One-shot maintainer script (RPC pi run, gitignored artifacts by default):

```bash
CURSOR_API_KEY=... npm run debug:provider-events -- \
  --cwd . \
  --model cursor/grok-4.6 \
  --prompt 'Repro prompt here' \
  --out .debug/cursor-sdk-events/manual-repro
```

Or read a prompt from disk:

```bash
CURSOR_API_KEY=... npm run debug:provider-events -- \
  --prompt-file .debug/repro-prompt.txt \
  --out .debug/cursor-sdk-events/manual-repro
```

Artifacts under `--out` (default `.debug/cursor-sdk-events/<timestamp>/` under `--cwd`):

- `metadata.json` — model, cwd, send-plan/provider metadata
- `context-snapshot.json` — full pi `Context` passed into the provider turn
- `send-payload.json` — exact `agent.send()` input (text + images)
- `on-delta.jsonl` — raw `InteractionUpdate` objects passed to `turnCoordinator.handleDelta`
- `on-step.jsonl` — raw `onStep` payloads passed to `turnCoordinator.handleStep`
- `stream-events.jsonl` — raw `run.stream()` events when supported
- `pi-stream-events.jsonl` — exact pi stream events emitted to the TUI (`text_delta`, `thinking_delta`, replay cards, `done`, etc.)
- `provider-events.jsonl` — provider lifecycle markers (`agent_send_start`, `agent_send_returned`, …)
- `live-run-events.jsonl` — queued native replay / bridge live-run events
- `bridge-events.jsonl` — bridge lifecycle/request diagnostics (file-only; no stderr unless bridge debug is also enabled)
- `bridge-raw.jsonl` — raw bridged MCP args/results
- `display-decisions.jsonl` — per-tool native replay routing (`queue_replay`, `emit_trace`, `inactive_trace`, dedupe skips, bridge ignores) with transcript/trace text
- `coordinator-events.jsonl` — turn-coordinator side effects (task progress labels, discarded incomplete started tool calls, etc.)
- `drain-events.jsonl` — live-run pre-send drain and per-turn drain lifecycle (`turn_start`, `turn_end`, inactive replay traces, native display registration)
- `timeline.jsonl` — merged cross-layer timeline (one grep-friendly stream for the whole turn)
- `pi-session-snapshot.jsonl` — copy of pi session JSONL at turn finalize (session dir also gets latest `pi-session.jsonl`)
- `final-partial.json` — assistant partial emitted to pi at end of the provider turn
- `errors.jsonl` — provider/stream/conversation failures
- `wait-result.json` — `run.wait()` result
- `conversation.json` — `run.conversation()` when supported
- `summary.json` — counts and artifact paths

During any normal pi session you can also opt in with:

```bash
PI_CURSOR_SDK_EVENT_DEBUG=1 pi --approve -e . --model cursor/grok-4.6
```

Multi-turn sessions group automatically by pi session file:

```text
.debug/cursor-sdk-events/sessions/<session-slug>/
  session.json                 # index of all turns in this pi session
  turn-001-<timestamp>/        # first provider turn
  turn-002-<timestamp>/        # second provider turn
  ...
```

Each turn still gets the full per-turn artifact bundle above. Use `session.json` to jump between turns while debugging incremental send, bridge resolution, or native replay continuation across pi messages. For tool-heavy turns, trace/thinking replay often drains on the **next** pi message — check turn N+1 `drain-events.jsonl` and `pi-stream-events.jsonl` alongside turn N `display-decisions.jsonl`.

Optional env:

- `PI_CURSOR_SDK_EVENT_DEBUG_DIR` — base directory (default `.debug/cursor-sdk-events`)
- `PI_CURSOR_SDK_EVENT_DEBUG_SESSION_DIR` — exact session root for all turns in the current pi session
- `PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR` — exact artifact directory for one isolated turn (the maintainer script sets this via `--out`; bypasses session grouping)
- `PI_CURSOR_SDK_EVENT_DEBUG_STDERR=1` — also print the summary line to stderr (off by default so the pi TUI stays normal)

Capture is file-only by default: no stderr markers, and bridge diagnostics during SDK event debug go to `bridge-events.jsonl` instead of `[pi-cursor-sdk:bridge]` unless you separately set `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1`. Raw payloads stay on disk and may contain secrets — do not commit or share them.

### Discarded incomplete SDK tool calls

When Cursor emits `tool-call-started` without a matching completion/step result, the provider surfaces a bounded neutral **Cursor … did not complete** activity card or thinking trace at run end for failed/aborted runs, runs with no assistant text, and external/side-effectful tools. Incomplete fast local discovery starts (`read`, `grep`, `glob`, `ls`) are debug-only after a successful text-producing run so stale SDK start events do not create red post-answer cards. pi bridge MCP calls (`pi__*`) are excluded because pi already shows the real pi tool execution path.

With `PI_CURSOR_SDK_EVENT_DEBUG=1`, each discarded started call is also recorded in `coordinator-events.jsonl` under phase `discarded-incomplete-started-tool-call` with:

- normalized SDK tool name
- scrubbed call-id hash (raw call IDs are not written)
- reason such as `no-completion-at-run-end`, `abort`, or `sdk-failure`

Stderr output for these records requires `PI_CURSOR_SDK_EVENT_DEBUG_STDERR=1`. This complements the standalone `npm run debug:sdk-events` probe by interpreting a specific provider discard path during normal pi runs. User-visible incomplete cards explain actionable gaps in the TUI; debug artifacts remain maintainer-only (**#52**) and are the source of truth for suppressed fast-local stale starts.

## Tool calls listed as plain text (#40 triage)

**Symptom:** Assistant output lists tool invocations (for example `Tool call`, `Cursor activity`, `call cursor-replay-…`, `toolName`, `browser_navigate`) instead of pi tool execution cards/results.

**What the screenshot in [#40](https://github.com/fitchmultz/pi-cursor-sdk/issues/40) shows:** Plain assistant text that mirrors the old prompt transcript format (`Tool call (Cursor activity, call cursor-replay-…): …`) rather than a rendered pi `toolCall` card. That pattern is narration, not proof that pi failed to emit `toolcall_start` / `toolUse`. Structured tool history now uses `Historical tool request/result/error` in `src/context.ts`; an unmatched request remains a request. Regression coverage retains arguments, IDs, errors, raw messages/fingerprints, prose/code fences, prompt paths and coherent estimates. The change removes an imitable template, not prior assistant text or the underlying model behavior in #257.

**Do not close #40 as duplicate of #55 without session JSONL.** #55 surfaces scrubbed SDK run failures and abort causes in the TUI. #40 can occur with no error toast when the model prints tool metadata as assistant text, when replay is display-only but the user expected real execution, when stale native replay routing or plan-strip resync gaps produce `Tool * not found` errors (see **#52**), or when started SDK tools were discarded at run end (see **#52** maintainer debug and [Discarded incomplete SDK tool calls](#discarded-incomplete-sdk-tool-calls) above). A hard **process exit** from uncaught `ConnectError` / `ETIMEDOUT` is **#43**, not #40 text echo.

### Reporter checklist (required before claiming a provider bug)

Ask the reporter (or capture yourself) for:

| Field | Why |
| --- | --- |
| `pi --version` and installed `pi-cursor-sdk` version | Confirms extension/runtime in use |
| Model ID (for example `cursor/grok-4.6`) | Routing/replay behavior is model-scoped |
| Exact repro prompt and prior turns | Multi-turn replay history affects prompt text |
| Flags: `--cursor-no-fast`, `PI_CURSOR_PI_TOOL_BRIDGE`, `PI_CURSOR_EXPOSE_BUILTIN_TOOLS`, `PI_CURSOR_SETTING_SOURCES`, `PI_CURSOR_TOOL_MANIFEST` | Bridge vs native-only vs narrowed settings; bootstrap callable-surface manifest |
| Whether the listed names are `pi__*` bridge MCP, Cursor-native (`browser_navigate`, `WebSearch`), or `cursor-replay-*` replay IDs | Three different surfaces (see [Cursor native tool replay](./cursor-native-tool-replay.md#live-bridge-vs-replay)) |
| Red toast / `errorMessage` text, if any | Distinguishes #55 failure surfacing from silent text echo |
| Process exit / uncaught `ConnectError` / `ETIMEDOUT` stack trace, if any | Hard network crash (**#43**), not #40 model text echo |
| Session JSONL path (redact secrets before sharing) | Source of truth for `toolCall` vs plain `text` blocks; scan for replay `Tool * not found` (**#52**) |

### Capture steps (maintainers)

Use an isolated session dir and do not paste auth, tokens, or raw debug payloads into issues.

```bash
SMOKE_DIR="/tmp/pi-cursor-sdk-issue40-$(date +%s)"
mkdir -p "$SMOKE_DIR/home/.pi/agent"
cp "$HOME/.pi/agent/auth.json" "$SMOKE_DIR/home/.pi/agent/auth.json"
chmod 600 "$SMOKE_DIR/home/.pi/agent/auth.json"

env -i HOME="$SMOKE_DIR/home" PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
  MISE_DISABLE=1 \
  PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1 \
  pi --approve -e . --cursor-no-fast --model cursor/grok-4.6 \
  --session-dir "$SMOKE_DIR/session" \
  -p '<exact reporter prompt>'
```

Optional provider/SDK timelines (separate from pi session JSONL; see [Pi provider SDK event capture](#pi-provider-sdk-event-capture) and [Cursor SDK event capture probe](#cursor-sdk-event-capture-probe)):

For pi parsing, replay routing, or bridge timing, prefer:

```bash
npm run debug:provider-events -- \
  --cwd "$PWD" \
  --model cursor/grok-4.6 \
  --prompt '<exact reporter prompt>' \
  --out "$SMOKE_DIR/provider-events"
```

Or add `PI_CURSOR_SDK_EVENT_DEBUG=1` to the pi run above (writes under `.debug/cursor-sdk-events/`).

For raw Cursor SDK surfaces only:

```bash
npm run debug:sdk-events -- \
  --cwd "$PWD" \
  --model composer-2.5 \
  --prompt '<exact reporter prompt>' \
  --out "$SMOKE_DIR/sdk-events"
```

### JSONL classification (decision tree)

Start with whether pi stayed alive:

0. **pi process exited / shell returned with an uncaught SDK transport error** — examples include `ConnectError` with `ETIMEDOUT`/`ECONNRESET` and `WriteIterableClosedError: WritableIterable is closed`. Current code keeps Connect/network suppression scoped to active provider turns; raw Cursor SDK `AbortError` DOMExceptions are suppressed while any provider turn or session process-error guard is active. The exact SDK-provenance closed-writable shape is guarded for the Pi session lifecycle because controlled-exec can reject after the originating provider turn when it attempts to write after its output iterable has closed; Bun requires an explicit rejection listener because it bypasses the patched `process.emit` path. The old raw child-stdin EPIPE workaround was removed because Cursor SDK fixed that path by 1.0.27. Unrelated failures remain fatal. Treat a fresh process exit as a process-guard regression, capture the stack/session tail, and route it separately from #40 model text echo. If tools were mid-flight, note whether session JSONL ends abruptly and whether the final tool call lacks a result.

Then inspect the failing assistant turn in `$SMOKE_DIR/session/*.jsonl`:

1. **Error `toolResult` (`isError: true`) or error assistant message contains `Tool grep/cursor/find/ls not found`** — stale `context.tools` snapshot or plan-strip resync gap after plan-mode execute stripped active tools. Run `node scripts/validate-smoke-jsonl.mjs --replay-errors-only "$SMOKE_DIR/session"`. Optional: `display-decisions.jsonl` from `PI_CURSOR_SDK_EVENT_DEBUG=1` shows `inactive_trace` routing. Route to **#52** — not model text echo (those strings appear in persisted error records, not narrated `Tool call (` lines). See [Dual-check invariant](#dual-check-invariant-contexttools-vs-pi-active-tools).
2. **`content` has `type: "toolCall"` blocks and matching `toolResult` rows** — pi executed or replayed tools; if the TUI still looked like plain text, capture a screenshot and pi version (possible pi TUI/display issue, not provider dispatch).
3. **`content` is only `type: "text"` and text contains `Tool call (` / `cursor-replay-` / serialized arg keys** — model text echo of prompt transcript format; not #55, not #52 stale routing. Compare with `buildCursorPrompt()` output in the prior turn.
4. **No `toolCall` blocks, no error toast, user expected real execution** — check whether names are replay-only (`cursor-replay-*`) or Cursor-native MCP; replay never re-runs work ([replay doc](./cursor-native-tool-replay.md)).
5. **`stopReason: "error"` or scrubbed `errorMessage`** — classify under **#55**; check whether incomplete started tools were discarded (`discardIncompleteStartedToolCalls()`). Discarded starts with no completion and no model text echo: see `coordinator-events.jsonl` phase `discarded-incomplete-started-tool-call` ([Discarded incomplete SDK tool calls](#discarded-incomplete-sdk-tool-calls) above); route broader stale/inactive replay gaps to **#52**.
6. **Bridge expected (`pi__*` in Cursor MCP)** — inspect stderr `[pi-cursor-sdk:bridge]` JSONL with `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1`. Exposure records are not connection proof; `mcp_initialized` is a validated server notification receipt, `mcp_tools_list` is catalog-handler output, and request records establish actual call handling. None proves model consumption or ongoing health. See [bridge diagnostic boundaries](./cursor-tool-surfaces.md#diagnosing-advertised-but-unused-bridge-tools).

Quick structural scan (no secrets):

```bash
node scripts/validate-smoke-jsonl.mjs --replay-errors-only "$SMOKE_DIR/session"
rg '"type": "toolCall"|Tool call \(Cursor|cursor-replay-' "$SMOKE_DIR/session"/*.jsonl
```

### When to file follow-ups

- **#43/#107** — pi exited from an uncaught Cursor SDK transport failure (hard crash, not a scrubbed #55 toast). Observed Connect/network shapes remain guarded only during active provider turns. Raw SDK-provenance `AbortError` DOMExceptions are guarded while a provider turn or session guard is active, and the exact SDK-provenance `WriteIterableClosedError` is guarded for the Pi session lifecycle because controlled-exec can reject after a turn. The removed raw child-stdin EPIPE workaround must not be reintroduced without new current-SDK evidence. Unrelated failures remain fatal, and new exits need stack/session evidence.
- **#55** — caught SDK run failure or abort with missing/opaque detail (already addressed on main for surfacing).
- **#52** — stale/inactive native replay routing after plan-strip or stale `context.tools` snapshot (`Tool * not found` in JSONL, `inactive_trace` in `display-decisions.jsonl`); or maintainer needs an explicit "started X, never completed" debug line when JSONL shows no completion and no model text echo.
- **New issue** — bridge dispatch failure with `[pi-cursor-sdk:bridge]` evidence, or proven provider bug with JSONL showing missing `toolCall` despite SDK `tool-call-completed` in `on-delta.jsonl` from `debug:provider-events` or `debug:sdk-events` artifacts.
## Related docs and scripts

- [Cursor live smoke checklist](./cursor-live-smoke-checklist.md)
- [Cursor native tool replay](./cursor-native-tool-replay.md)
- `scripts/isolated-cursor-smoke.sh`
- `scripts/tmux-live-smoke.sh`
- `scripts/validate-smoke-jsonl.mjs`
- `scripts/debug-sdk-events.mjs`
- `scripts/debug-provider-events.mjs`
- `shared/` — runtime-safe ESM helpers consumed by provider `src/` and maintainer scripts (`cursor-sensitive-text.mjs`, `cursor-setting-sources.mjs`).
- `scripts/lib/` — maintainer plumbing (CLI arg parsing, secret-aware `fail()`, child-process shutdown, shell timeout/auth helpers). Re-exports `shared/` helpers so published smoke/debug scripts stay aligned with provider runtime (`test/maintainer-scripts-lib.test.ts`).
- `test/helpers/pi-harness.ts` — canonical fake pi/extension harness (`createPiHarness`, shared model/context/event helpers)
- `test/helpers/cursor-provider-harness.ts` — Cursor SDK provider mocks and stream helpers (re-exports pi-harness fixtures; `createNativeToolDisplayPiForTest` for native replay)

Compatibility campaign watchdogs must bound setup and suite phases separately. A Linux run passed all unit assertions in 153.52 seconds but exhausted the old combined 180-second build/verify/native command budget as native tests started; killing only npm left children alive while cleanup removed their workspace. A later Ubuntu run exhausted even the independent 180-second verification budget while tests were still passing; it produced no terminal suite summary, so eventual completion and success are unknown. The command helper now defaults build/native and other commands to 180 seconds, and exactly `npm` with arguments `["run", "verify"]` to 360 seconds; explicit caller timeouts, including zero, take precedence. The campaign retains independent phases, stops owned POSIX descendants on a watchdog error, and allows twenty minutes for the complete two-host job. Keep every individual case deadline/assertion unchanged; downstream ENOENT after workspace removal is teardown evidence, not a product regression.
