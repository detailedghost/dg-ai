# Review pipeline: investigate, group, verify, consolidate — Initial Notes

## Purpose
/dg:thrash reviews a diff with no view of the code around it, so it misses defects that need context and posts claims that nobody checked. This feature gives each review a checkout at the PR head, bundles that group the changed files by concern with their callers and tests, an opus verifier for each serious finding, and a consolidator for reviews with more than one bundle. /dg:refactor reuses the investigate and verify stages. The channel-review daemon gets per-tier Bedrock models and a spice-scaled time limit so the longer pipeline can finish.

## Scope
### Included
- `dg-skills thrash diff` checkout in thrash scratch (cwd objects, then clone, then provider API files, then none), `--no-repo`, plan.json `repo`
- Provider `getFileAtRef` for GitHub and GitLab
- `dg-skills thrash investigate <paths>` and concern bundles as plan.json `chunks[]` entries: one bundle for a diff of 100 changed lines or fewer; above that one bundle per concern, about 400 changed lines at most each, 8 bundles at most
- `dg-skills thrash triage --stage merge|apply`, finding `id` and `evidence`, a limit of 16 verify tasks, compile reads the verified or consolidated set
- Personas `dg:thrash-verify` and `dg:thrash-consolidate` (opus), `dg:thrash` rules conditional on a `REPO` input
- /dg:thrash skill pipeline in waves of 16 or fewer agents, version probe on the new CLI surface
- /dg:refactor uses `thrash investigate` and `dg:thrash-verify` and shows only verified candidates
- channel-review: `runner.claude.bedrock.models`, `runner.timeoutMinutesBySpice`, `~model` with `[1m]`, logged fallback model switch, ADR 0019 amendment
- New ADR for the review checkout; README and developer docs in one final slice
### Excluded
- Thrashley CI action behavior (it only passes `--no-repo`)
- A Workflow script or a change to any tool allowlist
- Edits to plugins/dg/skills/hunt/references/hunt.workflow.mjs (prompt template source only)
- Hoisting the clone helpers in pkg/channel-review/src/address.ts and automation/repo-job.ts
- The fable tier for the consolidator (pkg/skills-cli/src/tiers.ts and `fableAgents` stay as they are)
- The spice verdict table (`VERDICT_LIMITS`)
- `planChunks` and its limits (`LARGE_DIFF_LINES`, `MAX_CHUNKS`): they stay as they are and still plan a review that has no git tree
- Built-in default values for `runner.timeoutMinutesBySpice`, and a time multiplier for `~stacked`
- A new top-level dg-skills command or doctor item (new verbs live under `thrash` and reuse `thrashChecks`)
- Changes to pkg/channel-review/stryker.conf.mjs
