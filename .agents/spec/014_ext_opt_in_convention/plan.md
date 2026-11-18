---
feature: "Local mode by default, --ext opt-in for the dg-ai-extension across every dg skill"
feature_snake_case: ext_opt_in_convention
date: "2026-10-29"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "ext-flag-and-guard"
    agents:
      primary: dg:js
      qa: [dg:qa-code]
    depends_on: []
    files: ["pkg/skills-cli/src/utils/ext-flag.ts","pkg/skills-cli/src/utils/cli-only.ts","pkg/skills-cli/src/commands/batch-open.ts","pkg/skills-cli/src/batch-open/doctor.ts","pkg/skills-cli/src/commands/launch.ts","pkg/skills-cli/src/commands/rerun.ts","pkg/skills-cli/src/commands/demo.ts","pkg/skills-cli/src/doctor/checks.ts","pkg/skills-cli/__tests__/ext-flag.spec.ts","pkg/skills-cli/__tests__/cli-only.spec.ts","pkg/skills-cli/__tests__/batch-open.spec.ts","pkg/skills-cli/__tests__/doctor-ext-only.spec.ts"]
  - id: 2
    name: "skills-callers-lint-docs"
    agents:
      primary: dg:lore
      qa: [dg:qa-code]
    depends_on: [1]
    files: ["plugins/dg/skills/browser/SKILL.md","plugins/dg/skills/browser/references/install.md","plugins/dg/skills/browser/references/extension.md","plugins/dg/skills/pushup/SKILL.md","plugins/dg/skills/deps-upgrade/references/steps.md","plugins/dg/skills/sdlc/references/finish.md","plugins/dg/skills/spec/references/execute.md","plugins/dg/skills/spec/SKILL.md","plugins/dg/skills/inbox-cleanup/SKILL.md","plugins/dg/skills/inbox-cleanup/references/providers.md","plugins/dg/skills/README.md","pkg/skills-test/__tests__/ext-opt-in.spec.ts","pkg/skills-test/__tests__/browser-skill.spec.ts","pkg/skills-cli/__tests__/cli-only.spec.ts","pkg/common/__tests__/installed-skill-files.ts","docs/install.md","docs/AGENT-INSTALL.md","docs/browser.md","docs/adr/0028-local-default-extension-opt-in.md","docs/adr/toc.md"]
  - id: 3
    name: "proton-pw-profile"
    agents:
      primary: dg:js
      qa: [dg:qa-code, dg:security]
    depends_on: [1, 2]
    files: ["pkg/inbox/src/protonmail/page-operations.ts","pkg/inbox/src/protonmail/pw-client.ts","pkg/inbox/src/protonmail/client.ts","pkg/inbox/src/runtime.ts","pkg/extension/lib/features/inbox-proton.ts","pkg/skills-cli/src/commands/inbox.ts","pkg/skills-cli/src/inbox/proton-pw.ts","pkg/skills-cli/src/inbox/doctor.ts","pkg/inbox/src/protonmail/__test__/page-operations.spec.ts","pkg/inbox/src/protonmail/__test__/pw-client.spec.ts","pkg/skills-cli/__tests__/inbox-proton-pw.spec.ts","plugins/dg/skills/inbox-cleanup/SKILL.md","plugins/dg/skills/inbox-cleanup/references/providers.md","docs/inbox-cleanup.md"]
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# Local mode by default, --ext opt-in for the dg-ai-extension across every dg skill

## Purpose
Every dg skill runs without the dg-ai-extension unless the caller passes --ext, the way /dg:proto already works. batch-open opens plain tabs in the default browser and adds the tab-group marker only with --ext; launch is an --ext-only verb; rerun and demo take the same flag (demo's local player lands in the next bundle); the CLI-only guard trips only when --ext is present; the browser skill, every batch-open caller (pushup, deps-upgrade, sdlc finish, spec execute) and inbox-cleanup's Proton path follow the same convention. A repo test fails when any SKILL.md declares requires: [extension] or runs require-extension outside an --ext path; chat, demo and overwatch stay on a named allowlist until bundles 015 and 016 remove them.

## Scope
### Included
- ext-flag helper and a flag-aware CLI-only guard in pkg/skills-cli
- batch-open: plain tabs by default, tab-group marker only with --ext; launch is --ext-only; demo and rerun accept --ext and keep today's default with a one-line notice until 015
- doctor: extension checks for batch-open, launch, rerun, demo and require-extension become --ext-only (info, not fail, on a CLI-only install)
- browser skill rewritten without requires: [extension], with a Flags table whose --ext row matches proto's format
- pushup, deps-upgrade, sdlc finish step 8f and spec execute step 6 call batch-open without a marker unless the human passed --ext
- inbox-cleanup: Proton runs locally through a pw-managed signed-in profile (slice 3); --ext keeps the extension path; Gmail and Outlook are local; the skill and providers.md say so
- Repo test ext-opt-in.spec.ts: no requires: [extension]; require-extension only on a line that also names --ext; chat, demo and overwatch on a PENDING_LOCAL_MODE allowlist
- docs: install.md skills table, AGENT-INSTALL.md, browser.md, skills README; ADR 0028
### Excluded
- The demo local player (bundle 015_demo_local_player)
- Local chat and overwatch pages served by dg-daemon (bundle 016_local_chat_overwatch_pages)
- Removing the extension, its install command or the daemon pairing flow
- Changing the _tab_group, _demo or _proto marker formats

### Slice 1 — ext-flag-and-guard

#### Engineering
- [ ] utils/ext-flag.ts: export const EXT_FLAG = '--ext'; export function hasExtFlag(argv: string[]): boolean (true when argv contains '--ext' before any '--' separator); export function addExtOption(command: Command): Command adds .option('--ext', 'use the dg-ai-extension instead of the local default')
- [ ] utils/cli-only.ts: EXTENSION_COMMANDS becomes EXT_ONLY_COMMANDS = ['launch']; guardExtensionCommands trips when the top-level name is in EXT_ONLY_COMMANDS, or when the invoked command's parsed opts.ext is true (read from action.opts() in the preAction hook); assertExtensionInstalled and extensionRequiredMessage are unchanged
- [ ] commands/batch-open.ts: addExtOption; without --ext each ref opens with tryOpen(resolveRef(...)) and no marker, the summary line is `<n> tab(s) opened`; with --ext today's addGroupMarker path runs unchanged with the `dg-ai-extension will group them into "<group>"` line; --group or --print without --ext prints one stderr line `batch-open: --group needs --ext; opening plain tabs` and continues (--print prints the plain URLs)
- [ ] commands/launch.ts: addExtOption; without --ext the action prints `launch: an extension-only command; add --ext (dg-skills launch --ext ...)` to stderr and returns 1 before detecting browsers; with --ext behavior is unchanged
- [ ] commands/rerun.ts: addExtOption; the flag is passed to playScript as opts.ext; without --ext this PR keeps today's extension behavior and prints one stderr notice `rerun: the extension flow now takes --ext; the local player replaces this default in the next release` (bundle 015 replaces the default)
- [ ] commands/demo.ts: addExtOption on the play path only (--verify keeps its current behavior); without --ext today's extension behavior runs with the same one-line notice as rerun; demo/SKILL.md is untouched here (bundle 015 owns it); register-all.ts needs no change because the commands keep their names
- [ ] doctor/checks.ts: export function extOnly(check: DoctorCheck): DoctorCheck wraps a check so a fail or warn on a CLI-only install becomes info with the message prefixed `--ext only: `; export const extOnlyChecks = extensionChecks.map(extOnly)
- [ ] batch-open/doctor.ts: replace ...extensionChecks with ...extOnlyChecks; launch, demo, rerun and require-extension doctor lists stay on extensionChecks in this PR because their defaults still run through the extension this release (015 relabels demo and rerun, 016 relabels require-extension)
- [ ] cli-only.spec.ts: only the EXTENSION_COMMANDS assertion changes in this slice (EXT_ONLY_COMMANDS equals ['launch']); the requires-list assertion is updated in slice 2 together with the browser SKILL.md rewrite, so this slice leaves the suite green

#### Testing Criteria
##### Contracts
- [ ] Contract: hasExtFlag(['batch-open', '--ext', 'x']) is true; hasExtFlag(['batch-open', '--', '--ext']) is false; hasExtFlag([]) is false
- [ ] Contract: on a CLI-only install, `batch-open https://a` opens one plain tab and exits 0; `batch-open --ext https://a` throws extensionRequiredMessage('dg-skills batch-open')
- [ ] Contract: `batch-open --print https://a https://b` prints two unmarked URLs and the stderr line about --group only when --group was passed
- [ ] Contract: `batch-open --ext --print --group R https://a` prints a URL whose fragment contains _tab_group=R, _tab_group_pos=0 and _tab_group_batch=
- [ ] Contract: `launch` without --ext returns 1 and prints the extension-only line; `launch --ext --list` reaches detectBrowsers (seam) on a full install
- [ ] Contract: extOnly(cliOnlyCheck) on a CLI-only home returns level info with a message starting `--ext only: `; on a full install it returns the wrapped check's result unchanged
- [ ] doctor-ext-only.spec.ts: `dg-skills doctor batch-open` exits 0 on a CLI-only home and prints the info lines; `dg-skills doctor launch` still fails on a CLI-only home
- [ ] cli-only.spec.ts: EXT_ONLY_COMMANDS equals ['launch'] (this slice); the requires-list assertion is untouched here
- [ ] doctor-coverage.spec.ts still passes: every registered command keeps an allow-rule check

#### Acceptance Criteria
- [ ] Given a CLI-only install, when an agent runs `dg-skills batch-open <pr-url>`, then the PR opens in the default browser with no fragment marker and the command exits 0
- [ ] Given a full install with the extension loaded, when the human runs `dg-skills batch-open --ext --group Reviews <url>`, then the tab lands in the Reviews group exactly as today
- [ ] Given any install, when `dg-skills launch <url>` runs without --ext, then it exits 1 with the one-line hint and starts no browser

### Slice 2 — skills-callers-lint-docs

#### Engineering
- [ ] browser/SKILL.md: remove `requires: [extension]`; description leads with `Open PR or URL tabs in the default browser (local mode, the default)` and names --ext after it; add a `## Flags` table with 4 columns (Flag, Short, Effect, Default) including a `--ext` row whose Default cell is `off (local is the default)`; `batch-open` is documented as plain tabs by default, grouped with --ext; `launch` and `install` are documented under `## --ext mode` with one sentence each and a pointer to references/extension.md; the first-run block stays the generated one
- [ ] browser/references/extension.md (new): today's extension content moved out of SKILL.md: install [chrome|firefox] [--local] [--version], launch, marker mechanics, group color, the Load-unpacked steps pointer; install.md keeps the per-OS detail
- [ ] pushup/SKILL.md step 6: `dg-skills batch-open <url>` (plain tab); add `--ext` to the pushup flags: `/dg:pushup --ext` runs `dg-skills batch-open --ext --group pr <url>`; the fallback sentence (print the URL and continue) is unchanged
- [ ] deps-upgrade/references/steps.md step 10: `dg-skills batch-open <pr-url>`; a `--ext` passthrough line: with --ext, `--ext --group Deps`; the sentence `grouping needs the dg-ai-extension loaded` moves under the --ext line
- [ ] sdlc/references/finish.md step 8f and spec/references/execute.md step 6 plus its GATE line: `dg-skills batch-open <url>` with no --group; the parenthetical about the CLI-only install changes to `when batch-open fails, print the URL and continue`; spec/SKILL.md line 92 wording follows
- [ ] inbox-cleanup/SKILL.md and references/providers.md: the Proton paragraph says Proton runs through a pw-managed profile by default and through the extension with --ext (slice 3 owns the final wording); Gmail and Outlook are stated as local; the gate line reads `--ext only: dg-skills require-extension inbox-cleanup || exit 1` so the lint rule (require-extension and --ext on the same line) holds
- [ ] ext-opt-in.spec.ts (model: skill-cli-invocation.spec.ts and proto-skill.spec.ts): rule A: no plugins/dg/skills/*/SKILL.md matches /^requires:.*extension/m except names in PENDING_LOCAL_MODE = ['chat', 'demo', 'overwatch']; rule B: every line in plugins/dg/skills/**/*.md that invokes the gate (matches /dg-skills require-extension\b/) also contains `--ext`; the generated doctor line (`If a step fails, run ... doctor require-extension ...`) does not match the invocation form and is not an offender; rule C: for FLAG_TABLE_SKILLS = ['browser', 'proto', 'demo', 'chat', 'overwatch'] minus PENDING_LOCAL_MODE, SKILL.md has a Flags table row whose first cell contains `--ext` and whose Default cell matches /off \(local is the default\)/; pushup and inbox-cleanup document --ext in prose and are not in that list
- [ ] cli-only.spec.ts: the requires-list assertion becomes ['chat', 'demo', 'overwatch'] in this slice, with the browser rewrite
- [ ] browser-skill.spec.ts: description leads with local mode before --ext; no requires line; the Flags table has rows for --ext, --group, --repo, --print, --browser, --list, --dry-run, --local, --version with short forms; the batch-open sentence says plain tabs by default
- [ ] installed-skill-files.ts: add browser/references/extension.md
- [ ] docs/install.md row 143 becomes two rows: `browser`, `proto`, `demo` (local default; --ext needs the extension) and `chat`, `overwatch` (still require the extension until the local pages bundle); docs/AGENT-INSTALL.md lines 73-79 and the table row at 329 say batch-open and rerun need the extension only with --ext and launch is --ext-only; docs/browser.md paragraph at line 40 says grouping is opt-in per batch with --ext; skills README rows for browser and demo lead with the local behavior
- [ ] ADR 0028 local default, extension opt-in: context (four skills required the extension; agents on CLI-only installs hit a wall on every PR open), decision (every skill runs locally by default; --ext is the only switch; the CLI guard and doctor follow the flag; a repo test enforces it), consequences (chat, demo and overwatch keep a named allowlist until bundles 015 and 016; no marker without --ext), with repository-relative links to ext-flag.ts and ext-opt-in.spec.ts; toc entry

#### Testing Criteria
##### Contracts
- [ ] ext-opt-in.spec.ts rule A: offenders list is empty for every SKILL.md outside PENDING_LOCAL_MODE; a fixture SKILL.md with `requires: [extension]` is reported with its path
- [ ] ext-opt-in.spec.ts rule B: a fixture line `dg-skills require-extension chat || exit 1` without --ext on the line is reported; the same line prefixed `--ext only:` passes; the doctor line `If a step fails, run dg-skills doctor require-extension install.` passes
- [ ] ext-opt-in.spec.ts rule C: browser/SKILL.md and proto/SKILL.md have the --ext row with the local default cell; demo, chat and overwatch are skipped while on PENDING_LOCAL_MODE
- [ ] browser-skill.spec.ts: the nine flag rows exist with 4 cells each; description index of `local` is lower than the index of `--ext`; no `requires:` line
- [ ] skill-cli-invocation.spec.ts and skill-manifests.spec.ts still pass for the rewritten browser skill
- [ ] installed-skill-files.ts lists browser/references/extension.md and the skills-only install copies it
- [ ] Doc grep gate in ext-opt-in.spec.ts: pushup, deps-upgrade steps, sdlc finish and spec execute contain `batch-open` only in a form with no `--group` unless `--ext` is on the same line

#### Acceptance Criteria
- [ ] Given a fresh skills-only install on Codex, when the agent reads the browser skill, then the first paragraph says plain tabs open without the extension and --ext is the opt-in
- [ ] Given the repo, when `bun test pkg/skills-test` runs, then ext-opt-in.spec.ts passes with chat, demo and overwatch as the only allowlisted skills
- [ ] Given docs/adr/toc.md, when a reader opens it, then 0028 is listed as Accepted with a one-line summary

### Slice 3 — proton-pw-profile

#### Engineering
- [ ] protonmail/page-operations.ts (pkg/inbox): the in-page Proton operations from pkg/extension/lib/features/inbox-proton.ts move here, taking a ProtonPageContext (origin, session headers, fetch, timeout, pace). The extension feature imports them, so both paths run one implementation.
- [ ] protonmail/pw-client.ts: a browserRequest that runs those operations inside a pw-managed page. It opens the pw session `inbox-proton` with a persistent profile under <dataDir>/inbox/proton-profile, waits for a signed-in mail.proton.me page, captures the session headers from the page's own requests, and runs each operation through page.evaluate. Cookies stay in that profile and never leave it.
- [ ] client.ts and runtime.ts: Proton uses the pw transport by default and the extension transport only with --ext. Gmail and Outlook are unchanged.
- [ ] commands/inbox.ts and inbox/proton-pw.ts: `dg-skills inbox proton sign-in` opens the profile once for the human to sign in (on WSL the Windows browser through pw open; never a headed browser inside WSL), then closes it. Other inbox commands run the profile headless and exit 4 with the sign-in command when the session is signed out.
- [ ] inbox/doctor.ts: one line reports the Proton transport (pw profile or --ext) and whether the profile is signed in, read from a marker file, never by launching a browser.
- [ ] inbox-cleanup/SKILL.md, references/providers.md, docs/inbox-cleanup.md: Proton is local through the pw profile; the agent asks before running sign-in; --ext keeps the extension path.

#### Testing Criteria
##### Contracts
- [ ] Contract: page-operations.ts returns the same results as today's extension feature for list, move and filter operations against the recorded Proton dataset fixture.
- [ ] Contract: pw-client.ts sends each request through an injected page seam and never imports playwright-core statically.
- [ ] Contract: with no --ext, the Proton provider selects the pw transport; with --ext it selects the extension transport.
- [ ] Contract: a signed-out profile makes inbox commands exit 4 and name `dg-skills inbox proton sign-in`.
- [ ] Contract: doctor reads the sign-in marker and never starts a browser.

#### Acceptance Criteria
- [ ] Given a human signed in once through `dg-skills inbox proton sign-in`, when inbox-cleanup runs without --ext, then Proton operations run through the pw profile and the daily browser is untouched.
- [ ] Given --ext, when inbox-cleanup runs, then Proton uses the extension exactly as today.

## Slice Summaries

## Agent Notes

- (slice 3, orchestrator) Slice 3 is committed as 2e98ae0e. Without a literal `--provider protonmail`, the provider comes from the daemon profile, so the early marker check runs only with the flag; otherwise assertProtonSignedIn runs at the top of pwBrowserRequest, after the daemon profile lookup and before any browser starts. The marker records profile windows or local. The public pw entry refuses cookie, state-save and request-header commands for the inbox-proton session.

- (slice 3, orchestrator) Accepted: headers come from `pw network --request-headers --filter /api/` (x-pm-uid, x-pm-appversion, x-pm-locale only, never cookies), polled up to 10 s; on WSL the Proton profile lives on the Windows side through pw --windows while the marker stays under dataDir, and there is no headed-WSL fallback; without --provider the marker check runs inside pwBrowserRequest and an expired session deletes the marker. The real sign-in path needs one human run of `dg-skills inbox proton sign-in` on WSL and on a non-WSL host; list it in the PR body as a manual check.

- (slice 3, orchestrator) Accept the Red-stage names: page-operations.ts exports executeProtonPage, redactInboxText, sanitizeInboxBrowserResponse and ProtonPageContext; the extension re-exports the same objects. createPwBrowserRequest({ dataDir, openSession }) returns { browserRequest, close }; openSession gets { name: 'inbox-proton', profileDir, headless: true }. observedHeaders() is fed by a page request listener that records only the Proton uid and app-version headers the extension reads today, never cookies. A non-mail.proton.me URL rejects with ProtonSignedOutError (exitCode 4, names `dg-skills inbox proton sign-in`).
- (slice 3, orchestrator) InboxRuntime gains ext?: boolean and pwBrowserRequest?. Without --ext Proton uses the pw transport; with --ext it uses the extension browserRequest. dataDir is resolveDgPaths().stateDir until F; protonProfilePaths(dataDir) returns { profileDir, markerPath }.
- (slice 3, orchestrator) The signed-out marker check runs before any daemon connect or browser start; --ext skips it; Gmail and Outlook never exit 4. protonTransportCheck reports warn when signed out (detail names pw profile, --ext and signed out; fix names the sign-in command) and ok when signed in. The doctor-never-launches test also asserts doctor.ts has no static or dynamic import of node:child_process, playwright-core or pw/core/launch.

- (slice 2, orchestrator) PRs #112, #113 and #114 merged. G1 is rebased onto 594b79f3: slice 1 is 52464c4d, slice 2 is c8cfaec2. batch-open uses newBatchId() from @dg/common only with --ext. pw is on master, so slice 3 can build: its names are pickLaunch in pw/core/browser.ts, wslPlan in pw/commands/open/run.ts, installBrowser in pw/browsers.ts.

- (slice 2, orchestrator) Accepted: the inbox-cleanup doctor line names require-extension; the browser skill keeps demo --ext and rerun --ext under `## --ext mode`, and docs say demo needs the extension until bundle 015 (which updates install.md and the skills README); pushup frontmatter says plain tab by default. ADR 0028 is Accepted under a new `## Skills` toc section.

- (slice 2, orchestrator) chat and overwatch stay exempt from rule B (PENDING_LOCAL_MODE) until bundles 015 and 016 make them local. browser-skill.spec.ts is new in pkg/skills-test and its shapes are the contract: a `## --ext mode` heading, --ext first in its Flags row, and one SKILL.md line with both `batch-open` and `plain tabs`.

- (slice 1, orchestrator) Slice 1 is committed as 1ba48fde. On a CLI-only install, demo and rerun without --ext exit 1 with a one-line notice until bundle 015 lands the local player. hasExtFlag was removed (no caller). info is a doctor status with no exit-code effect.

- (slice 1, orchestrator) Accepted: batch-open and launch-ext assert the extensionRequiredMessage prefix with toStartWith, because the full text depends on the sandboxed home. The CLI-only batch-open daemon check is now info with the `--ext only: ` prefix and no fix.

- (slice 1, orchestrator) Add `info` to CheckStatus, the report types, STATUS_ICON, the counts line and the doctor-command.spec.ts STATUSES list. The extOnly result uses `detail` starting `--ext only: `. info never changes the exit code.
- (slice 1, orchestrator) 'doctor launch still fails on a CLI-only home' means its checks are not downgraded to info, carry no `--ext only:` prefix, and at least one is non-ok. It does not require a non-zero exit.
- (slice 1, orchestrator) On a CLI-only install the guard's extensionRequiredMessage wins for launch; the one-line --ext hint is asserted on a full install. The launch refusal sets process.exitCode = 1 and returns.
- (slice 1, orchestrator) Add an injectable seam for playScript/open in demo and rerun, and test the interim notice and the --ext option through it in the Green stage.
- (slice 1, orchestrator) The coverage criterion refers to pkg/skills-test/__tests__/doctor-coverage.spec.ts, which exists on master; keep it passing.

- (build base, orchestrator) G1 builds from origin/master ahead of the install work (E, F, B, D). Command actions live in pkg/skills-cli/src/commands/<name>.ts on master (batch-open, launch, rerun, demo, inbox); the spec paths are updated to match. Register through the existing commander registration on master (registerRawCommand from utils/legacy-command.ts where a raw command is needed); there is no registerLazyRaw, DgPaths, exitAfterDrain, per-OS config dir or dg.js bundle yet, so use selfCommand from pkg/common/src/node/self-command.ts, the state dir from pkg/common/src/node/paths.ts, and master exit conventions.
- (build base, orchestrator) PR A (pw, #113) and PR C (hooks, #114) may merge before G1. Slice 2 edits plugins/dg/skills/README.md, docs/install.md and docs/adr/toc.md, which A and C also edit: rebase onto origin/master before the review loop. Slice 3 uses the pw session and profile API from #113 and builds only after #113 merges. ADR numbers: E holds 0025, C holds 0026; this bundle keeps 0028.
- (build base, orchestrator) The Chain position section is superseded: G1 follows A and C, not E, F, B or D.
- (security, orchestrator) An EDR alert (T1068) fired on this machine. Tests never start powershell.exe, cmd.exe, a Windows browser or a remote-debugging port, never put stub programs on PATH, and use injected seams (open, spawn, page). Write files with an atomic rename. Never launch a headed browser inside WSL; Proton sign-in on WSL uses the Windows browser through pw. Real browser checks run only behind PW_E2E=1.

- (ratified, orchestrator) Proton Mail in inbox-cleanup gets a Playwright-managed signed-in profile under dataDir, run through pw (user chose the pw profile path in this stack). It builds after PR A (009) merges.
- (ratified, orchestrator) Build order: the install work (007, 008, 010, and the install flag of 012) moves to the end of the chain. G1 builds from master after A.

## Issues Remediation
## Decisions

- [DECIDED] `--ext` is the one switch, spelled as `/dg:proto` already spells it. `hasExtFlag` and `addExtOption` live in `pkg/skills-cli/src/utils/ext-flag.ts`; proto keeps its own `dispatchProto` strip (raw command, already shipped), nothing else parses the flag by hand.
- [DECIDED] `batch-open --group` without `--ext` is not an error: one stderr line, then plain tabs. Every caller treats batch-open as best-effort, so a hard failure would only print a URL the caller prints anyway.
- [DECIDED] `launch` is an `--ext`-only verb. It exists to cold-start a browser with `--load-extension`; there is no local meaning. The refusal line copies proto's `EXTENSION_VERBS` message shape.
- [DECIDED] `demo` and `rerun` without `--ext` keep today's extension behavior in this PR and print one stderr notice (`demo: the extension flow now takes --ext; the local player replaces this default in the next release`). Rejected: refusing without `--ext`, which would break `/dg:demo` for one release if 014 ships before 015.
- [DECIDED] chat, overwatch and demo keep `requires: [extension]` until their local modes land (016 and 015). The lint test names them in `PENDING_LOCAL_MODE = ["chat", "demo", "overwatch"]`; 015 removes demo, 016 removes the rest. A named, temporary exception, not a hidden one.
- [SUPERSEDED by the next line] inbox-cleanup: Proton needs `--ext`; Gmail and Outlook are local today (daemon-only OAuth storage, no extension). The skill drops the implicit "use the extension" sentence for a `--ext only:` line.
- [DECIDED] Proton gets a pw-managed signed-in profile in this stack, after PR A. See Agent Notes.
- [DECIDED] The CLI-only guard trips on `opts.ext` or on an `EXT_ONLY_COMMANDS` name. Rejected: scanning `process.argv` for `--ext`, which would also trip on `dg-skills jot "--ext"`.

## Measured facts (origin/master v1.26.0)

- `requires: [extension]`: browser, chat, demo, overwatch (`cli-only.spec.ts` asserts exactly that list). `require-extension` callers: chat and overwatch SKILL.md, docs/AGENT-INSTALL.md.
- `EXTENSION_COMMANDS = ["batch-open", "launch", "demo", "rerun"]` in `pkg/skills-cli/src/utils/cli-only.ts`; `guardExtensionCommands` is a commander `preAction` hook keyed on the top-level command name only.
- `batch-open` callers outside the browser skill: `pushup/SKILL.md` step 6, `deps-upgrade/references/steps.md:154`, `sdlc/references/finish.md:57` (step 8f), `spec/references/execute.md:110` and its GATE line, `spec/SKILL.md:92`. Each already says "on failure, print the URL and continue".
- Docs that state the extension rule: `docs/install.md:143`, `docs/AGENT-INSTALL.md:73-79` and the table row at 329, `docs/browser.md:40`, `plugins/dg/skills/README.md:10-15, 25`.
- Among Codex agent manifests only `proto/agents/openai.yaml` mentions `--ext`.
- `extensionChecks = [cliOnlyCheck, unlessCliOnly(daemonCheck), unlessCliOnly(pairingCheck)]` is spread into the demo, batch-open, launch, rerun and require-extension doctor lists.

## Code Structure

```text
pkg/skills-cli/src/utils/ext-flag.ts                 EXT_FLAG, hasExtFlag(argv), addExtOption(command)
pkg/skills-cli/src/utils/cli-only.ts                 EXT_ONLY_COMMANDS = ["launch"]; guard reads opts.ext
pkg/skills-cli/src/commands/batch-open.ts                 plain tabs by default; marker path behind --ext
pkg/skills-cli/src/commands/launch.ts                     refuses without --ext
pkg/skills-cli/src/commands/rerun.ts                      --ext option; interim notice without it
pkg/skills-cli/src/commands/demo.ts                       --ext option on the play path; interim notice without it
pkg/skills-cli/src/doctor/checks.ts                  extOnly(check), extOnlyChecks
pkg/skills-cli/src/batch-open/doctor.ts              ...extOnlyChecks (demo, rerun and require-extension follow in 015 and 016)
pkg/skills-cli/__tests__/ext-flag.spec.ts            flag parsing
pkg/skills-cli/__tests__/batch-open.spec.ts          plain vs marked URLs, stderr line
pkg/skills-cli/__tests__/doctor-ext-only.spec.ts     info on CLI-only homes
pkg/skills-cli/__tests__/cli-only.spec.ts            updated exact lists
plugins/dg/skills/browser/SKILL.md                   local default, Flags table, --ext section (about 70 lines)
plugins/dg/skills/browser/references/extension.md    install, launch, markers, group color (moved text)
plugins/dg/skills/pushup/SKILL.md                    step 6 plain batch-open; --ext passthrough
plugins/dg/skills/deps-upgrade/references/steps.md   step 10 plain batch-open; --ext line
plugins/dg/skills/sdlc/references/finish.md          step 8f plain batch-open
plugins/dg/skills/spec/references/execute.md         step 6 and GATE wording
plugins/dg/skills/spec/SKILL.md                      line 92 wording
plugins/dg/skills/inbox-cleanup/SKILL.md             Proton local through a pw profile; --ext keeps the extension
plugins/dg/skills/inbox-cleanup/references/providers.md   --ext only gate line
plugins/dg/skills/README.md                          browser and demo rows
pkg/skills-test/__tests__/ext-opt-in.spec.ts         rules A, B, C and the caller grep gate
pkg/skills-test/__tests__/browser-skill.spec.ts      flags table and description order
pkg/common/__tests__/installed-skill-files.ts        + browser/references/extension.md
docs/install.md, docs/AGENT-INSTALL.md, docs/browser.md
docs/adr/0028-local-default-extension-opt-in.md, docs/adr/toc.md
```

Paths follow E slice 1's `src/<feature>/cli.ts` layout. If a feature still sits in `src/commands/<name>.ts` at rebase time, edit that file instead; the names are the only thing this bundle depends on.

## Code sample: `dg-skills batch-open <url>` end to end

```ts
// pkg/skills-cli/src/utils/ext-flag.ts
import type { Command } from "commander";

export const EXT_FLAG = "--ext";

export function hasExtFlag(argv: string[]): boolean {
 const end = argv.indexOf("--");
 return (end < 0 ? argv : argv.slice(0, end)).includes(EXT_FLAG);
}

export function addExtOption(command: Command): Command {
 return command.option(EXT_FLAG, "use the dg-ai-extension instead of the local default");
}
```

```ts
// pkg/skills-cli/src/utils/cli-only.ts (guard excerpt)
export const EXT_ONLY_COMMANDS = ["launch"];

export function guardExtensionCommands(program: Command): void {
 program.hook("preAction", (_program, action) => {
  const name = topLevelName(action);
  const wantsExt = EXT_ONLY_COMMANDS.includes(name) || action.opts().ext === true;
  if (wantsExt) assertExtensionInstalled(`dg-skills ${name}`);
 });
}
```

```ts
// pkg/skills-cli/src/commands/batch-open.ts
type Opts = { repo?: string; group?: string; print?: boolean; ext?: boolean };

export function registerBatchOpen(program: Command): void {
 addExtOption(
  program
   .command("batch-open")
   .description("open PRs or URLs in the default browser; --ext groups them through the dg-ai-extension")
   .argument("<refs...>", "URL | owner/repo#num | alias#num | bare num")
   .option("-R, --repo <owner/repo>", "default repo for bare PR numbers")
   .option("-g, --group <name>", "tab group name (needs --ext)")
   .option("--print", "print the URLs instead of opening them"),
 ).action(async (refs: string[], opts: Opts) => {
  const cfg = loadConfig();
  const plain = refs.map((r) => resolveRef(r, cfg, opts.repo));
  if (!opts.ext && opts.group) {
   process.stderr.write("batch-open: --group needs --ext; opening plain tabs\n");
  }
  const urls = opts.ext ? markGroup(plain, opts.group ?? "PRs") : plain;
  if (opts.print) {
   for (const u of urls) console.log(u);
   return;
  }
  for (const url of urls) console.log(`${(await tryOpen(url)) ? "opened" : "FAILED"}: ${url}`);
  console.log(
   opts.ext
    ? `\n${urls.length} tab(s) requested; dg-ai-extension will group them into "${opts.group ?? "PRs"}".`
    : `\n${urls.length} tab(s) opened`,
  );
 });
}

function markGroup(urls: string[], group: string): string[] {
 const batch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
 return urls.map((u, i) => addGroupMarker(u, group, i, batch));
}
```

```ts
// pkg/skills-test/__tests__/ext-opt-in.spec.ts (rules)
const PENDING_LOCAL_MODE = new Set(["chat", "demo", "overwatch"]);

test("no shipped skill requires the extension", () => {
 const offenders = skillDirs().filter(
  (name) => !PENDING_LOCAL_MODE.has(name) && /^requires:.*extension/m.test(skillFile(name)),
 );
 expect(offenders).toEqual([]);
});

test("require-extension appears only on an --ext line", () => {
 const offenders = markdownFiles(SKILLS_DIR).flatMap(({ name, text }) =>
  text.split("\n").filter((line) => /dg-skills require-extension\b/.test(line) && !line.includes("--ext")).map((line) => `${name}: ${line.trim()}`),
 );
 expect(offenders).toEqual([]);
});
```

The browser skill's `--ext` section reads: `--ext only: dg-skills batch-open --ext --group <name> <refs>` groups the tabs; `dg-skills launch --ext ...` cold-starts a Chromium browser with the extension; `install` stages the extension (see references/extension.md).

## Size, speed and token impact

- Size: one new 20-line helper; no dependency change; the bundle grows by under 2 KB.
- Speed: `--help` and hot paths unchanged; the guard reads parsed options it already had. `batch-open` without `--ext` skips marker generation (no measurable change).
- Tokens: browser SKILL.md shrinks from 118 lines to about 70 by moving install, launch and marker text to references/extension.md, read only when `--ext` is in play. Each batch-open caller loses one clause. The default `batch-open` summary is one line.

## Risks

- A caller that relied on grouping without passing `--ext` loses the group silently except for the stderr line. Signal: the deps-upgrade summary no longer says "grouped into Deps". Accepted; the PR body names it.
- `cli-only.spec.ts` carries two exact lists; slice 1 changes only the command list and slice 2 changes the requires list with the browser rewrite, so each slice leaves the suite green.
- `opts.ext` on a nested subcommand: commander `action.opts()` returns the leaf command's options, so a future `demo <verb> --ext` still trips the guard. Covered by the nested test.

## ADR 0028 draft: Local default, extension opt-in

Status: Proposed. Context: four skills declared `requires: [extension]` and every PR-opening flow called `batch-open`, which the CLI-only guard refuses; agents on CLI-only installs hit that wall on every PR, and /dg:proto had already moved to a local default with `--ext`. Decision: every dg skill runs without the dg-ai-extension unless the caller passes `--ext`; `--ext` is the only switch; the CLI guard and doctor follow the flag; a repo test enforces no `requires: [extension]` and no `require-extension` outside an `--ext` line. Consequences: tab grouping, side-loaded launch and the extension's tour, chat and board pages are opt-in; chat, demo and overwatch keep a named allowlist until bundles 015 and 016 land; skill documents put `--ext` material in references/extension.md. Links: `pkg/skills-cli/src/utils/ext-flag.ts`, `pkg/skills-test/__tests__/ext-opt-in.spec.ts`, `plugins/dg/skills/proto/SKILL.md`. Diagram: a flowchart `caller -> hasExtFlag? -> plain tryOpen | marker + extension`. Numbering assumes ADRs 0024 to 0027 from bundles 007, 008, 011 and 012 land first.

## Open questions

- RATIFIED (see Agent Notes): inbox-cleanup Proton Mail without the extension — keep Proton `--ext`-only and say so (zero new code) vs a Playwright-managed signed-in profile under dataDir that runs the same fixed operations through pw (new code, the human signs in once in that profile, cookies live outside their daily browser) vs drop Proton — recommend `--ext`-only now; the pw profile path is a separate PR after 009 lands, if wanted.

## Chain position

- Branch `feat/ext-opt-in-convention`. Last layer of the previous stack: after E and F (both own `pkg/skills-cli/src/utils/cli-only.ts` and `doctor/checks.ts`, and F slice 4 regenerates the first-run block in every SKILL.md this bundle edits), after A (009 slice 2 owns `plugins/dg/skills/README.md` and `docs/install.md`), after B (010 owns `docs/install.md`), after C (011 slice 3 owns the skills README and `docs/adr/toc.md`) and after D (012 slices 2 and 3 own `doctor/checks.ts`, `installed-skill-files.ts`, `docs/install.md`, `docs/AGENT-INSTALL.md`, `docs/adr/toc.md`, the skills README). Chaining it after D costs nothing: every overlap is a one-hunk rebase otherwise.
- 015 (demo local player) and 016 (local chat and overwatch pages) both depend on this bundle.
