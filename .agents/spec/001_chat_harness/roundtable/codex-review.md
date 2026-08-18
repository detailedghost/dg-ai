# Codex independent spec review

I had no `AskUserQuestion`, so I reviewed self-serve. One-way protocol/data choices remain explicit `⚑ RATIFY` items rather than assumed decisions.

## New findings

1. [CONTRACT] The “shared session handle” is two incompatible records — the marker needs `port/sessionId/token/agentIdentity`, while the singleton daemon lockfile is specified as `pid/port/version`; one lockfile cannot represent many session handles, and putting a bearer token there would widen exposure (`plan.md:129`, `plan.md:159`, `plan.md:450`). Split this into validated `DaemonHandle` and `SessionBootstrap` types; the lockfile must never contain session tokens. **⚑ RATIFY:** approve the split — recommendation: yes, because cardinality and secrecy differ.

2. [AUTHORIZATION] “Every frame carries the token” incorrectly applies a bearer credential to server-to-page traffic and still does not define how one socket becomes authorized for many sessions (`plan.md:93-94`, `plan.md:126`, `plan.md:245-246`). Echoing tokens on every outbound frame increases leakage without authenticating anything. Bind an authenticated socket to an explicit `sessionId → token` capability set; validate the exact pair on every inbound frame, add capabilities only through a newly captured bootstrap or authenticated session-create response, and omit tokens from ordinary outbound frames. One session token must never enumerate/control unrelated sessions. **⚑ RATIFY:** this directional wire contract is a one-way door — recommendation: capability-set model, not “any valid token unlocks the daemon.”

3. [BUILD/SCOPE] No slice owns the root lockfile update required by the new workspace package. The root uses `workspaces: ["pkg/*"]` (`package.json:4`), current workspace entries are frozen in `bun.lock:3-57`, and CI installs with `--frozen-lockfile` (`.github/workflows/skills-blt.yml:24-25`). Add `bun.lock` to slice 2’s files and acceptance; otherwise the first mirrored server workflow fails before lint/test.

4. [CONTRADICTION/OWNERSHIP] Slice 4 cannot simply make the toolbar reopen chat. `registerRecording` already owns `chrome.action.onClicked`, starting a pending recording or opening settings (`pkg/extension/lib/background/recording.ts:261-270`), while `wxt.config.ts:60-63` labels the action “DeeGee settings”; `recording.ts` is absent from slice 4’s files (`plan.md:36`), and recorder behavior is excluded (`plan.md:115`). Two listeners would both act. Route the existing fallback centrally: preserve pending-recording start, otherwise open chat (with settings reachable separately), and add `recording.ts` plus a regression test to slice 4.

5. [SECURITY] Untrusted agent/user text has no rendering contract. Slice 5 merely says “rendering whole agent messages” (`plan.md:248`); an `innerHTML`/Markdown implementation would give transcript content extension-page script privileges, including access to session tokens and `$` dispatch. Existing UI deliberately uses `textContent` for authored prose (`pkg/extension/lib/features/demo-tour.ts:1346`). Require plain-text rendering by default; if Markdown is desired, sanitize at the browser boundary and prohibit raw HTML/event handlers/javascript URLs. Test hostile HTML, links, and code fences. Structured asset references must not be parsed from arbitrary message HTML.

6. [SECURITY/TRANSPORT] The daemon-authoritative options write has no owned or authenticated transport. Scope names only `/start` and assets over HTTP (`plan.md:94`), yet the options page must mutate daemon config (`plan.md:367`, `plan.md:478-483`), and slice 1 has no config frames. A tokenless loopback POST is CSRF-able by any website. **⚑ RATIFY:** choose authenticated WebSocket config get/set frames (recommended; reuses the only real credential and `{ok,error}` convention) or a token-authenticated JSON HTTP endpoint that rejects simple/form requests and enforces Host/Origin as defense in depth. Add the protocol owner and tests before slice 9.

7. [SECURITY/TESTABILITY] No bound exists for WebSocket payloads, message bodies, manifest size, or asset upload size before parsing/persistence (`plan.md:124-143`, `plan.md:343`). A token-bearing or compromised page can exhaust daemon memory without invoking `$`. Put fixed v1 limits in shared constants, enforce transport size before JSON parsing and field sizes in validators, return a distinct oversized error, and test rejection without DB side effects. Do not add per-entry/per-session tuning yet.

8. [GRAPH/VERIFICATION] Cross-package acceptance has no test owner or runnable harness. Slice 2’s browser/WebSocket AC requires slices 4-5 (`plan.md:178`); slice 4’s live chat page requires slice 6 (`plan.md:237-239`); slice 7’s page/canvas ACs require slices 5-6 (`plan.md:331-332`); slice 9’s image render requires slices 5-6 (`plan.md:385`). Existing CI only runs package lint/test/build (`.github/workflows/ext-blt.yml:21-35`, `.github/workflows/skills-blt.yml:24-45`). Move these to a final slice-10 integration checklist with an owned browser harness/manual WSL probe; keep each earlier slice’s AC at its actual seam. Adding false `depends_on` edges would sequence work but would not make the criteria observable.

9. [GRAPH] Slice 8’s missing `[5,6]` dependencies are real, but slice 7 has the same category of error in its acceptance, not its implementation. `spawn` and manifest publication can remain `[2,3]`; “page receives autocomplete manifest” and “canvas shows attributed nodes” must move to slices 8/10 rather than forcing slice 7 to depend on UI (`plan.md:56-57`, `plan.md:331-332`). This preserves parallelism and honest ownership.

10. [SECURITY/ASSETS] Active content served from the daemon origin can become same-origin script. Inline SVG/HTML must not be accepted merely because a MIME lookup recognizes it. Restrict inline rendering to safe raster types, set `X-Content-Type-Options: nosniff`, use attachment disposition for everything else, and authenticate asset retrieval via `fetch` with the session token header followed by a blob URL—not a bearer token in an `<img>` query string (`plan.md:368`, `plan.md:375-376`).

## Corrections to existing reviews

1. slice-2.md item 3 is over-scoped because fixed-port probing plus unauthenticated `/health` replaces the explicit OS-assigned-port design to satisfy one impossible restart AC — correct position is to narrow slice 5’s AC to same-process reconnect and require a fresh `dg:start` bootstrap after daemon restart.

2. slice-2.md item 16 overstates TOFU pinning: a token-authenticated first connection cannot make origin a second credential, and Firefox reinstall invalidates the pin — correct position is scheme/Origin and Host checking as defense in depth, with the session token explicitly the sole access control.

3. slice-3.md items 5-6 recommend envelope encryption/key rotation prematurely — correct v1 position is one permanent database key, a non-secret key fingerprint to fail safely on mismatch, and documented delete/recreate recovery; defer rekey machinery until rotation is a requirement.

4. slice-7.md item 6 invents a manifest-update verb for “on change” — correct position is to delete “and on change” in bundle 1 and publish the validated snapshot on registration/reconnect; dynamic discovery belongs to bundle 2.

5. slice-8.md item 14 overstates publish-time executable resolution: it cannot prevent replacement after validation and conflicts with the required invocation-time missing-binary result — correct position is validate/refuse obvious bad targets at publish, then resolve/spawn/catch on every invocation.

6. slice-9.md item 3 is wrong that query-string credentials are forced; extension code can authenticated-`fetch` bytes and render a blob URL — correct position avoids placing the command-capable session token in URLs. Item 13 is unsafe to include SVG in the inline-image allowlist.

7. slice-6.md item 6 is scaling for ghosts: IntersectionObserver lazy mounting, DOM caps, and compositor management for hypothetical 20–30 nodes add failure modes before measured need — correct position is plain DOM plus bounded message backfill; profile before virtualizing.

## Reviewer disagreements resolved

1. slice-2 vs slice-7 on CLI transport — slice-2 wins: a short-lived `/cli` WebSocket reuses framing/auth and naturally supports the specified 300-second block; HTTP long-poll needs special timeout behavior.

2. slice-1 vs slice-9 on asset references — slice-1 wins: a structured attachment/asset-id field is safer and evolvable; a magic URI embedded in encrypted prose creates parsing, escaping, and rendering coupling.

3. slice-2 vs slice-6 on closing nodes — slice-2 wins: `session closed` already exists and slice 9 promises cleanup on session end, so “close” must be a real terminal session transition, not a local hide that resurrects on reload.

4. slice-2 vs slice-5 on restart discovery — slice-5 option (b) wins: keep OS-assigned ports and narrow reconnect semantics; fixed discovery ports buy optional convenience by expanding the unauthenticated surface.

## Verdict

Not ready to execute: resolve the capability model and three `⚑ RATIFY` wire/data decisions, repair ownership/graph gaps, then build; the settled transport/store choices themselves remain sound.
