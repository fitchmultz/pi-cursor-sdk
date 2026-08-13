# Prime Agent Startup Auth Implementation Plan

> 作成日時: 2026-08-13 11:29

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development and request code review before creating the pull request.

**Goal:** Remove the extension's dependency on `readStoredCredential` and resolve startup-session Cursor credentials through the host-provided `ModelRegistry`.

**Architecture:** Register the bundled/startup catalog immediately so the provider remains available before a session exists. During `session_start`, obtain the provider-scoped API key from `ctx.modelRegistry.getApiKeyForProvider("cursor")`, run cached/live discovery with that key, and replace the provider catalog before interactive selection. Runtime turns continue using the API key supplied by the host in stream options, while `CURSOR_API_KEY` remains the non-host fallback.

**Tech Stack:** TypeScript, pi extension lifecycle API, Vitest

## Issue

- fitchmultz/pi-cursor-sdk#214

## Global Constraints

- Do not import or dynamically access `readStoredCredential`.
- Do not persist or log Cursor API keys.
- Preserve provider registration and `CURSOR_API_KEY` behavior for standalone pi.
- Keep the change limited to authentication/catalog discovery and regression tests.

---

### Task 1: Host-scoped credential resolution

**Files:**
- Modify: `src/cursor-api-key.ts`
- Modify: `src/model-discovery.ts`
- Test: `test/cursor-api-key.test.ts`
- Test: `test/model-discovery.test.ts`

**Interfaces:**
- `resolveCursorRuntimeApiKey(apiKey?: string): string | undefined` normalizes a host-provided key first, then falls back to `CURSOR_API_KEY`.
- `discoverModels({ apiKey })` consumes the provider-scoped key supplied by the extension lifecycle.

- [ ] Replace stored-file credential reads with host-key normalization plus environment fallback.
- [ ] Add regression tests proving host keys take precedence, placeholders resolve through the environment, and missing values remain missing.
- [ ] Run the focused API-key and discovery tests.

### Task 2: Session-start catalog registration

**Files:**
- Modify: `src/index.ts`
- Test: `test/index-registration.test.ts`

**Interfaces:**
- `session_start` receives `ctx.modelRegistry` and calls `getApiKeyForProvider("cursor")`.
- Successful discovery replaces the initially registered Cursor provider catalog.

- [ ] Write a failing registration test for a stored host key used during `session_start`.
- [ ] Register a session-start catalog synchronization handler using `ModelRegistry`.
- [ ] Ensure fallback warnings are emitted only when the host-scoped discovery still falls back.
- [ ] Run the focused extension registration tests.

### Task 3: Verification and delivery

**Files:**
- Modify only if verification identifies defects.

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Run `npm run check:platform-smoke`.
- [ ] Request an independent code review and resolve all critical/important findings.
- [ ] Commit, push `fix/214-prime-agent-startup-auth`, and open an upstream PR containing `Closes #214`.
