# Platform Smoke Implementation Reference

Back to the canonical [Platform Smoke runbook](./platform-smoke.md) for cost-conscious verification, focused suite selection, optional comprehensive targets/suites, artifacts, assertions, security, and the release bar. Offline/faux checks and exact-input retained evidence come first; only necessary changed-behavior proof warrants the smallest live check on one representative environment. No paid Cloud testing for generic PRs/releases; only explicitly Cursor Cloud-focused PRs/issues may select a necessary focused Cloud check. Automated Cursor PR reviews continue unchanged.

This document records detailed detector, registry, command-rendering, implementation-history, replacement, and portability material. The phase plan is retained as implementation history, not as active release instructions.

## Visual evidence detector

The detector operates on host-rendered terminal HTML and PNG evidence. It must not pass from prompt text alone.

Required behavior:

- render ANSI with xterm/Playwright and assert the terminal DOM/theme is present, styled, non-empty, and screenshotted;
- search the rendered xterm buffer for suite-owned evidence patterns that correspond to actual tool output/results, not instructions in the prompt;
- scroll to each evidence line and write `cards/<evidence-id>.png` screenshots plus `visual-evidence.json`;
- write `cards.json` for the legacy rendered-evidence inventory;
- fail when required visual evidence is missing;
- fail when a card/evidence item has the wrong success/error state;
- fail when footer/status is missing or unreadable.

The legacy card inventory and required-card assertions use the same rendered xterm buffer lines already collected for visual evidence and screenshots. Raw ANSI stripping cannot reconstruct cursor movement, line erasure, or redraws; `terminal.txt` remains raw diagnostic text, not card evidence. Raw ANSI remains unchanged for xterm/PNG rendering and secret scanning; exact card patterns, wrapped-line matching, and JSONL success/error assertions still apply. `test/fixtures/platform-read-hyperlinks.json` retains minimal native/bridge OSC-8 headers from real captures with only the local hyperlink target anonymized.

Run the host renderer regression with `node --test test/platform-smoke-rendered-cards.test.mjs`. It requires the host Playwright Chromium checked by platform doctor and fails, rather than skips, if rendering is unavailable. Default `npm test` does not require a guest/CI browser install; the full platform gate still requires doctor and live rendered-card evidence.

Meaningful gap closed: earlier card assertions could pass when the prompt mentioned `pi__read` or a missing-file path even if the actual tool card/result never rendered. The gate now requires JSONL result evidence and per-evidence rendered screenshots for native read, native shell success/failure, native edit diffs, bridge read success/failure, and bridge shell success.

## Registry visual classification

The implementation must classify every `CURSOR_TOOL_PRESENTATION_SPECS` entry from `src/cursor-tool-presentation-registry.ts` as required or excluded for the optional comprehensive visual matrix. A validation check fails when a registry entry lacks classification.

Required deterministic cards:

- `read`
- `grep`
- `glob` / find
- `shell`
- `write`
- `edit`
- failed `read`

Excluded from release visual matrix with required rationale:

- `delete`: destructive and redundant with file mutation card coverage.
- `readLints`: dependent on target diagnostics state.
- `updateTodos`: model workflow dependent.
- `createPlan`: model workflow dependent.
- `task`: model/task orchestration dependent.
- `generateImage`: external image generation surface.
- `mcp`: separate MCP integration surface beyond built-in bridge smoke.
- `semSearch`: semantic index state dependent.
- `recordScreen`: desktop capture dependency outside terminal smoke.
- `webSearch`: network/search dependent.
- `webFetch`: network dependent.

Adding a registry entry requires adding it to the required or excluded list with rationale. `ls` is currently excluded from the required one-prompt matrix because composer-2-5 does not route the deterministic source-enumeration step through the native `ls` surface reliably; the suite instead gates that behavior through a successful native `find` result for `src/cursor-provider.ts`.

## Platform command rendering

Scenario commands are not raw shell strings. The runner renders commands per target:

- `posix` for macOS and Ubuntu.
- `powershell` for Windows native.

Scenario shape:

```js
{
  id: "cursor-native-visual-matrix",
  requires: ["cursor-auth", "pty", "packed-install"],
  promptTemplate: "... <platform-command:shellSmoke> ...",
  commands: {
    shellSmoke: {
      posix: "printf 'cursor visual smoke\\n'",
      powershell: "Write-Output 'cursor visual smoke'",
    },
  },
  assertions: ["final-marker", "required-cards", "jsonl-tools"],
}
```

The renderer owns quoting, path normalization, environment assignment, and canonical gzip JSON/base64 artifact encoding.

## Implementation phases

### Phase 0: plan-only branch state

Create this plan on `feat/crabbox-platform-smoke`. Do not implement code in this phase.

### Phase 1: dependency spike

Verify `node-pty` and ConPTY on every target before committing the dependency.

Exit criteria:

- node-pty self-test passes on macOS;
- node-pty self-test passes on Ubuntu local-container;
- node-pty self-test passes on Windows native Node 24.

### Phase 2: config and doctor

Add config, CLI skeleton, doctor, and npm scripts.

Exit criteria:

```bash
npm run smoke:platform:doctor
```

passes only when all required local setup exists.

### Phase 3: target session manager

Implement Crabbox target lifecycle for all three targets.

Exit criteria:

- each target can acquire/warm;
- each target can sync;
- each target can run `node --version`;
- each target can package/download a trivial artifact;
- each target can stop/cleanup;
- one lease per target session.

### Phase 4: `platform-build`

Implement build/package/install suite.

Exit criteria: `platform-build` passes on all targets through `smoke:platform:all -- --suite platform-build` without live Cursor calls.

### Phase 5: PTY capture and host render

Implement PTY/ConPTY capture and host-side xterm/Playwright render.

Exit criteria:

- ANSI capture works on all targets;
- host render writes HTML, full PNG, and final viewport PNG;
- visual evidence detector can capture fixture evidence screenshots.

### Phase 6: native visual matrix

Implement one-call native matrix.

Exit criteria:

- all required native visual evidence screenshots are captured on every target;
- JSONL assertions pass on every target;
- Cursor call budget remains one call per target.

### Phase 7: bridge visual matrix

Implement one-call bridge matrix.

Exit criteria:

- all required bridge visual evidence screenshots are captured on every target;
- bridge diagnostics assertions pass on every target;
- JSONL assertions pass on every target.

### Phase 8: abort cleanup

Implement interrupted bridge run.

Exit criteria:

- no leftovers on any target;
- no false success in JSONL;
- target session stops cleanly.

### Phase 9: docs and legacy cleanup

Update:

- `README.md`
- `docs/cursor-live-smoke-checklist.md`
- `docs/cursor-testing-lessons.md`
- `docs/cursor-native-tool-visual-audit.md`

They must state:

- offline/faux checks and exact-input retained proof come first; new live proof is limited to the smallest meaningful changed-behavior check on one representative environment;
- `npm run smoke:platform:all` is an optional comprehensive matrix, not an unconditional commit/release gate;
- no paid Cloud testing for generic PRs/releases; only explicitly Cursor Cloud-focused PRs/issues may select necessary focused Cloud proof, with unchanged run/evidence and cleanup contracts;
- no full paid campaign replay, matrix-only host coverage, or automatic paid retries; automated Cursor PR reviews continue unchanged;
- legacy smoke scripts are inner-loop/debug helpers;
- `tmux` visual smoke is not the canonical cross-platform gate.

## Gate replacement criteria

Replace or redesign this platform runner if any of these become true:

- Parallels Windows linked clones are unreliable.
- Windows native cannot run the required ConPTY visual matrix.
- macOS static SSH localhost cannot run the required PTY visual matrix.
- Ubuntu local-container cannot run the required PTY visual matrix.
- Packed install cannot be tested uniformly across all targets.
- Artifact transfer cannot be made uniform across success and failure.
- The visual card detector cannot reliably identify required deterministic cards.
- The full gate exceeds the fixed Cursor invocation budget.
- Node 24 + `node-pty` cannot be made reliable on Windows native.

If the runner is replaced, document the new verification process before removing it. Keep offline cross-platform contracts and selected-suite evidence fidelity; the comprehensive paid matrix is optional, not a default ship step.

## Portability to other pi extensions

Repo-specific pieces:

- `platform-smoke.config.mjs`
- expected package name
- model IDs
- scenario prompts
- required visual card matrix
- final markers

Reusable pieces:

- Crabbox target session manager
- PTY/ConPTY capture
- host-side ANSI render
- artifact manifest writer
- JSONL parser
- visual evidence detector
- process cleanup checker
- target doctor

The framework is successful when another pi extension can copy the runner and change only its config plus scenarios.
