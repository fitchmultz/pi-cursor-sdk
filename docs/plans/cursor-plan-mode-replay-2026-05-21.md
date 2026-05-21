# Cursor Plan-Mode Replay and Tool Output: Plan

## Goal

Plan the next pi-cursor-sdk pass so Cursor Composer sessions show plan-mode output clearly in pi, preserve useful identity for generic Cursor activity cards, and avoid misleading replay errors or empty shell output when the Cursor SDK has recoverable data.

## Background

- User-confirmed scope for this plan:
  - Show both Cursor plan/todo cards and the final plan text when Cursor switches into plan mode.
  - Include improvements to visible identity for generic `cursor` activity cards.
  - Suppress started-without-completed fallback error cards unless Cursor reports an explicit failure.
  - Investigate shell empty-output cases such as `sleep 2 && echo "background job done"`.
- Latest Cursor Composer smoke session: `/Users/mitchfultz/.pi/agent/sessions/--Users-mitchfultz-Projects-AI-pi-cursor-sdk--/2026-05-21T14-11-57-383Z_019e4ae0-f547-7718-9180-b533cf63b610.jsonl`.
  - The final assistant text repeated “Compiling the tool inventory and execution status...” instead of showing the requested summary/plan.
  - A generic `cursor` replay result showed `createPlan` with `{}`, but the generated plan-mode narrative stayed in assistant thinking/final text rather than a useful visible plan response.
  - A started-only `.tool-demo.ipynb` edit surfaced as an error: `Cursor SDK emitted tool-call-started but no tool-call-completed event.`
  - A shell replay for `sleep 2 && echo "background job done"` produced `(no output)`.
- Cursor provider lifecycle seams:
  - `streamCursor()` is the provider entry point and creates the pi assistant stream: `src/cursor-provider.ts:674`, `src/cursor-provider.ts:678-681`.
  - Cursor SDK prompt/send path uses `buildCursorPrompt()` and `agent.send(..., { onDelta, onStep })`: `src/cursor-provider.ts:743-748`, `src/cursor-provider.ts:1079-1082`.
  - `onDelta()` maps Cursor `text-delta`, `thinking-delta`, `thinking-completed`, summaries, and tool call start/completion updates into either direct stream events or queued live-run events: `src/cursor-provider.ts:1001-1044`.
  - Live-run queued events are drained by `emitCursorNativeRunNextTurn()`, which emits native replay/bridge tool-use turns and later emits final text when `run.done`: `src/cursor-provider.ts:600-660`, especially `src/cursor-provider.ts:638-649`.
  - Native replay tool-use turns set `partial.stopReason = "toolUse"`, so pi treats replayed Cursor tool cards as a turn boundary: `src/cursor-provider.ts:524-551`.
  - Pending live runs resume from trailing pi `toolResult` messages by synthetic replay IDs or bridge pending tool IDs: `src/cursor-provider.ts:309-326`, `src/cursor-provider.ts:662-672`.
- Cursor plan/todo/workflow replay seams:
  - Cursor `createPlan`, `updateTodos`, `task`, `generateImage`, `readLints`, `delete`, unsupported edit shapes, and MCP activity use neutral `cursor` activity rather than native `read/bash/edit/...` cards: `src/cursor-tool-transcript.ts:1017-1182`.
  - `createPlan` currently normalizes to `cursorToolName: "createPlan"`, title `Cursor plan`, and a status-count summary: `src/cursor-tool-transcript.ts:1111-1125` and `src/cursor-native-tool-display.ts:358-359`.
  - Cursor workflow tools such as `SwitchMode` and Cursor todo/plan state are documented as display-only Cursor activity, not pi workflow controls: `docs/cursor-native-tool-replay.md:51-64`.
- Tool identity and rendering seams:
  - Raw Cursor SDK names are normalized by `normalizeToolName()`: `src/cursor-tool-transcript.ts:82-116`.
  - `buildCursorPiToolDisplay()` chooses native-looking pi tool names (`read`, `bash`, `grep`, `find`, `ls`, `write`, `edit`) or the neutral `cursor` activity fallback: `src/cursor-tool-transcript.ts:943-1183`.
  - Generic `cursor` branch summaries/titles are written in `details.title`, `details.summary`, and `details.expandedText`: edit fallback `src/cursor-tool-transcript.ts:1047`, delete `src/cursor-tool-transcript.ts:1077`, readLints `src/cursor-tool-transcript.ts:1099`, todos `src/cursor-tool-transcript.ts:1118`, plan `src/cursor-tool-transcript.ts:1137`, task `src/cursor-tool-transcript.ts:1155`, image `src/cursor-tool-transcript.ts:1174`, MCP `src/cursor-tool-transcript.ts:1192`.
  - The renderer reads `details.title`, `details.summary`, and `details.expandedText` through `renderExpandableCursorReplayResult()` / `renderCursorReplayResult()`: `src/cursor-native-tool-display.ts:443-520`.
  - `cursor` is the current pi-facing neutral activity tool name; legacy internal replay names remain internal compatibility names: `src/cursor-tool-names.ts:1-14`, `docs/cursor-native-tool-replay.md:70-74`.
- Started-only and shell replay seams:
  - Started Cursor tool calls are stored by call ID and merged with completions when completion arrives: `src/cursor-provider.ts:1020-1031`, `src/cursor-tool-transcript.ts:1185-1198`.
  - `onStep()` can satisfy started tools when the SDK later reports a tool call in step data: `src/cursor-provider.ts:1047-1064`.
  - Remaining started calls after `run.wait()` currently become synthetic error results: `src/cursor-provider.ts:921-951`, called from `src/cursor-provider.ts:1090-1094` and `src/cursor-provider.ts:1123-1125`.
  - Existing tests encode this behavior at `test/cursor-provider.test.ts:605-679`; bridge MCP started-only suppression is tested around `test/cursor-provider.test.ts:2459-2498`.
  - Shell output normalization is centralized in `getShellOutput()`, which joins stdout/stderr/exit/timeout metadata and falls back to `(no output)`: `src/cursor-tool-transcript.ts:405-418`.
  - Shell display maps normalized shell activity to pi `bash` with `{ command, timeout }` args: `src/cursor-tool-transcript.ts:421-429`, `src/cursor-tool-transcript.ts:957-968`.
  - Cursor SDK `shell-output-delta` is currently not surfaced directly; replay uses completed tool result data: `src/cursor-provider.ts:1040-1043`.
- Prior decisions and validation expectations:
  - Replay vs execution is a hard split: Cursor replay is display-only and must not rerun commands, apply edits/deletes, call Cursor MCP, update pi state, or generate images: `docs/cursor-native-tool-replay.md:3-8`, `docs/cursor-native-tool-replay.md:47-60`.
  - Bridge calls are separate and execute real pi tools through queued MCP-to-pi tool calls: `docs/plans/cursor-pi-tool-bridge-2026-05-20.md:64-78`.
  - Visual parity changes require the offscreen PTY + xterm.js/Playwright workflow plus JSONL inspection: `docs/cursor-native-tool-visual-audit.md:23-32`, `docs/cursor-native-tool-visual-audit.md:125-139`.

## Open Questions

None at planning time. The user answered the scope questions up front.

## References

- Latest Cursor Composer smoke JSONL: `/Users/mitchfultz/.pi/agent/sessions/--Users-mitchfultz-Projects-AI-pi-cursor-sdk--/2026-05-21T14-11-57-383Z_019e4ae0-f547-7718-9180-b533cf63b610.jsonl`
- Comparison pi-native GPT + extension JSONL: `/Users/mitchfultz/.pi/agent/sessions/--Users-mitchfultz-Projects-AI-pi-cursor-sdk--/2026-05-21T14-13-49-212Z_019e4ae2-aa1c-79f2-af0d-820e743ebded.jsonl`
- Comparison pi-native GPT without extensions JSONL: `/Users/mitchfultz/.pi/agent/sessions/--Users-mitchfultz-Projects-AI-pi-cursor-sdk--/2026-05-21T14-16-05-615Z_019e4ae4-beef-795a-84ee-002187988078.jsonl`
- Prior bridge plan: `docs/plans/cursor-pi-tool-bridge-2026-05-20.md`
- Replay docs: `docs/cursor-native-tool-replay.md`
- Visual audit workflow: `docs/cursor-native-tool-visual-audit.md`

## Approach

- Use a targeted replay-path change rather than a broad refactor. `src/cursor-provider.ts` owns Cursor run ordering and final-text emission, `src/cursor-tool-transcript.ts` owns Cursor-tool normalization, and `src/cursor-native-tool-display.ts` owns neutral `cursor` card identity/rendering.
- Preserve replay as display-only. Do not re-run Cursor shell commands, apply Cursor edits/deletes, call Cursor MCP servers, switch pi workflow modes, or mutate pi todo/plan state.
- Treat Cursor Composer plan mode as provider-side Cursor workflow state, not pi's own plan-mode extension. The installed pi plan-mode example uses `pi.setActiveTools()`, `pi.sendMessage()`, widgets, and prompts to control pi sessions; this provider should only replay what Cursor did and show Cursor's plan text/cards clearly.
- Preserve `cursor` as the neutral pi-facing replay tool name for Cursor workflow/activity cards. Improve visible identity through arguments/details/rendering metadata, not by making Cursor workflow tools pi workflow controls.
- Treat unknown Cursor SDK event/result shapes as investigation inputs, not facts. Confirm plan-mode final-text shape and shell output shape from the referenced smoke JSONL or a focused raw SDK fixture before coding those extraction paths.

### Plan/todo cards plus final plan text

- Keep `createPlan` and `updateTodos` as neutral Cursor activity cards rendered through replay-only `cursor` cards.
- Ensure native replay turn splitting still emits Cursor final text after replay tool cards:
  - Completed `createPlan` / `updateTodos` events should queue replay cards.
  - The replay tool-use turn should end with `stopReason = "toolUse"`.
  - After the replay-only tool result is fed back, `replayPendingCursorLiveRun()` should resume the same live Cursor run and emit final text from the best confirmed Cursor source.
- Add an explicit final-text selection helper in `src/cursor-provider.ts` so the logic is testable and does not drift between live replay and non-live paths.
  - Preferred source: `run.wait().result` when non-empty and not already emitted.
  - Fallback source: accumulated `text-delta`s not already emitted.
  - Only if investigation proves Cursor stores the canonical plan narrative inside `createPlan` completion data while `run.result` omits it, add a recorded plan-text candidate extracted from that completed tool payload and use it as a final-text fallback.
- Do not synthesize plan text from todo titles/counts alone. If Cursor does not provide a plan narrative, show the plan/todo card and whatever final assistant text Cursor actually provided.

### Generic `cursor` activity card identity

- Keep `CURSOR_REPLAY_ACTIVITY_TOOL_NAME = "cursor"`.
- Add a small shared metadata shape for neutral activity calls so partial/collapsed cards are not just “Cursor activity”.
  - Suggested persisted argument shape for neutral `cursor` calls:
    - `activityTitle`: user-facing label such as `Cursor plan`, `Cursor todos`, `Cursor MCP`, `Cursor edit`.
    - `activitySummary`: short user-facing summary such as `1/2 completed, 1 pending`, `src/index.ts`, or `external_search`.
    - Existing domain args remain present, such as `path`, `paths`, `totalCount`, `description`, `prompt`, or `toolName`.
  - `details.title`, `details.summary`, and `details.expandedText` remain the result-rendering source of truth.
- Update `renderCursorReplayCall()` / `getCursorReplayCallSummary()` so neutral `cursor` partial cards use `activityTitle` and `activitySummary` when present.
- Do not expose legacy names such as `cursor_create_plan` in new user-visible output.

### Started-without-completed fallback cards

- Remove the synthetic error-card behavior for started-only Cursor tool calls.
- After `run.wait()`, leftover `startedToolCalls` should be discarded silently unless Cursor reported an explicit tool failure through a completion or step result.
- Explicit failure means Cursor provided a tool completion/step payload with an error-bearing result, for example normalized `result.status === "error"` or another confirmed SDK error field. Absence of `tool-call-completed` is not an explicit failure.
- Keep existing handling for:
  - `tool-call-completed` success/error payloads.
  - `onStep()` fallback tool results.
  - Bridge MCP started-only suppression.
  - Top-level run cancellation/errors.

### Shell empty-output investigation and fix

- Before coding, inspect the referenced smoke JSONL and, if needed, capture a focused raw SDK fixture for `sleep 2 && echo "background job done"`.
- Confirm whether recoverable output appears in:
  - completed shell result aliases beyond `stdout` / `stderr`,
  - `shell-output-delta`,
  - `onStep()` tool result data,
  - or another Cursor SDK field.
- Implement only the confirmed path:
  - If completed result data has alternate output keys, extend `getShellOutput()` with those aliases.
  - If `shell-output-delta` carries the missing data, track deltas by Cursor call ID in `src/cursor-provider.ts` and merge them into the completed shell tool call only when the completed result lacks usable output.
  - If both exist, prefer completed result `stdout` / `stderr`; use deltas only as a fallback to avoid duplicate output.
- Keep `(no output)` only for true empty successful shell results after all confirmed Cursor-provided output fields are checked.
- Do not re-run shell commands to fill missing replay output.

## Orchestration Status

- [x] Provider replay behavior: confirm event shapes, emit final plan text after replay cards, and suppress started-only synthetic errors.
- [x] Neutral cursor card identity: enrich generic `cursor` activity args/rendering without exposing legacy names.
- [x] Shell empty-output fix: implement only the confirmed Cursor-provided output path.
- [x] Docs and final validation: align replay docs/UX spec and run the full local gate.

Implementation findings recorded during final docs pass:

- Final replay text selection prefers non-empty `run.wait().result`, then falls back to accumulated text deltas after trimming already-emitted text.
- Started-only Cursor tool calls are discarded at run completion; explicit completed/step tool errors remain visible.
- Neutral `cursor` replay calls now carry `activityTitle` / `activitySummary` for partial and collapsed card identity.
- Shell `shell-output-delta` data is used only as an unambiguous display-only fallback for empty successful shell completions; overlapping shell calls drop ambiguous deltas.

## Ordered Work Items

### 1. Confirm Cursor event/result shapes

Touched files:

- No production files required for this investigation.
- Optional temporary fixture/log notes should stay outside committed source unless converted into focused tests.

Work:

1. Inspect the latest smoke JSONL listed in this plan for persisted assistant/toolResult ordering and final text.
2. If JSONL does not include raw Cursor SDK event details, capture a focused fixture with mocked or logged Cursor SDK callbacks for:
   - plan-mode switch with `createPlan` / `updateTodos`,
   - final plan narrative emission,
   - `sleep 2 && echo "background job done"`,
   - any `shell-output-delta` payloads.
3. Record only the confirmed field names in the implementation notes or tests. Do not add speculative aliases.

Regression tests to write after confirmation:

- Provider test proving plan/todo replay cards and final text are both emitted for the confirmed event sequence.
- Transcript/provider shell test using the confirmed shell output shape.

### 2. Add provider-level final-text selection for replay runs

Touched files:

- `src/cursor-provider.ts`
- `test/cursor-provider.test.ts`

Work:

1. Add a small internal helper for final-text selection near the existing `trimAlreadyEmittedCursorText()` logic.
2. Use it in the live-run `run.wait().then(...)` path before setting `liveRun.finalText`.
3. Keep non-live behavior unchanged unless investigation shows the same final-text loss occurs without native replay.
4. Track whether a Cursor workflow replay card was seen only if needed for the confirmed plan-mode fallback path.

Expected behavior:

- Native replay can emit:
  1. optional pre-tool Cursor text/thinking,
  2. neutral `cursor` plan/todo tool cards,
  3. final assistant plan text after replay tool results are returned.
- Already-emitted text is not duplicated.
- Empty final results do not create synthetic text.

Tests:

- Add a native replay test where Cursor emits `createPlan` or `updateTodos`, then `run.wait().result` contains final plan text; assert:
  - first turn is `toolUse`,
  - tool call name is `cursor`,
  - replay result card exists,
  - resumed turn emits the final plan text.
- Add a variant with an earlier text delta such as `Compiling...` and a distinct final `run.result`; assert the final plan text is still emitted after replay.
- Keep existing no-duplicate final result tests green.

### 3. Enrich neutral `cursor` activity identity

Touched files:

- `src/cursor-tool-transcript.ts`
- `src/cursor-native-tool-display.ts`
- `src/cursor-tool-names.ts` only if labels need adjustment.
- `test/cursor-tool-transcript.test.ts`
- `test/index.test.ts`

Work:

1. Add a helper in `src/cursor-tool-transcript.ts` that builds neutral activity args with `activityTitle` and `activitySummary`.
2. Apply it to all neutral `cursor` branches:
   - path-only / notebook edit fallback,
   - delete,
   - readLints,
   - updateTodos,
   - createPlan,
   - task,
   - generateImage,
   - MCP.
3. Keep `details.title`, `details.summary`, and `details.expandedText` populated as today.
4. Update `src/cursor-native-tool-display.ts` so neutral `cursor` call rendering prefers:
   - `args.activityTitle` for the title,
   - `args.activitySummary` for the call summary,
   - then existing path/toolName/description/prompt/count fallbacks.
5. Do not activate legacy replay tool names for new sessions.

Tests:

- Update transcript tests to expect enriched neutral args.
- Add renderer coverage proving a neutral `cursor` partial card renders like `Cursor plan 2 items` or `Cursor todos 1/2 completed...`, not only `Cursor activity`.
- Keep legacy replay rendering tests sanitized: no `cursor_create_plan`, `cursor_update_todos`, or other raw synthetic names.

### 4. Suppress started-only synthetic fallback errors

Touched files:

- `src/cursor-provider.ts`
- `test/cursor-provider.test.ts`
- Later implementation-doc alignment:
  - `docs/cursor-native-tool-replay.md`
  - `docs/cursor-model-ux-spec.md`

Work:

1. Replace `handleIncompleteStartedToolCalls()` behavior so leftover started calls are cleared without queuing replay cards or trace errors.
2. Keep bridge MCP started-only behavior suppressed.
3. Keep completed/step error results visible through the normal `handleCompletedToolCall()` path.
4. Rename the helper if useful so its behavior is clear, for example from “handle incomplete” to “discard incomplete started tool calls”.

Expected behavior:

- A started-only edit/read/MCP event does not create a red replay card.
- Cursor final text or top-level run errors remain visible.
- Explicit completed tool errors still render as errors.

Tests:

- Update the existing native replay started-only test to assert no fallback `cursor` error card is emitted and final text is emitted normally.
- Add non-native trace coverage proving started-only calls do not emit `Cursor tool started without a completion event`.
- Add or preserve explicit completed-error coverage proving real Cursor tool failures still show as errors.
- Keep bridge MCP started-only suppression test green.

### 5. Fix confirmed shell empty-output path

Touched files depend on investigation result:

- Always likely:
  - `src/cursor-tool-transcript.ts`
  - `test/cursor-tool-transcript.test.ts`
- If `shell-output-delta` is required:
  - `src/cursor-provider.ts`
  - `test/cursor-provider.test.ts`

Work if completed result aliases are confirmed:

1. Extend shell output extraction in `getShellOutput()` with only confirmed alternate output keys.
2. Preserve existing `stdout` + `stderr` ordering.
3. Preserve existing exit-code and timeout behavior.

Work if `shell-output-delta` is confirmed:

1. Track shell output deltas by Cursor `callId` inside `streamCursor()`.
2. On `tool-call-completed`, merge tracked shell output into the completed tool call only when the completed result lacks usable output.
3. Clear tracked output when the call completes or when leftover started calls are discarded.
4. Ensure output is scrubbed through existing display/result scrubbing before it reaches pi.

Tests:

- Add a shell transcript test for the confirmed completed result shape that returns `background job done` instead of `(no output)`.
- If delta merging is implemented, add provider coverage where:
  - `shell-output-delta` supplies `background job done`,
  - completed shell result lacks `stdout` / `stderr`,
  - replayed `bash` tool result contains `background job done`.
- Add a duplicate-protection test where completed `stdout` already contains output and deltas do not duplicate it.
- Keep existing nonzero exit and timeout tests green.

### 6. Align durable docs after behavior changes

Touched files:

- `docs/cursor-native-tool-replay.md`
- `docs/cursor-model-ux-spec.md`
- This plan file, if implementation findings need to be recorded.

Work:

1. Update replay docs so started-only calls are described as suppressed unless Cursor reports explicit failure.
2. Document that Cursor plan/todo workflow activity remains display-only and does not drive pi workflow controls.
3. Document any confirmed shell output fallback source, without overclaiming Cursor SDK behavior beyond the tested shape.
4. Keep visual audit requirement linked for replay-card UX changes.

## Validation Plan

### Focused Vitest during implementation

Run targeted tests while developing:

```bash
npm test -- test/cursor-provider.test.ts
npm test -- test/cursor-tool-transcript.test.ts
npm test -- test/index.test.ts
```

Recommended focused areas:

- Native replay turn splitting and final text after replay cards.
- `createPlan` / `updateTodos` neutral `cursor` display payloads.
- Neutral `cursor` partial/collapsed renderer identity.
- Started-only suppression.
- Explicit Cursor tool error replay.
- Shell output extraction / shell-output-delta merging, using confirmed fixtures.

### Full local gate before completion

Run:

```bash
npm test
npm run typecheck
```

There is no lint script in `package.json`.

### Later offscreen visual audit

When behavior is implemented, run the documented offscreen visual audit workflow from `docs/cursor-native-tool-visual-audit.md` for at least:

1. Plan-mode replay:
   - Prompt that makes Composer switch/create a plan.
   - Confirm screenshot shows Cursor plan/todo card identity plus final plan text.
   - Confirm JSONL has neutral `cursor` tool calls and final assistant text.
2. Started-only suppression:
   - Reproduce the prior started-only edit scenario if possible.
   - Confirm no red synthetic fallback error card appears.
3. Shell output:
   - Prompt for `sleep 2 && echo "background job done"`.
   - Confirm screenshot and JSONL toolResult contain `background job done` when Cursor provided completed output data.
4. Generic `cursor` identity:
   - Confirm neutral cards show labels such as `Cursor plan`, `Cursor todos`, `Cursor MCP`, or `Cursor edit` instead of an ambiguous `Cursor activity` card.

Keep generated screenshots, ANSI logs, JSONL pointers, and galleries outside the repo unless a maintainer explicitly asks to commit them.

## Risks / Guardrails

- Do not infer Cursor SDK fields from guesswork. Shell output and plan-mode narrative extraction must be backed by the referenced smoke data or a focused fixture.
- Do not solve missing shell output by re-executing commands. Replay must remain display-only.
- Do not map Cursor `SwitchMode`, `createPlan`, or `updateTodos` into pi workflow controls. They are Cursor activity cards only.
- Do not replace neutral `cursor` with legacy replay tool names for new cards. Improve identity through metadata and rendering while keeping public naming aligned with `src/cursor-tool-names.ts`.
- Do not reintroduce started-only synthetic errors under a different label. Missing completion is not itself a Cursor-reported tool failure.
