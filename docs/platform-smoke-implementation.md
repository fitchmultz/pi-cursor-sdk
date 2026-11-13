# Platform Smoke Implementation Reference

Back to the canonical [Platform Smoke runbook](./platform-smoke.md) for cost-conscious verification, focused suite selection, optional comprehensive targets/suites, artifacts, assertions, security, and the release bar. Offline/faux checks and exact-input retained evidence come first; only necessary changed-behavior proof warrants the smallest live check on one representative environment. No paid Cloud testing for generic PRs/releases; only explicitly Cursor Cloud-focused PRs/issues may select a necessary focused Cloud check. Automated Cursor PR reviews continue unchanged.

This document records detailed artifact transport/extraction, detector, registry, command-rendering, implementation-history, replacement, and portability material. The phase plan is retained as implementation history, not as active release instructions.

## Artifact transport and extraction

The target-side live and local-resume runners encode only canonical bounded text evidence as gzip-compressed JSON/base64.

### Evidence eligibility and secret scanning

Unknown extensions are secret-scanned and then omitted when benign; a secret finding still fails the run. Binary content under a transport-eligible text extension fails with bounded `binary-content` evidence, and direct bundles containing either unknown extensions or binary content are never extracted.

Every regular artifact file, regardless of name or extension, is binary-safe scanned from a descriptor-bounded snapshot before transport eligibility is checked. Binary scans retain exact `CURSOR_API_KEY`, generic auth assignments, and structured bearer/cookie/bridge/JSON signatures in UTF-8/ASCII, UTF-16LE/BE, and UTF-32LE/BE at any byte alignment; the intentionally broad generic credential-URL and SCP-style heuristics run only on valid UTF-8 text so random compressed/executable bytes cannot create false failures.

Sensitive files (`.env*`, `auth.json`, `id_rsa`, `id_ed25519`, `*.pem`, and `*.key`) therefore fail the run when they contain secrets but are never transported. `node_modules/` and `.git/` are non-artifact infrastructure and are pruned before recursion.

File size is checked before allocation or reading. An unreadable, changed, or oversized file fails closed; oversized files are not read and produce bounded limit evidence, while the host scanner reports an oversized or otherwise unscannable artifact as a finding so the suite fails.

### Root and traversal guards

The caller-selected artifact root is a trust boundary. Its final component must be a real directory, and its real path must equal the same relative path mapped beneath the canonical real CWD or temp base. This permits expected platform base aliases such as macOS `/var` → `/private/var` but rejects user-created intermediate root links.

Every traversed directory is secured with lstat/open/fstat/post-lstat identity checks (POSIX opens use `O_DIRECTORY|O_NOFOLLOW`), its descriptor stays open while descendants are visited, and all current/ancestor identities plus the original ctime, mtime, size, link count, and mode are rechecked around directory reads and bounded file reads. These immutable metadata checks apply only to traversal guards; extraction uses identity-only guards because creating destination entries legitimately mutates parent metadata.

Static child symlinks fail as non-regular entries; a nested rename/symlink ABA invalidates the whole traversal, discarding collected findings and bytes in favor of bounded failure evidence.

Windows uses lstat identity checks for directories and lstat/fstat identity checks for regular files and the spill, without POSIX-only flags.

### Bundle schema, limits, and preflight

The inner bundle schema is exactly `{files}`, and each entry is exactly `{path, contentBase64, size}`: source-root and per-file metadata are rejected, canonical paths and decoded content are secret-scanned, secret-bearing paths are rejected, and filenames in findings are redacted.

Bundles allow at most 512 files, 5 MiB per file, 40 MiB aggregate decoded content, 4,096 UTF-8 bytes per path, 4,096 total path components, 64 MiB inflated JSON, and 20 MiB compressed transport. The writer and extractor enforce the same limits; limit overflow emits only a bounded `bundle-limit-exceeded.json` failure artifact.

Before host filesystem mutation, extraction rejects duplicate and file-prefix-conflicting paths, symlink/non-directory destination components, and pre-existing final paths.

### POSIX extraction and rollback

On POSIX controllers, extraction sends the already prevalidated bounded files to the packaged `artifact-openat-extract.c` helper, compiled once into a private temporary directory. The helper independently validates the complete frame before mutation, requires its opened root identity to match the caller's pinned root, and uses descriptor-relative `mkdirat`/`openat` with `O_NOFOLLOW` one canonical component at a time.

Substituted symlinks and pre-open path swaps therefore fail without following them, final files use `O_EXCL`, and detected identity drift rolls created files back through retained parent descriptors even when a directory was moved. Rollback removes an entry only while its recorded name still has the identity this run created.

### Extraction outcomes and controller limits

The helper exits 0 after commit, 2 when it created nothing, 3 when it removed every entry it created, and 4 when an entry it created cannot be confirmed removed.

`extractPlatformArtifactBundle()` reports this as `extraction`: `committed`; `rejected` when extraction stopped before creating anything, such as an invalid envelope or bundle, failed preflight, unavailable helper, or native frame/root check; `rolled-back`; `rollback-incomplete`; or `unknown` when the helper ended by signal, spawn error or an unrecognized status, so created entries may remain. A failed bundle-extraction check records the extraction outcome (and the structured-artifact violation count when extraction committed malformed JSON/JSONL) in `assertions.json` and `failures.md`.

This is race-safe extraction, not a sandbox against a hostile same-owner process: such a process can transiently relocate an already-open directory or the pinned root itself, although it cannot make extraction overwrite an existing destination.

Windows controllers reject every nonempty extraction bundle before mutation because Node exposes no handle-relative Windows creation API.

### Inline, spill, and chunk transport

Small bundles stay between `PLATFORM_LIVE_BUNDLE_JSON_START` and `PLATFORM_LIVE_BUNDLE_JSON_END`; larger bundles exclusively create and descriptor-write the exact CWD-relative `.platform-artifact-bundle.gz` final component (`O_NOFOLLOW` on POSIX), emit that exact marker path, and allow chunk reads only for that one-component path. No intermediate spill path is accepted.

The host retrieves exact 32 KiB chunks through no-sync Crabbox runs before releasing the lease. Compact control output is collected through Crabbox's local `--capture-stdout` file.

This works on scenario failure and preserves the original command exit code; chunk transport success is not substituted for suite success, and no tar/zip side channel exists.

### Assertion output format

Each suite produces `assertions.json` with `ok`, `checks`, and an ISO timestamp in `writtenAt`:

```json
{
  "ok": true,
  "checks": [
    { "id": "final-marker", "ok": true },
    { "id": "pi-exit", "ok": true },
    { "id": "card-read", "ok": true },
    { "id": "jsonl-read", "ok": true }
  ],
  "writtenAt": "2026-11-08T12:00:00.000Z"
}
```

Each check result has `id` and `ok`. Failed checks include `error` when provided by the check or a thrown exception. Passing checks omit `error`.

`failures.md` is written only when at least one check fails. It contains:

- the heading `# Assertion Failures` and a blank line;
- one `- **<id>**: <error>` line per failed check, using `failed` if `error` is null or absent;
- a blank line and `Total: <count> failure(s)`.

Artifact paths, command context, and diagnostic hints appear only if a check includes them in its error text.

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

The implementation must classify every `CURSOR_TOOL_PRESENTATION_SPECS` entry from `src/cursor-tool-presentation-registry.ts` as required or excluded for the optional comprehensive visual matrix. `test/smoke-tooling.test.ts` fails when a registry tool name is missing from these lists or an excluded entry lacks a rationale.

Required deterministic cards:

- `read`
- `grep`
- `glob` / find
- `shell`
- `write`
- `edit`
- failed `read`

Excluded from release visual matrix with required rationale:

- `ls`: composer-2-5 does not route the deterministic source-enumeration step through the native `ls` surface reliably; the suite instead gates that behavior through a successful native `find` result for `src/cursor-provider.ts`.
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

Adding a registry entry requires adding it to the required or excluded list with rationale.

## Platform command rendering

Scenario commands are POSIX shell strings for Apple Silicon macOS and Ubuntu. `renderPrompt(scenario)` replaces each `{{key}}` with its command.

Prompt fields:

```js
{
  promptTemplate: "... {{shellSmoke}} ...",
  commands: {
    shellSmoke: "printf 'cursor visual smoke\\n'",
  },
}
```

## Implementation phases

### Phase 0: plan-only branch state

Create this plan on `feat/crabbox-platform-smoke`. Do not implement code in this phase.

### Phase 1: dependency spike

Verify `node-pty` on every target before committing the dependency.

Exit criteria:

- node-pty self-test passes on macOS;
- node-pty self-test passes on Ubuntu local-container;

### Phase 2: config and doctor

Add config, CLI skeleton, doctor, and npm scripts.

Exit criteria:

```bash
npm run smoke:platform:doctor
```

passes only when all required local setup exists.

### Phase 3: target session manager

Implement Crabbox target lifecycle for both targets.

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

Implement PTY capture and host-side xterm/Playwright render.

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

- macOS static SSH localhost cannot run the required PTY visual matrix.
- Ubuntu local-container cannot run the required PTY visual matrix.
- Packed install cannot be tested uniformly across all targets.
- Artifact transfer cannot be made uniform across success and failure.
- The visual card detector cannot reliably identify required deterministic cards.
- The full gate exceeds the fixed Cursor invocation budget.

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
- PTY capture
- host-side ANSI render
- artifact manifest writer
- JSONL parser
- visual evidence detector
- process cleanup checker
- target doctor

The framework is successful when another pi extension can copy the runner and change only its config plus scenarios.
