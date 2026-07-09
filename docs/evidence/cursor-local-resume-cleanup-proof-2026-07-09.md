# Cursor local resume cleanup proof — 2026-07-09

## Result

Recorded-ID-only local Cursor SDK cleanup is implemented and proved across macOS, Ubuntu, and Windows native. At capture time local resume remained default-off; after user approval on 2026-07-09, local resume moved to default-on with opt-out.

## What changed

- Added `/cursor-local-resume-cleanup --dry-run` and `/cursor-local-resume-cleanup --yes`.
- Cleanup candidates come only from `cleanupCandidateAgentIds` recorded on `cursor-sdk-agent-resume` session custom entries when a newer local agent supersedes the prior branch agent.
- Cleanup writes `cursor-sdk-agent-cleanup` ledger entries for dry-runs and deletes.
- Deletes call `Agent.delete(agentId, { cwd })` once per exact recorded `agent-*` ID.
- Cleanup protects the latest active branch agent, ignores unsafe/non-recorded IDs, and does not use lower-level store filters or global sweeps.

## Proof

Final full platform gate:

- Command: `npm run smoke:platform:all`
- Result: passed
- Artifact index: `.artifacts/platform-smoke/latest.json`
- Started: `2026-07-09T02:09:25.861Z`
- Finished: `2026-07-09T02:31:14.202Z`
- macOS run: `run-1783562965865-q4i5yx`
- Ubuntu run: `run-1783562965867-vt5kmf`
- Windows native run: `run-1783562965868-odiqhm`

All targets passed these suites:

- `platform-build`
- `cursor-native-visual-matrix`
- `cursor-bridge-visual-matrix`
- `cursor-abort-cleanup`
- `cursor-local-resume-restart`
- `cursor-local-resume-safety`
- `cursor-local-resume-tool-surface`
- `cursor-local-resume-abort`
- `cursor-local-resume-tree`
- `cursor-local-resume-copy-switch`
- `cursor-local-resume-fallback`
- `cursor-local-resume-compaction`
- `cursor-local-resume-default-dry-run`
- `cursor-local-resume-cleanup`

Focused cleanup proof also passed locally:

- Command: `npm run smoke:local-resume:cleanup`
- Marker: `local-resume-cleanup-smoke-ok`

## Cleanup lane assertions

`cursor-local-resume-cleanup` proves:

1. a tool-surface replacement creates a new local agent instead of reusing the old agent;
2. the new resume entry records the old agent in `cleanupCandidateAgentIds`;
3. `/cursor-local-resume-cleanup --dry-run` records exactly the old candidate and deletes nothing;
4. `/cursor-local-resume-cleanup --yes` records the old candidate as deleted and no failures;
5. restart resumes the current recorded agent after cleanup;
6. tree navigation to the old resume entry does not resume the deleted old agent and falls back safely.

## Recommendation

Local resume default-on was no longer blocked by missing recorded-ID-only cleanup proof. User approval to flip the default landed later on 2026-07-09; the implementation has platform proof for restart, safety, tool-surface mismatch, abort, tree navigation, copy/switch, fallback, compaction, default/opt-out proof, and cleanup.
