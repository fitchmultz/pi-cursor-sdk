# Development and releases

Start with the [README](../README.md) for installation and the [Cursor SDK reference](reference.md) for runtime configuration. This page collects maintainer verification, event capture, compatibility and release procedures.

## Maintainer cost-conscious verification

Run offline/faux tests, native contracts, type checks, builds, and package checks first; preserve offline cross-platform CI. Reuse retained evidence for unchanged tested inputs. Real Cursor calls are only for the smallest meaningful changed-behavior check that needs real-service proof, on one representative environment. Docs/metadata-only changes need no paid testing. Do not replay full paid campaigns, run host matrices merely for matrix coverage, or automatically retry paid failures. Automated Cursor PR reviews continue unchanged.

No paid Cursor Cloud testing for generic PRs or releases. Only a PR or issue explicitly focused on Cursor Cloud may use a necessary focused Cloud check; incidental Cloud code changes do not qualify. Cloud product capabilities, offline contracts, and explicit smoke commands remain available. Even for Cloud-focused work, the multi-lane `npm run smoke:cloud` is optional, not an unconditional gate; selected checks retain run/evidence and agent/repository cleanup requirements.

[Platform smoke](./platform-smoke.md) documents existing single-suite/single-target commands and the optional comprehensive `npm run smoke:platform:all` matrix. The matrix uses packed installs, PTY/ConPTY ANSI capture, host-rendered xterm/PNG evidence, JSONL assertions, bridge diagnostics, usage/cache checks, abort cleanup, artifact manifests, and redaction scans. `.artifacts/platform-smoke/latest.json` points to each platform run's evidence. Report exactly the scope observed, not unrun matrix coverage.

The older live smoke helpers remain useful for inner-loop debugging and focused visual audits, not as the release gate. Use [Cursor live smoke checklist](./cursor-live-smoke-checklist.md), `npm run smoke:visual`, `npm run smoke:live`, or direct `pi --approve -e . --cursor-no-fast --model cursor/grok-4.6` runs only when a changed TUI/card/runtime behavior needs new live evidence. Select one relevant check rather than executing every helper. `npm run smoke:visual` captures an offscreen PTY rendered through browser/xterm and saved as PNG screenshots with Playwright, or with `agent_browser` from the generated HTML when available. Its default matrix is native replay only: native replay registration is forced on, Cursor setting sources are disabled, the pi bridge is off, overlapping built-in pi tools are not exposed, and inherited Cursor SDK event-debug artifact env is cleared; `--event-debug` writes to a deterministic debug directory under the visual output directory. The visible TUI/output, rendered screenshots, scrubbed diagnostics, and persisted JSONL must agree. See [Cursor testing lessons](./cursor-testing-lessons.md) for auth.json seeding, isolated `/tmp` harness layout, JSONL replay-error scans, and other regression traps.

## Maintainer Cursor SDK event capture

Use `npm run debug:sdk-events` to capture timestamped `run.stream()`, `onDelta`, and `onStep` timelines for one direct `@cursor/sdk` run.

Use `npm run debug:provider-events` to capture the same `onDelta`/`onStep` payloads **through pi's Cursor provider** (session agent reuse, bridge, native replay, send planning). Artifacts default under gitignored `.debug/cursor-sdk-events/`. Interactive multi-turn pi sessions group turns under `.debug/cursor-sdk-events/sessions/<session-slug>/turn-NNN-.../` with a `session.json` index. You can also opt in during any pi run with `PI_CURSOR_SDK_EVENT_DEBUG=1`; capture is file-only by default so the pi TUI stays normal. Each cumulative JSONL artifact is capped at 2 MiB, ends with an `artifact_truncated` record when capped, and is listed in `summary.json` under `truncatedJsonlFiles`.

See [Cursor testing lessons](./cursor-testing-lessons.md#cursor-sdk-event-capture-probe) for usage, artifact layout, and safety notes.

## Automatic npm releases (maintainers)

Follow the [shared release procedure](https://github.com/fitchmultz/.github#automatic-npm-releases): merge a reviewed PR into `main` with an intentional `package.json` version bump and a matching versioned `CHANGELOG.md` section. Automation never bumps versions, overwrites releases, or republishes an existing version. Once configured and enabled, it runs the existing offline compatibility and native macOS/Windows jobs, qualifies one candidate tarball, then waits for `fitchmultz` approval in the `npm` environment.

Approve only after checking the exact source commit, version, downloaded candidate tarball and summary against the [release review gate](../AGENTS.md#release-review-gate-maintainer) and [cost-conscious verification policy](#maintainer-cost-conscious-verification). Complete the exact-release-diff deep review with zero findings, the documented pre-release catalog check, and any genuinely necessary changed-behavior proof. Approval attests genuine satisfaction of existing requirements; it does not create proof. Authenticated checks remain outside CI; automated Cursor PR reviews remain unchanged, and no routine paid Cloud campaigns or paid retries are added. Automated publication disables npm hooks to publish the checked bytes; existing manual publisher instructions remain valid.

Failed/unpublished candidates can retry daily at 12:17 UTC or via manual dispatch of `npm release` on `main` only while the current source still owns the same version, tag, draft, and candidate assets. Inspect their exact source/run identities first: an authentication repair alone does not authorize publishing an old candidate after `main` advances. When source advances beyond a reserved candidate, use the next unused stable version and fresh qualification; never move its tag, overwrite its draft/assets, or relabel old proof. The [0.5.1 changelog](../CHANGELOG.md#051-unpublished-source-history) is unpublished source history carried into 0.5.2, not a successful publication record. Set repository variable `NPM_RELEASE_ENABLED` to anything other than `true` to stop new release plans; cancel pending runs separately when needed. Workflow validation is not evidence of a completed real OIDC publication.

Publication records are independent: on 2026-10-07, npm listed 0.5.2 as published and `latest`, while GitHub's `v0.5.2` release remained a draft bound to source `9820ae7`. Preserve that tag, draft, and candidate assets unchanged. The 0.5.3 source uses a new version and candidate; its preparation is not proof of npm or GitHub publication.

## Development

Required qualification targets are the latest stable official Pi and latest maintained `fitchmultz/pi` main, with optional wildcard Pi/TypeBox host peers and exact Cursor SDK **1.0.37**. CI resolves the official version/fork commit once and retains exact SDK/CLI provenance. Types, tests and package checks use each selected host's consistent dependency graph; the locked development Pi **1.1.0** dependencies are reproducible snapshots, not qualification targets. Updating these snapshots does not upgrade the user's Pi installation or change the official Pi 0.87.1 minimum. After `npm ci --ignore-scripts`, run `node scripts/ci-compatibility.mjs --automation /path/to/automation` in an empty HOME/agent profile for credential-free latest qualification. Native macOS/Windows checks select the same resolved latest official graph. This builds the manifest entry, runs existing type/unit/package checks, and tests the compiled provider's registration plus production prompt shaping against native Pi transcript/tool transitions. Replay arguments must match their JSON stream deltas. A second native contract runs the registered Cursor provider with only its external SDK transport/storage substituted: real loopback bridge execution, display-only replay, persisted usage, incremental sends, tree navigation, compaction, request-boundary steering, abort and reload/disposal. Tests use no live Cursor service.

TypeScript 7 builds and checks package types. Build and typecheck commands invoke `node_modules/typescript/bin/tsc` explicitly to avoid npm's shared `tsc` shim selecting a different compiler. `@typescript/typescript6` is dev-only for AST architecture and installed-SDK contract tests because TypeScript 7 does not expose a stable compiler API. Vitest 5 runs with `clearMocks: true` by default.

Pull-request CI runs that suite once per selected host: the latest stable official Pi and a source-built revision of the latest maintained fork `main`, each using its own consistent dependency graph and the version/commit resolved once for the run. It checks both npm and Git installations against both hosts without starting a Cursor model turn. The selected official version and fork commit are printed in the check log. Separate macOS and Windows jobs install with lifecycle scripts, load `node-pty`, and run the platform-build test, typecheck, and pack checks on Node 24.

For authorized uncommitted repairs, qualify an isolated immutable working-tree snapshot without committing:

```bash
node scripts/ci-compatibility.mjs --working-tree --official-only --versions 0.87.1,0.99.1,1.0.3
```

This builds and packs the snapshot, checks package loading, and exercises actual official native provider/session flows. The default invocation still requires a clean checkout and includes the maintained fork. `--help` documents selection and exit codes.

This manual snapshot mode retains explicit older-host qualification for the advertised floor; it is separate from CI's once-resolved latest-only targets. Do not combine manual selection flags with `--automation`.

This is offline compatibility proof, not Cursor authentication, desktop/cloud execution, visual, or all-platform live proof. Add only necessary changed-behavior live evidence under the [cost-conscious verification policy](#maintainer-cost-conscious-verification); the comprehensive paid matrix is optional, and paid Cloud testing is restricted to explicitly Cursor Cloud-focused PRs/issues. Older advertised Pi/Node floors require their own offline compatibility evidence.

Run checks:

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

