# Investigation: PR #9 Review Findings Deep Dive

## Summary

Deep-dive verification of the five PR #9 review findings on the Cursor pi tool bridge. The user reported a successful lengthy run and asked not to assume the review was correct.

Result: the review was mostly correct. All five findings had real code evidence. Finding 2 and finding 4 were narrower than originally phrased, but still worth fixing.

## Verdicts

| # | Review claim | Verdict | Fix |
|---|---|---|---|
| 1 | Path-only Cursor `write` replay can emit an invalid pi `write` tool call | Valid | Path-only write replay now uses neutral `cursor` activity. Contentful writes still use native `write`. |
| 2 | Already-aborted signals can hang pending live-run replay | Partially valid | Top-level replay already handled signals aborted before replay starts, but the wait helper had the race. Added checks inside `waitForCursorNativeRunProgress()`. |
| 3 | Prompt sanitization rewrites literal user/transcript content | Valid | Removed global literal replay-name replacement. Only structured tool labels are relabeled. |
| 4 | Bridge suppression can hide unrelated MCP activity | Partially valid | Exact bridge tool-name values in result/value/details could suppress unrelated calls. Matching now ignores result payload fields. |
| 5 | Default setting-source logs are not fully contained | Valid | Replaced allowlist filtering with scoped direct stdout/stderr/console suppression during Cursor SDK startup. |

## Evidence and causal chains

### 1. Path-only Cursor write replay

Root cause:
- `buildWriteDisplayArgs()` could return only `{ path }` when Cursor emitted a write event without content.
- `buildCursorPiToolDisplay()` still emitted native `toolName: "write"` for that display.
- pi validates tool arguments before executing the replay wrapper.
- The built-in pi `write` schema requires both `path` and `content`.

Evidence:
- `src/cursor-tool-transcript.ts`
- `src/cursor-provider.ts`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js`
- `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`

Fix:
- Path-only Cursor write events now replay as neutral `cursor` activity with Cursor write details.
- Cursor write events with content still replay through native `write`.

Regression protection:
- `test/cursor-tool-transcript.test.ts` now asserts path-only write is neutral and contentful write is native.
- `test/cursor-provider.test.ts` now covers path-only write replay without mutation or validation failure.

### 2. Already-aborted pending replay wait

Root cause:
- `streamCursor()` already checks aborted signals before pending replay starts.
- `waitForCursorNativeRunProgress()` did not check `signal.aborted` before waiting or after registering its waiter.
- A signal that became aborted after the top-level check but before listener registration could leave the waiter pending until future Cursor progress.

Fix:
- `waitForCursorNativeRunProgress()` now throws `CursorAbortError` if the signal is already aborted before waiting.
- It checks again after adding the waiter and before adding the abort listener, cleaning up immediately if needed.

Regression protection:
- `test/cursor-provider.test.ts` covers the already-aborted-before-listener path with a controlled signal and verifies cleanup.

### 3. Prompt sanitization of literal text

Root cause:
- `sanitizeCursorReplayNamesForPrompt()` performed global `replaceAll()` over system text, user text, assistant text, tool result bodies, and serialized tool args.
- Literal text such as `cursor_edit` or `cursor_mcp` was changed before Cursor saw the prompt.

Fix:
- Removed global replay-name text sanitization.
- Kept structured label relabeling through `getCursorReplayPromptLabel()` for tool call/result labels.

Regression protection:
- `test/context.test.ts` now asserts structured labels become `Cursor edit` / `Cursor MCP`, while literal message text, tool args, and tool result bodies remain unchanged.

### 4. Bridge suppression matching result payloads

Root cause:
- `containsKnownMcpToolName()` recursively scanned `result`, `value`, and `details`.
- A non-bridge tool result containing an exact known bridge MCP tool name such as `pi__read` could be treated as bridge-owned and suppressed.
- The original “mere mention” phrasing was too broad: matching was exact string equality, not substring matching.

Fix:
- Bridge-owned detection now scans invocation identity fields and invocation input containers only: `args`, `arguments`, and `input`.
- It no longer scans result payload fields.

Regression protection:
- `test/cursor-pi-tool-bridge.test.ts` now asserts bridge calls are still recognized through args/arguments, while result/value/details payload matches are ignored.
- `test/cursor-provider.test.ts` now asserts a bridge `tool-call-started` suppresses later completion/onStep replay even when the later Cursor event omits the original bridge args.

Regression review follow-up:
- The initial fix correctly stopped scanning result payloads, but it could have let a bridge-owned completion leak if Cursor emitted bridge identity only on `tool-call-started` and omitted args on completion/onStep.
- The provider now remembers bridge-started Cursor call IDs and suppresses matching completions/steps by identity.

### 5. Default setting-source output containment

Root cause:
- `PI_CURSOR_SETTING_SOURCES` defaults to `all`.
- The SDK output filter only dropped a short allowlist of known startup strings.
- Unknown direct writes from Cursor settings/plugins/MCP startup could still pass through to stdout/stderr/console.

Fix:
- Direct `process.stdout.write`, `process.stderr.write`, and console methods are suppressed inside the Cursor SDK startup scope instead of allowlist-filtered.
- Known late Cursor startup noise such as `managed_skills.removed` is also suppressed for the full installed filter lifetime because the SDK can emit those lines after `Agent.create()` returns.
- Non-Cursor/non-startup writes pass through the wrapper, and the original streams/methods are restored in the existing `finally` path.

Regression protection:
- `test/cursor-provider.test.ts` now asserts known startup noise, late `managed_skills.removed` lines matching the observed TUI corruption, and unknown startup writes with fake secret-bearing text are suppressed, while unrelated non-startup writes still pass through.

## Validation run

Focused validation passed:

```bash
npm test -- --run test/context.test.ts test/cursor-tool-transcript.test.ts test/cursor-pi-tool-bridge.test.ts test/cursor-provider.test.ts
```

Result: 4 files passed, 123 tests passed.

Final validation passed:

```bash
npm test
npm run typecheck
npm pack --dry-run
git diff --check
```

Results after the late `managed_skills.removed` regression fix and final bridge call-id regression review:
- `npm test`: 10 files passed, 213 tests passed.
- `npm run typecheck`: passed.
- `npm pack --dry-run`: passed.
- `git diff --check`: passed.
