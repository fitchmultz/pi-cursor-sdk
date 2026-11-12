# Development and releases

Start with the [README](../README.md) for installation and the [Cursor SDK reference](reference.md) for runtime configuration. This page collects maintainer verification, event capture, compatibility and release procedures.

## Maintainer cost-conscious verification

Choose offline checks that exercise the changed behavior and its affected callers. Run focused owner tests with `npm test -- test/cursor-state.test.ts`, for example, and select relevant native contracts, type checks, builds, and package checks. Reuse valid evidence for unchanged inputs. Do not rerun the full suite after every edit, review, commit, or push. Broaden verification when the focused checks cannot reach a credible regression. Required CI and offline cross-platform coverage remain unchanged.

Each test must be able to catch a credible regression. Remove tests designed to always pass instead of counting them as verification. Prefer extending the existing owner test over adding a duplicate.

Real Cursor calls are only for the smallest meaningful changed-behavior check that needs real-service proof, on one representative environment. Docs/metadata-only changes need no paid testing. Do not replay full paid campaigns, run host matrices merely for matrix coverage, or automatically retry paid failures. Automated Cursor PR reviews continue unchanged.

No paid Cursor Cloud testing for generic PRs or releases. Only a PR or issue explicitly focused on Cursor Cloud may use a necessary focused Cloud check; incidental Cloud code changes do not qualify. Cloud product capabilities, offline contracts, and explicit smoke commands remain available. Even for Cloud-focused work, the multi-lane `npm run smoke:cloud` is optional, not an unconditional gate; selected checks retain run/evidence and agent/repository cleanup requirements.

[Platform smoke](./platform-smoke.md) documents existing single-suite/single-target commands and the optional comprehensive `npm run smoke:platform:all` matrix. The matrix uses packed installs, PTY/ConPTY ANSI capture, host-rendered xterm/PNG evidence, JSONL assertions, bridge diagnostics, usage/cache checks, abort cleanup, artifact manifests, and redaction scans. `.artifacts/platform-smoke/latest.json` points to each platform run's evidence. Report exactly the scope observed, not unrun matrix coverage.

The older live smoke helpers remain useful for inner-loop debugging and focused visual audits, not as the release gate. Use [Cursor live smoke checklist](./cursor-live-smoke-checklist.md), `npm run smoke:visual`, `npm run smoke:live`, or direct `pi --approve -e . --cursor-no-fast --model cursor/grok-4.6` runs only when a changed TUI/card/runtime behavior needs new live evidence. Select one relevant check rather than executing every helper. `npm run smoke:visual` captures an offscreen PTY rendered through browser/xterm and saved as PNG screenshots with Playwright, or with `agent_browser` from the generated HTML when available. Its default matrix is native replay only: native replay registration is forced on, Cursor setting sources are disabled, the pi bridge is off, overlapping built-in pi tools are not exposed, and inherited Cursor SDK event-debug artifact env is cleared; `--event-debug` writes to a deterministic debug directory under the visual output directory. The visible TUI/output, rendered screenshots, scrubbed diagnostics, and persisted JSONL must agree. See [Cursor testing lessons](./cursor-testing-lessons.md) for auth.json seeding, isolated `/tmp` harness layout, JSONL replay-error scans, and other regression traps.

## Zod peer and bridge packaging

Keep the exact SDK peer `zod@4.6.6` external and the bridge's newer nested `zod@4.6.7` copies bundled. Both contain the upstream bounded-collection fix; their published tarballs differ only in version metadata. This uses npm's ordinary locked dependency layout, not overrides, copied dependencies or SDK patches.

Preserve that layout when updating dependencies. Installing the bridge's Zod version at the package root or deduplicating can move the shared copy to the root, where npm includes it in the bridge bundle. Pi's `--legacy-peer-deps` consumer then hoists the unbundled SDK without an accessible Zod peer. `--omit=peer` is not equivalent and does not reproduce that failure.

`test/package-metadata.test.ts` owns the required peer/entrypoint contract, SDK v4/v4-mini and bridge parser controls, and the packed-root exclusion guard.

Release qualification compares runtime dependency metadata, the runtime lock graph, and bundled files with the previous published release. A change to those inputs, or an added or removed source line that mentions Zod, triggers installer qualification. The source-line check includes prose.

The qualifier installs the exact candidate tarball into fresh consumers with default npm, Pi-managed npm (`--legacy-peer-deps`), npm `--omit=peer`, Pi-managed pnpm (peer auto-installation off) and Pi-managed Bun (`--omit=peer`). It checks actual SDK ESM imports and SDK-relative `zod`, `zod/v3`, `zod/v4`, `zod/v4-mini` resolution, plus the bundled bridge under Node and Bun, and retains artifact hashes and installer versions. A clean audit or source-only parser test does not prove the published installation works.

The installer qualifier attaches its passed or skipped receipt to the prepared review scope. The deep reviewer must read that receipt, and the review command verifies its hash before and after the review.

## Maintainer Cursor SDK event capture

Use `npm run debug:sdk-events` to capture timestamped `run.stream()`, `onDelta`, and `onStep` timelines for one direct `@cursor/sdk` run.

Use `npm run debug:provider-events` to capture the same `onDelta`/`onStep` payloads **through pi's Cursor provider** (session agent reuse, bridge, native replay, send planning). Artifacts default under gitignored `.debug/cursor-sdk-events/`. Interactive multi-turn pi sessions group turns under `.debug/cursor-sdk-events/sessions/<session-slug>/turn-NNN-.../` with a `session.json` index. You can also opt in during any pi run with `PI_CURSOR_SDK_EVENT_DEBUG=1`; capture is file-only by default so the pi TUI stays normal. Each cumulative JSONL artifact is capped at 2 MiB, ends with an `artifact_truncated` record when capped, and is listed in `summary.json` under `truncatedJsonlFiles`.

See [Cursor testing lessons](./cursor-testing-lessons.md#cursor-sdk-event-capture-probe) for usage, artifact layout, and safety notes.

## Automatic npm releases (maintainers)

Follow the [shared release procedure](https://github.com/fitchmultz/.github#automatic-npm-releases). When enabled, the `npm release` workflow plans releases on `main` pushes, a daily schedule, and manual dispatch. It runs the existing offline compatibility and native macOS/Windows jobs and qualifies a candidate tarball before publication to npm and GitHub.

Before merging, check the final PR head (up to date with `main`) against the [release review gate](../AGENTS.md#release-review-gate-maintainer) and [cost-conscious verification policy](#maintainer-cost-conscious-verification). Complete the exact-release-diff deep review with zero findings, the documented pre-release catalog check, and any genuinely necessary changed-behavior proof. When automatic versioning is enabled, its version PR receives this qualification before merge; publication independently qualifies the retained post-merge candidate. Authenticated catalog and review steps run in the protected release environment, with separate credentials for each process. Automated Cursor PR reviews remain unchanged, and no routine paid Cloud campaigns or paid retries are added. Automated publication disables npm hooks to publish the checked bytes; existing manual publisher instructions remain valid.

Before retrying a failed or unpublished candidate, inspect its exact source/run identities and the shared retry procedure. An authentication repair alone does not authorize publishing an old candidate after `main` advances. Never move an existing tag, overwrite its draft/assets, or relabel old proof. The [0.5.1 changelog](../CHANGELOG.md#051-unpublished-source-history) is unpublished source history carried into 0.5.2, not a successful publication record. Set repository variable `NPM_RELEASE_ENABLED` to anything other than `true` to stop new release plans; cancel pending runs separately when needed. Workflow validation is not evidence of a completed real OIDC publication.

Publication records are independent: npm published 0.5.2, while GitHub's `v0.5.2` release remains a draft bound to source `9820ae7`. Preserve that tag, draft, and candidate assets unchanged. Verify npm and GitHub records independently for each new release.

The pinned shared versioner preserves a final newline when merging changelogs. When fetch rejects during version reconciliation or review remediation, the CLI reports the service, HTTP method, and public endpoint with Node's native error and cause details. A transport failure does not establish whether a remote write completed. See the [shared recovery guidance](https://github.com/fitchmultz/.github/blob/main/docs/npm-releases.md#recovery) before retrying.

### Replace a failed unpublished version

The version workflow supports paired `supersede-version` and `supersede-source` inputs through the pinned shared automation. Merge the source fix through normal PR checks before dispatching. Follow the [shared replacement procedure](https://github.com/fitchmultz/.github/blob/main/docs/npm-releases.md#replace-a-failed-unpublished-version-with-fixed-source).

Dispatch `npm-version.yml` only on `main`, with both inputs. For failed unpublished 0.5.27, `supersede-source` is the full failed automatic version PR merge SHA, not the earlier `99590875` queue source:

```bash
gh workflow run npm-version.yml --repo fitchmultz/pi-cursor-sdk --ref main \
	-f supersede-version=0.5.27 \
	-f supersede-source=d6f45b5ee72e9410a74f3252edbca4b70be8da53
```

The shared versioner verifies that the version is still unpublished and its original release run failed. The existing release App opens a normal version PR from fixed `main`. It chooses the replacement version above the manifest, all npm versions, and version tags. Leave both inputs empty for ordinary reconciliation.

Preserve the failed source and its history, tag, draft, assets, candidate, failed run, and receipts unchanged. Do not relabel old proof or publish fixed bytes as 0.5.27. Keep all normal pre-commit/pre-push reviews, current-head CI and Pi/Cursor reviews, prospective candidate qualification, actual post-merge candidate/catalog/installer gates, and OIDC publication checks. Verify the new npm and GitHub records independently; a local workflow check does not prove real recovery.

### Review and catalog qualification commands

Run these maintainer commands from the repository root.

`scripts/release-review.mjs` performs independent, read-only Pi reviews with the actual thermo-nuclear skill and its complete rubric. It requires the current Pi CLI, `ZAI_API_KEY`, and `PI_RELEASE_REVIEW_SKILL` pointing to that skill's `SKILL.md`. Run each review in a separate process without GitHub, npm publishing, OIDC, App, or Cursor credentials; Pi uses an isolated home and receives only its model credential. The receipt records the reviewed Git identities, skill/rubric hashes, and verdict; sibling files retain redacted Pi events and copies of the review inputs.

```bash
node scripts/release-review.mjs pre-commit --receipt /tmp/pre-commit-review.json
node scripts/release-review.mjs pre-push --base "$OUTGOING_BASE_SHA" --receipt /tmp/pre-push-review.json
```

Pre-commit reviews `HEAD` against the complete staged tree and rejects unstaged tracked changes. Pre-push reviews the outgoing commits and tree against the exact remote branch tip, or the captured `main` tip for a new branch; pass its full SHA as `OUTGOING_BASE_SHA`. Pre-push requires a clean tracked checkout and index. Both reject incomplete reviews or file reads, material findings, or a tree changed during review. Page through long files until the read tool reports no continuation. The default direct Z.ai reviewer is `glm-5.3-flash`, which can inspect images; an override via `PI_RELEASE_REVIEW_MODEL` must also support images when the reviewed changes contain them. Minor polish is recorded; release qualification requires zero findings, including polish. When `PI_RELEASE_REVIEW_AUTOMATION_VERSIONER` names the shared versioner, the receipt binds and retains that exact file as review context.

To supply retained verification evidence or prior finding dispositions, add `--review-context PATH` to a pre-commit, pre-push, or release review. The reviewer must read the whole file and assess its claims independently. The receipt retains its contents and SHA-256, and the command rejects changes to that file during review. Release reviews retain prepared qualification evidence alongside optional user context and require both files to be read and remain unchanged. Supplied context does not replace required source reads or qualification checks.

For a release candidate, `catalog --receipt PATH` runs the authenticated catalog check on a clean tracked checkout using `CURSOR_API_KEY` and binds its receipt and output to the current source, GitHub run, and attempt. For local staged changes, `catalog --staged` instead binds the staged tree; unstaged tracked changes are still rejected. In a separate step, `release-prepare --source SHA --release-source SHA --artifact DIR --catalog-receipt PATH --evidence DIR` collects the exact previous published tag-to-source diff, previous npm package and registry receipt, candidate artifacts, release notes, and associated PR/issue closure context. For a prospective release PR, add `--pull NUMBER` to include its current PR, review threads, and linked issue context; preparation rejects a PR whose head does not match the candidate source. The evidence directory must not already exist. Preparation requires `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, and a read-only `GH_TOKEN`.

Run `release --source SHA --release-source SHA --evidence DIR --receipt PATH` in another process with the model key but no GitHub or Cursor credentials. It must retain the same `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT` as preparation, such as in a separate step of that GitHub Actions run. It revalidates source, run, catalog, package bytes and extracted trees before and after the review. Release qualification requires every finding, including polish, to be resolved. A successful receipt is evidence of the review and catalog scope; it does not replace the other release checks or publish anything.

Before an otherwise completed native review settles, an isolated review-only extension checks the same read-coverage ledger as the independent final gate. It gives the reviewer exact missing paths and inclusive line ranges, then lets Pi continue the same review. Existing target files cannot borrow base-tree reads; deleted files use the recorded base. Feedback never substitutes for reading, changes a verdict, or clears findings. Incomplete verdicts, stated material limitations, native errors and aborts exit normally to the fail-closed gate. Unchanged missing coverage receives no repeated continuation; only meaningful read progress can produce further feedback. Pi owns continuation, retries, compaction and cancellation; the command does not restart the reviewer.

The static feedback module is loaded explicitly only inside this review's isolated native process, alongside disabled extension discovery. The command supplies its immutable review-input path through the internal child-only `PI_RELEASE_REVIEW_FEEDBACK_INPUT` binding; users do not configure it. The native child's working directory supplies the repository root. Ordinary Cursor extension sessions do not load it. Review commands and receipt fields are unchanged. Redacted native events and stderr remain beside the receipt, including all corrective reads. Use a current official or maintained-fork native CLI for this maintainer command; the package's runtime floor is unchanged.

Offline continuation regression checks use the real selected native CLI, loader, built-in read tool, provider parser and scheduler, substituting only the external model HTTP transport. Run `PI_HOST_CLI=/absolute/path/to/current/pi/dist/bundle/cli.js node --test test/native-release-review.test.mjs` for each selected host. Set `PI_CURSOR_TEST_EVIDENCE_DIR` to retain provider requests, native events and receipts. Current-host compatibility CI includes this check. `npm run check:compat` runs build, verify, then the native phase through `scripts/ci-compatibility-native.mjs`, preserving forwarded native test arguments; both compatibility routes take their native file list from `NATIVE_COMPATIBILITY_TEST_FILES`. The npm route remains unbounded; the isolated-host command watchdogs are unchanged. Run `node --test test/release-review.test.mjs test/release-review-read-coverage.test.mjs test/release-review-github.test.mjs test/release-review-npm.test.mjs` for the focused coverage and final-gate contracts.

A release reviewer must open every changed package path. A complete changed-source read can also cover a byte-identical package copy. The receipt verifies the SHA-256 match and records both paths and trees in `readEvidence.artifactSourceReads`. Different package content still requires a complete read.

## Development

Required qualification targets are the latest stable official Pi and latest maintained `fitchmultz/pi` main, with optional wildcard Pi/TypeBox host peers and exact Cursor SDK **1.0.40**. CI resolves the official version/fork commit once and retains exact SDK/CLI provenance. Types, tests and package checks use each selected host's consistent dependency graph; the locked development Pi **1.5.0** dependencies are reproducible snapshots, not qualification targets. Updating these snapshots does not upgrade the user's Pi installation or change the official Pi 1.5.0 minimum. After `npm ci --ignore-scripts`, run `node scripts/ci-compatibility.mjs --automation /path/to/automation` in an empty HOME/agent profile for credential-free latest qualification. Native macOS/Windows checks select the same resolved latest official graph. This builds the manifest entry, runs existing type/unit/package checks, and tests the compiled provider's registration plus production prompt shaping against native Pi transcript/tool transitions. Replay arguments must match their JSON stream deltas. A second native contract runs the registered Cursor provider with only its external SDK transport/storage substituted: real loopback bridge execution, display-only replay, persisted usage, incremental sends, tree navigation away from a run an abort left pending, compaction, request-boundary steering, steering after a bridge result that replaces a still-running SDK run, abort and reload/disposal. Tests use no live Cursor service.

TypeScript 7 builds and checks package types. Build and typecheck commands invoke `node_modules/typescript/bin/tsc` explicitly to avoid npm's shared `tsc` shim selecting a different compiler. `@typescript/typescript6` is dev-only for AST architecture and installed-SDK contract tests because TypeScript 7 does not expose a stable compiler API. Vitest 5 runs with `clearMocks: true` by default.

Pull-request CI runs that suite once per selected host: the latest stable official Pi and a source-built revision of the latest maintained fork `main`, each using its own consistent dependency graph and the version/commit resolved once for the run. It checks both npm and Git installations against both hosts without starting a Cursor model turn. The selected official version and fork commit are printed in the check log. Separate macOS and Windows jobs install with lifecycle scripts, load `node-pty`, and run the platform-build test, typecheck, and pack checks on Node 24.

For authorized uncommitted repairs, qualify an isolated immutable working-tree snapshot without committing:

```bash
node scripts/ci-compatibility.mjs --working-tree --official-only --versions 1.5.0
```

This builds and packs the snapshot, checks package loading, and exercises actual official native provider/session flows. The default invocation still requires a clean checkout and includes the maintained fork. `--help` documents selection and exit codes.

This manual snapshot mode retains explicit older-host qualification for the advertised floor; it is separate from CI's once-resolved latest-only targets. Do not combine manual selection flags with `--automation`.

This is offline compatibility proof, not Cursor authentication, desktop/cloud execution, visual, or all-platform live proof. Add only necessary changed-behavior live evidence under the [cost-conscious verification policy](#maintainer-cost-conscious-verification); the comprehensive paid matrix is optional, and paid Cloud testing is restricted to explicitly Cursor Cloud-focused PRs/issues. Older advertised Pi/Node floors require their own offline compatibility evidence.

Available full-suite commands:

```bash
npm test
npm run typecheck
```

Check the reviewable Cursor fallback catalog against the authenticated live catalog before releases:

```bash
CURSOR_API_KEY="your-key" npm run check:cursor-snapshots
```

Refresh it after Cursor model changes:

```bash
CURSOR_API_KEY="your-key" npm run refresh:cursor-snapshots -- --write
```

Refresh the bundled default/non-Max context-window snapshot only when checkpoint-derived context windows have been collected from live local runs:

```bash
CURSOR_API_KEY="your-key" npm run refresh:cursor-snapshots -- --write \
  --context-windows ~/.pi/agent/cursor-sdk-context-windows.json
```

The check and refresh modes fetch and sort the same sanitized live catalog. Check mode byte-compares the generated fallback without writing; generated provenance records the installed `@cursor/sdk` version and model count. Both modes print public model metadata only and scrub known auth material from SDK errors. Do not run them with shell tracing that would echo API keys.

Local development run:

```bash
npm install
CURSOR_API_KEY="your-key" pi --approve -e . --model cursor/grok-4.6
```

After editing `src/`, run `npm run build` before the next `pi -e .` run, or pi loads the previous build.

Maintainer design notes live in [`docs/cursor-model-ux-spec.md`](./cursor-model-ux-spec.md).

