---
feature: "Velora dg fixes"
feature_snake_case: velora_dg_fixes
date: "2026-11-20"
version: "1.0"
status: in-progress
current_slice: 3
pr_strategy: single
slices:
  - id: 1
    name: "verify-saved-sign-in"
    depends_on: []
    files: ["pkg/skills-cli/src/verify/**", "pkg/skills-cli/__tests__/verify-*.spec.ts", "plugins/dg/skills/verify/**", "docs/verify.md"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:security, dg:qa-code]
  - id: 2
    name: "prototype-sign-in-and-timeout"
    depends_on: [1, 4]
    files: ["pkg/skills-cli/src/prototype/**", "pkg/skills-cli/__tests__/prototype-*.spec.ts", "plugins/dg/skills/proto/references/local-ui.md", "plugins/dg/skills/proto/references/local-formats.md", "docs/demo-and-proto.md", "pkg/skills-cli/src/completion/tree.json", "plugins/dg/skills/proto/references/local-build.md", "plugins/dg/skills/proto/assets/README.md", "pkg/skills-test/__tests__/proto-skill.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:qa-code]
  - id: 3
    name: "thrash-nested-run"
    depends_on: []
    files: ["plugins/dg/skills/thrash/SKILL.md", "plugins/dg/skills/thrash/references/**", "plugins/dg/skills/address/SKILL.md", "plugins/dg/skills/address/references/workflow.md", "plugins/dg/skills/review-loop/SKILL.md", "pkg/skills-test/__tests__/thrash-pipeline-skill.spec.ts", "pkg/skills-test/__tests__/thrash-nested-run.spec.ts"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: low
      qa: [dg:reviewer]
  - id: 4
    name: "stat-archive-and-bg-cwd"
    depends_on: []
    files: ["pkg/skills-cli/src/stat/**", "pkg/skills-cli/src/bg/jobs.ts", "pkg/skills-cli/__tests__/stat-*.spec.ts", "pkg/skills-cli/__tests__/bg-jobs.spec.ts", "plugins/dg/skills/stat/**", "plugins/dg/skills/bg/references/job-management.md", "pkg/skills-cli/src/completion/tree.json"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:qa-code]
  - id: 5
    name: "legacy-launcher-removal"
    depends_on: []
    files: ["pkg/skills-cli/src/install/compat-launchers.ts", "pkg/skills-cli/__tests__/compat-launchers.spec.ts", "docs/install.md"]
    agents:
      primary: dg:js
      confidence: high
      complexity: low
      qa: [dg:qa-code]
  - id: 6
    name: "update-doctor-failures"
    depends_on: []
    files: ["pkg/skills-cli/src/update/run.ts", "pkg/skills-cli/src/doctor/runner.ts", "pkg/skills-cli/__tests__/update.spec.ts", "pkg/skills-cli/__tests__/doctor-runner.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: low
      qa: [dg:qa-code]
execution:
  profile: balance
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# Velora dg fixes

## Purpose
Fix the dg 6.1.0 rough edges found during the Velora release. Verify and prototype capture cannot reach a page behind a sign-in, prototype wait timeouts read as crashes, thrash and address degrade in nested subagents, the stat checklist grows without bound, the ~/.dg/bin notice launchers come back after their removal release, and update hides which doctor checks failed. None of these blocks Velora; each is a small, separately testable fix.

## Scope
### Included
- verify role `state`: load a saved pw state into the capture browser (issue 1)
- prototype: carry --sign-in and a new --state through ui/session waits, and a loud, actionable skipped-fingerprint exit (issue 2)
- prototype wait/await-decision: a 'timeout, still pending' line and a distinct exit code (issue 5)
- thrash and address: a written nested-run rule (no agent tool, or persona not registered) that never skips verify, consolidate, compile or local cleanup (issues 3 and 4 residue)
- stat archive: move done checklist items to an archive file (issue 6)
- bg list --cwd filter, and the stat skill uses it in place of its jq select (issue 9)
- ~/.dg/bin compat launchers: never recreated after removal; stale <name>.version leftovers swept (issue 7)
- update prints each failed doctor check after its summary line (issue 8)
- proto in-app bar: require More versions in hand-rolled bars and document a non-JS endpoint port (item 10)
### Excluded
- pw not finding Brave or Firefox (separate PR in flight)
- db setup and the dg launcher missing after update (bundle 024)
- issue 4 cleanup work: .agents/code-review/ is gitignored since #237 and /dg:address phase 7 already deletes accomplished files
- form fill from a stored credential in verify or prototype (a saved pw state covers it)
- stat archive --before <date> (checklist items carry no timestamp)
- rewriting stale skill copies under ~/.agents/skills or ~/.codex/skills (no dg installer writes them)
- a new one-shot thrash CLI command

### Slice 1 — verify-saved-sign-in

#### Engineering
- [ ] Manifest role accepts optional `state: <pw state name>`, validated with STATE_NAME from pkg/skills-cli/src/pw/core/states.ts; header and cookie seed checks stay unchanged
- [ ] CaptureRequest gains optional `stateName`; the playwright capturer loads it with pw states `load()` and passes it as the context storageState; loopback routing and redirect refusal stay in force
- [ ] A role with `state` refuses the http capturer with a clear error (cookies from a state need the browser engine)
- [ ] A missing state fails before capture with the StateNotFoundError text, which names `pw state list`
- [ ] When a capture lands on a different path than requested, the error names the path and says: save a sign-in with `dg-skills pw state save <name>` and add `state` to the role
- [ ] The state's cookies and storage are never written to the board, session files or logs
- [ ] Update verify SKILL.md, references/capture.md and docs/verify.md

#### Testing Criteria
##### Contracts
- [ ] Contract: `roles[].state?: string` in the verify manifest; invalid names throw `roles[N].state must be a saved pw state name`
- [ ] Contract: `CaptureRequest.stateName?: string`; playwright capturer calls newContext with `storageState` from `load(stateName)`
- [ ] Contract: http capturer throws `verify role <id> uses a saved state; it needs the playwright engine` for a request with stateName
- [ ] verify-manifest.spec: accepts a valid state, rejects a bad name, leaves the 500-char cookie limit and secret checks as they are
- [ ] verify-playwright.spec: a state-backed request reaches the signed-in page through a fake capturer seam; a missing state fails before any page opens
- [ ] verify-capture.spec: a redirected capture error names the landing path and the pw state command

#### Acceptance Criteria
- [ ] Given a saved pw state for a signed-in loopback app, when a verify role names it, then every capture for that role shows the signed-in page
- [ ] Given a role with no state on a page that redirects to sign-in, when capture runs, then the error tells the user exactly how to save and name a state
- [ ] No session cookie value appears in the manifest, board data or verify logs

### Slice 2 — prototype-sign-in-and-timeout

#### Engineering
- [ ] `prototype ui`, `wait` and `fingerprint` accept `--state=<pw state name>`; `ui` also accepts `--sign-in`; both are stored in UiState so `waitSession` passes them into the AcceptTarget (today the session path drops --sign-in)
- [ ] AcceptTarget gains `stateName`; readLayouts passes it to the capturer as CaptureRequest.stateName (slice 1)
- [ ] When an approve is recorded but the fingerprint was skipped, print to stderr `prototype: fingerprint skipped: <reason>` and one line `run: dg-skills prototype fingerprint <name> --url=<url> --state=<name>` (or `--sign-in=<url>` when that was used), and exit with the skipped-fingerprint code; the user's pick stays recorded
- [ ] On timeout, text mode prints `timeout, still pending`; JSON mode prints `{"status":"timeout","pending":true}`; both `wait` paths (named and session) and `await-decision` exit with the timeout code
- [ ] Add the two exit codes as named constants in prototype/sentinels.ts (EXIT_PROTOTYPE_TIMEOUT, EXIT_FINGERPRINT_SKIPPED); they must not collide with the EXIT_* values 1-6 and 78 in pkg/common/src/errors.ts
- [ ] Regenerate completion tree.json with `bun scripts/completion-trees.ts`
- [ ] Update local-ui.md (sign-in section, wait result handling, exit codes) and docs/demo-and-proto.md
- [ ] Item 10: the shipped bars already render More versions (PrototypeSwitcher.tsx/.astro, prototype-decision-bar.html since #215, v5.11.3) and wait already returns status more. The gap is the hand-rolled bar: local-ui.md requires only Approve and Reject, and no endpoint template exists for a non-JS host such as ASP.NET. Change the minimum-bar rule to Approve, Reject, More versions and notes
- [ ] local-build.md and assets/README.md: for a host with no shipped endpoint template, port prototype-endpoint.ts and keep all four actions (confirm, reject, more, status), or mount prototype-decision-bar.html with that ported endpoint; never drop the more action

#### Testing Criteria
##### Contracts
- [ ] Contract: exit 0 decision, exit 124 timeout with pick still pending, exit 75 approve recorded but fingerprint skipped, exit 1 error (codes subject to RATIFY)
- [ ] Contract: `formatWait({status:'timeout'}, false)` returns `timeout, still pending\n`; JSON adds `pending: true`
- [ ] Contract: UiState stores optional `signIn` and `stateName`; waitSession forwards them to acceptanceHook
- [ ] prototype-sentinels.spec: timeout text and JSON shapes
- [ ] prototype-ui.spec: a session started with --sign-in or --state forwards it on wait; timeout exits 124
- [ ] prototype-accept.spec: a skipped fingerprint after a sign-in redirect prints the exact run line with --state and returns the skipped code; a good fingerprint returns 0
- [ ] completion.spec passes after regeneration
- [ ] Contract (item 10): every proto doc that defines the minimum in-app bar names Approve, Reject and More versions; the non-JS host recipe names the more action and the .more sentinel
- [ ] proto-skill.spec: asserts the minimum-bar rule and the port recipe text; the existing bar render test (proto-skill.spec) and endpoint test (proto-endpoint-template.spec, action more) and prototype-sentinels.spec (wait returns more) stay green

#### Acceptance Criteria
- [ ] Given a prototype behind a sign-in and a saved pw state, when the user approves and the agent runs `prototype wait <name> --state=<s>`, then accepted.json holds six readings
- [ ] Given no state and a redirect to the sign-in page, when the user approves, then wait exits non-zero with a line that names the exact command to repair the fingerprint
- [ ] Given no decision before --timeout, when wait returns, then it prints `timeout, still pending` and exits 124, never 1
- [ ] Given a mounted in-app prototype on any host stack, when the agent builds the bar from the skill, then it has a More versions button and prototype wait reports status more for it

### Slice 3 — thrash-nested-run

#### Engineering
- [x] Add a `Nested run` section to thrash SKILL.md: when the host has no agent-launch tool (a subagent) or `dg:thrash-verify` / `dg:thrash-consolidate` is not registered, run that stage in the same agent, one item at a time, after reading the persona file from the plugin `agents/` folder; or route the stage through `dg-skills proxy <backend> --subagent thrash-verify|thrash-consolidate`
- [x] State that triage, verify, apply, consolidate and compile never get skipped; if no path works, stop and print `thrash cannot run nested here: <reason>; run /dg:thrash . from the main loop`
- [x] address SKILL.md and workflow.md: in a subagent, `-l` still runs phase 7, so accomplished .agents/code-review files are deleted
- [x] review-loop SKILL.md: one line pointing a subagent at the nested-run rule for each round
- [x] Keep the skill text in ASD-STE100 style and American spelling

#### Testing Criteria
##### Contracts
- [x] Contract: thrash SKILL.md has a `## Nested run` heading naming both personas, the persona-file fallback, the proxy fallback and the exact stop line
- [x] Contract: address SKILL.md says phase 7 cleanup also runs in a subagent
- [x] thrash-nested-run.spec (skills-test): asserts the heading, the stop line and that no step says verify or consolidate may be skipped
- [x] Existing thrash-pipeline-skill.spec still passes

#### Acceptance Criteria
- [ ] A subagent that reads /dg:thrash knows how to run every stage without the Agent tool, or stops with a clear reason
- [ ] After a nested /dg:address -l round, no accomplished .agents/code-review file is left

### Slice 4 — stat-archive-and-bg-cwd

#### Engineering
- [ ] `dg-skills stat archive [--dry-run] [--json]` moves every done top-level item with its subtree out of checklist.md into a sibling checklist-archive.md under a `## Archived YYYY-MM-DD` heading, inside the existing updateChecklist lock
- [ ] The report states moved items and how many open children went with a done parent
- [ ] `dg-skills bg list --cwd <dir>` keeps jobs whose cwd is the dir or below it, reusing isPathInside from pkg/common/src/node/scratch-paths.ts; unknown list flags exit with EXIT.USAGE
- [ ] stat SKILL.md replaces the jq select with `bg list --cwd "$PWD"` and suggests `stat archive` when the done section is long
- [ ] bg job-management.md documents --cwd
- [ ] Regenerate completion tree.json

#### Testing Criteria
##### Contracts
- [ ] Contract: `stat archive --json` prints `{"kind":"checklist-archive","moved":N,"openChildren":M,"archive":"<path>"}`
- [ ] Contract: `bg list --cwd <dir>` prints `{jobs:[...]}` filtered by path containment, never a sibling prefix such as /repo-other
- [ ] stat-cli.spec: archive moves done items, keeps open items and order, appends on a second run, --dry-run writes nothing
- [ ] bg-jobs.spec: --cwd keeps the dir and its children, drops a sibling prefix
- [ ] completion.spec passes after regeneration

#### Acceptance Criteria
- [ ] Given a checklist with many done rows, when the user runs stat archive, then checklist.md holds only open work and the archive holds the rest
- [ ] Given jobs from several repos, when stat gathers jobs, then it lists only this repo's jobs without jq

### Slice 5 — legacy-launcher-removal

#### Engineering
- [x] syncCompatLaunchers rewrites only a legacy file that already exists; it never creates a launcher in a ~/.dg/bin that has none, so the removal release cannot slide forward
- [x] When it removes launchers (or none remain), it also removes the old `<name>.version` leftovers of LEGACY_PROGRAMS so removeIfEmpty can delete ~/.dg/bin
- [x] Keep the notice text; it already names the replacement path
- [x] docs/install.md: one line that stale skill copies outside the dg install (for example ~/.agents/skills) can still call ~/.dg/bin and need a reinstall from their own source

#### Testing Criteria
##### Contracts
- [x] Contract: no file present means no launcher written, at any version
- [x] Contract: at or past the removal release, the launcher and `<name>.version` files go away and an otherwise empty ~/.dg/bin is removed
- [x] compat-launchers.spec: regression for the drift (launcher removed at release R, a later install with a leftover dg-skills.version does not write a new launcher with a later release)

#### Acceptance Criteria
- [ ] After the removal release, ~/.dg/bin stays gone on every later install or update
- [ ] Before it, the notice keeps one fixed removal release

### Slice 6 — update-doctor-failures

#### Engineering
- [x] Add `formatFailures(report)` to doctor/runner.ts: one line per `fail` check as `  ❌ <item> / <id>: <first detail line>` plus `      Fix: <fix>` when present; empty string when none fail
- [x] update's doctor step logs the summary line, then formatFailures output, then the existing `Run dg-skills doctor for details.` pointer
- [x] Doctor stays information only; the update exit code does not change

#### Testing Criteria
##### Contracts
- [x] Contract: `formatFailures(report: DoctorReport): string` exported from doctor/runner.ts
- [x] Contract: the update deps seam returns the report (or summary and failures) so tests need no real doctor run
- [x] doctor-runner.spec: only fail checks appear, fix lines included, warn and info excluded
- [x] update.spec: four failures print four lines after the summary; zero failures print only the summary

#### Acceptance Criteria
- [ ] Given an update whose doctor run has failed checks, when update finishes, then each failed check and its fix is printed under the summary

## Slice Summaries
- Slice 5: syncCompatLaunchers rewrites only launchers that exist and sweeps leftover <name>.version files once no launcher remains, so ~/.dg/bin stays gone after the removal release; docs/install.md notes stale skill copies (R6).
- Slice 6: update logs each failed doctor check and its fix under the summary line through the new formatFailures; the update deps seam returns the DoctorReport; exit code unchanged.
- Slice 3: thrash SKILL.md gains a Nested run rule (persona-file fallback, then proxy --subagent fallback, never skip a stage, exact stop line); address and review-loop point subagents at it, and address phase 7 cleanup runs in a subagent too.

## Agent Notes
- (owner, 2026-11-20) R1: verify loads a saved pw state per role (`role.state`), loopback only. Seed checks and the cookie cap stay unchanged.
- (owner, 2026-11-20) R2: `prototype wait` exits 124 on timeout and 75 on a skipped fingerprint.
- (owner, 2026-11-20) R3: approve with a skipped fingerprint still records the pick and exits 75.
- (owner, 2026-11-20) R4: thrash in a subagent is a doc rule only, with no new command.
- (owner, 2026-11-20) R5: `stat archive`, with no dates.
- (owner, 2026-11-20) R6: old ~/.dg/bin calls in skill copies dg does not install are out of scope, with a docs note.
- (owner, 2026-11-20) R7: hand-written in-app bars get a doc rule plus a porting guide now.
- (owner, 2026-11-20) Waves: slice 2 depends on [1, 4] and slice 4 has no dependency, so the build runs in two waves.

## Issues Remediation

## Verified Against origin/master

Checked on 2026-11-20 against origin/master 6a86f3e7 (6.1.0).

- Issue 1: open. manifest.ts caps cookie values at 500. Roles take only seed headers and cookies. looksSecret would likely reject a real session cookie at any length.
- Issue 2: partly fixed by #216 (--sign-in and a repair hint in the skipped text). Still open: ui.ts waitSession drops --sign-in, there is no saved-state path, and a skipped fingerprint exits 0.
- Issue 3: open. The persona files ship in plugins/dg/agents, and SKILL.md says to use them when the host has none. Nothing covers a host with no agent-launch tool. Stale hosts (plugin 3.1.0 has only thrash.md) do not register thrash-verify or thrash-consolidate.
- Issue 4: fixed. #237 gitignores .agents/code-review/, and /dg:address phase 7 deletes accomplished files. What is left comes from issue 3, so slice 3 covers it.
- Issue 5: open. The named wait prints `timeout`, the session wait prints `{"status":"timeout"}`, and both exit 1.
- Issue 6: open. stat has no archive. Checklist items carry no timestamp.
- Issue 7: the cause is different from the report. The notice already names the replacement path. At its removal release, syncCompatLaunchers removes the launcher. But leftover `dg-skills.version` files keep ~/.dg/bin from being empty, so the next install writes a fresh launcher with a later release (5.13.0, then 6.3.0). The stale ~/.dg/bin calls come from skill copies in ~/.agents/skills and ~/.codex/skills, which no dg installer writes.
- Issue 8: open. update logs only summarizeReport.
- Issue 9: open. bg list takes no flags.
- Item 10: the shipped bars are fixed by #215 (in v5.11.3 and later). PrototypeSwitcher.tsx, PrototypeSwitcher.astro and prototype-decision-bar.html all render More versions, and wait returns status `more`. The likely gap is a hand-rolled bar: local-ui.md requires only Approve and Reject, and no endpoint template exists for a non-JS host. Slice 2 covers it.

## Open Ratification

Each item is [OPEN — roundtable] until the human ratifies it.
- ⚑ RATIFY R1 (slice 1): Should verify load a saved pw state? A saved state holds live session cookies. Options: (a) `role.state` names a pw state, loopback only, with the seed checks unchanged; (b) (a) plus a cookie cap raised to 4096; (c) a cap raise only. Recommendation: (a).
- ⚑ RATIFY R2 (slice 2): Which exit codes should prototype wait use? Options: 124 on timeout and 75 when the pick is recorded but the fingerprint is skipped; or keep 1 and add only the text. Recommendation: 124 and 75. Docs that test for exit 1 need updates, and slice 2 owns those docs.
- ⚑ RATIFY R3 (slice 2): When approve skips the fingerprint, what happens to the pick? Options: record the pick and exit 75 with the repair command; or refuse the approve. Recommendation: record and exit 75, so the user's choice is never lost.
- ⚑ RATIFY R4 (slice 3): How should thrash run nested? Options: a doc-only nested-run rule with persona-file and proxy fallbacks; or a new one-shot `dg-skills thrash round` command. Recommendation: doc-only (YAGNI).
- ⚑ RATIFY R5 (slice 4): Which shape should stat cleanup take? Options: `stat archive` that moves done items with their subtrees; timestamps so that `--before <date>` can work; or `stat prune --done-parent`. Recommendation: `stat archive`, with no dates.
- ⚑ RATIFY R6 (slice 5): Should dg fix the stale ~/.dg/bin calls in skill copies that dg does not install (~/.agents/skills, ~/.codex/skills)? Options: out of scope, with a docs note; or a doctor check that scans those folders. Recommendation: out of scope.
- ⚑ RATIFY R7 (slice 2, item 10): How should we fix a hand-rolled in-app bar? Options: a doc rule plus a recipe to port the endpoint to a non-JS host; or ship a framework-neutral endpoint, such as a Bun sidecar that the bar posts to. Recommendation: the doc rule and recipe now; add a sidecar only if a second non-JS host needs one.
