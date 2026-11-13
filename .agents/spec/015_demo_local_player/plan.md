---
feature: "Demo local player: /dg:demo plays the tour in a Playwright-driven browser by default, --ext keeps the extension flow"
feature_snake_case: demo_local_player
date: "2026-10-29"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "tour-ui-shared-package"
    agents:
      primary: dg:js
      qa: [dg:qa-code]
    depends_on: []
    files: ["pkg/tour-ui/**","pkg/extension/lib/features/demo-tour.ts","pkg/extension/lib/tour-host.ts","pkg/extension/lib/picker.ts","pkg/extension/lib/ui-helpers.ts","pkg/extension/lib/video-timing.ts","pkg/extension/lib/narration-progress.ts","pkg/extension/wxt.config.ts","pkg/extension/package.json","pkg/extension/__tests__/**","package.json"]
  - id: 2
    name: "local-player"
    agents:
      primary: dg:js
      qa: [dg:qa-code, dg:security]
    depends_on: [1]
    files: ["pkg/skills-cli/src/demo/cli.ts","pkg/skills-cli/src/demo/local.ts","pkg/skills-cli/src/demo/player-process.ts","pkg/skills-cli/src/demo/bridge.ts","pkg/skills-cli/src/demo/paths.ts","pkg/skills-cli/src/demo/result.ts","pkg/skills-cli/src/demo/verify-local.ts","pkg/skills-cli/src/demo/doctor.ts","pkg/skills-cli/src/demo/player-asset.ts","pkg/skills-cli/src/rerun/cli.ts","pkg/skills-cli/src/rerun/doctor.ts","pkg/skills-cli/src/utils/demo-verify.ts","pkg/skills-cli/src/utils/cdp-harness.ts","pkg/skills-cli/__tests__/demo-*.spec.ts","pkg/skills-cli/__tests__/rerun.spec.ts","pkg/skills-cli/build.ts","pkg/launcher/build.ts"]
  - id: 3
    name: "local-narration"
    agents:
      primary: dg:js
      qa: [dg:qa-perf, dg:qa-devops]
    depends_on: [2]
    files: ["pkg/tour-ui/src/narration/**","pkg/tour-ui/src/hosts/player-entry.ts","pkg/skills-cli/src/demo/narration.ts","pkg/skills-cli/src/demo/narration-assets.ts","pkg/skills-cli/src/demo/mux.ts","pkg/skills-cli/src/demo/bridge.ts","pkg/skills-cli/__tests__/demo-narration*.spec.ts",".github/workflows/release.yml","scripts/pack-narration-assets.ts"]
  - id: 4
    name: "demo-skill-docs-adr"
    agents:
      primary: dg:lore
      qa: [dg:qa-code]
    depends_on: [2,3]
    files: ["plugins/dg/skills/demo/SKILL.md","plugins/dg/skills/demo/references/extension.md","plugins/dg/skills/demo/references/authoring.md","plugins/dg/skills/README.md","pkg/skills-test/__tests__/demo-skill.spec.ts","pkg/skills-test/__tests__/ext-opt-in.spec.ts","pkg/common/__tests__/installed-skill-files.ts","docs/demo-and-proto.md","docs/AGENT-INSTALL.md","docs/install.md","docs/adr/0029-shared-tour-ui-and-local-player.md","docs/adr/toc.md"]
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# Demo local player: /dg:demo plays the tour in a Playwright-driven browser by default, --ext keeps the extension flow

## Purpose
Plain `/dg:demo` no longer needs the dg-ai-extension. The CLI launches a browser with the pw skill's rules (system Chrome or Edge first, the Windows browser over CDP on WSL, headless Chromium as the fallback, install-browser when none), injects the same tour overlay the extension renders, shows the same start screen in the page (review, walkthrough, video, narration and voice) and records a video file next to the saved plan. The overlay, step engine, start screen and editor move into a shared pkg/tour-ui package behind a small host interface so the extension and the local player run one implementation. `--ext` is today's flow through the extension; `--verify` walks the plan in the local player unless --ext is given.

## Scope
### Included
- pkg/tour-ui: overlay, step renderer, start screen, editor and video sequencing extracted from the extension behind a TourHost interface; the extension's WXT host; a Bun-built IIFE player bundle for injection
- dg-skills demo local mode: detached player process, browser from pw's pickLaunch and wslPlan, start screen in page, walkthrough and video, result file, `demo status`
- Local --verify that walks the player's overlay; --ext --verify keeps the extension harness
- Local narration: Kokoro in the page with the ORT wasm and model fetched on demand, a sidecar WAV and an optional ffmpeg mux [ASSUMED, see Open questions]
- demo and rerun skills and docs: local default, --ext documented in references/extension.md, flags table, doctor browser status, ADR 0029
### Excluded
- Changes to the TourScript plan format or authoring.md grammar
- Recording through tabCapture or the extension's offscreen document in local mode
- Firefox or WebKit as local demo browsers
- The --ext convention itself (bundle 014) and the pw browser rules (bundle 009)

### Slice 1 — tour-ui-shared-package

#### Engineering
- [ ] pkg/tour-ui/package.json (@dg/tour-ui, private, exports ./src/index.ts and ./host) added to the root workspaces; depends only on @dg/common; no wxt, chrome or node imports anywhere under src (a test greps for them)
- [ ] pkg/tour-ui/src/host.ts: export type TourHost = { storage: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> }; messages: { send(msg: TourMessage): Promise<unknown>; on(handler: (msg: TourMessage) => void): () => void }; mountUi(name: string, onMount: (root: HTMLElement) => void): Promise<{ remove(): void }>; tabKey(): string; openExternal?(url: string): void }; TourMessage is the union of today's MSG payloads typed in one place
- [ ] pkg/tour-ui/src/engine.ts: PlayState, initialPlayState, recordingStartState, restartState, completeSetupPhase, automaticPlayback, advanceClickNeeded, performAction, stepEffect, runVideoStepSequence, editMachine, scriptToDraft, draftToScript, editorReviewRows (moved verbatim from demo-tour.ts; pure functions, no host)
- [ ] pkg/tour-ui/src/overlay.ts: buildOverlay, positionCard, recIndicator, renderStep(host, state, step) (uses host.mountUi instead of createShadowRootUi); pkg/tour-ui/src/start-screen.ts: showStartScreen(host, script, opts) renders narration and voice selects, include-setup toggle, Review, Play walkthrough, Record video, Download plan and resolves with the choice; pkg/tour-ui/src/editor.ts: showEditPanel(host, script); pkg/tour-ui/src/picker.ts, ui-helpers.ts, video-timing.ts, narration-progress.ts moved from pkg/extension/lib with their tests
- [ ] pkg/tour-ui/src/player.ts: runTour(host, script, opts) is the one entry both hosts call: marker or saved state in, start screen when the mode is undecided, then walkthrough or video playback; export type TourResult = { outcome: 'done' | 'stopped' | 'error'; mode: TourMode; steps: number; error?: string }
- [ ] pkg/extension/lib/tour-host.ts: wxtHost(ctx): TourHost implemented with browser.storage.local (keys demo_tour:<tab>, demo_recording:<tab>, demo_edit:<tab>, demo_pending:<tab> unchanged), browser.runtime.sendMessage/onMessage, createShadowRootUi; demo-tour.ts shrinks to marker capture, tab id, recorder listener and the calls into @dg/tour-ui; the extension's observable behavior is unchanged
- [ ] pkg/extension/lib/{picker,ui-helpers,video-timing,narration-progress}.ts become one-line re-exports from @dg/tour-ui so internal imports keep working; wxt.config.ts adds the @dg/tour-ui alias next to @dg/common
- [ ] pkg/tour-ui/build.ts: Bun.build({ entrypoints: ['src/hosts/player-entry.ts'], format: 'iife', minify: true, target: 'browser', outdir: 'dist' }) writes dist/player.js; player-entry.ts defines window.__dgTour = { run(script, opts) } on top of a host that keeps state in memory and talks to the CLI through window.__dgDemoBridge (installed by Playwright exposeBinding in slice 2); the root `bun run build` and pkg/launcher/build.ts run this step before the skills bundle

#### Testing Criteria
##### Contracts
- [ ] Contract: no file under pkg/tour-ui/src imports wxt, webextension-polyfill, chrome, node: or bun: (grep test tour-ui-purity.spec.ts)
- [ ] Contract: runTour with a fake host and a 3-step walkthrough script mounts the start screen first, then after choose('walkthrough') renders step 1's overlay with the title and body text, advances on Next, and resolves TourResult {outcome:'done', steps:3}
- [ ] Contract: runTour with mode video and a fake host that resolves narration immediately advances steps by holdFor(step, null) and reports done
- [ ] Contract: editMachine, scriptToDraft/draftToScript and editorReviewRows tests moved from pkg/extension/__tests__ pass unchanged against @dg/tour-ui
- [ ] pkg/extension/__tests__/demo-tour-review.spec.ts, demo-tour-pending-race.spec.ts, tour-state.spec.ts, video-timing.spec.ts, narration-progress.spec.ts, picker.spec.ts pass without edits other than import paths
- [ ] Contract: dist/player.js is under 120 KB minified (size-budget line) and evaluates in happy-dom defining window.__dgTour.run
- [ ] Contract: the built extension still loads: wxt build succeeds and the chrome-mv3 manifest lists the same permissions as before

#### Acceptance Criteria
- [ ] Given the extension built from this slice, when a `_demo` marker tour runs in Chrome, then the start screen, overlay, Next and Back, and the video prompt look and behave as in v1.26.0
- [ ] Given pkg/tour-ui, when `bun test pkg/tour-ui` runs, then every engine and overlay test passes with no browser extension APIs present

### Slice 2 — local-player

#### Engineering
- [ ] demo/cli.ts: dispatch like proto: no --ext runs local.ts; --ext runs today's playScript/extension verify; --verify <plan> runs verify-local unless --ext; new verbs `status <slug>` and the hidden `__player <json>`; options: --video (record now, no start screen), --out <path>, --browser <name>, --windows, --wsl-headed, --timeout <min> (default 30), --print and --edit are --ext-only and print `--print/--edit need --ext` otherwise
- [ ] demo/local.ts: playLocal(script, opts): resolves the browser plan with pw's pickLaunch and wslPlan from pkg/skills-cli/src/pw/browsers.ts; when the plan is headless and no --video, exits 2 with `demo: the start screen needs a visible browser; pass --video for an unattended recording, or --windows / --wsl-headed`; writes <demosDir>/<slug>/<slug>.demo.md through savePlan (paths from demo/paths.ts); spawns programCommand('dg-skills', ['demo', '__player', JSON.stringify(job)]) detached with stdio to <demosDir>/<slug>/player.log; prints `demo "<title>": start screen open in <browser>. The human picks there. Results: dg-skills demo status <slug>` and returns 0
- [ ] demo/player-process.ts: main for `__player`: launches playwright-core chromium with the plan (executablePath or channel from pickLaunch; connectOverCDP for the Windows plan), newContext({ recordVideo: job.video ? { dir, size } : undefined }), page.exposeBinding('__dgDemoBridge', bridge handler), page.addInitScript(playerJs) so the overlay survives navigations, page.goto(startUrl), then page.evaluate(() => window.__dgTour.run(script, opts)); keeps main pending with forever() until the bridge reports done, stopped or the --timeout elapses; closes the context so the webm is flushed, renames it to <slug>-<yyyymmdd-hhmm>.webm, writes <slug>.result.json and exits through exitAfterDrain
- [ ] A --video run has no start screen, so it plays captions-only in this slice; slice 3 adds `--narration <both|voice|captions>` (default: the slug's saved choice.json, else captions)
- [ ] demo/bridge.ts: handles bridge messages {kind:'choice', mode, narration, voice, includeSetup} (persisted to <demosDir>/<slug>/choice.json), {kind:'progress', index}, {kind:'navigate', url} (the player re-injects via addInitScript automatically), {kind:'download-plan'} (writes the edited plan next to the saved one), {kind:'done'|'stopped'|'error'}; narration messages are accepted and answered `captions-only` until slice 3
- [ ] demo/player-asset.ts: import playerJs from '../../../tour-ui/dist/player.js' with { type: 'text' }; export function playerScript(): string; the build step in pkg/launcher/build.ts runs pkg/tour-ui/build.ts first so the text asset exists; a size-budget line keeps the demo chunk under 400 KB and asserts the stash chunk does not include player.js
- [ ] demo/paths.ts: demosDir() = join(resolveDgPaths().dataDir, 'demos') (F's layout; the ~/.dg/demos legacy dir is read-only fallback for `status` and `rerun` of old plans); profileDir() = join(dataDir, 'demo-profile') used as a persistent context so logins and the narration model survive runs
- [ ] demo/result.ts: type DemoResult = { slug, outcome, mode, steps, video?: string, plan: string, startedAt, endedAt, error? }; readResult(slug), writeResult(result); `demo status <slug>` prints the result as one JSON line, or `running (pid <n>)` when the player log is live and no result exists, or `no run for <slug>`
- [ ] demo/verify-local.ts: verifyLocal(script): headless launch through pickLaunch (no human needed), injects the player with opts { autopilot: true } which skips the start screen and clicks Next itself, reads the overlay through a bridge probe {kind:'overlay'} returning {kind:'none'|'consent'|'step'|'done', index}, and reuses the Finding types and walk logic from utils/demo-verify.ts (walkTour is exported and takes a PageLike with readTourOverlay, clickThroughTour, selectorResolves, locationHref, drainNavigations); the extension harness path stays for --ext
- [ ] rerun/cli.ts: local by default through playLocal; --ext through the extension; --video passes through; rerun/doctor.ts moves to extOnlyChecks (deferred from 014)
- [ ] demo/doctor.ts: demoChecks = [skillFilesCheck(['demo']), browserStatusCheck (from pw: system chrome|msedge|downloaded chromium|none, fix `dg-skills pw install-browser`), ...extOnlyChecks, allowRuleCheck('demo')]
- [ ] utils/cdp-harness.ts and utils/demo-verify.ts: resolveExtensionDir and DemoVerifyHarness are only reached from the --ext verify path; walkTour is exported for verify-local

#### Testing Criteria
##### Contracts
- [ ] Contract: `dg-skills demo plan.md` with a fake spawn seam calls programCommand('dg-skills', ['demo', '__player', <json>]) once and returns 0 with the `start screen open` line
- [ ] Contract: with a headless browser plan and no --video, `demo plan.md` returns 2 and the message names --video, --windows and --wsl-headed; with --video it spawns the player
- [ ] Contract: --print and --edit without --ext return 1 and name --ext; with --ext they call playScript as today
- [ ] Contract: demo status <slug> prints the result JSON after a completed run fixture; `running (pid n)` while the fixture log is held open; `no run` otherwise
- [ ] Contract: the player text asset is non-empty, defines window.__dgTour, and is not part of the stash chunk (size-budget.spec.ts)
- [ ] demo-player-e2e.spec.ts (runs when PW_E2E=1): a 2-step plan against a local http server in --video mode produces <slug>-<ts>.webm over 1 KB, a result.json with outcome done and steps 2, and the overlay text appears in a screenshot taken by the bridge mid-run
- [ ] demo-player-e2e.spec.ts (PW_E2E=1, WSL with a Windows Chrome): --video over connectOverCDP produces a webm; when recordVideo is unsupported over CDP the player falls back to a headless local Chromium for --video and prints one line saying so
- [ ] verify-local.spec.ts: a plan whose selector misses reports selector-unresolved for step 2 through the local walker; a clean plan reports ok true; --verify never requires the extension build
- [ ] rerun.spec.ts: `rerun old.demo.md` reads a plan under the legacy ~/.dg/demos dir and plays locally
- [ ] doctor test: `dg-skills doctor demo` on a CLI-only home exits 0 and shows the browser status line and the --ext only info lines

#### Acceptance Criteria
- [ ] Given a Linux host with Chrome and no extension, when an agent runs `dg-skills demo tour.md`, then a visible Chrome opens on startUrl with the start screen and the command returns within 5 s
- [ ] Given the human presses Record video on that start screen, when the tour ends, then <dataDir>/demos/<slug>/<slug>-<ts>.webm exists and `dg-skills demo status <slug>` prints its path
- [ ] Given WSL with Windows Chrome, when `dg-skills demo tour.md` runs with no flags, then the start screen opens in the Windows browser over CDP
- [ ] Given no browser at all, when `dg-skills demo tour.md` runs, then it exits 3 with the install-browser message and starts nothing
- [ ] Given `dg-skills demo --verify tour.md`, when no extension is built, then findings JSON prints and the exit code is 0

### Slice 3 — local-narration

#### Engineering
- [ ] [DECIDED] Narration runs in the page, not in Bun: pkg/tour-ui/src/narration/kokoro.ts is the extension's utils/kokoro.ts generalized with an assetBase URL (env.wasmPaths = assetBase + 'ort/'); the player host loads it only when the start-screen choice is `both` or `voice`
- [ ] scripts/pack-narration-assets.ts builds dg-demo-narration-<version>.zip from kokoro-js and its transformers dist (kokoro IIFE about 2.1 MB, ort-wasm-simd-threaded.jsep.{mjs,wasm} 21 MB); release.yml uploads it and lists it in SHA256SUMS
- [ ] demo/narration-assets.ts: ensureNarrationAssets(version) downloads the zip into <dataDir>/demo-narration/<version>/ on first use, verifies the SHA256SUMS entry, and serves it to the page through page.route('https://dg-demo.local/narration/*') from disk; offline with no cached assets prints `narration assets are not downloaded; running captions-only` and continues
- [ ] The Kokoro model (about 86 MB) is fetched by the page from Hugging Face into the persistent demo-profile's cache on the first narrated run, exactly as the extension does; the start screen shows the same model progress bar from narration-progress.ts
- [ ] demo/bridge.ts: {kind:'clip', index, sampleRate, pcm: base64 Float32} messages are written to <run>/clips/<index>.f32; after done, demo/narration.ts writes <slug>-<ts>.wav with each clip placed at the step's recorded start offset (from progress timestamps) so the picture and the voice line up without a capture of tab audio
- [ ] demo/cli.ts: `--narration <both|voice|captions>` for --video runs; the start screen's choice wins when both exist; the value is stored in choice.json
- [ ] demo/mux.ts: when Bun.which('ffmpeg') exists, run ffmpeg -i video.webm -i voice.wav -c:v copy -c:a libopus -shortest <slug>-<ts>.webm and remove the sidecar; otherwise keep both files and print `ffmpeg not found: video and voice saved separately (<webm>, <wav>)`; the result.json carries audio: 'muxed' | 'sidecar' | 'none'

#### Testing Criteria
##### Contracts
- [ ] Contract: narration assets zip name and SHA256SUMS entry are produced by the pack script for the current version (test runs the script against a temp outdir)
- [ ] Contract: ensureNarrationAssets with a fake fetch verifies the checksum and refuses a tampered zip with `checksum mismatch`
- [ ] Contract: offline with no cached assets, a `both` choice prints the captions-only line and the run completes with audio 'none'
- [ ] Contract: narration.ts assembles two clips at offsets 0 ms and 4200 ms into a 24 kHz mono WAV whose length equals the last offset plus the last clip
- [ ] Contract: mux.ts calls ffmpeg with the expected argv when present (spawn seam) and reports sidecar when absent
- [ ] demo-narration-e2e.spec.ts (PW_E2E=1 and DG_NARRATION_E2E=1): a 1-step video run with narration `both` produces a webm with an audio stream (ffprobe) or a sidecar wav when ffmpeg is missing

#### Acceptance Criteria
- [ ] Given a first narrated run, when the human picks Voiceover + captions, then the start screen shows the model download progress and the tour records with voice
- [ ] Given a machine without ffmpeg, when a narrated video finishes, then both files exist and the final line names them

### Slice 4 — demo-skill-docs-adr

#### Engineering
- [ ] demo/SKILL.md (target under 110 lines): description leads with `Produce a guided demo that plays in a local browser (the default, no extension)` and names --ext after it; no requires line; `## Flags` table with --ext, --video, --out, --browser, --windows, --wsl-headed, --verify, --print (--ext), --edit (--ext) in proto's 4-column format; Step 2 runs `dg-skills demo tour.md` and stops when the start-screen line prints; the WSL paragraph mirrors the pw skill (Windows browser by default, headless fallback, `--wsl-headed` only when the human asks); the narration paragraph says the model downloads on the first voiced run and that ffmpeg is optional; the `--ext` section is three lines pointing to references/extension.md
- [ ] demo/references/extension.md (new): today's extension content: --edit review panel, Alt+Shift+D, Downloads/dg-demo, tabCapture limits, the dev-checkout note, `--ext --verify` harness requirements
- [ ] authoring.md: unchanged grammar; one sentence that local and --ext play the same plan
- [ ] skills README row for demo leads with local playback; docs/demo-and-proto.md opening section says plain /dg:demo plays locally and --ext uses the extension; docs/AGENT-INSTALL.md and docs/install.md tables: demo is local by default
- [ ] demo-skill.spec.ts (proto-skill.spec.ts pattern): description order, no requires, flags table rows and defaults, the `agents never pass --wsl-headed unless the human asks` sentence, the start-screen stop rule, SKILL.md line count under 110
- [ ] ext-opt-in.spec.ts: PENDING_LOCAL_MODE unchanged (chat, overwatch); installed-skill-files.ts adds demo/references/extension.md
- [ ] ADR 0029 shared tour UI and local player: context (one overlay implementation lived inside the extension; the local default needs it outside), decision (pkg/tour-ui behind TourHost; the player is an injected IIFE embedded in the demo chunk; narration in the page with on-demand assets and a sidecar WAV), alternatives rejected (duplicate the overlay in the CLI; inject the extension content script; Kokoro in Bun through onnxruntime-node at 208 MB), links to pkg/tour-ui/src/host.ts and demo/player-process.ts, a sequence diagram CLI -> player process -> page -> bridge; toc entry

#### Testing Criteria
##### Contracts
- [ ] demo-skill.spec.ts: description index of `local` lower than `--ext`; no requires line; --ext row Default `off (local is the default)`; --wsl-headed row exists with the human-asks sentence; line count under 110
- [ ] skill-index-docs.spec.ts and installed-skill-files.ts pass with references/extension.md added
- [ ] ext-opt-in.spec.ts rule C passes for demo/SKILL.md

#### Acceptance Criteria
- [ ] Given a Codex agent with the skills-only install, when it reads the demo skill, then the first command it runs needs no extension and the only --ext mention is the pointer to references/extension.md
- [ ] Given docs/adr/toc.md, when a reader opens it, then 0029 is listed as Accepted

## Slice Summaries

## Agent Notes

- (slice 3, orchestrator) Accept the Red seams: the pack script writes dg-demo-narration-<version>.zip and SHA256SUMS; release.yml's SHA256SUMS step must also cover the zip (check and fix). ensureNarrationAssets(version, { fetch }) unpacks to <stateDir>/demo-narration/<version>/, reusing expectedSha256, extractZip and the `checksum mismatch` wording from src/utils/lib.ts, and leaves no files after a mismatch. assembleNarrationWav writes 24 kHz mono. muxNarration takes an explicit out; a missing ffmpeg or a non-zero exit keeps the sidecar and reports sidecar.
- (slice 3, orchestrator) runPlayer installs the page.route for narration assets at launch; the handler calls ensureNarrationAssets lazily on the first matching request, so captions-only and walkthrough runs never download. PlayerJob.narration and PlayerHooks.fetch as assumed; DemoResult gains audio: 'muxed'|'sidecar'|'none'.
- (slice 3, orchestrator) The Green stage adds tests for bridge clip writes (<run>/clips/<index>.f32, bounded size and index), the --narration flag stored in choice.json, and the final output line. The e2e narration spec stays a manual check (PW_E2E=1 and DG_NARRATION_E2E=1).

- (ratified, orchestrator) Slice 2 is committed as 1f88ffa0. User decisions: gate the real-browser `demo --verify` tests behind PW_E2E=1; record the WSL loopback debug-port risk in ADR 0029 (this bundle); keep the window.__dgTour state()/advance() probe; docs say `--video --browser chromium` keeps a run inside WSL (wslPlan unchanged). Bridge calls are accepted only from the main frame on plan origins.

- (slice 2, orchestrator) Accepted: verifyLocal starts the player in walkthrough mode and clicks Next or Done itself (autopilot would double-advance). The e2e spec, a real headless verifyLocal run, the WSL Windows-Chrome --video over CDP check and the 5 s return time are manual checks for the PR body. demo-verify.spec.ts now passes --ext. The inbox-cleanup doctor-line gap comes from G1 and is fixed on PR #115; rebase picks it up.

- (slice 2, orchestrator) Accept the Red seams: deps = { play, local: LocalDeps }, LocalDeps = { isWSL, windowsBrowserPresent, pickLaunch, spawn(argv, logPath) }; playLocal returns 0, 1 (--print/--edit without --ext), 2 (headless without --video), 3 (BrowserMissingError). The player job JSON carries slug, planPath, dir, video, startUrl and the inline script; argv ends with ['demo','__player', json] after selfCommand([]).
- (slice 2, orchestrator) demo status: <demosDir>/<slug>/player.pid holds the player pid; a live pid (checked with the pw isDaemonOf-style cmdline check) means running; a result file wins. Legacy ~/.dg/demos/<slug>/ is a read fallback for status and rerun. rerun with a bare name looks in <demosDir>/*/ then the legacy dirs; an explicit path also works.
- (slice 2, orchestrator) verifyLocal(script, { open }) always closes and turns an open() failure into a harness-error finding (never throws). Add a seam so the demo --verify command path without --ext is tested at command level. runPlayer(job, hooks?) with hooks.onProgress(page, index); the webm and <slug>.result.json land in job.dir. Size-budget chunk roots are src/demo/local.ts and src/commands/stash.ts until E.
- (slice 2, orchestrator) The WSL Windows-Chrome --video over CDP and its headless fallback are covered through an injected launch seam only; real runs stay manual, with the 5 s return time and the Record video flow, and are listed in the PR body. Rewrite demo-rerun-ext.spec.ts for the new behavior and remove demo from PENDING_LOCAL_MODE. Any spec that uses mock.module runs in a subprocess (ext-command-harness pattern) so mocks never leak.

- (ratified, orchestrator) Slice 1 is committed as 5f47a6c7. User decisions: a blocked video in the tutorial phase restarts the run and shows the record prompt; ending a tour clears demo_tour and demo_recording. Accepted: tabKey() returns the bare tab id and tourKeys(host) builds the four keys; the maybePerform* helpers take host first and live in @dg/tour-ui. The local player gets no progress messages for walkthrough steps.

- (ratified, orchestrator) Both hosts call runTour in this PR (user decision). runTour and TourHost grow optional hooks for consent modals, the recorder video flow, the end screen, setup handoff and narration progress; demo-tour.ts shrinks to marker capture, tab id, recorder listener and tour-ui calls, keeping v1.26.0 behavior. TourMessage maps onto the existing MSG wire in wxtHost.

- (slice 1, orchestrator) runTour(host, script, opts?) with opts { mode?: 'walkthrough'|'video', autopilot?: boolean }. opts.mode decides the mode and skips the start screen; script.mode does not.
- (slice 1, orchestrator) Video timing: with no narration event a step advances by holdFor(step, null). TourMessage adds { kind: 'narration-complete', ms } for the narration path; a step then advances by holdFor(step, ms). The fake host test sends none.
- (slice 1, orchestrator) showStartScreen resolves { mode: 'review'|'walkthrough'|'video', includeSetup, narration, voice }. Download plan sends { kind: 'download-plan', markdown } and does not resolve. The Green stage adds tests for review and the narration and voice fields.
- (slice 1, orchestrator) buildOverlay(host, cleanups) keeps today's controls. Move the 'buildOverlay — callout controls' tests from demo-tour-review.spec.ts into pkg/tour-ui with the code.
- (slice 1, orchestrator) The extension host is an async factory: `await wxtHost(ctx)` runs MSG.whoami once, then tabKey() is synchronous and returns demo_tour:<tab>. Test the key.
- (slice 1, orchestrator) The tour-ui player build hooks into pkg/skills-cli/build.ts (no root build script and no pkg/launcher on master).
- (slice 1, orchestrator) After the move, delete the extension copies of the moved test blocks and specs so each test lives once, in pkg/tour-ui. The other extension specs keep passing with import-path edits only. Run bun install so @dg/tour-ui resolves.

- (build base, orchestrator) The install work (E 007, F 008, B 010, D 012) moved to the end of the chain. G2 builds stacked on G1's branch, not on E or F. G1 (014, branch feat/ext_opt_in_convention: 1ba48fde slice 1, 9bc12190 slice 2) gives: the --ext flag helpers in src/utils/ext-flag.ts, the flag-aware cli-only guard, extOnlyChecks and the `info` doctor status (no exit-code effect), the PlayDeps seam on registerDemo(program, deps) and registerRerun(program, deps) with noteExtDefault, the require-extension doctor on extOnlyChecks, and the PENDING_LOCAL_MODE allowlist in pkg/skills-test/__tests__/ext-opt-in.spec.ts.
- (build base, orchestrator) Map E/F names to master: programCommand("dg-skills", [...]) -> selfCommand([...]) from pkg/common/src/node/self-command.ts; resolveDgPaths().dataDir -> resolveDgPaths().stateDir from pkg/common/src/node/paths.ts (master has no dataDir), so demosDir() is <stateDir>/demos and the ratified video location is <stateDir>/demos/<slug>/ until F moves it; registerLazyRaw -> registerRawCommand with a dynamic import inside the action; exitAfterDrain does not exist, so the detached __player follows master exit conventions; pkg/launcher/build.ts does not exist, so the player IIFE embeds through pkg/skills-cli/build.ts.
- (build base, orchestrator) Master command actions live in pkg/skills-cli/src/commands/demo.ts and commands/rerun.ts; src/demo/ and src/rerun/ hold doctor.ts only. The spec's src/demo/cli.ts and src/rerun/cli.ts mean those commands files. New modules (local.ts, player-process.ts, bridge.ts, paths.ts, result.ts, verify-local.ts, player-asset.ts) go under src/demo/.
- (build base, orchestrator) pw comes from PR #113 (009), which must merge before slice 2. Its names differ from this spec: pickLaunch and BrowserMissingError live in src/pw/core/browser.ts, wslPlan(flags, windowsBrowserPresent) in src/pw/commands/open/run.ts, and installBrowser/browserStatus in src/pw/browsers.ts. Slice 1 (pkg/tour-ui) touches only the extension and the new package and can start before #113 merges.
- (build base, orchestrator) G2 must remove from G1: noteExtDefault and the CLI-only refusal of demo and rerun without --ext (the local player replaces both); demo leaves PENDING_LOCAL_MODE in ext-opt-in.spec.ts and drops `requires: [extension]`; the demo rows in docs/install.md and plugins/dg/skills/README.md move from still-requires-extension to local by default.
- (security, orchestrator) An EDR alert (T1068) fired on this machine. Tests never start powershell.exe, cmd.exe, a Windows browser or a remote-debugging port, and never put stub programs on PATH. Use injected seams (spawn, launch, fetch, exists) and write files with an atomic rename. Never launch a headed browser on WSL; agents pass --wsl-headed only when the human asks. Real-browser checks run only behind PW_E2E=1. Command tests reuse pkg/skills-cli/__tests__/ext-command-harness.ts from G1. Never run git stash in any form.

- (ratified, orchestrator) Local narration is option B: Kokoro in the page over ONNX Runtime WASM, assets as a release zip fetched on first voiced run, sidecar WAV aligned to step offsets, ffmpeg mux when present.
- (ratified, orchestrator) The video lands in <dataDir>/demos/<slug>/ next to the plan; --out overrides; demo status prints the path.

## Issues Remediation
## Decisions

- [DECIDED] One overlay implementation. The DOM-only parts of `pkg/extension/lib/features/demo-tour.ts` (overlay, step renderer, start screen, editor, video sequencing) and the DOM-only helpers (picker, ui-helpers, video-timing, narration-progress) move to `pkg/tour-ui` behind a `TourHost` interface. The extension implements the host with WXT and chrome storage; the local player implements it with an in-page object whose storage and messages go over a Playwright `exposeBinding` bridge to the CLI. Rejected: a second overlay in the CLI (drift; two test suites), and injecting the built WXT content script (it imports `wxt/browser` and `chrome.*` and would need shims for every API).
- [DECIDED] The player is a Bun-built IIFE (`pkg/tour-ui/dist/player.js`) embedded in the demo chunk as a text asset, the same `import x from "..." with { type: "text" }` pattern `proxy/packaged-personas.ts` uses. It loads only when the demo chunk loads.
- [DECIDED] The browser comes from 009's `pickLaunch` and `wslPlan` in `pkg/skills-cli/src/pw/browsers.ts`: system Chrome, then Edge, then the downloaded Chromium; on WSL the Windows browser over CDP first, headless Chromium inside WSL second, the install-browser message last; `--wsl-headed` only when the human asks. The `cdp-harness.ts` candidate list that excludes Chrome stable stays on the `--ext` verify path only; that exclusion exists because of `--load-extension`, which the local player never passes.
- [DECIDED] The start screen is an in-page overlay. Agents cannot answer prompts, so the CLI never waits in the foreground: `dg-skills demo tour.md` spawns a detached player process (`dg-skills demo __player <json>` through `programCommand`, E's pattern), prints where the human picks and where results land, and returns. `dg-skills demo status <slug>` and `<slug>.result.json` report the outcome.
- [DECIDED] `--video` is the unattended path: no start screen, auto-play, works headless. Plain `demo` with a headless-only browser plan exits 2 and names `--video`, `--windows` and `--wsl-headed`.
- [DECIDED] Videos are durable output: `<dataDir>/demos/<slug>/<slug>-<yyyymmdd-hhmm>.webm` next to the saved plan (F's layout; today's `~/.dg/demos` is read as a legacy fallback). Scratch is wrong here because the 14-day TTL reaps it. `--out <path>` overrides. See Open questions for the one alternative.
- [DECIDED] Local `--verify` walks the player's overlay, so the agent's verify-before-handoff loop needs no extension build. `--ext --verify` keeps today's harness.
- [DECIDED] `--print` and `--edit` are `--ext`-only: `--print` emits a marker URL only the extension reads, and the local start screen always offers Review, so `--edit` has nothing to add locally.
- [DECIDED] Narration runs in the page (Kokoro over ONNX Runtime WASM, the extension's own path), the ORT wasm and Kokoro JS arrive as a release zip on first use, the voice is written as a sidecar WAV aligned to step offsets, and `ffmpeg` muxes it when present. See Open questions; slice 3 is cut cleanly if the answer changes.
- [DECIDED] The player's in-page host keeps tour state through the bridge (the CLI holds the map), so a step that navigates resumes on the next page load exactly as the extension resumes from `storage.local`; `page.addInitScript(playerJs)` re-injects the player on every navigation.

## Measured facts (origin/master v1.26.0 and this machine)

- `pkg/extension/lib/features/demo-tour.ts` is 2822 lines; the built content script `demo-tour.js` is 77 KB; `picker.ts`, `ui-helpers.ts`, `video-timing.ts`, `narration-progress.ts` import nothing from wxt or chrome.
- The kokoro chunk in the built extension is 2.1 MB; `public/ort/` is 21 MB (two files copied by `scripts/copy-ort.ts`); `onnxruntime-node` is 208 MB in node_modules; `kokoro-js` resolves its `node` export to the transformers node build, which needs onnxruntime-node. The Kokoro model (about 86 MB) is fetched from Hugging Face at run time.
- `playwright-core` 1.64.1 is already a `pkg/skills-cli` dependency (`verify/playwright-capturer.ts`); Playwright `recordVideo` records picture only, no audio track.
- `savePlan` writes `~/.dg/demos/<slug>/<slug>.demo.md` (this machine holds 11 such folders). `demo --verify` requires a built extension (`resolveExtensionDir`) and clicks through the extension's overlay.
- `dg-skills demo` flags today: `--video`, `--print`, `--edit`, `--verify <plan>`; `rerun` takes `--video` and `--print` and shares `playScript`.

## Code Structure

```text
pkg/tour-ui/
  package.json                       @dg/tour-ui, depends on @dg/common only
  build.ts                           Bun.build iife -> dist/player.js (minified)
  src/index.ts                       public exports
  src/host.ts                        TourHost, TourMessage
  src/engine.ts                      PlayState and pure step logic (moved from demo-tour.ts)
  src/overlay.ts                     buildOverlay, renderStep(host, ...)
  src/start-screen.ts                showStartScreen(host, script) -> choice
  src/editor.ts                      showEditPanel(host, script)
  src/player.ts                      runTour(host, script, opts) -> TourResult
  src/picker.ts, ui-helpers.ts, video-timing.ts, narration-progress.ts   moved helpers
  src/hosts/player-entry.ts          window.__dgTour.run; bridge-backed host
  src/narration/kokoro.ts            (slice 3) loader with assetBase
  __tests__/**                       engine, overlay, start screen, purity grep
pkg/extension/lib/tour-host.ts       wxtHost(ctx): TourHost
pkg/extension/lib/features/demo-tour.ts   marker capture, tab id, recorder listener, calls @dg/tour-ui
pkg/extension/lib/{picker,ui-helpers,video-timing,narration-progress}.ts   re-exports
pkg/skills-cli/src/demo/
  cli.ts                             dispatch local | --ext; status; __player; option table
  local.ts                           playLocal: browser plan, save plan, spawn player, print
  player-process.ts                  __player main: playwright launch, bridge, recordVideo, result
  bridge.ts                          bridge message handling, CLI-held tour state
  player-asset.ts                    playerScript() from the embedded text asset
  paths.ts                           demosDir(), profileDir() from resolveDgPaths
  result.ts                          DemoResult, readResult, writeResult, status text
  verify-local.ts                    verifyLocal(script) through the player with autopilot
  doctor.ts                          browser status + extOnlyChecks
  narration.ts, narration-assets.ts, mux.ts   (slice 3)
pkg/skills-cli/src/rerun/cli.ts      local by default, --ext passthrough
pkg/skills-cli/src/utils/demo-verify.ts     walkTour exported; harness only under --ext
pkg/skills-cli/__tests__/demo-*.spec.ts     unit, e2e (PW_E2E=1), narration (DG_NARRATION_E2E=1)
pkg/launcher/build.ts                runs pkg/tour-ui/build.ts first; size-budget lines
scripts/pack-narration-assets.ts     dg-demo-narration-<version>.zip (slice 3)
.github/workflows/release.yml        uploads the narration zip and its SHA256SUMS line (slice 3)
plugins/dg/skills/demo/SKILL.md      local default, Flags table, under 110 lines
plugins/dg/skills/demo/references/extension.md   --ext material moved out of SKILL.md
docs/adr/0029-shared-tour-ui-and-local-player.md, docs/adr/toc.md
```

## Code sample: `dg-skills demo tour.md` end to end

```ts
// pkg/tour-ui/src/host.ts
export type TourMessage =
 | { kind: "choice"; mode: TourMode; narration: NarrationMode; voice: string; includeSetup: boolean }
 | { kind: "progress"; index: number }
 | { kind: "download-plan"; markdown: string }
 | { kind: "clip"; index: number; sampleRate: number; pcm: string }
 | { kind: "done" | "stopped" }
 | { kind: "error"; message: string };

export type TourHost = {
 storage: {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
 };
 messages: { send(msg: TourMessage): Promise<unknown>; on(handler: (msg: TourMessage) => void): () => void };
 mountUi(name: string, onMount: (root: HTMLElement) => void): Promise<{ remove(): void }>;
 tabKey(): string;
};
```

```ts
// pkg/tour-ui/src/hosts/player-entry.ts (built to dist/player.js, injected by Playwright)
import { runTour } from "../player";
import type { TourHost, TourMessage } from "../host";
import type { TourScript } from "@dg/common";

declare global {
 interface Window {
  __dgDemoBridge: (msg: unknown) => Promise<unknown>;
  __dgTour: { run(script: TourScript, opts: { autopilot?: boolean }): Promise<void> };
 }
}

const host: TourHost = {
 storage: {
  get: (key) => window.__dgDemoBridge({ kind: "storage-get", key }) as Promise<any>,
  set: (key, value) => window.__dgDemoBridge({ kind: "storage-set", key, value }).then(() => undefined),
  remove: (key) => window.__dgDemoBridge({ kind: "storage-remove", key }).then(() => undefined),
 },
 messages: { send: (msg: TourMessage) => window.__dgDemoBridge(msg), on: () => () => undefined },
 async mountUi(name, onMount) {
  const el = document.createElement("div");
  el.id = `dg-${name}`;
  const root = el.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  root.appendChild(container);
  document.documentElement.appendChild(el);
  onMount(container);
  return { remove: () => el.remove() };
 },
 tabKey: () => "local",
};

window.__dgTour = { run: (script, opts) => runTour(host, script, opts).then((r) => host.messages.send(r.outcome === "done" ? { kind: "done" } : r.outcome === "stopped" ? { kind: "stopped" } : { kind: "error", message: r.error ?? "" })) };
```

```ts
// pkg/skills-cli/src/demo/local.ts
export async function playLocal(script: TourScript, opts: LocalOpts): Promise<number> {
 const plan = await resolveBrowserPlan(opts);
 if (plan.kind === "missing") {
  process.stderr.write(`${plan.message}\n`);
  return 3;
 }
 if (plan.headless && !opts.video) {
  process.stderr.write("demo: the start screen needs a visible browser; pass --video for an unattended recording, or --windows / --wsl-headed\n");
  return 2;
 }
 const slug = slugify(script.title ?? "demo");
 const dir = join(demosDir(), slug);
 const planPath = savePlan(script, dir);
 const job: PlayerJob = { slug, dir, planPath, script, plan, video: !!opts.video, out: opts.out, timeoutMin: opts.timeout ?? 30 };
 const log = openSync(join(dir, "player.log"), "a");
	const [cmd, ...args] = programCommand("dg-skills", ["demo", "__player", JSON.stringify(job)]);
	const child = spawn(cmd, args, { detached: true, stdio: ["ignore", log, log] });
 child.unref();
 console.log(`demo "${script.title ?? slug}": ${opts.video ? "recording" : "start screen open"} in ${plan.label}. ${opts.video ? "" : "The human picks there. "}Results: dg-skills demo status ${slug}`);
 return 0;
}
```

```ts
// pkg/skills-cli/src/demo/player-process.ts
export async function main(job: PlayerJob): Promise<number> {
 const { chromium } = await import("playwright-core");
 const browser = job.plan.mode === "windows"
  ? await chromium.connectOverCDP(job.plan.cdpUrl)
  : await chromium.launch({ executablePath: job.plan.executablePath, channel: job.plan.channel, headless: job.plan.headless });
 const context = await browser.newContext({
  recordVideo: job.video ? { dir: join(job.dir, "rec"), size: { width: 1280, height: 720 } } : undefined,
  viewport: { width: 1280, height: 720 },
 });
 const state = new Map<string, unknown>();
 const bridge = createBridge({ job, state, onDone: (outcome) => finish(outcome) });
 const page = await context.newPage();
 await page.exposeBinding("__dgDemoBridge", (_src, msg: unknown) => bridge.handle(msg));
 await page.addInitScript(`${playerScript()}\n`);
 await page.goto(job.script.startUrl);
 await page.evaluate(([script, video]) => window.__dgTour.run(script, { autopilot: video }), [job.script, job.video] as const);
 const outcome = await Promise.race([bridge.done, timeout(job.timeoutMin * 60_000).then(() => "stopped" as const)]);
 await context.close();
 const video = job.video ? await moveVideo(join(job.dir, "rec"), job.out ?? join(job.dir, `${job.slug}-${stamp()}.webm`)) : undefined;
 writeResult({ slug: job.slug, outcome, mode: job.video ? "video" : "walkthrough", steps: job.script.steps.length, video, plan: job.planPath, startedAt: bridge.startedAt, endedAt: new Date().toISOString() });
 await browser.close();
 return outcome === "error" ? 1 : 0;
}
```

`bridge.ts` answers `storage-get/set/remove` from the map (so a `navigate` step resumes on the next page load, where `addInitScript` has already re-installed the player), persists `choice` to `choice.json`, writes `download-plan` markdown next to the saved plan, and resolves `done` when the tour ends. `main()` keeps the process alive through the pending `bridge.done` promise; the dispatcher's `exitAfterDrain` flushes the final lines.

## Flags table (SKILL.md draft rows)

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--ext` | none | Play through the dg-ai-extension in the user's real browser (today's flow). Needs the extension. | off (local is the default) |
| `--video` | none | Record now with no start screen; works with a headless browser. | off (start screen) |
| `--out <path>` | none | Where the video file goes. | `<dataDir>/demos/<slug>/<slug>-<ts>.webm` |
| `--browser <name>` | none | `chrome`, `msedge` or `chromium`; skips the system-first pick. | first found |
| `--windows` | none | WSL: drive the Windows-side browser over CDP. | on when a Windows browser exists |
| `--wsl-headed` | none | WSL: headed browser inside WSL (experimental). Never pass it unless the human asks. | off |
| `--narration <mode>` | none | `both`, `voice` or `captions` for a `--video` run with no start screen (slice 3). | saved choice, else `captions` |
| `--verify <plan>` | none | Walk the plan and print findings JSON. Local unless `--ext`. | off |
| `--print` | none | `--ext` only: print the marker URL. | off |
| `--edit` | none | `--ext` only: open the review panel first. Locally the start screen always offers Review. | off |

## Size, speed and token impact

- Size: `dist/player.js` about 60 to 90 KB minified (the built extension content script is 77 KB and the player drops marker capture and the recorder listener) inside the demo chunk; `playwright-core` is already in the bundle for verify and loads only when the demo or pw chunk runs. Narration assets (23 MB) and the model (86 MB) are fetched on demand into the data dir and the browser profile, never into the bundle. The extension gains nothing; `pkg/tour-ui` is shared source.
- Speed: `dg-skills demo --help` is a lazy chunk (no change to `--version` or `stash`); `demo tour.md` returns in under 5 s after spawning the player; the size-budget test asserts the stash chunk does not include `player.js`.
- Tokens: demo SKILL.md goes from 118 lines (7.3 KB) to under 110 lines with the `--ext` material in references/extension.md; the default command prints two lines; `demo status` prints one JSON line.

## Risks

- `recordVideo` over `connectOverCDP` (WSL Windows mode) is unverified. Slice 2 contract: if the context rejects `recordVideo`, `--video` falls back to a headless local Chromium with one printed line. Signal: the WSL e2e test.
- Extraction size: moving 2000 lines out of `demo-tour.ts` is the riskiest slice, so it goes first; its gate is the unchanged extension test suite plus a manual tour in Chrome.
- Headed browser lifetime: the player process must survive the agent's shell exiting (detached, stdio to a log). Signal: the spawn-seam test and the e2e run from a subshell.
- Narration alignment: step start offsets come from `progress` timestamps on the CLI side, so audio drift is bounded by one bridge round trip per step (tens of ms).

## ADR 0029 draft: Shared tour UI and a local player

Status: Proposed. Context: the tour overlay, start screen and editor lived only in the extension's content script, so a demo needed the extension; the local-default rule (ADR 0028) needs the same UI outside it. Decision: extract the DOM-only tour UI into `pkg/tour-ui` behind `TourHost`; the extension and a Playwright-injected player are two hosts of one implementation; the player is an IIFE text asset in the demo chunk; the CLI detaches a player process and reports through a result file; narration runs in the page with on-demand assets and a sidecar WAV. Alternatives rejected: a duplicate overlay in the CLI; injecting the WXT content script; Kokoro in Bun through onnxruntime-node (208 MB). Consequences: one UI to test; the extension content script shrinks; `--ext` remains the path for tabCapture video in the user's own browser. Links: `pkg/tour-ui/src/host.ts`, `pkg/skills-cli/src/demo/player-process.ts`. Diagram: sequence `dg-skills demo -> __player -> page (player.js) -> bridge -> result.json`. Numbering assumes ADRs 0024 to 0027 from bundles 007, 008, 011 and 012 land first.

## Open questions

- RATIFIED (see Agent Notes): local narration — (A) captions-only in local mode for now, silent video, voice stays an `--ext` feature; (B) Kokoro in the page over WASM, assets as a 23 MB release zip fetched on first voiced run, model from Hugging Face as today, sidecar WAV plus `ffmpeg` mux when present; (C) Kokoro in Bun through onnxruntime-node (208 MB download, one more native dependency) — recommend B: it reuses the extension's exact TTS path, keeps the bundle lean, and the WAV sidecar is the only honest answer to Playwright's silent video; A is the fallback if B's e2e proves flaky, and slice 3 is the whole cut.
- RATIFIED (see Agent Notes): where the video lands — `<dataDir>/demos/<slug>/` next to the plan (durable, one place to find a demo) vs the user's `~/Videos` (or Windows `Videos` on WSL) vs `Downloads/dg-demo/` as the extension does — recommend the demos dir with `--out` for the rest; `demo status` prints the path either way.

## Chain position

- Branch `feat/demo-local-default`. After A (009: `pickLaunch`, `wslPlan`, `installBrowser` in `pkg/skills-cli/src/pw/browsers.ts`) and after 014 (`ext-flag.ts`, the flag-aware guard, `extOnlyChecks`, the lint allowlist this bundle shrinks). 016 follows this bundle: both own root `package.json`, `pkg/launcher/build.ts`, `pkg/extension/__tests__/**`, the skills README, `ext-opt-in.spec.ts`, `installed-skill-files.ts` and the install docs.
- Slice 1 (`pkg/tour-ui`) touches only the extension and the new package, so it can start before A merges; slices 2 to 4 need A.
