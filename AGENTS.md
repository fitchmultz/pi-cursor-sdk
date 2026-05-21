# AGENTS.md

## Purpose

This repository is a pi provider extension that registers Cursor SDK-backed models under the `cursor` provider. Agent work is successful when changes preserve pi-native model/thinking/session behavior, keep Cursor API keys out of repo state and logs, and pass the local validation commands below.

## Repository map

- `src/index.ts` registers the pi extension, provider, fallback warnings, Cursor fast controls, native replay wrappers, question tool, and pi tool bridge hooks.
- `src/model-discovery.ts` discovers Cursor models, builds pi model metadata, stores per-model metadata, and defines fallback models.
- `src/cursor-provider.ts` streams through local `@cursor/sdk` agents, injects local MCP bridge config, resumes live bridge runs, and sanitizes Cursor SDK errors.
- `src/cursor-pi-tool-bridge.ts` exposes active pi tools to local Cursor agents through a per-run loopback MCP bridge.
- `src/cursor-question-tool.ts` owns the bridge-exposed `cursor_ask_question` pi UI tool.
- `src/cursor-native-tool-display.ts`, `src/cursor-tool-transcript.ts`, and `src/cursor-tool-names.ts` handle display-only Cursor native tool replay and transcript labels.
- `src/cursor-mcp-timeout-override.ts` owns Cursor SDK MCP call timeout overrides for long-running local MCP tools.
- `src/cursor-state.ts` owns `/cursor-fast`, `--cursor-fast`, `--cursor-no-fast`, session state, and global fast defaults.
- `src/context.ts`, `src/context-window-cache.ts`, and `src/bundled-context-windows.ts` handle prompt conversion and context-window caches.
- `test/**/*.test.ts` contains Vitest coverage for provider registration, discovery, state, context, bridge, replay, and streaming behavior.
- `docs/cursor-model-ux-spec.md` is the maintainer design source of truth for Cursor model UX. Keep it aligned with behavior changes.

## Operating rules

- Prefer the smallest change that preserves the current pi user contract.
- Treat Cursor SDK model metadata as the source of truth for model IDs, parameters, variants, thinking controls, and context variants. Do not hardcode new model-specific behavior unless it is a documented fallback.
- Keep pi-native abstractions first: context is a model variant, thinking uses pi thinking metadata, and Cursor-only `fast` is extension state/status.
- Preserve the default pi footer; use extension status only for Cursor-only state such as `cursor fast`.
- Stop discovery once package scripts, README, config files, tests, and the relevant `src/` modules explain the task. Do not broad-search `node_modules` unless debugging a dependency API.
- Ask the user before changing public UX, published package metadata, dependency families, or behavior that requires a migration. Otherwise proceed and verify locally.

## Setup and commands

- Install dependencies: `npm install`
- Run tests: `npm test`
- Typecheck: `npm run typecheck`
- Package-readiness check: `npm pack --dry-run`
- Watch tests while developing: `npm run test:watch`
- Local development run, requires a Cursor key: `CURSOR_API_KEY="your-key" pi -e . --model cursor/composer-2.5`
- List Cursor models, requires pi and usually a Cursor key: `pi --list-models cursor`

There is no lint or format script in `package.json` at this time.

## Coding conventions

- TypeScript is ESM with `moduleResolution: "NodeNext"`; keep `.js` extensions on local relative imports.
- Keep strict TypeScript types. Avoid `any` except in tests or when narrowing untyped external SDK data.
- Keep provider runtime code side-effect-light. Do not write secrets, and do not let cache or discovery failures break response streaming unless the run cannot proceed safely.
- Add or update tests for behavior changes in `src/`. Prefer focused unit tests over live Cursor calls.
- If dependency versions change, update `package-lock.json` with npm. Do not manually edit generated dependency output.
- Do not commit `dist/`, `coverage/`, `.env*`, `.pi/`, or package tarballs.

## Validation and done criteria

Done means:

- The intended behavior or documentation change is complete.
- `npm test` and `npm run typecheck` pass, unless the change is docs-only and the user asked for minimal validation.
- `npm pack --dry-run` passes when package metadata, publishable docs, dependencies, or ignored artifacts change.
- Related README/docs/tests are updated when behavior, commands, user-visible model IDs, flags, or troubleshooting change.
- No secrets, local API keys, or noisy local state are added.

If validation fails:

1. Triage the first failing test/type error to root cause.
2. Fix failures caused by the change.
3. If a failure is unrelated or cannot be run locally, report the command, failure, likely reason, and what still needs verification.

## Planning and large changes

Use a short written plan before multi-file behavior changes, SDK integration changes, or public UX changes. Use `PLANS.md` only if a task needs durable multi-session tracking; do not create one for routine edits.

## Security and side effects

- NEVER store Cursor API keys in repo files, `~/.pi/agent/cursor-sdk.json`, tests, logs, snapshots, or docs examples.
- Scrub Cursor SDK errors and output that may contain API keys, bearer tokens, cookies, sessions, or auth headers.
- Ambient Cursor settings/rules loading is enabled by default through `PI_CURSOR_SETTING_SOURCES=all`; keep SDK startup log filtering intact so settings/skills output does not corrupt pi's TUI.
- Live `pi`/Cursor smoke tests may call external services and require `CURSOR_API_KEY`; run them only when needed and report if skipped.

## Progress updates and handoff

For multi-step or tool-heavy work, give short progress updates after meaningful milestones: what changed, what is being checked, and any blocker. Final handoff should include changed files, validation commands/results, skipped checks with reasons, and any follow-up risks.

## Updating this file

Keep this file concise and repo-specific. Update it when commands, package layout, safety constraints, or validation expectations change. Put specialized subdirectory rules in a nested `AGENTS.md` only when that subtree has materially different commands or constraints.
