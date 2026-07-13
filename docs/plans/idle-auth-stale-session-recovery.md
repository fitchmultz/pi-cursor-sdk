# Plan: Idle auth stale-session recovery

**Status:** Approved 2026-07-13 — implement Phase A+B+C (10m acquire-time idle + retry safety net + classifier/messages).  
**Branch:** `fix/idle-auth-stale-session`  
**Fork:** https://github.com/tejasghutukade/pi-cursor-sdk  
**Upstream:** https://github.com/fitchmultz/pi-cursor-sdk  
**Worktree:** `/Users/tejasghutukade/Projects/pi-cursor-sdk-idle-auth`  
**Base:** `origin/main` @ `922723a` (v0.1.57 prep)  
**Revised:** 2026-07-13 — primary fix flipped from reactive retry to durable pool idle invalidation.  
**Approval:** Proper fix (10m idle + retry safety net).

## Decision needed from you

Reply with one of:

1. **Approve proper fix (recommended)** — implement Phase A (acquire-time idle invalidate) + Phase B (one-shot retry safety net) + Phase C (classifier/messages). Default idle budget **10m** (under observed ~13m floor).
2. **Approve with different idle budget** — same phases; tell us the minutes (e.g. 5 / 12 / 15).
3. **Needs more revisions** — note which sections to change.

---

## Purpose

Stop intermittent post-idle Cursor turns from failing with a misleading “API key invalid/unauthorized” error when the stored Cursor API key is still valid. Prefer **preventing** reuse of a long-idle pooled SDK agent over recovering after the failure.

## Problem

User-visible error (today):

```text
Cursor SDK request failed because the Cursor SDK API key may be invalid or unauthorized.
Cursor Agent CLI/Desktop login is not reused. Run /login -> Use an API key -> Cursor,
verify CURSOR_API_KEY, or pass --api-key, then retry.
```

### Observed causal chain

1. `pi-cursor-sdk` pools a long-lived local Cursor SDK agent per session (`src/cursor-session-agent.ts`). Ready entries have **no idle age check** and are leased forever until pool-key mismatch, lifecycle invalidation, or failure abandon.
2. After long idle (local evidence: min ~13m, median ~2.8h across 11 session occurrences), the first `agent.send()` on that pooled agent fails with Cursor SDK `ConnectError` / `[unauthenticated]` (gRPC code 16).
3. `sanitizeCursorProviderError()` in `src/cursor-provider-errors.ts` remaps that to `AUTH_CURSOR_SDK_ERROR_MESSAGE`, which blames the API key.
4. The turn path already abandons/resets the pool on failure (`abandonSessionCursorAgent` → `resetSessionCursorAgent`).
5. The user’s next message creates a fresh agent and succeeds with the same key — so the failure is recoverable, but only manually.

Related history: issue [#101](https://github.com/fitchmultz/pi-cursor-sdk/issues/101) / commit `bd531da` fixed the **crash** (`uncaughtException`) path for the same ConnectError class. It did **not** stop reuse of a stale pooled agent.

Secondary issue: `isLikelyAuthError` matches bare `\bauth\b`, which can over-classify unrelated messages (e.g. `allow-unauthenticated`).

### Not the problem

- Missing `auth.json` / missing key at startup (that already uses `MISSING_CURSOR_API_KEY_MESSAGE`).
- Truly revoked Cursor User API keys (fresh create/resume must still fail and then show a hard key error).
- Live-run native-replay idle dispose (`DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS` = 5m) — that path disposes **completed live-run display state**, not the session agent pool itself.

## Why the earlier Phase 1+2 plan was a temporary fix

Reacting with “fail → recreate → retry once” after `send()` already returned unauthenticated:

- Leaves a user-visible failure race whenever the first attempt fails (cost, latency, risk of double emission if hooked wrong).
- Treats a durable pool-lifecycle bug as a one-off transport blip.
- Does not reduce how often the SDK is called on a dead handle.

A retry alone is acceptable only as a **safety net**, not as the primary product behavior.

## Solution options considered

| Approach | Verdict | Why |
|----------|---------|-----|
| **A. Acquire-time idle invalidate (lazy TTL)** | **Primary — recommend** | On pool lease of a `ready` entry, if idle age exceeds budget, dispose the handle and fall through to create/resume. Prevents send on stale agents. No background timer races with busy/creating. Matches existing acquire loop shape in `acquireSessionCursorAgent`. |
| **B. Background setTimeout idle dispose** | Optional hygiene only | Mirrors live-run idle timers, but adds timer/unref/busy races and still leaves a window if the user sends just before the timer fires. Prefer lazy check-on-acquire for correctness; do **not** require background timers for this bug. |
| **C. One-shot recreate+retry after unauthenticated on reused agent** | **Safety net** | Covers races under the idle budget, clock skew, and SDK auth dying without idle age. Max one retry per turn. |
| **D. Always create per turn / never pool** | Rejected | Loses local incremental-send benefits and increases create/resume churn for normal interactive use. |
| **E. Call a hypothetical SDK reauth/refresh API** | Rejected for now | No verified Cursor SDK contract for refreshing auth on a live `SDKAgent` handle. `agent.reload()` is config refresh, not auth reattach. Do not invent SDK behavior (`AGENTS.md` hard rule). |
| **F. Force-create instead of resume after idle dispose** | Rejected as default | Local resume is default-on; disposing an in-memory handle should **prefer `Agent.resume(agentId)`** with current MCP resupply so Cursor-side continuity survives. Only force-create when resume is disabled/unavailable/fails (existing path). |

### Better long-term design than “timer TTL alone”

**Acquire-time idle invalidation + resume-aware recreate + one-shot retry safety net** is the durable fix:

1. **Prevent** reuse of long-idle pooled handles at lease time (correctness).
2. **Preserve** Cursor continuity via existing local resume when the in-memory agent is dropped for age.
3. **Recover** rarely when prevent missed (safety net).
4. **Tell the truth** in error copy only when a fresh agent also auth-fails (hard key) vs when pool reuse exhausted recovery (stale session wording).

Background pool TTL timers remain optional follow-up for earlier resource release in abandoned sessions; they are not required to close the auth bug.

---

## Solution (proposed — for this PR)

### Phase A — pool idle invalidation on acquire (required, primary)

Track last-use time on active pool entries (stamp when a run completion returns an entry to `ready`, and when a newly created/resumed entry is inserted).

In `tryLeaseReadyEntry` / `acquireSessionCursorAgent` ready path:

1. If `now - lastUsedAtMs >= idleBudgetMs`, dispose that scope’s pool entry and continue the acquire loop (create or resume as today).
2. Do **not** lease the stale ready entry for send.
3. Default `idleBudgetMs = 10 * 60 * 1000` (10 minutes) — under the observed ~13.3m failure floor so most post-idle first turns never hit the SDK unauthenticated path.
4. Keep the constant testable / optionally overridable for unit tests (same pattern as `setCursorNativeReplayIdleDisposeMs`), but **no new public CLI/env/UX** unless you explicitly ask for it later.
5. Local-only for this slice (same pool path as the bug). Cloud remains create-per-turn without this pool.

**Resume interaction:** age-based disposal must not clear or rewrite resume handles incorrectly. After dispose, the next acquire uses the existing resume path (`localResume` + matching session custom entry). Proof cases: idle invalidate → resume same agent id when eligible; idle invalidate with resume disabled → create+bootstrap.

### Phase B — one-shot recreate+retry safety net (required, secondary)

When a local turn fails with classified unauthenticated / auth-stale error **and** the turn used a reused pooled agent (`created === false`):

1. Reset the session agent for that scope.
2. Re-prepare / re-send **once** with a freshly acquired agent (create/resume) and the same resolved API key.
3. If retry succeeds, emit the successful turn normally (silent recovery; no reconnect banner by default).
4. If retry also auth-fails, emit the hard invalid/unauthorized key message.
5. Never retry on user abort / cancellation. Max one automatic recreate+retry per user turn.

Hook points (smallest durable place wins):

| Candidate | Role |
|-----------|------|
| `src/cursor-provider-turn-runner.ts` | Outer prepare/send loop; natural place for a single retry of the whole turn |
| `src/cursor-provider-turn-prepare.ts` | Reset / recreate; pool lease / create vs reuse |
| `src/cursor-provider-run-finalizer.ts` | Avoid double-emitting terminal auth error when retry will happen |
| `src/cursor-provider-errors.ts` | Classification helpers |

### Phase C — message + classifier hygiene (required, same PR)

1. Split user-facing copy:
   - **Stale session (retry exhausted):** clear “session auth expired after idle / could not reconnect — verify API key…” wording.
   - **Hard key failure** (fresh create/resume also unauthenticated, or never had a pooled agent): keep / refine current `/login` + `CURSOR_API_KEY` guidance.
2. Tighten `isLikelyAuthError` so bare `\bauth\b` is **not** sufficient; prefer specific tokens (`unauthenticated`, `unauthorized`, `invalid api key`, Connect code 16, etc.).
3. Keep ConnectError code 16 / `[unauthenticated]` as the primary classifier for the recovery path.

### Explicitly deferred (not this PR unless you insist)

- Background setTimeout pool dispose for memory hygiene in never-returning sessions.
- Public config (`local.poolIdleMs` / env) — ship constant + test override first.
- Cloud-runtime equivalent recovery (no evidence yet).

---

## Relevant files

### Existing (expected touch)

- `src/cursor-session-agent.ts` — `lastUsedAtMs` on ready/busy entries; acquire-time idle invalidate; stamp on return-to-ready / create
- `src/cursor-provider-errors.ts` — classify stale-session vs hard key; tighten matcher; message constants
- `src/cursor-provider-turn-runner.ts` — one-shot retry orchestration
- `src/cursor-provider-turn-prepare.ts` — reset / recreate; expose reuse vs create if needed
- `src/cursor-provider-run-finalizer.ts` — gate terminal auth emission when retry will happen
- `test/cursor-session-agent*.test.ts` (or closest existing pool tests) — idle invalidate / resume after age dispose
- `test/cursor-provider-errors.test.ts` — classifier / message contracts
- `test/cursor-provider-stream-auth.test.ts` — recreate+retry stream contracts
- `docs/cursor-model-ux-spec.md` — document idle pool invalidation + recoverable auth behavior
- `CHANGELOG.md` — user-facing note
- `README.md` — only if troubleshooting needs a one-liner

### New (only if modules get too large)

- Prefer existing modules. Tiny helpers (`cursor-provider-stale-auth-retry.ts`, or idle-budget helpers colocated with session-agent) are OK if they keep the runner/pool thin.

## Implementation checklist (for after approval)

### 1. Pool idle invalidate

- [ ] Add `lastUsedAtMs` (or equivalent) to active pool entries; update on create insert and busy→ready
- [ ] Before leasing `ready`, if idle ≥ budget, dispose and continue acquire loop
- [ ] Default budget 10m; test override setter/resetter
- [ ] Idle dispose then resume (when enabled) reuses recorded agent id; opt-out creates fresh
- [ ] Busy entries are not age-disposed mid-run; age is evaluated at lease time after they become ready

### 2. Classification API

- [ ] `isRetryableStaleCursorSessionAuthError(error)` (or equivalent) from ConnectError unauthenticated + tightened text rules
- [ ] Distinct messages for stale-session vs hard key; keep secret scrubbing
- [ ] `sanitizeCursorProviderError` no longer always looks like “bad key” for idle reuse failures after recovery policy applies

### 3. One-shot retry safety net

- [ ] Detect reused pooled agent for the failing attempt
- [ ] Reset + retry prepare+send once
- [ ] Success emits normal finished path; dual auth-fail emits hard key once
- [ ] Abort short-circuits; local-only

### 4. Tests

- [ ] Unit: ready entry older than budget is disposed; next acquire create/resume runs
- [ ] Unit: entry younger than budget is reused (`created === false`)
- [ ] Unit: ConnectError code 16 classifies as retryable stale auth; bare `auth` no longer over-matches
- [ ] Stream: pooled unauthenticated → recreate → success with no terminal auth error
- [ ] Stream: both attempts unauthenticated → hard key once
- [ ] Abort mid-retry does not force a second send

### 5. Docs / packaging

- [ ] UX spec: pool idle invalidate + silent retry safety net
- [ ] CHANGELOG entry
- [ ] Approval of this plan covers the public error-copy split already listed

## Validation

Local (required before commit):

```bash
npm test
npm run typecheck
npm run typecheck:tests
```

Provider/runtime gate (required before release-ready / pre-commit for this runtime change; per `AGENTS.md`):

```bash
npm run smoke:platform:all
```

If Cursor auth or Crabbox resources are unavailable, report blocked for smoke — do not mark release-ready.

## Out of scope

- Reusing Cursor Agent CLI / Desktop OAuth login (keys only)
- Changing pi `/login` UX beyond our remapped messages
- Cloud agent auth recovery without local-pool evidence
- Broad retry of all provider errors
- Background pool timers (deferred hygiene)
- Public idle-budget CLI/env/config (deferred)

## Risks

| Risk | Mitigation |
|------|------------|
| 10m budget causes extra create/resume churn for power users who idle ~11m between turns | Acceptable vs auth hard-fail; budget under observed floor; resume keeps Cursor continuity |
| 10m still misses rare sub-10m auth death | Phase B one-shot retry |
| Resume after idle dispose still hits stale SDK store auth | Safety-net retry + existing resume-failure → create+bootstrap; treat surprising resume auth-fail as evidence to revisit force-create |
| Retry hides a truly bad key for one extra round-trip | Only once; second failure shows hard key |
| Over-matching auth classifier | Tighten matcher; contract tests |
| Hooking retry too late double-emits stream errors | Gate terminal emission; test both paths |

## Open questions (defaults if you approve “proper fix”)

| # | Question | Default |
|---|----------|---------|
| 1 | Idle budget | **10 minutes** |
| 2 | Background timer dispose too? | **No** — acquire-time only |
| 3 | Show “reconnecting…” on successful silent recovery? | **No** |
| 4 | Apply to cloud runtime too? | **No** — local pool only |
| 5 | Change public error wording? | **Yes** — stale-session vs hard key |
| 6 | After idle dispose, prefer resume when enabled? | **Yes** |

## Evidence appendix (diagnosis)

- Message constant: `AUTH_CURSOR_SDK_ERROR_MESSAGE` in `src/cursor-provider-errors.ts`
- Remap site: `sanitizeCursorProviderError`
- Pool reset already happens on failure; missing pieces are (1) not leasing long-idle ready agents and (2) automatic one-shot recreate+retry in the same turn when prevent misses
- Local session scan (2026-07-11 diagnosis): 11 exact auth-error occurrences; idle before user prompt min ~13.3m, median ~166m; all recovered on later retry with same key
- Controlled SDK probe: 90s idle did not reproduce; longer idle was not required once session evidence confirmed the pattern
- Existing related pattern: live-run idle dispose timers in `src/cursor-live-run-coordinator.ts` / `DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS` — different object lifecycle; do not conflate with session agent pooling

## Approval signature

- [ ] Approved proper fix (Phase A+B+C, 10m idle)
- [ ] Approved with different idle budget: _____ minutes
- [ ] Needs more revisions (comment below)

Approver: __________________  
Date: __________________
