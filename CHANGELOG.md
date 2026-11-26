# Changelog

## Unreleased

### Features

- feat(dg): run a native front door at `dg` by default; it answers `--version`, built-in hooks, completion, `config get|set|list|doctor` and `plugin list|verify` itself and runs the Bun program, now `dg-core`, for every other command; opt out with `DG_FRONT=0` or `front.enabled = false`, and go back to Bun-only with `DG_FRONT=0 dg install`; see [docs/install.md](docs/install.md#install-layout)
- feat(release): ship each program as `.zst` and `.gz` next to the raw file, update with a zstd patch from the previous release, and download the `pw` and `db` companions on first use with a sha256 check
- feat(plugin): add `dg plugin` to list, add, remove, enable, disable, update and verify plugins; a plugin stays untrusted until you approve it; see [docs/plugin-protocol.md](docs/plugin-protocol.md)
- feat(pw): pick the browser per call with `browser.mode = auto` as the new default: a call goes to the real browser through the extension when it is paired and the verb has an ext verb, else to local Playwright; see [docs/pw.md](docs/pw.md)
- feat(extension): add 24 `dg pw --ext` verbs, including `eval`, typing, checkboxes, `resize` and storage writes, behind new safety rules; see [ADR 0060](docs/adr/0060-pw-auto-mode-and-ext-verbs-for-the-real-browser.md)
- docs(dev): add the `native/` build for Linux, macOS and Windows to [docs/DEVELOPER.md](docs/DEVELOPER.md#native-the-c-front-door) and the lean gates to [docs/lean-baseline.md](docs/lean-baseline.md)

### Breaking

- feat(pw)!: a browser binary path in `DG_BROWSER` now makes `dg pw` stop with `DG_BROWSER must be ext, local or auto`. Set the path in `DG_VERIFY_BROWSER` instead; `demo` and `verify` read it from there

## v7.0.5 (2026-11-24)

### Fixes

- perf(launcher): run every dg command without the JIT ([#255](https://github.com/detailedghost/dg-ai/pull/255))

## v7.0.4 (2026-11-24)

### Fixes

- perf(launcher): cut dg peak RSS and gate it in CI ([#254](https://github.com/detailedghost/dg-ai/pull/254))

## v7.0.3 (2026-11-24)

### Fixes

- fix(proto): say recording in progress, not interrupted, while wait reads the layout ([#252](https://github.com/detailedghost/dg-ai/pull/252))

## v7.0.2 (2026-11-24)

### Fixes

- fix(proto): enforce a waiter, claim signed in, and print the pick first ([#251](https://github.com/detailedghost/dg-ai/pull/251))

## v7.0.1 (2026-11-22)

### Fixes

- fix(update): finish a 6.0 or 6.1 self-update from the new bundle ([#250](https://github.com/detailedghost/dg-ai/pull/250))

## v7.0.0 (2026-11-21)

### Breaking

- feat(dg)!: ship one compiled dg with flat commands and remove the old names ([#248](https://github.com/detailedghost/dg-ai/pull/248))

### Fixes

- fix(launcher): run the compiled dg entry without an import.meta.main guard ([#249](https://github.com/detailedghost/dg-ai/pull/249))

## Unreleased

### Breaking

- feat(dg)!: ship one compiled `dg` program with flat commands; `dg-skills`, `dg-agent` and `dg-daemon` are removed, so run `dg <command>` (daemon lifecycle verbs stay under `dg daemon`, agent session verbs under `dg agent`); upgrade a 6.3 or 6.4 install with `dg upgrade` and see [docs/install.md](docs/install.md#upgrade-from-63)

## v6.4.0 (2026-11-21)

### Features

- feat(config): keep dg settings in one config.toml ([#247](https://github.com/detailedghost/dg-ai/pull/247))

## v6.3.1 (2026-11-21)

### Fixes

- fix(release): build chat skill zips in Bun ([#246](https://github.com/detailedghost/dg-ai/pull/246))

## v6.3.0 (2026-11-20)

### Features

- feat(dg-daemon): add jobs from a repository or a local path, with credential setup ([#245](https://github.com/detailedghost/dg-ai/pull/245))

## v6.2.0 (2026-11-20)

### Features

- feat(skills-cli): guided database connection setup ([#243](https://github.com/detailedghost/dg-ai/pull/243))
- feat(web): web-only skills for Claude chat and a --web-only install ([#212](https://github.com/detailedghost/dg-ai/pull/212))

### Fixes

- fix(chat): sync dg-proto with the proto template ([#244](https://github.com/detailedghost/dg-ai/pull/244))
- fix(skills-cli): fix Velora dg 6.1.0 rough edges ([#242](https://github.com/detailedghost/dg-ai/pull/242))

## v6.1.1 (2026-11-20)

### Fixes

- fix(pw): launch the Chromium-family browser that pw finds ([#241](https://github.com/detailedghost/dg-ai/pull/241))

## v6.1.0 (2026-11-20)

### Features

- feat(skills): track .agents as agent memory ([#237](https://github.com/detailedghost/dg-ai/pull/237))

## v6.0.0 (2026-11-19)

### Breaking

- feat(pw)!: fold the browser skill into pw ([#236](https://github.com/detailedghost/dg-ai/pull/236))

## v5.18.0 (2026-11-19)

### Features

- feat(dg-daemon): merge services and scheduled jobs into jobs ([#234](https://github.com/detailedghost/dg-ai/pull/234))

## v5.17.0 (2026-11-19)

### Features

- feat(adr): add the decision records tool ([#235](https://github.com/detailedghost/dg-ai/pull/235))

## v5.16.0 (2026-11-19)

### Features

- feat(dg-daemon): run only one daemon per user and stop test leaks ([#233](https://github.com/detailedghost/dg-ai/pull/233))

## v5.15.0 (2026-11-19)

### Features

- feat(channel-review): send only the GIF for a ~fun reply ([#232](https://github.com/detailedghost/dg-ai/pull/232))

## v5.14.0 (2026-11-19)

### Features

- feat(channel-review): register each watched chat with Orion Belt ([#229](https://github.com/detailedghost/dg-ai/pull/229))

### Fixes

- fix(channel-review): start the daemon through the dg-skills program ([#231](https://github.com/detailedghost/dg-ai/pull/231))

## v5.13.2 (2026-11-19)

### Fixes

- fix(extension): put batch tabs in pos order when a tab moves right ([#230](https://github.com/detailedghost/dg-ai/pull/230))

## v5.13.1 (2026-11-19)

### Fixes

- fix(dg-daemon): close the follow-ups of the dg program PR ([#228](https://github.com/detailedghost/dg-ai/pull/228))

## v5.13.0 (2026-11-19)

### Features

- feat(dg): add the dg program, daemon autostart and the test home fence ([#227](https://github.com/detailedghost/dg-ai/pull/227))

## v5.12.1 (2026-11-18)

### Fixes

- fix(extension): type pw --ext fill key by key ([#224](https://github.com/detailedghost/dg-ai/pull/224))
- fix(extension): fail fast when pw --ext screenshot cannot capture ([#223](https://github.com/detailedghost/dg-ai/pull/223))

## v5.12.0 (2026-11-17)

### Features

- feat(pw): press a key with pw --ext press ([#221](https://github.com/detailedghost/dg-ai/pull/221))

### Fixes

- fix(extension): move the agent banner to a bottom-left pill ([#219](https://github.com/detailedghost/dg-ai/pull/219))
- fix(extension): keep masked Web MCP JSON valid and hide the Outlook name in snapshots ([#218](https://github.com/detailedghost/dg-ai/pull/218))
- fix(extension): search Outlook mail with a subject restriction ([#220](https://github.com/detailedghost/dg-ai/pull/220))

## v5.11.4 (2026-11-17)

### Fixes

- fix(extension): post to /owa/service.svc on outlook.live.com with no account index ([#217](https://github.com/detailedghost/dg-ai/pull/217))

## v5.11.3 (2026-11-16)

### Fixes

- fix(proto): sign in before the acceptance layout capture ([#216](https://github.com/detailedghost/dg-ai/pull/216))
- fix(proto): add More versions to the copied decision bars ([#215](https://github.com/detailedghost/dg-ai/pull/215))

## v5.11.2 (2026-11-15)

### Fixes

- fix(common): land final follow-ups for process kill, install marker, file lock, relay secret and SQLite ([#214](https://github.com/detailedghost/dg-ai/pull/214))

## v5.11.1 (2026-11-15)

### Fixes

- fix(inbox): stop headless Proton runs from falsely reporting signed out ([#213](https://github.com/detailedghost/dg-ai/pull/213))

## v5.11.0 (2026-11-15)

### Features

- feat(extension): run Web MCP tools on the person's own tabs ([#210](https://github.com/detailedghost/dg-ai/pull/210))

## v5.10.0 (2026-11-14)

### Features

- feat(extension): Outlook mail Web MCP tools (spec 018 mail area) ([#208](https://github.com/detailedghost/dg-ai/pull/208))

## v5.9.0 (2026-11-14)

### Features

- feat(extension): add the Web MCP area approval class ([#209](https://github.com/detailedghost/dg-ai/pull/209))

## v5.8.1 (2026-11-14)

### Fixes

- fix(skills): retarget child PRs before /dg:land merges ([#206](https://github.com/detailedghost/dg-ai/pull/206))

## v5.8.0 (2026-11-14)

### Features

- feat(pw): save sign-in values without showing them, and read storage ([#198](https://github.com/detailedghost/dg-ai/pull/198))

## v5.7.0 (2026-11-14)

### Features

- feat(extension): split settings into tabs on a full-page options tab ([#201](https://github.com/detailedghost/dg-ai/pull/201))
- feat(extension): separate Web MCP approvals from pw --ext ([#196](https://github.com/detailedghost/dg-ai/pull/196))
- feat(extension): restyle the agent banner as a top strip ([#194](https://github.com/detailedghost/dg-ai/pull/194))
- feat(skills): add /dg:land and end spec builds with it ([#203](https://github.com/detailedghost/dg-ai/pull/203))
- feat(extension): allow pw --ext sites per registrable domain ([#191](https://github.com/detailedghost/dg-ai/pull/191))
- feat(pw): read agent tab network calls with pw --ext network ([#195](https://github.com/detailedghost/dg-ai/pull/195))
- feat(skills-cli): add bash, zsh and fish completion ([#197](https://github.com/detailedghost/dg-ai/pull/197))
- feat(stat): reap leftover agent processes and stop stuck loops ([#192](https://github.com/detailedghost/dg-ai/pull/192))

### Fixes

- fix(extension): pass the full tool to WebMCP executeTool ([#205](https://github.com/detailedghost/dg-ai/pull/205))
- fix(extension): reuse the agent tab group after an extension reload ([#200](https://github.com/detailedghost/dg-ai/pull/200))
- fix(extension): mask the Outlook account name in pw --ext page titles ([#199](https://github.com/detailedghost/dg-ai/pull/199))
- fix(address): handle escape sequences in CI job logs ([#204](https://github.com/detailedghost/dg-ai/pull/204))
- fix(skills-cli): add stat reap and loops to the completion tree ([#202](https://github.com/detailedghost/dg-ai/pull/202))

## v5.6.1 (2026-11-13)

### Fixes

- fix(inbox): retry Proton sign-in eval across redirect navigation ([#190](https://github.com/detailedghost/dg-ai/pull/190))

## v5.6.0 (2026-11-13)

### Features

- feat(dg-daemon): supervise outside services with service add and a service API ([#173](https://github.com/detailedghost/dg-ai/pull/173))

## v5.5.1 (2026-11-13)

### Fixes

- fix(phone): case-insensitive vault and credential names ([#189](https://github.com/detailedghost/dg-ai/pull/189))
- fix(phone): keep roster names live and add a roster switch ([#188](https://github.com/detailedghost/dg-ai/pull/188))

## v5.5.0 (2026-11-13)

### Features

- feat(phone): exchange agent rosters on setup, self-name from session, clear on hang-up ([#185](https://github.com/detailedghost/dg-ai/pull/185))
- feat(extension): add Stop for driving sessions to the toolbar popup ([#186](https://github.com/detailedghost/dg-ai/pull/186))

## v5.4.0 (2026-11-13)

### Features

- feat(pw): show "Agent is driving" with Stop, and a per-session site allowlist ([#184](https://github.com/detailedghost/dg-ai/pull/184))

## v5.3.0 (2026-11-13)

### Features

- feat(pw): handle page dialogs in pw --ext ([#183](https://github.com/detailedghost/dg-ai/pull/183))

## v5.2.1 (2026-11-13)

### Fixes

- fix(pw): close the open pw --ext redaction and grant gaps ([#181](https://github.com/detailedghost/dg-ai/pull/181))

## v5.2.0 (2026-11-13)

### Features

- feat(thrash): add checkout, investigate, verify and consolidate stages to reviews ([#177](https://github.com/detailedghost/dg-ai/pull/177))

### Fixes

- fix(phone): make contacts remove clear about groups, npub and kept messages ([#179](https://github.com/detailedghost/dg-ai/pull/179))
- fix(proto): refingerprint keeps no stale prior.shots after a failed repair ([#178](https://github.com/detailedghost/dg-ai/pull/178))

## v5.1.1 (2026-11-12)

### Fixes

- fix(extension): keep the Outlook Web MCP built-in off until its script ships ([#176](https://github.com/detailedghost/dg-ai/pull/176))

## v5.1.0 (2026-11-12)

### Features

- feat(extension): Web MCP dg tools, approval, script registry and dg-agent mcp ([#167](https://github.com/detailedghost/dg-ai/pull/167))

## v5.0.0 (2026-11-12)

### Breaking

- refactor(layout)!: one layout module for all dg state ([#152](https://github.com/detailedghost/dg-ai/pull/152))

### Features

- feat(pw): browser-approved unmask and select/date/time fill for pw --ext ([#166](https://github.com/detailedghost/dg-ai/pull/166))
- feat(verify): gate verify on the accepted prototype layout ([#133](https://github.com/detailedghost/dg-ai/pull/133))

## v4.2.0 (2026-11-12)

### Features

- feat(deps-upgrade): default the cooldown to 0 and read DG_DEPS_COOLDOWN_DAYS ([#119](https://github.com/detailedghost/dg-ai/pull/119))

### Fixes

- fix(install): close the minor review notes from the bundle and layout PRs ([#138](https://github.com/detailedghost/dg-ai/pull/138))

## v4.1.0 (2026-11-11)

### Features

- feat(stat): show the checklist in plan order ([#170](https://github.com/detailedghost/dg-ai/pull/170))

## v4.0.0 (2026-11-10)

### Breaking

- feat(demo)!: record local demos with a Node Playwright recorder ([#160](https://github.com/detailedghost/dg-ai/pull/160))

### Features

- feat(skills-cli): add dg-skills skill audit and split ([#168](https://github.com/detailedghost/dg-ai/pull/168))

## v3.1.0 (2026-11-09)

### Features

- feat(pw): add pw --ext count, --session, and a verb handshake ([#164](https://github.com/detailedghost/dg-ai/pull/164))
- feat(skills-cli): add dg-skills update and the /dg:update skill ([#162](https://github.com/detailedghost/dg-ai/pull/162))
- feat(skills-cli): interactive dg-skills doctor ([#163](https://github.com/detailedghost/dg-ai/pull/163))

### Fixes

- fix(channel-review): add a setup step for a missing config ([#161](https://github.com/detailedghost/dg-ai/pull/161))

## v3.0.1 (2026-11-08)

### Fixes

- fix(demo): voice on strict-CSP pages and no REC badge in videos ([#159](https://github.com/detailedghost/dg-ai/pull/159))

## v3.0.0 (2026-11-08)

### Breaking

- feat(pairing)!: pair the CLI and extension with no codes ([#157](https://github.com/detailedghost/dg-ai/pull/157))

## v2.0.1 (2026-11-08)

### Fixes

- fix(pairing): close the deferred Known Issues from #155 ([#156](https://github.com/detailedghost/dg-ai/pull/156))

## v2.0.0 (2026-11-08)

### Breaking

- feat(extension)!: pair agents from a toolbar popup and drop the extension pages ([#155](https://github.com/detailedghost/dg-ai/pull/155))

## v1.43.0 (2026-11-06)

### Features

- feat(pw): drop the per-call approval popup for pw --ext ([#151](https://github.com/detailedghost/dg-ai/pull/151))

## v1.42.1 (2026-11-06)

### Fixes

- fix(hooks): point the Windows hook launcher at the dg-skills.cmd shim ([#149](https://github.com/detailedghost/dg-ai/pull/149))
- fix(phone): move the legacy phone home before any command opens the db ([#147](https://github.com/detailedghost/dg-ai/pull/147))

## v1.42.0 (2026-11-05)

### Features

- feat(pw): drive the real browser with pw --ext ([#143](https://github.com/detailedghost/dg-ai/pull/143))

## v1.41.0 (2026-11-05)

### Features

- feat(phone): add receipts, presence, ping, texting names, a PHI vault and agent extensions ([#142](https://github.com/detailedghost/dg-ai/pull/142))

## v1.40.0 (2026-11-05)

### Features

- feat(phone): send encrypted images over Wormhole and mark PHI ([#140](https://github.com/detailedghost/dg-ai/pull/140))

## v1.39.0 (2026-11-04)

### Features

- feat(spec): cost profiles, greedy slice build, --proxy and --bg ([#139](https://github.com/detailedghost/dg-ai/pull/139))

## v1.38.0 (2026-11-04)

### Features

- feat(install): add --with-recommended for pinned third-party plugins ([#137](https://github.com/detailedghost/dg-ai/pull/137))

## v1.37.0 (2026-11-04)

### Features

- feat(install): keep dg files in per-OS folders ([#136](https://github.com/detailedghost/dg-ai/pull/136))

## v1.36.0 (2026-11-03)

### Features

- feat(runtime): ship one pinned Bun runtime and one minified bundle ([#135](https://github.com/detailedghost/dg-ai/pull/135))

## v1.35.0 (2026-11-03)

### Features

- feat(install): prune stale dg plugin cache versions on install ([#132](https://github.com/detailedghost/dg-ai/pull/132))

## v1.34.2 (2026-11-03)

### Fixes

- fix(dg-daemon): require a credential for no-Origin service and job requests ([#131](https://github.com/detailedghost/dg-ai/pull/131))

## v1.34.1 (2026-11-03)

### Fixes

- fix(dg-daemon): refuse no-Origin requests without a token ([#130](https://github.com/detailedghost/dg-ai/pull/130))

## v1.34.0 (2026-11-03)

### Features

- feat(dg-daemon): serve the chat and board pages on loopback ([#129](https://github.com/detailedghost/dg-ai/pull/129))

## v1.33.0 (2026-11-02)

### Features

- feat(stat): order checklist by critical path and offer /dg:walk ([#127](https://github.com/detailedghost/dg-ai/pull/127))

## v1.32.2 (2026-11-02)

### Fixes

- fix(sdlc): stop checkbox and confirmation deferrals from blocking slice waves ([#126](https://github.com/detailedghost/dg-ai/pull/126))

## v1.32.1 (2026-11-02)

### Fixes

- fix(install): update the unpacked extension in place and retire the batch extension ([#125](https://github.com/detailedghost/dg-ai/pull/125))

## v1.32.0 (2026-11-02)

### Features

- feat(hooks): add an opt-in hook that removes AI co-author trailers ([#124](https://github.com/detailedghost/dg-ai/pull/124))

## v1.31.0 (2026-11-02)

### Features

- feat(demo): play demos locally without the extension ([#122](https://github.com/detailedghost/dg-ai/pull/122))

## v1.30.1 (2026-11-02)

### Fixes

- fix(meaningful): add --onto to rebuild a stacked branch on a reshaped parent ([#123](https://github.com/detailedghost/dg-ai/pull/123))

## v1.30.0 (2026-11-02)

### Features

- feat(prototype): pass the page through by default with a Responsive width ([#121](https://github.com/detailedghost/dg-ai/pull/121))

## v1.29.0 (2026-11-02)

### Features

- feat(prototype): add a More versions decision to the viewer bar ([#118](https://github.com/detailedghost/dg-ai/pull/118))

## v1.28.1 (2026-11-02)

### Fixes

- fix(inbox): block Proton mailbox changes on an account mismatch ([#117](https://github.com/detailedghost/dg-ai/pull/117))

## v1.28.0 (2026-11-02)

### Features

- feat(skills-cli): make the dg-ai-extension opt-in with --ext ([#115](https://github.com/detailedghost/dg-ai/pull/115))
- feat(hooks): add opt-in dg hooks for Claude, Codex and opencode ([#114](https://github.com/detailedghost/dg-ai/pull/114))
- feat(pw): port the pw browser skill into dg-skills ([#113](https://github.com/detailedghost/dg-ai/pull/113))

### Fixes

- fix(extension): stop old tab-group markers from re-grouping tabs ([#112](https://github.com/detailedghost/dg-ai/pull/112))

## v1.27.0 (2026-11-01)

### Features

- feat(phone): multi-party threads v1 ([#111](https://github.com/detailedghost/dg-ai/pull/111))
- feat(ssms): add Google Messages and Signal providers ([#107](https://github.com/detailedghost/dg-ai/pull/107))

### Fixes

- fix(phone): supervise the listener with open --ensure, widen catch-up, watch --new ([#109](https://github.com/detailedghost/dg-ai/pull/109))
- fix(phone): relay publish reliability and listener liveness ([#108](https://github.com/detailedghost/dg-ai/pull/108))

## v1.26.0 (2026-10-29)

### Features

- feat(verify): add /dg:verify round-based review board ([#97](https://github.com/detailedghost/dg-ai/pull/97))

## v1.25.2 (2026-10-29)

### Fixes

- fix(phone): reload invites without restarting the listener ([#96](https://github.com/detailedghost/dg-ai/pull/96))

## v1.25.1 (2026-10-29)

### Fixes

- fix(thrash): encode the GitLab target ref in file reads ([#103](https://github.com/detailedghost/dg-ai/pull/103))

## v1.25.0 (2026-10-29)

### Features

- feat(thrash): run the action in GitLab CI ([#102](https://github.com/detailedghost/dg-ai/pull/102))

### Fixes

- fix(phone): refuse an unnamed or colliding accept ([#98](https://github.com/detailedghost/dg-ai/pull/98))

## v1.24.0 (2026-10-28)

### Features

- feat(assign): one model and effort tier table ([#92](https://github.com/detailedghost/dg-ai/pull/92))

### Fixes

- fix(phone): remove the phone-friend alias as announced ([#101](https://github.com/detailedghost/dg-ai/pull/101))

## v1.23.0 (2026-10-28)

### Features

- feat(thrash): clear fixed findings and review only new work ([#94](https://github.com/detailedghost/dg-ai/pull/94))

### Fixes

- fix(install): keep the piped bootstrap script away from the installer ([#99](https://github.com/detailedghost/dg-ai/pull/99))
- fix(phone): move the phone-friend alias removal to 1.23.0 ([#100](https://github.com/detailedghost/dg-ai/pull/100))

## v1.22.0 (2026-10-28)

### Features

- feat(release): release automatically from conventional commits ([#95](https://github.com/detailedghost/dg-ai/pull/95))

### Fixes

- fix(install): replace the dg-skills binary by rename ([#89](https://github.com/detailedghost/dg-ai/pull/89))
