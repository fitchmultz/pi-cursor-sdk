# Cursor SDK capability roadmap — 2026-07-04

Status: **Active planning source of truth** for aligning `pi-cursor-sdk` with current `@cursor/sdk@1.0.23` capabilities. Last updated 2026-07-09. Contract probe results are summarized in this document. Older completed or stale plan files were removed so future sessions do not treat stale SDK/runtime guidance as current.

## Contract classification legend

Use these labels when this roadmap states SDK/runtime behavior, pi product intent, or an unresolved item status:

| Label                             | Meaning                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Implemented**                   | Code/docs/tests for this slice have landed. Notes may still describe intentionally partial rollout scope.                         |
| **Validated**                     | Backed by installed SDK types/source, official docs, or safe live/read-only probes. Safe to treat as an implementation contract. |
| **Pi policy**                     | Deliberate pi product rule layered over SDK behavior. Requires resolver/tests/docs when implemented.                             |
| **Ready for implementation**      | Evidence is sufficient to build behind feature flag/config with the listed acceptance criteria.                                  |
| **Rejected**                      | Do not build this path under the current SDK/product contract. The listed next condition is required to revisit it.              |
| **Deferred by product decision**  | Product/security policy intentionally keeps this out of the current runtime.                                                     |
| **Needs SDK/API change**          | Do not treat as an implementation task unless the SDK/API contract changes or pi owns the explicitly listed adapter burden.       |
| **Needs live account/setup**      | Requires live account, entitlement, repository, or platform setup before validation can proceed.                                  |

## Non-negotiable product constraints

1. **Local agents stay the default.** A plain `cursor/*` pi model run continues to use Cursor local agents.
2. **Pi tools stay available to local Cursor agents by default.** Any MCP-to-`local.customTools` migration is only acceptable as a transport swap. It must not make Pi tools opt-in, hidden by default, or less dynamic.
3. **Cursor cloud agents are explicit opt-in.** Cloud support must not silently replace local runs or degrade local Pi tool access. Project config may propose cloud runtime defaults, but it must not make a user's first Cursor run in that project use cloud without a user-level acknowledgement or explicit non-interactive allow.
4. **Cloud UX should feel like local Cursor UX.** Cloud runs should use the same streaming shape, TUI rhythm, status visibility, activity cards, abort expectations, and model IDs where the SDK/runtime allows it. Differences must be explicit only where cloud forces them.
5. **Cloud mode must be honest about Pi-local tools.** Until a separate secure remote bridge exists, Cursor cloud agents do not get local Pi tools through loopback MCP or `local.customTools`.
6. **The bridge invariant stays:** Cursor tool call → real pi `toolCall` → matching pi `toolResult` → Cursor result. Do not call pi tool `execute()` directly from a Cursor adapter.
7. **Full platform smoke remains required** for SDK/runtime/provider/bridge changes: `npm run smoke:platform:all`.

## Configuration and rollout policy

New behavior should start behind feature flags/config while current behavior remains the default. Use feature flags for maintainer validation and user/project config when the behavior is a real preference. After validation, defaults may flip, but keep an opt-out/fallback for a few releases when the behavior replaces a proven path such as MCP.

**Implemented**: `src/cursor-config.ts` provides the effective-config resolver with ordinary precedence, safety caps, fast-default migration, cloud/runtime/tool-transport/env scaffolding, first-use cloud acknowledgement, explicit save destinations, and trust-gated project config loading. Explicit cloud runtime now starts `Agent.create({ cloud })` after preflight, with fresh context by default and no pi bridge, inline MCP, or pi env forwarding. A minimal opt-in `npm run smoke:cloud` lane validates that path. Status footer shows local/cloud runtime using the canonical resolver path. Cloud agents are named from the pi session title when available. Explicit Cursor-managed cloud environment selection is wired without local env forwarding. Bounded cloud completion telemetry streams display-only agent/run IDs, branch/PR metadata, passive artifacts, and raw usage when available without persisting it into transcript content or feeding cloud usage into pi accounting; successful reports also record a session-branch cloud lifecycle ledger with explicit `/cursor-cloud list|archive|delete` commands for exact recorded `bc-` IDs only. Guarded local branch-scoped SDK resume is enabled by default for local runtime, with opt-out through `local.resume: false`, `--cursor-no-local-resume`, or `PI_CURSOR_LOCAL_RESUME=0`; cloud resume remains deferred. Current follow-up statuses: env forwarding, SDK agents, URL display, inline cloud MCP, automatic local force, and remote Pi bridge are classified below.

**Pi policy**: target ordinary precedence (enforced by `src/cursor-config.ts` and tests):

1. CLI flag
2. Environment variable
3. Project config
4. User config
5. Built-in default

**Validated**: current fast-only precedence (`~/.pi/agent/cursor-sdk.json` shape is `{ fastDefaults: Record<string, boolean> }`, mode `0o600`, non-secret): CLI flags → virtual alias override → session custom → global file → model default. Migrate through the resolver; do not strand this behavior.

**Pi policy**: safety caps use stricter precedence; lower-trust sources may tighten but never loosen safety controls. For the first cloud-runtime slice, project config may save runtime only. User denials win over project runtime defaults and over session/user/env defaults for sending prior pi context to cloud, env forwarding, direct push / `workOnCurrentBranch`, local-state allows, and any remote Pi bridge product decision; only an explicit one-shot CLI allow can override a user denial for that invocation. Precedence for safety-sensitive cloud choices: explicit one-shot CLI allow > user deny/cap > explicit env allow > session/user allow > built-in safe default. Project config is intentionally absent from that safety-sensitive chain.

**Validated**: non-interactive contract: pi print/JSON/RPC modes must not prompt. **Pi policy**: project config in non-interactive mode is ignored without saved project trust/`--approve`; `--no-approve` must ignore project cloud defaults. Non-interactive cloud runs fail closed unless required pi-owned safety choices are supplied by CLI/env/user/session state and are allowed by user safety caps.

Minimum config contract before implementation:

| Setting group        | CLI / env                                                                                | Config key                          | Class                             | Notes                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime              | `--cursor-runtime`, `PI_CURSOR_RUNTIME`                                                  | `runtime`                           | ordinary + first-cloud safety ack | `local` remains built-in default.                                                                                                                                      |
| First cloud ack      | `--cursor-cloud-ack`, `PI_CURSOR_CLOUD_ACK`; `/cursor-runtime cloud`                     | `cloud.acknowledged`                | user/session/CLI/env only         | Project config cannot provide first-use acknowledgement.                                                                                                               |
| Cloud repo           | `--cursor-cloud-repo`, `PI_CURSOR_CLOUD_REPO`                                            | `cloud.repo`                        | explicit override                  | Repo URL only, no credentials. Reserved for CLI/env/user/session override in the first cloud-runtime slice; do not project-save.                                        |
| Cloud branch/ref     | `--cursor-cloud-branch`, `PI_CURSOR_CLOUD_BRANCH`                                        | `cloud.branch`                      | explicit override                  | Pass only when explicit. Reserved for CLI/env/user/session override in the first cloud-runtime slice; do not infer or project-save.                                     |
| Direct push          | `--cursor-cloud-direct-push`, `PI_CURSOR_CLOUD_DIRECT_PUSH`                              | `cloud.directPush`                  | safety-sensitive                  | Maps to `workOnCurrentBranch`; default false. One-shot/user/session only in the first cloud-runtime slice; do not project-save.                                         |
| Local-only state     | `--cursor-cloud-allow-local-state`, `PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE`                  | `cloud.allowLocalState`             | safety-sensitive                  | Needed for dirty/unpushed state. One-shot/user/session only in the first cloud-runtime slice; do not project-save.                                                      |
| Context handoff      | `--cursor-cloud-context`, `PI_CURSOR_CLOUD_CONTEXT`                                      | `cloud.contextHandoff`              | safety-sensitive                  | Fresh by default. `bootstrap` is user/session/CLI/env only in the first cloud-runtime slice; do not project-save bootstrap.                                             |
| Env forwarding names | `--cursor-cloud-env`, `PI_CURSOR_CLOUD_ENV`                                              | `cloud.envNames`                    | Deferred by product decision       | Names only, never values. Parse/save shape is reserved; preflight fails while pi env forwarding remains intentionally disabled.                                           |
| Env file reading     | `--cursor-cloud-env-from-files`, `PI_CURSOR_CLOUD_ENV_FROM_FILES`                        | `cloud.envFromFiles`                | Deferred by product decision       | Extra opt-in; disabled by default and excluded from the first cloud-runtime slice.                                                                                       |
| Cloud environment    | `--cursor-cloud-env-type`, `--cursor-cloud-env-name`; `PI_CURSOR_CLOUD_ENV_TYPE`, `PI_CURSOR_CLOUD_ENV_NAME` | `cloud.environment.type/name`       | explicit Cursor-managed env select | Selects Cursor Cloud `cloud` / `pool` / `machine` environments. No local env values are read or forwarded. Project config remains ignored for the initial cloud runtime. Named `cloud` environments fail closed with explicit repo overrides. |
| Cloud MCP (reserved) | —                                                                                        | —                                   | Rejected                            | Do not expose inline cloud MCP in the initial cloud runtime; revisit only with an SDK/API contract or passing live probes for first-run availability, per-send replacement, resume/resupply, and no hidden persistence. |
| Tool transport       | `--cursor-tool-transport`, `PI_CURSOR_TOOL_TRANSPORT`                                    | `toolTransport`                     | ordinary with fallback            | `mcp` remains canonical until customTools parity is proven.                                                                                                            |
| Local safety         | `--cursor-auto-review`, `PI_CURSOR_AUTO_REVIEW`; `--cursor-sandbox`, `PI_CURSOR_SANDBOX` | `local.autoReview`, `local.sandbox` | ordinary safety feature           | Defaults stay off to preserve current behavior.                                                                                                                        |
| Local resume         | `--cursor-local-resume`, `--cursor-no-local-resume`, `PI_CURSOR_LOCAL_RESUME`          | `local.resume`                      | ordinary runtime feature          | Defaults on for local runtime. Local only; stores agent IDs in pi session custom entries, not config. Use `PI_CURSOR_LOCAL_RESUME=0` or `local.resume: false` to opt out. |
| Fast defaults        | existing slash/config behavior                                                           | `fastDefaults`                      | ordinary                          | Migrate through the same resolver; do not strand old behavior.                                                                                                         |

Config files:

- **Validated**: user config stays in `~/.pi/agent/cursor-sdk.json` and must not store secret values.
- **Validated**: project config path uses pi `CONFIG_DIR_NAME` (default `.pi`); intended path is `.pi/cursor-sdk.json`.
- **Validated**: `.pi/cursor-sdk.json` is trust-gated via `ctx.isProjectTrusted()` / pi project trust flow. **Pi policy**: add an explicit load gate in implementation.
- **Pi policy**: `.pi/cursor-sdk.json` is shareable only when a repo commits `.pi/`; this repo ignores `.pi/`, so docs must not assume versioned team sharing. It must not store secret values. For the first cloud-runtime slice, project config may save runtime only; do not project-save repo URLs, branch/ref, context bootstrap, env variable names, direct-push allows, local-state allows, or cleanup preferences.
- **Pi policy**: first-run confirmation does not automatically write project config. Initial cloud first-use disclosure should offer at most runtime save choices; Cursor Cloud owns repo, branch, env, lifecycle, dashboard, and cleanup setup.
- **Pi policy**: session custom entries are state, not config. They may record SDK agent IDs and acknowledgements, but they must not override user safety caps.

Slash commands:

- Runtime commands such as `/cursor-runtime cloud` apply to the current session immediately. Offer a one-line hint for saving, for example `/cursor-runtime cloud --save-user` or `/cursor-runtime cloud --save-project`; do not ask session-vs-project on every switch.
- Other Cursor preference slash commands can write config by default only when the setting is clearly a persistent preference and the destination is explicit.
- CLI and env always override ordinary slash/config choices for that invocation. For safety-sensitive behavior, use the safety precedence above: only an explicit one-shot CLI allow can override a user denial; env vars cannot.

## Capability status against `@cursor/sdk@1.0.23`

Impact numbers rank product/user risk, not implementation order; sequencing is intentionally handled separately below. The `customTools` ranking reflects the risk of regressing default Pi tool access, not a recommendation to prioritize that migration; the loopback MCP bridge remains canonical because SDK `customTools` lacks cancellation/deadline support.

### Implemented on branch `cursor-sdk-capability-safe-slices`

| Slice | Status | Notes |
| ----- | ------ | ----- |
| Config resolver foundation + minimal cloud runtime | **Implemented** | `src/cursor-config.ts` / `src/cursor-state.ts` / provider turn prepare — ordinary precedence, safety caps, fast-default migration, trust-gated project load, remaining cloud/tool-transport/env keys, CLI flags, first-use acknowledgement, Cursor-managed cloud environment selection, save destinations, and `/cursor-runtime`. Explicit cloud runtime starts `Agent.create({ cloud })` after preflight, with fresh context by default and no pi bridge/local MCP/env forwarding. |
| `RunResult.usage` fallback | **Rejected** | Direct and live/native-replay drains use real `turn-ended` only when the counts fit the selected model window; otherwise they fall back to bounded pi estimates. `RunResult.usage` can describe full local agent context and must not feed pi message usage, compaction, or context totals. |
| `agent.reload()` refresh | **Implemented** | `/cursor-refresh-config` calls pooled `agent.reload()` without recreating the agent. |
| Local safety controls | **Implemented** | `autoReview` and `sandboxOptions.enabled` via CLI/env/config; defaults stay off. |
| Manual local force recovery | **Implemented** | `--cursor-local-force` and `PI_CURSOR_LOCAL_FORCE` explicitly pass `send({ local: { force: true } })`; persistent project/user config cannot enable force by default, and no automatic retry/staleness recovery is added. |
| Cloud reporting | **Implemented** | Cloud direct runs stream bounded display-only agent/run IDs, pushed branch/PR metadata with fetch/checkout hint, passive artifact paths, and raw usage when available. The telemetry is stream-only and raw cloud usage stays out of pi AssistantMessage usage, context occupancy, compaction, and cost totals. |

### Open capability decisions

| Impact | Area | Current code | SDK capability | Status / next condition |
| -----: | ---- | ------------ | -------------- | ----------------------- |
|      1 | Pi tool bridge vs SDK `customTools` | `src/cursor-pi-tool-bridge-run.ts` starts an HTTP MCP endpoint; `src/cursor-session-agent.ts` passes `mcpServers` into `Agent.create`. | `LocalAgentOptions.customTools` / `LocalSendOptions.customTools` expose caller functions through the SDK's synthetic `custom-user-tools` MCP server. | **Needs SDK/API change**. Keep loopback MCP canonical. Next condition: SDK cancellation/deadline support, or a pi-owned adapter that supplies abort signals, timeouts, child cleanup, diagnostics, permissions, and platform-smoke parity. |
|      2 | Branch-scoped `Agent.resume()` | Local runtime uses in-memory pooling plus guarded session-custom-entry resume by default; cloud runtime still creates a fresh cloud agent each turn. | `Agent.resume(agentId)` can reattach to local/cloud persisted agent state after process restart. | **Implemented** for default-on local resume. Cloud resume remains deferred pending broader live smoke and product decision. |
|      3 | Automatic stuck-run recovery | Manual `send({ local: { force: true } })` is wired only when explicitly requested. | `LocalSendOptions.force` expires a stuck local active run in the persisted store before sending. | **Rejected** until pi owns session/run ownership, heartbeat/stale-process proof, active SDK run status read, stale threshold, stable idempotency key, and cross-handle warning. Manual force remains implemented. |
|      4 | SDK `agents` / Cursor-native subagents | Cursor `task` activity is displayed, but `Agent.create` omits `agents`. | `AgentOptions.agents` defines Cursor-native subagents; file-based `.cursor/agents/*.md` also load from setting sources. | **Deferred by product decision**. Do not auto-map Pi subagents. Let Cursor load `.cursor/agents/*.md`; add explicit config only after product decision. |
|      5 | Cloud reporting + lifecycle | Explicit cloud runtime starts `Agent.create({ cloud })` after preflight, with fresh context by default, no pi bridge/local MCP/env forwarding, runtime-aware footer status through the canonical resolver, cloud agent names from the pi session title, explicit Cursor-managed cloud environment selection, and session-branch cloud lifecycle ledger entries after successful reports. | Cloud agent/run IDs, branch/PR metadata, artifacts, archive/delete, and raw usage endpoints exist. | **Implemented** for bounded display telemetry plus explicit `/cursor-cloud list`, `/cursor-cloud archive <bc-agentId>`, and `/cursor-cloud delete <bc-agentId> --yes` for recorded `bc-` IDs only. No cloud resume/default-on, auto-cleanup, bulk delete, raw delete filters, or local store sweeping. URL display stays deferred by product decision. |

## Local customTools — Needs SDK/API change for default Pi-tool transport

**Current behavior:** the pi-owned loopback MCP bridge remains canonical for default local Pi tools.

**Validated**: `local.customTools` removes the pi-owned loopback HTTP MCP server, but it does **not** remove MCP semantics. The SDK exposes custom tools as a synthetic `custom-user-tools` MCP server (`GetMcpTools` / `CallMcpTool`). Preserve that fact in permission, display-name, cancellation, and debugging expectations if a separate adapter is ever built.

**Validated**: `SDKCustomToolContext` exposes only `{ toolCallId?: string }`; no `AbortSignal`, deadline, or cancellation channel. Bundled executor passes only `{ toolCallId }`.

**Validated**: per-send `send(..., { local: { customTools } })` replaces create-time tools for that run (`e.local.customTools ?? this.options.local.customTools`).

**Validated**: cancellation limit from live cancel/process probe — `run.cancel()` stops the run (`waitResult.status=cancelled`), but in-flight `customTools.execute()` does not settle and a spawned child process remained alive after the run became terminal.

**Status:** **Needs SDK/API change**. Do not migrate default Pi-tool transport to `local.customTools` under the current SDK contract. Next condition: SDK cancellation/deadline support, or a pi-owned adapter with abort signals, timeouts, child cleanup, diagnostics, permissions, and platform-smoke parity.

The current bridge already has the single source of truth an adapter would reuse if that next condition is met:

- `buildCursorPiToolBridgeSnapshot(pi, options)` reads `pi.getActiveTools()` and `pi.getAllTools()`.
- It filters inactive tools, excluded replay wrappers, and overlapping built-ins according to current policy.
- It preserves descriptions, prompt guidelines, schemas, and source info.
- `buildCursorPiToolBridgeSurfaceSignature(snapshot)` already hashes the effective tool surface for agent-pool identity.

```ts
const snapshot = buildCursorPiToolBridgeSnapshot(pi, options);
const customTools = snapshotToSdkCustomTools(snapshot);
const signature = buildCursorPiToolBridgeSurfaceSignature(snapshot);
```

### Adapter acceptance criteria if SDK/API support changes

A customTools adapter is acceptable only if all are true:

- Local Cursor agents still get active Pi tools by default.
- Dynamic per-user Pi tool surfaces still work from installed Pi extensions and active-tool settings.
- The real Pi `toolCall` / `toolResult` path is preserved.
- Built-in overlap policy remains unchanged unless explicitly approved.
- `/cursor-tools` still reports the callable Pi surface accurately.
- Visual cards/history remain equivalent.
- Timeout, cancellation, abort cleanup, and leak cleanup are equivalent to MCP.
- Tool result formatting, structured errors, redaction, progress/output handling, and debug diagnostics are equivalent to MCP.
- Approval/permission behavior is no looser than the current bridge path.
- `npm run smoke:platform:all` passes on macOS, Ubuntu, and Windows native.

## Branch-scoped SDK Agent.resume — Implemented for guarded local resume

Resume is desirable for both local and cloud agents, and the evidence sweep resolved the SDK contract enough for guarded local default-on implementation. The current implementation is intentionally local-only. It respects pi's session tree semantics by restoring only records found on the active pi branch path and still must not persist one SDK `agentId` per pi session file for all branches.

Implemented local slice:

- Persist local SDK agent IDs only in pi session custom entries, not user/project config.
- Local identity includes pi session file/id, active branch/path prefix hash, cwd/repo root, model/API/tool-surface pool key, and compaction generation.
- Pass current pi model on every `agent.send()` and pass current local tool transport to `Agent.resume(...options)`.
- Missing/deleted/unavailable local resume falls back to create + bootstrap with one display-only continuity note.
- Tests cover default-on config behavior, opt-out behavior, matching branch restore, copied session-entry rejection, tree/compaction clearing, compaction generation mismatch, model/API/tool-surface pool-key mismatch, resume failure fallback, and custom-entry persistence.

Remaining before cloud resume:

- Same-session restart proof is covered by `cursor-local-resume-restart` in `npm run smoke:platform:all` and by focused `npm run smoke:local-resume`.
- Fork/clone, tool-surface mismatch, abort/interrupted-turn, tree navigation, copied session switch, missing-agent fallback, compaction boundary, default/opt-out proof, and recorded-ID-only cleanup now have focused smoke lanes and are part of the required platform suite list.
- Tree safety was tightened after live proof found that direct navigation to an earlier `cursor-sdk-agent-resume` custom entry could reuse a future-seeing SDK agent. Old handles are rejected when the same session/pool/agent has a newer resume handle anywhere in the session file.
- Cloud resume/default-on remain deferred pending broader live smoke and product decision.
- Local cleanup/GC now has an explicit command and proof lane: `/cursor-local-resume-cleanup --dry-run` lists exact recorded superseded `agent-*` IDs and `/cursor-local-resume-cleanup --yes` deletes only those IDs through `Agent.delete(agentId, { cwd })`. SDK local-store delete filters remain match-all when IDs are omitted or empty, so do not add lower-level store deletes or bulk cleanup paths.
- Reuse across fork/clone/import by copied custom entry alone remains rejected.

Persistence:

- Store SDK agent identity in pi session custom entries because agent IDs are session/branch state.
- Store concrete pi branch/path identity metadata with the SDK agent ID so reuse can be strict. Current local fields include pi session id/file, active path prefix hash, cwd/repo root, SDK agent id, model/API/tool-surface pool key, send state, and post-compaction generation.
- Do not store SDK agent IDs in user/project config.

Identity and fallback rules:

- Bind recorded SDK agent IDs to the originating pi session file/id plus active branch/path metadata. A copied custom entry in a forked/cloned/imported session is not enough to reuse an SDK agent.
- **Validated**: `Agent.resume(agentId)` loads from store and throws if missing (`Agent ${id} not found`).
- If resume fails because state was deleted, archived, garbage-collected, moved to a different machine/store, or is otherwise unavailable, fall back to create + bootstrap from the current pi context. Show one continuity card such as “Could not resume prior Cursor agent; continuing from current pi transcript in a new Cursor agent.” Do not hard-fail unless create also fails.
- **Validated**: default store is SQLite under `getDefaultSdkStateRoot(workspaceRef)` when sqlite is available; live state under `~/.cursor/projects/.../sdk-agent-store/...`. Anchor implementation to SDK default `stateRoot`; use JSONL/custom stores only through a deliberate config path.
- **Validated**: after resume, model is null until `send({ model })`; passing `model` in `resume()` pre-seeds `_model`, but pi must still pass `send({ model })` every turn. Pi model selection is the source of truth.
- **Validated**: local inline tools (`mcpServers`, `local.customTools`) are not persisted. Without resupply, resumed runs can finish with assistant-visible tool failure such as `MCP server does not exist`; with `mcpServers` or `send({ local: { customTools } })` resupplied, tools execute. On every resume, restore transport via `Agent.resume(...options)` and/or first send.
- **Pi policy**: branch/fork identity rules remain pi-owned; do not infer tool availability from the prompt manifest alone. If the current model/tool surface cannot be restored, create a new SDK agent and bootstrap from pi context rather than silently running without Pi tools.

Reuse rules:

- Same active branch/path after process restart: resume the recorded SDK agent when the session file/id and branch/path match.
- `/compact` is an SDK-agent boundary. Pi compaction shrinks pi's transcript; it does not shrink Cursor's existing agent thread. After compaction, create or resume a post-compaction SDK agent bootstrapped from the compacted pi context and record that new agent for the active branch.
- Overflow recovery relies on the compaction boundary. A Cursor context overflow is rewritten to `context_length_exceeded` so pi compacts and retries; preserving the pre-compaction SDK agent would retry against the same full Cursor-side thread and likely overflow again.
- In cloud mode, resume is not enabled yet. Future cloud resume/compaction should show a clear continuity card such as: “Context compacted; continuing in a new Cursor cloud agent from the compacted pi summary.” Do not hide the agent handoff.
- `/tree` to the latest unsuperseded branch/path with a matching recorded SDK agent: resume that agent.
- `/tree` to a branch/path with no matching SDK agent: create a new SDK agent and bootstrap from pi's active context.
- `/tree` moving back to an earlier point must not reuse an SDK agent that has seen messages beyond the selected leaf. If the same session/pool/agent has a newer resume handle anywhere in the session file, treat the older handle as superseded and create a new SDK agent.
- `/fork` and `/clone` create a new SDK agent by default. They may record the parent SDK agent ID for traceability only.
- Session switch/resume/import must apply the same session file/id binding rules before reusing any copied SDK agent entry.
- If a resumed local branch sees a changed Pi tool surface, use the current Pi tool surface for the next send. If the active transport cannot safely update tools per send, recreate the branch SDK agent and bootstrap from pi context.

Garbage collection:

- Every new branch agent, compaction boundary, tool-surface fallback, or periodic rebootstrap can mint another SDK agent. New resume entries record replaced predecessor agent IDs as cleanup candidates when a different local agent supersedes the prior branch handle.
- Cleanup must only delete/archive SDK agent IDs that pi-cursor-sdk recorded for this session/project lineage. Never sweep the SDK store globally because other SDK consumers may share the same state root.
- **Validated**: SDK local-store delete filters treat omitted or empty IDs as match-all. Cleanup uses SDK `Agent.delete(agentId, { cwd })` with one exact recorded `agent-*` ID per call and records successful deletions in `cursor-sdk-agent-cleanup` custom entries so repeated cleanup does not retry deleted IDs.
- Preserve cloud agents after normal pi exit; explicit cloud list/archive/delete cleanup commands have landed, while cloud resume/default-on remain deferred pending broader live smoke and product decision.
- Periodic rebootstrap after `MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP` must re-record the replacement SDK agent and mark the predecessor cleanup-eligible via the same recorded-ID-only path.

Rollout:

- Branch-scoped local resume is default-on for local runtime.
- Create/bootstrap remains the fallback for opt-out, missing/unavailable SDK state, identity mismatch, tool-surface mismatch, tree safety, compaction boundaries, abort recovery, and any rejected stale handle.

Required resume probes/tests before flipping defaults:

| Probe                                         | Status                             | Notes                                                                                                                                                                      |
| --------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool re-supply without accidental persistence | **Validated**                      | Missing resupply fails; `send({ local: { customTools } })` succeeds.                                                                                                       |
| Model re-supply every turn                    | **Validated**                      | `modelBeforeSend: null` after resume until `send({ model })`.                                                                                                              |
| MCP bridge Pi tool through real pi lifecycle  | **Validated**                      | Loopback-style `mcpServers` must be re-supplied on resume; missing resupply can finish as assistant-visible MCP failure.                                                   |
| Same-session process restart                  | **Validated**                      | Platform suite `cursor-local-resume-restart` and focused `npm run smoke:local-resume` prove a recorded local SDK agent resumes across a pi process restart with the built-in default enabled. |
| Fork/clone isolation                          | **Pi policy**                      | `cursor-local-resume-safety` / `npm run smoke:local-resume:safety` prove cloned-session copied resume entries and fork-before-future branches do not reuse the original local `agent-*`, and the earlier fork does not reveal the future token. |
| Tool-surface mismatch                         | **Pi policy**                      | `cursor-local-resume-tool-surface` / `npm run smoke:local-resume:tool-surface` prove a bridge builtin tool-surface change rejects the old local resume handle, creates a bridge run, uses a new local `agent-*`, and persists a new resume pool key. |
| Abort/interrupted turn                        | **Pi policy**                      | `cursor-local-resume-abort` / `npm run smoke:local-resume:abort` prove an interrupted long-running bridge turn does not append a new resume handle, and the next same-surface restart does not reuse the pre-abort local `agent-*`. |
| Tree navigation                               | **Pi policy**                      | `cursor-local-resume-tree` / `npm run smoke:local-resume:tree` prove earlier assistant and earlier resume-entry tree targets reject the future-seeing SDK agent and do not leak the future token. |
| Session copy/switch                           | **Pi policy**                      | `cursor-local-resume-copy-switch` / `npm run smoke:local-resume:copy-switch` prove a copied session file carrying resume entries rejects the copied handle while bootstrapping from transcript. |
| Resume failure fallback                       | **Pi policy**                      | `cursor-local-resume-fallback` / `npm run smoke:local-resume:fallback` prove missing local agent IDs fall back to create+bootstrap and emit the continuity notice in `pi-stream-events.jsonl`. |
| Post-compaction new SDK agent                 | **Pi policy**                      | `cursor-local-resume-compaction` / `npm run smoke:local-resume:compaction` prove pre-compaction agent rejection, `compactionGeneration: 1` post-compaction handle persistence, and restart resume of the post-compaction agent. |
| Default-on / opt-out proof                    | **Pi policy**                      | `cursor-local-resume-default-dry-run` / `npm run smoke:local-resume:default-dry-run` prove the built-in default resumes, and `PI_CURSOR_LOCAL_RESUME=0` opts out. |
| Local cleanup/GC                              | **Pi policy**                      | `cursor-local-resume-cleanup` / `npm run smoke:local-resume:cleanup` prove `/cursor-local-resume-cleanup --dry-run` reports exact recorded superseded IDs, `/cursor-local-resume-cleanup --yes` deletes the old recorded agent, the current recorded agent still resumes, and tree navigation to the old handle falls back instead of resuming the deleted agent. |
| `RunResult.usage` without `turn-ended`        | **Rejected**                       | Local Composer 2.5 returns `RunResult.usage`, but real long-session evidence shows it can represent full agent context and poison pi compaction totals. Do not use it for pi message usage. |
| Bounded pi estimate fallback                  | **Pi policy**                      | Use bounded pi estimates when `turn-ended` is absent or outside the selected model window.                                                                                  |
| Empty delete filters rejected                 | **Pi policy**                      | SDK local-store delete filters treat omitted or empty IDs as match-all; pi must guard before SDK store calls.                                                              |

## Local force and retry behavior

Preserve SDK `local.enableAgentRetries` default behavior unless a live failure shows it conflicts with pi retry semantics. Treat SDK transport/stall retries and pi provider retries as separate layers; do not add another retry loop without idempotency and ownership checks.

**Implemented**: manual override: `--cursor-local-force` or `PI_CURSOR_LOCAL_FORCE=1` passes `send({ local: { force: true } })` for that send. Defaults stay false; project/user config cannot enable force by default; `enableAgentRetries` keeps the SDK default.

**Validated**: `send({ local: { force: true } })` expires the current active persisted local run when non-terminal and starts a new follow-up run. Store/list showed the old run as `status: "expired"`, `error: "force_send"`, `result: null`, with `endedAt` set.

**Rejected**: automatic recovery under the current pi contract. SDK force mutates persisted store state only; it does not prove pi ownership, cancel another live handle, or clean callback/process resources. A live force send allowed a second send while the first callback still owned resources; the old run's existing handle still showed `running`, and waiting on it timed out. `SendOptions.idempotencyKey` exists, but pi does not yet own a full idempotent stale-run protocol.

Next condition for automatic force: implement pi session/run ownership record, PID/heartbeat or equivalent stale-process proof, active SDK run status read, stale threshold, stable idempotency key, and cross-handle warning; then probe stale no-owner and competing-live-owner cases. Until then, auto-force stays rejected and manual force remains the only recovery path.

## Usage accounting

**Validated**: pi source of truth:

- Prefer real per-turn SDK usage from `turn-ended` events.
- Preserve existing mapping: `inputTokens` → `usage.input`, `outputTokens` → `usage.output`, `cacheReadTokens` → `usage.cacheRead`, `cacheWriteTokens` → `usage.cacheWrite`.
- Preserve existing pi semantics: `totalTokens = input + output`, not `input + cacheRead + output`.
- Never copy SDK `usage.totalTokens` directly into pi usage. Recompute pi totals from mapped fields using pi semantics.

**Validated**: SDK semantics:

- Payload fields: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, optional `reasoningTokens`.
- SDK `totalTokens` = input + output + cacheRead + cacheWrite (bundled `usage-types.ts` and live numbers).
- For local Composer 2.5, normal and resumed sends returned `RunResult.usage` even without `onDelta`; values are not safe per-turn counters for pi occupancy. Output can decrease across turns while prompt/cache fields reflect the current run context. Real compaction evidence showed `RunResult.usage` near 1M input / 900k cache-read tokens on single assistant messages, which poisoned session totals and compaction pressure.

**Pi policy**: fallback:

- Use real `turn-ended` usage when available, when it fits the selected model window, and recompute pi `total = input + output`.
- Do **not** use `RunResult.usage` for pi assistant message usage, context occupancy, or compaction totals when `turn-ended` is absent. Use bounded local prompt/output estimates instead.
- If `turn-ended` reports usage outside the selected model window, treat it as full-agent-context usage and fall back to bounded estimates rather than poisoning compaction/session totals.
- Surface SDK `reasoningTokens` only if pi has a safe usage field for it. Until then, keep it in debug/metadata rather than changing user-visible accounting semantics.

Regression coverage lives in `test/cursor-usage-accounting.test.ts`, `test/cursor-provider-stream-usage.test.ts`, and `test/cursor-provider-replay-live-run.test.ts`.

## Cloud agents support plan

Cloud support is a new explicit runtime mode, not a replacement for local mode. All existing local-only user routes must remain behaviorally unchanged: same default runtime, model IDs, fast-mode behavior, loopback MCP bridge, native replay display, visual smoke expectations, and local validation gates. Cloud work must be testable through explicit opt-in paths without forcing users or maintainers to worry that local Cursor agent behavior changed.

Interface:

```bash
# default remains local
pi --model cursor/composer-2-5

# explicit cloud opt-in
pi --cursor-runtime cloud --model cursor/composer-2-5
```

Also provide `/cursor-runtime` for interactive use.

**Validated**: current status: footer reports explicit runtime-aware status (`cursor:local · fast:on|off|n/a` or `cursor:cloud · fast:n/a`, plus optional `· plan`), anchored in `src/cursor-state.ts`, `docs/cursor-model-ux-spec.md`, tests, and `AGENTS.md`.

### Non-interactive cloud policy

Non-interactive cloud runs must never prompt. They fail closed only when pi-owned safety decisions are missing or unsafe:

- first-use cloud acknowledgement is missing: require `--cursor-cloud-ack` / `PI_CURSOR_CLOUD_ACK=1` or a user/session acknowledgement;
- prior pi context would be sent to cloud: default to a fresh cloud agent; require an explicit user/session opt-in to bootstrap from current pi context;
- dirty or unpushed local-only state exists: non-interactive runs fail every time unless explicitly allowed for that send/session; fingerprinted warn-once behavior is interactive-only, and dirty/unpushed detection is pi-owned because Cursor Cloud cannot see local-only work;
- direct push to the current branch: require an explicit one-shot or user/session opt-in if pi ever exposes `workOnCurrentBranch`; do not persist direct-push or local-state risk allows in project config.

Repo, branch, env, cleanup, and lifecycle setup belong to Cursor Cloud by default. Pi may pass explicit CLI/env/user overrides, but it should not infer, prompt for, or project-save those choices in the initial cloud runtime. SDK/API errors remain authoritative for repo/provider/branch access.

### Runtime defaults and persistence

- Built-in default is local runtime, and local behavior must stay unchanged unless cloud is explicitly selected.
- Cloud can be selected with CLI flag, env var, slash command, project config, or user config using the target precedence above once the resolver exists. Those cloud paths must not alter current local-only routes.
- Project config may save only the runtime default (`runtime: "cloud"` / `"local"`) for the initial cloud runtime. First use by a user must still require TUI acknowledgement or an explicit user/CLI/env non-interactive allow. **Implemented**: scaffold: `/cursor-runtime cloud` records session acknowledgement, `/cursor-runtime cloud --save-user` persists a personal acknowledgement, `--cursor-cloud-ack` / `PI_CURSOR_CLOUD_ACK=1` cover non-interactive acknowledgement, and project config cannot supply `cloud.acknowledged`.
- Runtime slash commands apply to the current session immediately. Saving a project default requires an explicit save flag/subcommand and is the only path that writes project config. Do not project-save repo, branch/ref, direct-push, local-state allow, context bootstrap, env names, or cleanup preferences in the first cloud-runtime slice.
- Cloud mode notes that Pi-local tools are unavailable as part of first-use disclosure. If a later product decision adds recurring warnings because cloud output references unavailable Pi tools, that recurring warning may be permanently silenced in user config.

### Cloud UX expectations

Cloud should feel like the current local Cursor provider as much as possible:

- Show footer/status so users always know whether the current agent is local or cloud. **Implemented**: status-UX slice: explicit runtime status uses `cursor:local · fast:on|off|n/a · plan` and `cursor:cloud · fast:n/a`.
- Show local-like activity/tool cards for cloud activity when the SDK reports it.
- Stream with the same shape as local runs where possible; cloud SDK surfaces support the same delta/step/stream style and should use the same pi display path when possible.
- Initial model-picker decision: keep one `cursor/*` provider and make it runtime-aware with annotations/filters, not a separate `cursor-cloud/*` provider. Revisit only if the one-provider UX proves confusing.
- **Validated**: live `Cursor.models.list()` returned 32 models; params include `fast`, `thinking`, `context`, `effort`, `reasoning`; no `maxMode` param ID. **Validated**: installed `@cursor/sdk@1.0.23` `ModelListItem` exposes `id`, `displayName`, `description`, `aliases`, `parameters`, and `variants`, with no local/cloud availability field. **Validated**: cloud docs — curated models, always Max Mode, no toggle, API pricing. **Pi policy**: Max Mode is implicit cloud runtime/billing disclosure, not a pi toggle. Param support comes from `Cursor.models.list()`; do not blanket-ban `:fast`/thinking/context if the catalog lists them. Do not invent a cloud availability map until the SDK/API exposes one or a live create-time preflight table is captured.
- `/model` should show cloud availability when runtime is cloud, `/cursor-runtime cloud` should warn if the current model/variant is not cloud-compatible, and `--list-models cursor` should include runtime availability or accept a runtime filter once an SDK/API source exists. Run-start validation remains the safety net, not the primary UX; for now, cloud model compatibility must fail closed through create-time/preflight errors, not guessed catalog metadata.
- Treat Cursor-only local state such as `fast` as `n/a` in cloud. **Implemented**: CLI/env/session/user/trusted-project cloud runtime updates the current session footer to `cursor:cloud · fast:n/a`.
- Abort cancels the cloud run by default in both interactive and non-interactive modes, matching local abort semantics and pi's expectation that abort is fast. Add an explicit detach/keep-running command or config later; do not prompt in the abort path.
- The first-run setup flow should include one non-blocking cost row: “Cloud Agents run in Max Mode and are billed at Cursor API pricing; Cursor may require spend-limit setup on first use.” Do not repeat this as a generic billing warning unless an auth/billing error blocks the run.

### First-run cloud setup flow

**Validated**: existing pi primitives can implement first-run setup: `ctx.ui.select/confirm/input/editor/notify`, `ctx.ui.setStatus`, `appendEntry`, `registerCommand`, `getAgentDir()`, `ctx.isProjectTrusted()`. Do not invent a new TUI abstraction unless these prove insufficient.

Start with one short first-use disclosure, not a repo/branch/env wizard. The disclosure should say:

- Cursor Cloud owns repo, branch, environment, lifecycle, dashboard, and cleanup setup;
- Pi-local tools are unavailable in cloud;
- prior pi context is **not** sent by default; the first cloud run starts fresh unless the user explicitly chooses bootstrap;
- dirty/unpushed local-only work is not visible to Cursor Cloud;
- Cloud Agents run in Max Mode and are billed at Cursor API pricing.

Store first-run acknowledgement in user/global Cursor SDK state, not project config. Non-interactive mode never shows this setup flow and fails closed unless cloud was already allowed by CLI/env/user/session and user safety caps.

Escalate to focused follow-up prompts only for pi-owned safety edges: context bootstrap, dirty/unpushed local state, or explicit direct-push/local-state overrides. Interactive dirty/unpushed warnings should appear once per dirty/unpushed-state fingerprint; steady-state dirty/unpushed state should degrade to a footer/status indicator so users are not trained to click through the same warning every run. Non-interactive runs still fail every time unless an explicit allow is active.

### Cloud repo, branch, and local-state honesty

- Do not infer or prompt for a cloud repo by default in the initial runtime. Let Cursor Cloud's own setup/defaults handle repo selection, or let the SDK/API return the authoritative repo/provider error.
- Support explicit `--cursor-cloud-repo` / `PI_CURSOR_CLOUD_REPO` for power users and automation. Treat it as a one-shot/user/session override, not a project default in the initial runtime.
- **Validated**: types/API docs — `repos[].startingRef`, `workOnCurrentBranch` default false creates new `cursor/...` branch from `startingRef`. **Validated**: live runs created separate Cursor branches/PRs when direct push was not requested.
- **Pi policy**: do not set `startingRef` by inference in the initial runtime; pass it only from explicit CLI/env/user/session input. Do not set `workOnCurrentBranch: true` unless the user explicitly opts into pushing commits to that existing branch. **Validated**: explicit `workOnCurrentBranch: true` direct-pushed to the selected branch and produced no PR URL.
- **Validated**: missing/unpushed `startingRef` fails with `[validation_error] Branch ... does not exist` and no server agent remains. **Pi policy**: dirty/unpushed local state is not visible to Cloud API and must be detected by pi before send. **Validated**: with GitHub branch protection requiring PR review, explicit `workOnCurrentBranch: true` did not push to protected `main`; Cursor created a `cursor/...` branch and PR instead, and `main` stayed unchanged.
- **Validated**: public `Agent.get()` cloud shape exposes `repos: string[]` only; no `startingRef`/`workOnCurrentBranch`. Use run `git.branches[]` or raw API if branch policy fields are needed.
- Do not infer or project-save an active branch/ref by default. If a branch/ref is supplied explicitly, pass it as `startingRef`; otherwise let Cursor Cloud/SDK defaults decide or fail with an SDK/API error.
- Support `--cursor-cloud-branch` as an explicit override and a separate direct-push flag if `workOnCurrentBranch` is exposed. Direct push must remain one-shot/user/session scoped; no project default in the initial runtime.
- Before a cloud send, detect local uncommitted changes and commits not pushed to the selected remote/ref when pi can observe them. Interactive runs warn that cloud cannot see local-only work once per dirty/unpushed-state fingerprint, then show a footer/status indicator for unchanged dirty/unpushed state. Non-interactive runs fail every time unless an explicit allow is active.

### Cloud environment and env vars

Do not prompt for local env forwarding on first cloud run. Cursor's native cloud environment setup is `.cursor/environment.json`, dashboard-managed secrets, snapshots, Dockerfiles, and agent-led setup. Prefer those paths rather than building a parallel secret-management system in pi. **Implemented**: explicit `cloud.environment.type/name` selection passes Cursor-managed `cloud` / `pool` / `machine` environment options without reading or forwarding local env values; named `cloud` environments fail closed with explicit repo overrides.

- Default env forwarding is none.
- Do not ship pi env forwarding in the first cloud-runtime slice. Prefer Cursor-native environment setup and show guidance toward `.cursor/environment.json`, dashboard-managed secrets, snapshots, Dockerfiles, and agent-led setup.
- **Deferred by product decision**: keep `cloud.envNames` as reserved parsed config. Until pi env forwarding is deliberately added, preflight should fail if env names are set rather than silently ignoring them. Persist only allowlisted variable names, never secret values, if this feature later ships.
- **Validated**: reject names starting with `CURSOR_`; `envVars` cannot combine with caller-supplied `agentId`. API docs mark session `envVars` as beta and say unsupported accounts may silently ignore them.
- **Validated**: SDK exposes agent-scoped `CloudAgentOptions.envVars` and run-scoped `SendOptions.cloud.envVars`. Raw API create-time `runEnvVars` exists in `V1CreateAgentRequest`, not public `AgentOptions`.
- If pi env forwarding later ships after a product decision, read current values from process env only for explicitly allowlisted names by default.
- Reading `.env.local` / `.env` for cloud forwarding is an extra explicit opt-in such as `--cursor-cloud-env-from-files`; it must not happen merely because names are allowlisted.
- If env forwarding later ships after a product decision, a user-level `cloudEnvForwarding: "disabled"` or equivalent must beat lower-trust defaults; project env-name defaults are not part of the initial cloud runtime.
- **Validated**: refreshed 2026-07-06: allowlisted `envVars` reached a cloud shell in a no-edit throwaway run (`env-present` final text). SDK transcript/tool output redacted the value as `[REDACTED]`, so pi must verify by behavior/exit status or file-size-style checks, never by printing secret values.
- **Validated**: SDK footgun refreshed 2026-07-06 — when `cloud.envVars` is used, the pre-send `agent.agentId` was a ghost ID (`Agent.get()` returned `agent_not_found`); after first `send`, both `agent.agentId` and `run.agentId` changed to the real server ID. Record post-send `run.agentId` instead.
- If pi forwards env vars in a later slice, omit caller-supplied cloud `agentId` and use SDK/API idempotency keys for duplicate-create protection instead.
- If a cloud run fails because an env var is missing, show a hint toward Cursor-native environment setup first; mention explicit pi env forwarding only after that feature exists.

### Local-to-cloud context handoff

Switching an existing pi session from local runtime to cloud can send prior pi context to Cursor cloud. That context may include local file contents, tool outputs, paths, and secrets accidentally read earlier in the session.

- Any mid-session switch from local runtime to cloud with prior context must disclose what kind of prior context may be sent and offer at least two choices: start fresh with no prior pi transcript, or bootstrap cloud from the current pi context. This is per-switch, not only first-run-per-project, because the leak risk recurs in later sessions.
- The handoff preference can be remembered in user/session state to reduce friction, but the default must be explicit and safe. Do not let project config save `bootstrap` in the initial runtime.
- Non-interactive cloud switch must start fresh unless a user/session/CLI/env option explicitly allows sending current pi context to cloud.
- Keep the cloud bootstrap bounded by the same prompt-budget and redaction rules as local, but do not pretend that makes the handoff secret-free.
- Negative privacy checklist for handoff: no env values, local MCP server config, active Pi tool metadata, local-only custom entries, or user-denied cloud state may be copied by default. Compaction summaries and tool outputs count as cloud-bound context and require the same consent as raw transcript context.

### Cloud settings, tools, and Pi bridge

- Cloud uses Cursor cloud defaults/project/team/plugins.
- Cloud may run repo `.cursor/hooks.json`, team/enterprise hooks, dashboard/cloud MCP, plugins, and cloud-managed settings. Local user Cursor settings, local user hooks, and pi `PI_CURSOR_SETTING_SOURCES` do not apply.
- Do not try to mirror local `PI_CURSOR_SETTING_SOURCES` into cloud.
- No local Pi tool bridge in cloud mode.
- No loopback MCP bridge; the cloud VM cannot call `127.0.0.1` on the user's machine.
- No `local.customTools`; SDK marks it local-only.
- Cursor Cloud MCP servers configured in Cursor/dashboard/team settings may still be available and are separate from pi-local tools.
- Inline cloud `mcpServers` are a separate, explicit cloud-safe config path, not a substitute for Pi tools. Never infer them from local loopback MCP, local user MCP, or active Pi tools.
- **Validated**: docs/types — create-time and follow-up run `mcpServers`; HTTP/SSE/stdio with headers/OAuth/stdio env. **Validated**: bundled cloud code rejects cloud MCP configs with `cwd`.
- **Rejected**: inline MCP for the initial pi cloud runtime. In a live `@cursor/sdk@1.0.23` cloud probe, create-time stdio MCP was unavailable on the first run, then persisted across resume/follow-up without resupply. Per-send replacement did not replace the persisted provider; the model mixed the old provider with the new tool name and failed.
- Next condition for inline cloud MCP: SDK/API contract or passing live probe for first-run availability, per-send replacement, resume/resupply, and no hidden persistence.
- If users expect Pi tools in cloud mode, the UI/docs must explain that Pi-local tools require local runtime unless a separate product/security decision adds a secure remote bridge.

### Cloud auth, PRs, artifacts, and lifecycle

- **Validated**: read-only live probes refreshed 2026-07-06: `Cursor.me()` OK with user-scoped key; `Cursor.models.list()` 32 models; `Cursor.repositories.list()` 191 repos and listed this repo; `Agent.list({ runtime: 'cloud' })` OK. Bad key → 401 `Invalid User API Key`.
- **Validated**: types include `IntegrationNotConnectedError` with `helpUrl` and `provider`. API overview: Cloud Agents API accepts user or service-account keys; Admin API keys are for Enterprise admin/metrics, not Cloud Agents operational auth.
- **Validated**: protected branch behavior uses normal Cursor branch/PR fallback rather than direct-pushing the protected branch. **Validated**: an archived controlled repo let the run finish with a branch-local commit and final text saying push failed with GitHub 403 because the repo was archived/read-only. **Validated**: an unsupported GitLab URL failed during send with `ConfigurationError` / `validation_error` while verifying the branch and left only a ghost pre-send agent ID. No roadmap-specific account-failure probe remains; implementation should handle entitlement and provider-connection variants through generic SDK/API error mapping plus the documented `IntegrationNotConnectedError` type.
- Cloud mode requires a Cursor API key accepted by Cursor cloud APIs. If local auth works but cloud auth is missing or unsupported, show a cloud-specific auth error. Use a user API key or service-account API key; Admin API keys for Enterprise admin/metrics are not Cloud Agents operational auth keys.
- Cloud also requires the user's plan/entitlements, an SCM integration connected for the repository provider, and read-write repository access. Catch `IntegrationNotConnectedError` and show its dashboard/help URL. `Cursor.repositories.list()` is only a weak URL precheck because SDK repository items contain just `url`; it cannot prove branch existence, write access, default branch, provider state, repo permissions, or protected-branch policy. Actual authority remains `Agent.create()` / send errors.
- **Validated**: refreshed 2026-07-06: `Agent.create({ cloud, model })` calls model validation when `model` is set; bogus model returned `ConfigurationError` code `invalid_model` with no agent created. **Pi policy**: `createCloudAgent` does not call the helper; direct callers bypass preflight. Helper is not a public export. Pi must preflight for any path that might call `createCloudAgent` directly.
- **Implemented**: name SDK cloud agents from the pi session title/name when available via `AgentOptions.name`, so Cursor cloud UI and `Agent.list()` are understandable.
- **Implemented**: expose cloud `env.type` selection (`cloud`, `pool`, `machine`) through CLI/env/user/session config before relying on non-default environments; project config is ignored for the initial cloud runtime.
- Do not impose a pi-specific PR policy. Pass through Cursor SDK defaults, expose cloud PR options in config/flags, and show the PR URL if Cursor creates one.
- Leave cloud agents alive/archiveable after normal pi exit. Do not add a cleanup/archive prompt or command in the first cloud-runtime slice; users can use Cursor UI until a later explicit cleanup feature is justified.
- **Deferred by product decision**: do not display cloud agent/run URLs yet. Raw `V1Agent.url` exists, but public SDK `SDKAgentInfo` does not expose agent/run URL. For now show agent/run IDs plus branch/PR URL; add URL display only after SDK/API evidence exists.
- **Validated**: read-only list/get agent, list/get run (`git.branches`, `prUrl`), `listArtifacts` (path/size/updatedAt), run supports `stream`/`cancel`.
- **Implemented**: display-only raw usage. Refreshed 2026-07-06: API docs expose `GET /v1/agents/{id}/usage`; the public SDK still has no wrapper and a no-edit cloud run had no `RunResult.usage` / `run.usage`, but raw `GET /v1/agents/{agentId}/usage` returned `totalUsage` and per-run usage for the real post-send agent ID. Pi fetches this endpoint best-effort for cloud stream-only completion telemetry; it does not feed pi message usage, occupancy, or compaction totals.
- Show artifact path/size lists when available. Treat artifact download as cloud-only until a local-runtime SDK contract says otherwise.
- **Validated**: `run.cancel()` returned cancelled and `Agent.getRun()` reported cancelled with `durationMs`. `Agent.archive()` returned `archived:true`; `Agent.delete()` succeeded and later `Agent.get()` returned `agent_not_found`.
- **Validated**: artifact limits refreshed 2026-07-06: `listArtifacts()` returned `[]` for a fresh no-edit run and earlier generated-file runs, including a run that wrote `artifacts/pi-probe-artifact-*.txt` in the workspace. `downloadArtifact("definitely-missing-artifact.txt")` returned validation error because artifact paths must live under `artifacts/`; downloading the generated workspace file returned `artifact_not_found`. Treat artifact support as passive list/download only for API-produced artifacts; do not assume writing a repo/workspace `artifacts/` file creates a downloadable SDK artifact.
- Do not auto-download cloud artifacts by default. Users inspect/download from Cursor UI or from an explicit download command if product scope adds one.
- When Cursor pushes a branch or opens a PR, show the pushed branch name, PR URL if present, and a one-line fetch/checkout hint so users can find the work without hunting through the dashboard.

### Remote Pi bridge — Deferred by product/security decision

No remote Pi bridge is planned or required for the current cloud runtime. Cloud Pi-tool access needs a separate product/security decision plus all of the following before implementation can be considered:

- public or tunneled HTTPS endpoint;
- per-run auth tokens;
- narrow allowlist of tools;
- explicit user opt-in;
- cancellation and timeout design;
- secret redaction;
- remote trust model;
- cleanup guarantees.

Do not let cloud-agent support depend on this.

## Implementation order

Implementation order follows the explicit statuses in this roadmap, not impact ranking.

Safe first slices:

1. Config resolver/spec/tests, including migration of existing fast defaults and safety cap precedence — **Implemented**.
2. `RunResult.usage` fallback — **Rejected** after compaction evidence for pi message usage; keep `turn-ended` usage, otherwise use bounded local estimates.
3. Explicit `agent.reload()` command — **Implemented** (`/cursor-refresh-config`).
4. Safety flag/config exposure for `autoReview` and `sandboxOptions`, preserving off-by-default behavior — **Implemented**.
5. Minimal explicit cloud runtime with fresh context by default, no pi bridge/local MCP/env forwarding, and minimal `npm run smoke:cloud` — **Implemented** with partial cloud UX.

Cloud implementation decisions after grill-me mode (2026-07-06):

| Area | Decision | Implementation effect |
| ---- | -------- | --------------------- |
| Local UX/default preservation | Current local-only Cursor routes stay behaviorally unchanged; cloud support is explicit opt-in only. | Cloud implementation PRs must prove local default/runtime/tool/status/visual behavior did not change. |
| Pi vs Cursor ownership | Pi chooses runtime and guards safety/context. Cursor Cloud owns repo, branch, env, lifecycle, dashboard, and cleanup setup. | Remove roadmap pressure to build a repo/branch/env wizard in pi. |
| First-use acknowledgement | One short disclosure with no repo/branch/env prompts. | Keep `/cursor-runtime cloud`, `--cursor-cloud-ack`, and user/session ack; project config cannot acknowledge. |
| Persistence / save destinations | Project config may save runtime only in the first cloud-runtime slice. | Do not project-save repo, branch/ref, direct-push, local-state allows, context bootstrap, env names, or cleanup preferences. |
| Context handoff | Fresh cloud agent by default. Bootstrap requires explicit user/session/CLI/env opt-in. | Non-interactive cloud defaults to fresh unless explicitly allowed. Project config cannot save bootstrap initially. |
| Repo / branch / direct push | No inferred defaults in pi. Explicit overrides may be passed; otherwise Cursor Cloud/SDK owns defaults or errors. | `--cursor-cloud-repo` / `--cursor-cloud-branch` stay power-user overrides, not project defaults. Direct push stays one-shot/user/session only. |
| Dirty/unpushed local state | Interactive: warn once per dirty/unpushed-state fingerprint, then show status. Non-interactive: fail every time unless explicitly allowed. | Avoid repeated click-through warnings without weakening non-interactive fail-closed behavior. |
| Env vars | No pi env forwarding in the first cloud runtime. | Reserved env-name config should fail preflight while product policy keeps forwarding disabled; guide users to Cursor-native env setup. |
| Usage | Raw `/usage` helper may be used for display/report only. | Never feed raw cloud usage into pi message usage or compaction totals. |
| Status UX | Implemented through the canonical runtime resolver. | Current footer shows `cursor:local · fast:on|off|n/a · plan` and `cursor:cloud · fast:n/a`. |
| Lifecycle | Leave cloud agents alive/archiveable after normal pi exit. | No cleanup/archive prompt or command in first cloud-runtime slice. |
| Cloud smoke | Minimal lane exists and is required before merging any PR that touches actual cloud runtime. | Keep `npm run smoke:cloud`; add branch/PR/direct-push/missing-branch/cancel/delete/artifact/usage coverage when those slices move to implementation. |

Outstanding user decisions are cleared for initial cloud runtime wiring. Implementation status is explicit:

- **Implemented**: guarded local branch-scoped SDK resume is default-on for local runtime with opt-out via `local.resume: false`, `--cursor-no-local-resume`, or `PI_CURSOR_LOCAL_RESUME=0`; cloud resume remains deferred.
- **Implemented**: cloud reporting bounded slice — stream display-only agent id, run id, pushed branch, PR URL, passive artifact list, and raw usage.
- **Rejected**: automatic local force until pi owns ownership/heartbeat/idempotency design plus stale no-owner and competing-live-owner probes.
- **Needs SDK/API change**: default Pi-tool transport migration to `customTools` until cancellation/deadline support exists or pi owns a full adapter.
- **Rejected**: inline cloud MCP for initial pi cloud runtime until SDK/API contract or live probes prove first-run availability, replacement, resume/resupply, and no hidden persistence.
- **Deferred by product decision**: env forwarding, cloud resume/default-on, cloud URL display, remote Pi bridge, and SDK agents / Cursor-native subagent config.

## Contract probe results

| Probe                                        | Classification                     | Result                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customTools` cancel/process cleanup         | **Needs SDK/API change**           | `run.cancel()` stops run, but in-flight `customTools.execute()` did not settle and a spawned child stayed alive. Keep loopback MCP canonical unless the SDK adds cancellation/deadline support or pi owns abort/timeouts/process cleanup.                                                                       |
| Local resume tool re-supply                  | **Validated**                      | Local `mcpServers` and `customTools` are not persisted. Missing resupply can finish as assistant-visible tool failure; resupplying tools succeeds.                                                                                                                                                               |
| Resume model re-supply                       | **Validated**                      | Model null until `send({ model })`; pi must pass model every turn.                                                                                                                                                                                                                                               |
| Local `RunResult.usage` fallback             | **Rejected**                       | Composer 2.5 returns usage fields on normal/resumed/no-delta sends, but real compaction evidence showed full-context-sized values on single assistant messages. Do not feed `RunResult.usage` into pi per-message usage or compaction totals.                                                                   |
| `local.force` persisted store behavior       | **Validated**                      | Force expires active persisted run as `status: "expired"`, `error: "force_send"`, `result: null`, then starts a follow-up run.                                                                                                                                                                                   |
| `local.force` existing handle wait           | **Rejected**                       | Automatic recovery cannot rely on old run handles/callback resources being cancelled; an old handle can still show `running` and wait can time out. Pi must not assume cross-handle cleanup.                                                                                                                     |
| `local.force` ownership                      | **Pi policy**                      | SDK does not validate pi ownership; auto-force needs pi session/run ownership, heartbeat/stale-process proof, active SDK run status read, stale threshold, stable idempotency key, and cross-handle warning.                                                                                                     |
| Cloud model preflight via `Agent.create`     | **Validated**                      | Bogus model failed pre-create with `invalid_model`.                                                                                                                                                                                                                                                              |
| Cloud model preflight via `createCloudAgent` | **Pi policy**                      | No preflight; pi must guard direct paths.                                                                                                                                                                                                                                                                        |
| Cloud model catalog / Max Mode               | **Validated**                      | Catalog params are source of truth; Max Mode implicit in cloud runtime/billing.                                                                                                                                                                                                                                  |
| Cloud `startingRef` default                  | **Validated**                      | Separate `cursor/...` branch + PR, not direct push.                                                                                                                                                                                                                                                              |
| Cloud `workOnCurrentBranch` direct push      | **Validated**                      | Explicit `workOnCurrentBranch: true` direct-pushed to the selected branch and produced no PR URL. **Pi policy**: require explicit opt-in.                                                                                                                                                                        |
| Cloud missing/unpushed branch                | **Validated**                      | Nonexistent remote branch failed with `[validation_error] Branch ... does not exist`; no server agent remained.                                                                                                                                                                                                  |
| Cloud dirty/unpushed local state             | **Pi policy**                      | Dirty/unpushed local-state detection is pi-owned because Cloud cannot see local-only work, including uncommitted changes and unpushed commits.                                                                                                                                                                   |
| Cloud protected branch                       | **Validated**                      | Protected `main` with required PR review stayed unchanged; Cursor created a `cursor/...` branch and PR.                                                                                                                                                                                                          |
| Cloud env forwarding                         | **Deferred by product decision**   | Allowlisted env reached cloud shell with SDK redaction. With `envVars`, record post-send `run.agentId`, not pre-send ghost IDs. Current runtime intentionally forwards no pi env.                                                                                                                               |
| Cloud inline MCP                             | **Rejected**                       | Initial cloud runtime must not expose inline MCP. First create-time stdio MCP was unavailable, then persisted across resume/follow-up; per-send replacement did not replace the old provider. Revisit only with SDK/API contract or passing live probes for first-run availability, replacement, resume/resupply, and no hidden persistence. |
| Cloud auth read-only                         | **Validated**                      | User key works for me/models/repos/list; bad key → auth error.                                                                                                                                                                                                                                                   |
| Cloud repo/provider/write failures           | **Validated**                      | Archived controlled repo finished with final text that push failed 403 due read-only repo. GitLab URL failed with `ConfigurationError` / `validation_error` while verifying branch and left a ghost pre-send agent ID. Keep generic SDK/API error mapping for account-specific entitlement/integration failures. |
| Cloud cancel/archive/delete                  | **Validated**                      | `run.cancel()` reported cancelled; archive returned `archived:true`; delete succeeded and follow-up get returned `agent_not_found`.                                                                                                                                                                              |
| Cloud artifacts                              | **Implemented**                    | `listArtifacts()` returned `[]`; writing a workspace `artifacts/...` file did not create an SDK artifact; missing/generated downloads return validation or `artifact_not_found`. Current runtime reports the passive artifact list only and does not auto-download.                                                               |
| Cloud usage public SDK/raw API               | **Implemented**                    | Public SDK wrapper is missing and run handles lacked usage; raw `/usage` returned total and per-run usage for the real post-send agent ID. Current runtime fetches it best-effort for display only and never feeds it into pi message usage, occupancy, or compaction totals.                                                                                     |

Cloud validation must have its own strategy: unit/contract tests for option building and error handling, plus a live cloud smoke scenario gated on cloud-capable auth/entitlements. If cloud credentials or entitlements are unavailable, report cloud smoke as **Needs live account/setup**. **Pi policy**: platform smoke should include cloud only when an opt-in cloud matrix is added to `docs/platform-smoke.md`.

Current minimal live cloud smoke lane:

- requires `CURSOR_API_KEY`;
- starts one non-interactive cloud request with explicit acknowledgement and fresh context;
- asserts cloud runtime metadata, no pi bridge, no native replay live-run mode, and cloud agent id shape;
- archives the throwaway cloud agent when an id is available and verifies `archived: true` before passing;
- provides `npm run smoke:cloud:context` as an opt-in sessionful matrix proving `fresh` does not send prior pi context and `bootstrap` does;
- keeps branch/PR/direct-push/artifact/usage scenarios out of the default local platform gate.

Expanded cloud smoke matrix when product scope requires it:

- no credentials or unsupported key type → cloud-specific auth error;
- non-interactive cloud request missing required choices → fail closed with exact remediation;
- first interactive cloud run → one setup flow, no env forwarding by default;
- unavailable model → preflight rejects it when catalog is reachable;
- `startingRef` default → Cursor creates a separate branch/PR (**Validated**);
- explicit direct push → direct-pushes only with explicit opt-in (**Validated**);
- missing/unpushed branch → fail closed with branch-does-not-exist remediation (**Validated**);
- dirty/unpushed local state → pi-owned detection before send; interactive warns once per fingerprint, non-interactive fails unless explicitly allowed; protected branch → Cursor branch/PR fallback surfaced (**Validated**);
- env forwarding disabled in initial cloud runtime → explicit env-name config fails preflight with Cursor-native env setup guidance; no env values are persisted or forwarded;
- inline cloud MCP → rejected for initial pi cloud runtime because live parity failed;
- cloud run result → pushed branch/PR/artifact list surfaced without auto-download;
- context handoff → opt-in `smoke:cloud:context` proves fresh vs bootstrap token visibility and verifies cleanup of every observed cloud agent id;
- cancel/delete cleanup and richer archive checks → validated against throwaway agents; expanded smoke must leave no remote mutation outside the throwaway repo.

Docs to update before landing behavior changes:

- `README.md` for flags, config, cloud limitations, and auth.
- `AGENTS.md` for maintainer commands, validation gates, and agent constraints.
- `CHANGELOG.md` for user-visible behavior and flag changes.
- `docs/cursor-model-ux-spec.md` for runtime-aware model/status UX.
- `docs/cursor-tool-surfaces.md` for MCP/customTools/cloud Pi-tool availability — **current policy documented: loopback MCP remains canonical, customTools needs SDK/API change before migration, cloud gets no local Pi tools**.
- `docs/platform-smoke.md` for opt-in cloud smoke matrix — **`npm run smoke:cloud` is now required for PRs that touch actual cloud runtime execution; default platform smoke remains local-only**.
- `docs/cursor-testing-lessons.md` for any new SDK/cloud contract lesson — **usage/compaction JSONL fixture lesson documented**.
- `docs/cursor-live-smoke-checklist.md` and `docs/cursor-dogfood-checklist.md` for user-visible smoke flows.

## Evidence anchors

- Live local compaction boundary evidence captured 2026-07-08 in `docs/evidence/cursor-local-compaction-boundary-2026-07-08.md` and sanitized report excerpt `docs/evidence/cursor-local-compaction-boundary-2026-07-08.report.json`. The run used `cursor/composer-2-5:slow`, compacted a three-turn session (`tokensBefore: 113244`, `estimatedTokensAfter: 40260`), wrote compaction entry `5c65d5c6`, created post-compaction agent `agent-b5e5e885-9c63-4415-9593-575418449607` instead of reusing pre-compaction agent `agent-9f5c78fb-458c-4225-9976-a95b22806221`, recalled `COMPACT_BOUNDARY_1783484227852`, and resumed the generation-1 agent on the next restart. Full session snapshots remain local gitignored artifacts because they contain large filler prompts.
- SDK official docs captured 2026-07-04 and refreshed 2026-07-05 from `https://cursor.com/docs/sdk/typescript` / `https://cursor.com/docs/sdk/typescript.md`. Cloud agent docs refreshed 2026-07-05 from `https://cursor.com/docs/cloud-agent`, `https://cursor.com/docs/cloud-agent/api/endpoints`, `https://cursor.com/docs/cloud-agent/setup`, `https://cursor.com/docs/cloud-agent/capabilities`, `https://cursor.com/docs/cloud-agent/choose-runtime`, `https://cursor.com/docs/cloud-agent/security-network`, `https://cursor.com/docs/cloud-agent/settings`, and `https://cursor.com/docs/cloud-agent/best-practices`. Official docs are behavior guidance and may lag package text; installed `@cursor/sdk@1.0.23` types/source and contract probes are the implementation contract for this repo.
- Live probes on 2026-07-05 used real Composer 2.5 local and cloud agents against temporary workspaces/repos, including protected-branch, archived-repo, artifact, env, direct-push, missing-branch, MCP, cancel/archive/delete, usage, resume, force, and customTools cancellation cases. Temporary GitHub repos and cloud agents were deleted after probes.
- Fresh probes on 2026-07-06 refreshed `@cursor/sdk@1.0.23` cloud facts: read-only `Cursor.me`/models/repositories/agent-list, invalid-key auth error, invalid-model create-time preflight, `envVars` + `agentId` guard, and one no-edit env-var cloud send. The throwaway cloud agent was deleted after the probe; the run produced no branch/PR and `listArtifacts()` returned `[]`.
- Installed SDK: `@cursor/sdk@1.0.23`.
- SDK type anchors:
  - `node_modules/@cursor/sdk/dist/esm/options.d.ts` — `LocalAgentOptions.customTools`, `autoReview`, `sandboxOptions`, `enableAgentRetries`, `LocalSendOptions.force`, `idempotencyKey`, `AgentOptions.name`, cloud options, `workOnCurrentBranch`, `repos[].startingRef`, and cloud `env.type`.
  - `node_modules/@cursor/sdk/dist/esm/agent.d.ts` — `SDKAgent.send`, `reload`, artifacts, per-send `local` / `cloud` options, and `Agent.model` being set only after successful `send({ model })`.
  - `node_modules/@cursor/sdk/dist/esm/cloud-agent.d.ts` — cloud create/resume/list/cancel/archive/delete/model/repository APIs and model preflight helper.
  - `node_modules/@cursor/sdk/dist/esm/artifacts.d.ts` — artifact path/size/update metadata.
  - `node_modules/@cursor/sdk/dist/esm/run.d.ts` — `RunResult.error`, `RunResult.usage`, `Run.usage`, and run cancel/status APIs.
  - `node_modules/@cursor/sdk/dist/esm/agent/store/local-agent-store.d.ts` — local agent store documents, statuses, checkpoints, runs, run events, cleanup/delete surfaces, and delete-filter match-all footguns.
  - `node_modules/@cursor/sdk/dist/esm/store/sqlite-local-agent-store.d.ts` and `node_modules/@cursor/sdk/dist/esm/store/sdk-state-root.d.ts` — SQLite default state-root behavior and reuse guidance.
  - `node_modules/@cursor/sdk/dist/esm/custom-tools.d.ts` — SDK customTools are exposed through synthetic `custom-user-tools` MCP definitions/executor.
- Cloud API behavior anchors:
  - `POST /v1/agents` accepts `repos[].startingRef`, `workOnCurrentBranch`, `envVars`, inline `mcpServers`, `mode`, `agentId`, and PR options.
  - `workOnCurrentBranch` defaults false, so `startingRef` normally creates a separate Cursor branch.
  - `envVars` are beta, may be silently ignored when unavailable, cannot start with `CURSOR_`, and cannot be combined with caller-supplied `agentId`.
  - Docs say follow-up run `mcpServers` replace create-time inline MCP for that run, but live cloud probes showed surprising persistence and replacement failure; treat docs as insufficient until a deterministic contract exists.
- Pi behavior anchors:
  - Pi runs in interactive, print/JSON, RPC, and SDK modes; non-interactive modes must not prompt.
  - Pi global settings live in `~/.pi/agent/settings.json`; project settings live under the project `CONFIG_DIR_NAME` directory and are loaded through the project trust flow.
  - Pi sessions are JSONL trees; `/tree` changes active leaf in the same file, while `/fork` and `/clone` create new session files.
  - Pi compaction appends compaction entries and sends compacted context; it is not the same as Cursor SDK checkpoint state, and preserving the same SDK agent after compaction would preserve Cursor-side pre-compaction context.
- Current implementation anchors:
  - `src/cursor-config.ts` — effective-config resolver, precedence, safety caps, fast-default migration.
  - `src/cursor-session-agent.ts` — agent create/pool key/local options and local safety passthrough.
  - `src/cursor-session-agent-lifecycle.ts` — current invalidation/reset hooks for tree, compaction, shutdown, model select.
  - `src/cursor-session-compaction-prep.ts` — current pre-compaction live-run release and session-agent reset.
  - `src/cursor-provider-turn-send.ts` — send options.
  - `src/cursor-pi-tool-bridge-snapshot.ts` — dynamic Pi tool snapshot and surface signature.
  - `src/cursor-pi-tool-bridge-run.ts` — current loopback MCP bridge.
  - `src/cursor-provider-run-finalizer.ts` / `src/cursor-provider-turn-finalize.ts` — usage and wait-result handling.
