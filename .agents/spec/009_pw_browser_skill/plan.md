---
feature: "pw browser skill in the plugin"
feature_snake_case: pw_browser_skill
date: "2026-10-29"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "pw-core-port"
    agents:
      primary: dg:js
      qa: [dg:qa-code, dg:security]
    depends_on: []
    files: ["pkg/skills-cli/src/pw/core/**","pkg/skills-cli/src/pw/commands/**","pkg/skills-cli/src/pw/code/**","pkg/skills-cli/src/pw/daemon.ts","pkg/skills-cli/src/pw/cli.ts","pkg/skills-cli/src/pw/code-cli.ts","pkg/skills-cli/src/pw/browsers.ts","pkg/skills-cli/src/pw/test-support.ts","pkg/skills-cli/src/commands/pw.ts","pkg/skills-cli/src/commands/pw-code.ts","pkg/skills-cli/src/index.ts","pkg/skills-cli/__tests__/pw/**","pkg/launcher/__tests__/size-budget.spec.ts"]
  - id: 2
    name: "pw-skill-doctor-docs"
    agents:
      primary: dg:js
      qa: [dg:lore]
    depends_on: [1]
    files: ["plugins/dg/skills/pw/**","plugins/dg/skills/README.md","pkg/skills-cli/src/pw/doctor.ts","pkg/skills-cli/src/doctor/registry.ts","pkg/skills-cli/__tests__/pw-skill-tree.spec.ts","pkg/skills-test/__tests__/pw-skill.spec.ts","docs/pw.md","README.md","docs/install.md"]
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# pw browser skill in the plugin

## Purpose
Port the pw browser CLI (Bun daemon per session on playwright-core) into the dg plugin as `dg-skills pw` and `dg-skills pw-code`, with the skill at plugins/dg/skills/pw. It ships to every plugin user as a lazy chunk that costs nothing until called, uses the system Chrome or Edge first, offers `dg-skills pw install-browser` when none exists, and inside WSL drives the Windows-side browser by default, opening a headed browser inside WSL only with an explicit flag.

## Scope
### Included
- Port of ~/scripts/ai/skills/pw src (core, commands, code, daemon, cli) and its 93 test files into pkg/skills-cli/src/pw and __tests__/pw
- Registration as lazy commands `pw` and `pw-code`; daemon runs as `dg-skills pw __daemon <spec>` from the same bundle
- Storage through the shared scratch-paths helpers (same paths as today: <scratch>/pw/{sessions,sock,log,<cwd-hash>}, <state>/pw/states)
- install-browser command that downloads Chromium under the dg data dir; doctor item reporting browser status
- WSL rule: Windows mode by default (Windows Chrome, then Edge, over CDP), then headless Chromium inside WSL, then the install-browser message; `--wsl-headed` is the explicit opt-in for a headed browser inside WSL
- SKILL.md plus references, doctor items for pw and pw-code, docs, removal list for the local ~/scripts copy
### Excluded
- New browser features beyond the current pw command set
- Firefox or WebKit downloads through install-browser (Chromium only)
- Windows-native or macOS session liveness beyond pid checks (Linux and WSL are the tested hosts)

### Slice 1 — pw-core-port

#### Engineering
- [ ] Copy src/core, src/commands, src/code, daemon.ts, cli.ts, code-cli.ts, test-support.ts from ~/scripts/ai/skills/pw into pkg/skills-cli/src/pw; drop .ts import extensions; replace ../../../../lib/fs.ts with @dg/common/node scratch-paths (scratchRoot, stateRoot, cwdHash) and lib/platform.ts with isWSL from @dg/common/node
- [ ] core/registry.ts: runtimeDir uses scratchDir('pw', {cwdScope:false}) + kind; defaultOutputDir uses scratchDir('pw'); DAEMON_PATTERN becomes /dg\.js dg-skills pw __daemon |skills-cli\/src\/index\.ts pw __daemon /; isDaemonOf falls back to isAlive when /proc is absent
- [ ] core/states.ts statesDir uses stateDir('pw', {cwdScope:false}) + 'states'
- [ ] core/daemon-command.ts returns selfCommand(['pw','__daemon']) and drops PW_ROOT and BUNDLED_DAEMON
- [ ] core/browser.ts: launch picks channel chrome, then msedge, then the downloaded Chromium under browsersDir when no --browser is given; a missing browser throws BrowserMissingError whose message is 'No browser found. Ask the user, then run: dg-skills pw install-browser (downloads about 150 MB)' and exits 3
- [ ] open/run.ts: on WSL with none of --browser, --windows or --wsl-headed, `wslPlan` picks Windows mode when a Windows Chrome or Edge exists (the existing openWindows path; headed is allowed because the window is on Windows), else a local headless launch through pickLaunch; `--wsl-headed` launches headed inside WSL and prints `experimental: headed browser inside WSL (WSLg)` once
- [ ] pw/browsers.ts: installBrowser() runs playwright-core's registry install for chromium with PLAYWRIGHT_BROWSERS_PATH=<dataDir>/browsers; browserStatus() reports {system: chrome|msedge|none, downloaded: version|none}
- [ ] cli.ts main(argv): adds the hidden `__daemon <json>` route and `install-browser`; pw --help lists install-browser under core
- [ ] commands/pw.ts and commands/pw-code.ts register raw lazy commands; pw-code forwards method 'code' and stays a separate top-level command so Bash(dg-skills pw:*) never covers it
- [ ] Port all 93 test files to pkg/skills-cli/__tests__/pw/** on bun:test; e2e smoke runs only when PW_E2E=1

#### Testing Criteria
##### Contracts
- [ ] Contract: `dg-skills pw` with no command exits 2 and prints the index help; `dg-skills pw --help` exits 0
- [ ] Contract: on WSL, `pw open` with a Windows Chrome present records mode:cdp; with no Windows browser it records mode:local and headless:true; `--wsl-headed` records headless:false and prints the experimental line once
- [ ] wsl-plan.spec.ts: wslPlan({}, true) is {mode:'windows'}; wslPlan({}, false) is {mode:'local', headless:true}; wslPlan({'wsl-headed':true}, true) is local, headless:false, with the experimental warning; wslPlan({browser:'chrome'}, true) is local
- [ ] Contract: with no chrome, msedge or downloaded chromium, `pw open` exits 3 with the install-browser message and starts no daemon
- [ ] Contract: daemonCommand() equals selfCommand(['pw','__daemon']) and isDaemonOf accepts a cmdline ending in `dg.js dg-skills pw __daemon {json}`
- [ ] Contract: runtimeDir('sessions') === <scratch>/pw/sessions and statesDir() === <state>/pw/states (unchanged paths)
- [ ] Contract: pw-code is a separate top-level command; `dg-skills pw code` is not a command
- [ ] All ported pw unit tests pass under bun test in pkg/skills-cli
- [ ] size-budget.spec.ts: `dg.js dg-skills stash --help` loads no pw chunk; `dg-skills pw list` loads no playwright chunk; only `pw __daemon` loads playwright-core

#### Acceptance Criteria
- [ ] Given a Linux host with Chrome, when `dg-skills pw open https://example.com` then `pw snapshot` run, then a snapshot file lands under $(dg-skills stash pw)
- [ ] Given WSL with Windows Chrome, when `pw open` runs with no flags, then the Windows browser opens over CDP; given WSL with no Windows browser, then a headless local browser opens, or the install-browser message appears when none is installed
- [ ] Given the built bundle, when `dg-skills pw list` runs with no sessions, then it finishes under 60 ms median on the developer machine

### Slice 2 — pw-skill-doctor-docs

#### Engineering
- [ ] plugins/dg/skills/pw/SKILL.md (<= 90 lines) with the generated first-run block, calling rules, context rules, browser rule (ask before install-browser), WSL rule, security rule for pw-code; references/ copied from ~/.codex/skills/pw/references with pw -> dg-skills pw
- [ ] pw/doctor.ts: pwChecks = [skillFilesCheck(['pw']), browserCheck (ok system chrome|msedge, ok downloaded chromium, warn none with fix `dg-skills pw install-browser`), scratch and state root checks, allowRuleCheck('pw')]; pwCodeChecks = [skillFilesCheck(['pw']), noAllowRuleCheck('pw-code') warning when an allow rule covers pw-code]
- [ ] registry rows pw and pw-code; README skill table row; docs/pw.md with the removal list for ~/scripts users
- [ ] docs/install.md: install-browser location and how doctor removes it (`dg-skills pw install-browser --remove`)

#### Testing Criteria
##### Contracts
- [ ] Contract: doctor pw reports browser status in one line; doctor pw-code warns when Bash(dg-skills pw-code:*) is present
- [ ] pw-skill.spec.ts: SKILL.md names install-browser, the ask-first rule, the WSL rule, the sentence that agents never pass --wsl-headed unless the human asks, and never lists pw-code in allowed-tools
- [ ] doctor-coverage.spec.ts passes for pw and pw-code
- [ ] skill-index-docs lists pw

#### Acceptance Criteria
- [ ] Given an agent reading SKILL.md, when no browser exists, then the text tells it to ask the user before `dg-skills pw install-browser`
- [ ] Given `dg-skills doctor pw`, when Chrome is installed, then the report says `browser: chrome (system)`

## Slice Summaries

## Agent Notes

- (slice 2, orchestrator) Slice 2 is committed. The SKILL.md contract test lives at pkg/skills-cli/__tests__/pw-skill.spec.ts, not pkg/skills-test.

- (slice 2, orchestrator) pw/doctor.ts exports pwChecks, pwCodeChecks and createBrowserCheck(system) returning a DoctorCheck; browserCheck is createBrowserCheck(systemBrowserPresent). Check ids: browser, skill-files, allow-rule, and scratch/state ids for pw; pwCodeChecks is skill-files plus a guard whose id is not allow-rule.
- (slice 2, orchestrator) Detail lines: 'browser: chrome (system)' (chrome preferred), 'browser: msedge (system)', a downloaded browser line naming chromium, its version and 'downloaded'; a missing browser is a warn whose fix names 'dg-skills pw install-browser'. The pw-code guard warns, with a fix, when Bash(dg-skills pw-code:*) or the dg-skills wildcard rule is allowed.
- (slice 2, orchestrator) pw-code joins NO_ALLOW_RULE in doctor-coverage.spec.ts, and SKILL.md carries a `doctor pw pw-code` line. The SKILL.md sentence patterns in pw-skill.spec.ts are the contract. The real-host browser line is checked only for its 'browser: ' prefix; the chrome acceptance check runs through the injected seam.

- (slice 1, orchestrator) Slice 1 is committed. The daemon checks that cwd, outputDir and profileDir are absolute and normalized but does not confine them (the client lets the user pick them); storageState, socketPath and executablePath are confined to pw dirs.
- (slice 1, orchestrator) pw attach and the daemon accept loopback CDP hosts only (127.0.0.1 or [::1]); a remote host exits 2.

- (slice 1, orchestrator) wslPlan(flags, windowsBrowserPresent) lives in src/pw/commands/open/run and returns {mode:"windows"} or {mode:"local", headless, warning?}; warning is "experimental: headed browser inside WSL (WSLg)" and appears only with --wsl-headed. --windows forces {mode:"windows"} whether or not a Windows browser is found, and the existing Windows-mode error path reports a missing browser.
- (slice 1, orchestrator) pickLaunch and BrowserMissingError live in src/pw/core/browser.ts (the Code Structure line naming pw/browsers.ts is superseded). Seam: pickLaunch({ system(channel: "chrome"|"msedge"): boolean, downloaded(): string|null }) returns {channel} or {executablePath}, else throws BrowserMissingError with exitCode 3. pw/browsers.ts keeps browserStatus and installBrowser.
- (slice 1, orchestrator) DAEMON_PATTERN accepts all three forms: bundled `dg.js dg-skills pw __daemon`, source `skills-cli/src/index.ts pw __daemon`, and compiled `dg-skills pw __daemon`. The compiled form is required on master.
- (slice 1, orchestrator) Export names are registerPw (src/commands/pw.ts) and registerPwCode (src/commands/pw-code.ts), following registerJot.
- (slice 1, orchestrator) Seams for the untested contracts: the open handler takes injected deps { windowsBrowserPresent, pickLaunch, startDaemon } with real defaults; readCmdline is injectable so isDaemonOf falls back to isAlive when /proc is absent; installBrowser takes an injected registry-install function so tests never download. The Green stage adds the WSL open-mode tests, the exit-3 no-daemon test, the isDaemonOf fallback test and the browserStatus/installBrowser tests through these seams.
- (slice 1, orchestrator) The chunk-based size-budget test moves to the shared runtime spec (E). On master, lazy-graph.spec.ts (static import closure) is the accepted proxy.
- (slice 1, orchestrator) The Yellow stage ports the existing ~/scripts/ai/skills/pw/src/**/*.test.ts files with the source (drop .ts import extensions, swap lib/fs.ts for @dg/common/node, retarget daemon-command and registry tests to the new constants). test-support.ts keeps exporting useTempEnv and useTempScratch. e2e and benchmark acceptance items stay behind PW_E2E=1 and are not run here.

- (build base, orchestrator) The user moved the install work (E, F, B) to the end of the chain. PR A builds now from origin/master (v1.27.0); E and F rebase onto it later. Map the E/F names in this spec to master: registerLazyRaw -> registerRawCommand from pkg/skills-cli/src/utils/legacy-command.ts, with the pw feature imported only inside the action so `dg-skills --help` never loads playwright-core; selfCommand -> pkg/common/src/node/self-command.ts as it is (compiled: [execPath, "pw", "__daemon"]); DgPaths.browsersDir -> the state dir from pkg/common/src/node/paths.ts (DG_HOME or ~/.dg) plus browsers/chromium; exitAfterDrain does not exist yet, so follow master exit conventions.
- (build base, orchestrator) isDaemonOf/DAEMON_PATTERN accept the compiled cmdline `dg-skills pw __daemon {json}` and the source form `skills-cli/src/index.ts pw __daemon`. E adds the `dg.js dg-skills pw __daemon` form when it rebases.
- (security, orchestrator) An EDR alert (T1068) fired on this machine. Tests never launch a real Windows browser, never open a remote-debugging port, never overwrite a running executable, and never put new stub programs on PATH. Windows-mode, WSL and browser-pick tests use injected seams (exists, spawn and fetch functions). Real browser e2e stays behind PW_E2E=1 and does not run in this build.

## Issues Remediation

## Decisions

- [DECIDED] pw ships to every plugin user as a lazy chunk: zero cost until `dg-skills pw` is called.
- [DECIDED] System browser first: Chrome, then Edge; `--browser=` still selects chrome, chromium, msedge, firefox, webkit.
- [DECIDED] No browser found: exit 3 with one message naming `dg-skills pw install-browser`; the SKILL.md tells the agent to ask the human first (about 150 MB). The download lives under the dg data dir (`browsersDir` from PR F; `~/.dg/browsers` before F) so install and doctor can find and remove it.
- [DECIDED] WSL: `pw open` defaults to the existing Windows mode (Windows Chrome, then Edge, over CDP; headed is allowed there because the window is on Windows). With no Windows browser it falls back to headless Chromium inside WSL, then to the install-browser message. A headed browser inside WSL runs only with the explicit `--wsl-headed` flag, which prints an experimental warning; agents never pass it unless the human asks.
- [DECIDED] doctor reports browser status.
- [DECIDED] `dg-skills pw` subcommand, not a separate binary and not a daemon binary. Size: pw adds its own code only (about 4,750 source lines, about 90 KB minified) because `playwright-core` is already in the bundle for verify and channel-review. Speed: with PR E, `dg-skills pw list` costs the dispatcher plus the pw client chunk (target under 60 ms); only `pw __daemon` loads playwright-core (456 ms import, paid once per session). A separate binary would add 80 MB per platform for 90 KB of code; a daemon binary would still leave the client at the old 300 ms.
- [DECIDED] Storage paths are unchanged, so there is no data migration: `scratchDir("pw", {cwdScope:false})` + `sessions|sock|log` equals today's `<scratch>/pw/...`, `scratchDir("pw")` equals today's `<scratch>/pw/<cwd-hash>` output dir, and `stateDir("pw", {cwdScope:false})/states` equals today's `<state>/pw/states`. Persistent profiles stay in `~/.cache/playwright-cli/profiles/<name>` so saved logins survive.
- [DECIDED] `pw-code` stays a separate top-level command. Claude Code's `Bash(prefix:*)` match is word-boundary aware (`Bash(ls *)` does not match `lsof`, per the permissions doc), so `Bash(dg-skills pw:*)` never covers `dg-skills pw-code`.
- [DECIDED] Linux and WSL are the tested hosts; macOS and Windows get `--help` smoke only, and session liveness falls back to a pid check where `/proc` is absent.

## Code Structure

```text
pkg/skills-cli/src/pw/
  cli.ts                      main(argv): parse, client commands, forward to daemon, __daemon route, install-browser
  code-cli.ts                 main(argv) for pw-code: forwards method "code" only
  daemon.ts                   main(spec): launch browser, serve the socket, queue requests (ported)
  browsers.ts                 pickLaunch(): chrome -> msedge -> downloaded chromium; installBrowser(); browserStatus()
  doctor.ts                   pwChecks, pwCodeChecks
  test-support.ts             fakes for daemon, locator, events (ported)
  core/                       args, registry, socket, client, launch, browser, states, windows, ... (ported, 36 files)
  commands/<name>/spec.ts     command spec per command (70 commands, ported)
  commands/<name>/run.ts      client or daemon handler (lazy per command, ported)
  commands/index.ts           COMMANDS table (spec + load)
  code/                       run-code daemon handler (ported)
pkg/skills-cli/src/commands/pw.ts          registerLazyRaw(program, { name: "pw", load: () => import("../pw/cli") })
pkg/skills-cli/src/commands/pw-code.ts     registerLazyRaw(program, { name: "pw-code", load: () => import("../pw/code-cli") })
pkg/skills-cli/__tests__/pw/**             93 test files ported (bun:test), e2e behind PW_E2E=1
plugins/dg/skills/pw/SKILL.md              about 80 lines
plugins/dg/skills/pw/references/*.md       commands, windows, session-management, test-generation, request-mocking, running-code, storage-state, tracing, video-recording (ported)
docs/pw.md                                 user doc with the removal list for ~/scripts users
```

## Code sample: `dg-skills pw click e15` end to end

1. Shim: `~/.dg/bin/dg-skills pw click e15` execs `bun dg.js dg-skills pw click e15`.
2. Dispatcher loads the skills chunk; commander matches `pw`; the action imports `../pw/cli` (pw client chunk, no playwright).
3. `pw/cli.ts`:

```ts
export async function main(argv: readonly string[], env: ClientEnv = defaultEnv()): Promise<number> {
	const args = normalize(argv);
	const name = commandName(args);
	if (name === "__daemon") return (await import("./daemon")).main(JSON.parse(args[1] ?? "null"));
	if (name === "install-browser") return (await import("./browsers")).installBrowser(env, args.includes("--remove"));
	if (!name) {
		env.out(indexHelp(COMMANDS.map((entry) => entry.spec)));
		return args.includes("--help") ? 0 : 2;
	}
	const entry = COMMANDS.find((candidate) => candidate.spec.name === name);
	if (!entry) {
		env.err(`Unknown command: ${name}\nRun: dg-skills pw --help`);
		return 2;
	}
	if (args.includes("--help")) {
		env.out(commandHelp(entry.spec));
		return 0;
	}
	const parsed = parse(args, entry.spec);
	if (entry.spec.side === "client") return ((await entry.load()).default as ClientHandler)(parsed, env);
	return forward(parsed, "run", args, env);
}
```

4. `forward` (core/client.ts, unchanged) resolves the session record under `<scratch>/pw/sessions/<key>.json`, connects to `<scratch>/pw/sock/<key>.sock`, writes one JSON line `{id, method:"run", params:{argv, cwd, raw, snapshotDepth}}` and prints the reply.
5. The daemon side (started earlier by `pw open`) is the same bundle: `core/daemon-command.ts` becomes

```ts
import { selfCommand } from "@dg/common/node";

export function daemonCommand(): string[] {
	return selfCommand(["pw", "__daemon"]);
}
```

so `launch.ts` spawns `[bun, dg.js, "dg-skills", "pw", "__daemon", "<spec json>"]` detached; `daemon.ts` imports `playwright-core` (the only place that does), launches the browser, serves the socket and prints `READY <socket>`.

6. Registry liveness (`core/registry.ts`):

```ts
export const DAEMON_PATTERN = "(dg\\.js dg-skills|skills-cli/src/index\\.ts) pw __daemon ";
```

7. Browser pick and the WSL rule (`pw/browsers.ts`, used by `core/browser.ts`):

```ts
export class BrowserMissingError extends Error {
	readonly exitCode = 3;
	constructor() {
		super("No browser found. Ask the user, then run: dg-skills pw install-browser (downloads about 150 MB).");
	}
}

export function pickLaunch(requested: BrowserName | undefined, paths: DgPaths): { type: BrowserType; channel?: string; executablePath?: string } {
	if (requested) return engine(requested);
	for (const channel of ["chrome", "msedge"] as const) if (channelInstalled(channel)) return { type: chromium, channel };
	const downloaded = downloadedChromium(paths.browsersDir);
	if (downloaded) return { type: chromium, executablePath: downloaded };
	throw new BrowserMissingError();
}

export type WslPlan = { mode: "windows" } | { mode: "local"; headless: boolean; warning?: string };

export function wslPlan(flags: Record<string, string | boolean | undefined>, windowsBrowser: boolean): WslPlan {
	if (flags["windows"] === true) return { mode: "windows" };
	if (flags["wsl-headed"] === true) {
		return { mode: "local", headless: false, warning: "experimental: headed browser inside WSL (WSLg); pass --wsl-headed only when the human asks" };
	}
	if (flags["browser"] === undefined && windowsBrowser) return { mode: "windows" };
	return { mode: "local", headless: true };
}
```

`open/run.ts` calls `wslPlan` only when `isWSL()`: mode `windows` reuses `openWindows` (Windows Chrome, then Edge, over CDP), mode `local` goes through `pickLaunch`, and the warning prints once. `installBrowser` runs playwright-core's registry install for `chromium` with `PLAYWRIGHT_BROWSERS_PATH=<browsersDir>`; `--remove` deletes that directory.

## SKILL.md draft: plugins/dg/skills/pw/SKILL.md

```markdown
---
name: pw
description: Drive a browser with dg-skills pw to open a site, click, fill forms, take snapshots or screenshots, scrape page data, mock requests, record video, and save logins as named states.
---

# Browser automation with pw

<generated first-run block, probe `pw`>

If a step fails, run dg-skills doctor pw pw-code stash.

## Calling rules

- Run every step as `dg-skills pw <command>`. Open with `dg-skills pw open`.
- One command per Bash call. No `cd`, `&&`, `;`, `|`, `>` or `$( )`.
- Read snapshots with Read, using the `[Snapshot](...)` path the command prints.
- Refs look like `e13`, or `f1e1` inside a frame. Snapshot again on "Ref not found".

## Browser

`pw open` uses the system Chrome, then Edge. With no browser it exits 3 and names `dg-skills pw install-browser`. Do not run that command on your own: it downloads about 150 MB under the dg data directory. Ask the user first, and tell them `dg-skills pw install-browser --remove` deletes it.

Inside WSL `pw open` drives the Windows-side Chrome or Edge over CDP by default; that window may be headed because it lives on Windows. With no Windows browser it falls back to a headless browser inside WSL, then to the install-browser message. `--wsl-headed` opens a headed window inside WSL and is experimental: never pass it unless the human asks (see references/windows.md).

## Keep context small

(unchanged rules: depth 6 default, `--depth=N`, `--raw eval`, screenshots only for visual checks, `### Events` shows counts)

## Output files

Snapshots, screenshots, downloads, traces and videos land in `$(dg-skills stash pw)/`. Nothing is written to the project unless you pass `--out=<dir>`.

## Logins

`pw state save <name>` stores a login under `$(dg-skills stash -s -G pw states)/`; `pw open --from=<name>` reuses it.

## Code in the page

`dg-skills pw eval` runs JavaScript in the page. `dg-skills pw-code` runs Node code with full access to `page` and is a separate command on purpose: the allow rule for `dg-skills pw` never covers it, so the user approves each call. Never add `pw-code` to an allow rule.

## References

| Need | File |
| --- | --- |
| Commands, raw output, snapshots, targeting | references/commands.md |
| Windows mode, CDP | references/windows.md |
| Sessions, profiles, named states | references/session-management.md |
| Request mocking, tracing, video, storage, pw-code recipes | references/*.md |
```

## Removal list for the local ~/scripts copy (after merge and one `dg-skills install`)

1. `~/scripts/bin/pw kill-all` (stops old daemons, whose cmdline no longer matches the new pattern).
2. Delete `~/scripts/bin/pw`, `~/scripts/bin/pw-daemon`, `~/scripts/bin/pw-code`.
3. Delete `~/scripts/ai/skills/pw/` and remove the three `pw`, `pw-daemon`, `pw-code` entries from `TOOLS` in `~/scripts/ai/build.ts`; rebuild.
4. Delete `~/.codex/skills/pw` and `~/.config/opencode/skills/pw` (64 KB each); `dg-skills install --skills-only --dest <dir>` installs the plugin copy.
5. Replace `Bash(pw:*)` in `~/.claude/settings.json` with `Bash(dg-skills pw:*)` (doctor prints it); keep `Bash(playwright-cli *)` only if the legacy tool stays.
6. Optional: `~/.cache/playwright-cli/profiles` holds saved logins and stays valid; delete only to start clean.

## Size, speed and token impact

Size: about +90 KB minified in a pw chunk (0.9 % of the 9.3 MB bundle); 0 B until the chunk loads; no new release asset; playwright-core already present. Speed: `pw list` under 60 ms; `pw open` pays the playwright import once per session in the daemon. Tokens: SKILL.md about 80 lines (today 120), references loaded on demand; `--help` output unchanged in shape.

## Risks and early signals

- Bundle mode changes `Bun.main`; `DAEMON_PATTERN` and `selfCommand` tests fail first if the argv shape drifts.
- A persistent profile held by another cwd is refused (existing behavior); doctor shows live sessions.
- `install-browser` depends on playwright-core's internal registry API; pin the call behind one function with a test on the current version.

## Ratified decisions

- [DECIDED] `install-browser` scope: Chromium only.
- [DECIDED] WSL rule (changed from the first draft): Windows mode by default, then headless Chromium inside WSL, then the install-browser message; `--wsl-headed` is the only way to a headed browser inside WSL and prints an experimental warning.

## Chain position

Layer 3 on `feat/per-os-layout`. Branch `feat/pw-browser-skill`. Independent of B, C and D except two rows in the command registration table and the doctor registry (one-hunk rebase).
