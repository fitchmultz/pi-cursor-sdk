# Plan: Idle auth stale-session recovery

**Status:** Awaiting approval — do not implement until this document is approved.  
**Branch:** `fix/idle-auth-stale-session`  
**Fork:** https://github.com/tejasghutukade/pi-cursor-sdk  
**Upstream:** https://github.com/fitchmultz/pi-cursor-sdk  
**Worktree:** `/Users/tejasghutukade/Projects/pi-cursor-sdk-idle-auth`  
**Base:** `origin/main` @ `922723a` (v0.1.57 prep)

## Decision needed from you

Reply with one of:

1. **Approve as written** — implement Phase 1 + Phase 2 (retry + messaging + classifier tighten); defer idle TTL.
2. **Approve + include idle TTL** — also dispose pooled agents after N minutes idle (propose 15m default).
3. **Revise** — note which sections to change.

---

## Purpose

Stop intermittent post-idle Cursor turns from failing with a misleading “API key invalid/unauthorized” error when the stored Cursor API key is still valid. Recover silently once by recreating the pooled local session agent, and reserve the hard key message for true key failures.

## Problem

User-visible error (today):

```text
Cursor SDK request failed because the Cursor SDK API key may be invalid or unauthorized.
Cursor Agent CLI/Desktop login is not reused. Run /login -> Use an API key -> Cursor,
verify CURSOR_API_KEY, or pass --api-key, then retry.
```

### Observed causal chain

1. `pi-cursor-sdk` pools a long-lived local Cursor SDK agent per session (`src/cursor-session-agent.ts`).
2. After long idle (local evidence: min ~13m, median ~2.8h across 11 session occurrences), the first `agent.send()` on that pooled agent fails with Cursor SDK `ConnectError` / `[unauthenticated]` (gRPC code 16).
3. `sanitizeCursorProviderError()` in `src/cursor-provider-errors.ts` remaps that to `AUTH_CURSOR_SDK_ERROR_MESSAGE`, which blames the API key.
4. The turn path already abandons/resets the pool on failure (`abandonSessionCursorAgent` → `resetSessionCursorAgent`).
5. The user’s next message creates a fresh agent and succeeds with the same key — so the failure is recoverable, but only manually.

Related history: issue [#101](https://github.com/fitchmultz/pi-cursor-sdk/issues/101) / commit `bd531da` fixed the **crash** (`uncaughtException`) path for the same ConnectError class. It did **not** auto-recover the stale pooled agent.

Secondary issue: `isLikelyAuthError` matches bare `\bauth\b`, which can over-classify unrelated messages (e.g. `allow-unauthenticated`).

### Not the problem

- Missing `auth.json` / missing key at startup (that already uses `MISSING_CURSOR_API_KEY_MESSAGE`).
- Truly revoked Cursor User API keys (retry with a fresh agent must still fail and then show a hard key error).

## Solution (proposed)

Treat first post-idle `unauthenticated` on an **existing pooled** local agent as **stale session**, not bad key.

### Phase 1 — one-shot recreate + retry (required)

When a local turn fails with a classified unauthenticated / auth-stale error **and** the turn used a reused pooled agent (`created === false` or equivalent lease flag):

1. Reset the session agent for that scope.
2. Re-prepare / re-send **once** with a freshly created agent and the same resolved API key.
3. If the retry succeeds, emit the successful turn as normal (user should not see the auth error).
4. If the retry also fails with auth, then emit the hard invalid/unauthorized key message.

Hook points to investigate during implementation (smallest durable place wins):

| Candidate | Role |
|-----------|------|
| `src/cursor-provider-turn-runner.ts` | Outer prepare/send loop; natural place for a single retry of the whole turn |
| `src/cursor-provider-turn-prepare.ts` | Already calls `resetSessionCursorAgent`; knows pool lease / create vs reuse |
| `src/cursor-provider-run-finalizer.ts` | Today converts failures into terminal stream errors after abandon |
| `src/cursor-provider-errors.ts` | Classification helpers used to gate “retryable stale auth” vs “hard key failure” |

**Constraint:** Max one automatic recreate+retry per user turn. No loops. Abort signal must still short-circuit.

### Phase 2 — message + classifier hygiene (required, same PR)

1. Split user-facing copy:
   - **Stale session (retry exhausted or pre-retry trace if shown):** “Cursor session auth expired after idle; reconnecting…” / “could not reconnect — verify API key…” as appropriate.
   - **Hard key failure (only after recreate+retry also authenticates badly, or when no agent was ever pooled):** keep / refine current `/login` + `CURSOR_API_KEY` guidance.
2. Tighten `isLikelyAuthError` so bare `\bauth\b` is **not** sufficient; prefer specific tokens (`unauthenticated`, `unauthorized`, `invalid api key`, Connect code 16, etc.).
3. Keep ConnectError code 16 / `[unauthenticated]` as the primary classifier for the recovery path.

### Phase 3 — idle TTL dispose (optional; default **out of this PR**)

Dispose pooled ready agents after N minutes of inactivity (e.g. 15m) so the first post-idle turn creates a fresh agent without failing.

Pros: fewer failures to recover.  
Cons: new timer/lifecycle surface; needs careful interaction with live-run idle dispose and resume.

**Recommendation:** ship Phase 1+2 first; add TTL only if you choose option 2 above.

## Relevant files

### Existing (expected touch)

- `src/cursor-provider-errors.ts` — classify stale-session vs hard key; tighten matcher; message constants
- `src/cursor-provider-turn-runner.ts` — likely one-shot retry orchestration
- `src/cursor-provider-turn-prepare.ts` — reset / recreate pool entry; expose reuse vs create signal if needed
- `src/cursor-provider-run-finalizer.ts` — avoid double-emitting terminal auth error when retry will happen
- `src/cursor-session-agent.ts` — only if lease metadata must expose “reused pool entry”
- `test/cursor-provider-errors.test.ts` — classifier / message contracts
- `test/cursor-provider-stream-auth.test.ts` — stream/auth integration; extend for recreate+retry
- `docs/cursor-model-ux-spec.md` — document recoverable idle auth behavior
- `CHANGELOG.md` — user-facing note
- `README.md` — only if troubleshooting section needs a one-liner

### New (only if runner gets too large)

- Prefer keeping logic in existing modules. A tiny helper (e.g. `src/cursor-provider-stale-auth-retry.ts`) is OK if it keeps the runner thin; otherwise no new file.

## Implementation checklist (for after approval)

### 1. Classification API

- [ ] Add a narrow helper, e.g. `isRetryableStaleCursorSessionAuthError(error)`, backed by ConnectError unauthenticated + tightened text rules
- [ ] Add distinct messages for stale-session vs hard key (no secret leakage; keep scrubbing)
- [ ] Update `sanitizeCursorProviderError` so first-touch idle auth does not always look like “bad key”

### 2. One-shot retry

- [ ] Detect reused pooled agent for the failing attempt
- [ ] Reset pool entry
- [ ] Retry prepare+send once with same key / same turn inputs
- [ ] Emit success path if retry works; emit hard key error only if retry also auth-fails
- [ ] Never retry on user abort / cancellation
- [ ] Never retry cloud runtime in this slice unless evidence shows the same failure (local-only by default)

### 3. Tests

- [ ] Unit: ConnectError code 16 → stale-session classification; bare `auth` no longer over-matches
- [ ] Stream/auth: pooled agent fails unauthenticated once → recreate → second send succeeds → stream has no terminal auth error
- [ ] Stream/auth: both attempts unauthenticated → hard key message once
- [ ] Abort mid-retry does not force a second send

### 4. Docs / packaging

- [ ] UX spec note under session/agent pooling or auth troubleshooting
- [ ] CHANGELOG entry
- [ ] Ask before changing public UX copy if anything beyond the already-misleading auth string expands user-facing surface (this plan already includes that change; approval covers it)

## Validation

Local (required before commit):

```bash
npm test
npm run typecheck
npm run typecheck:tests
```

Provider/runtime gate (required before maintaining that this commit is release-ready; per `AGENTS.md`):

```bash
npm run smoke:platform:all
```

If Cursor auth or Crabbox resources are unavailable, report blocked for smoke — do not mark release-ready.

## Out of scope

- Reusing Cursor Agent CLI / Desktop OAuth login (explicitly not supported; keys only)
- Changing pi `/login` UX beyond our remapped messages
- Cloud agent resume / cloud-specific auth recovery (unless the same local pool path is proven to apply)
- Broad retry of all provider errors

## Risks

| Risk | Mitigation |
|------|------------|
| Retry hides a truly bad key for one extra round-trip | Only retry once; second failure shows hard key message |
| Retry doubles token/cost on rare failures | Acceptable; failures are infrequent and recover manually today |
| Hooking retry too late double-emits stream errors | Gate terminal emission until retry decision; test both paths |
| Over-matching auth classifier on unrelated errors | Tighten matcher; contract tests for false positives |

## Open questions (defaults if you approve “as written”)

| # | Question | Default if Approve as written |
|---|----------|-------------------------------|
| 1 | Include idle TTL dispose in this PR? | **No** — Phase 1+2 only |
| 2 | Show a transient “reconnecting…” notice on successful silent recovery? | **No** — silent success; only change messages when something still fails |
| 3 | Apply recovery to cloud runtime too? | **No** — local pooled agents only |
| 4 | Change public error wording? | **Yes** — separate stale-session vs hard key copy |

## Evidence appendix (diagnosis)

- Message constant: `AUTH_CURSOR_SDK_ERROR_MESSAGE` in `src/cursor-provider-errors.ts`
- Remap site: `sanitizeCursorProviderError`
- Pool reset already happens on failure; missing piece is automatic one-shot recreate+retry in the same turn
- Local session scan (2026-07-11 diagnosis): 11 exact auth-error occurrences; idle before user prompt min ~13.3m, median ~166m; all recovered on later retry with same key
- Controlled SDK probe: 90s idle did not reproduce; longer idle was not required once session evidence confirmed the pattern

## Approval signature

- [ ] Approved as written (Phase 1+2)
- [ ] Approved with idle TTL included (Phase 1+2+3)
- [ ] Needs revisions (comment below)

Approver: __________________  
Date: __________________
