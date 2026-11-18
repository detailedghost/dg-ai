---
feature: "Local chat and overwatch pages served by dg-daemon, --ext for the extension pages"
feature_snake_case: local_chat_overwatch_pages
date: "2026-10-29"
version: "1.0"
status: complete
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "daemon-local-pages"
    agents:
      primary: dg:js
      qa: [dg:qa-code, dg:security]
    depends_on: []
    files: ["pkg/pages/**", "pkg/dg-daemon/src/server/http.ts", "pkg/dg-daemon/src/server/pages.ts", "pkg/dg-daemon/src/server/origin.ts", "pkg/dg-daemon/src/assets/**", "pkg/dg-daemon/__tests__/local-pages.spec.ts", "pkg/dg-daemon/__tests__/origin.spec.ts", "pkg/extension/lib/features/overwatch.ts", "pkg/extension/lib/features/chat-client.ts", "pkg/extension/lib/features/chat-connection.ts", "pkg/extension/entrypoints/chat/main.ts", "pkg/extension/entrypoints/overwatch/main.ts", "pkg/extension/wxt.config.ts", "pkg/extension/package.json", "pkg/extension/__tests__/chat-*.spec.ts", "pkg/extension/__tests__/overwatch-page.spec.ts", "pkg/launcher/build.ts", "package.json"]
  - id: 2
    name: "agent-open-skills-docs"
    agents:
      primary: dg:js
      qa: [dg:qa-code, dg:lore]
    depends_on: [1]
    files: ["pkg/dg-agent/src/start.ts", "pkg/dg-agent/src/index.ts", "pkg/dg-agent/src/overwatch.ts", "pkg/dg-agent/__tests__/start-open.spec.ts", "pkg/dg-agent/__tests__/overwatch-open.spec.ts", "pkg/skills-cli/src/require-extension/doctor.ts", "pkg/skills-cli/__tests__/cli-only.spec.ts", "plugins/dg/skills/chat/SKILL.md", "plugins/dg/skills/chat/references/extension.md", "plugins/dg/skills/overwatch/SKILL.md", "plugins/dg/skills/overwatch/references/extension.md", "plugins/dg/skills/inbox-cleanup/references/providers.md", "plugins/dg/skills/README.md", "pkg/skills-test/__tests__/ext-opt-in.spec.ts", "pkg/skills-test/__tests__/chat-skill.spec.ts", "pkg/skills-test/__tests__/overwatch-skill.spec.ts", "pkg/common/__tests__/installed-skill-files.ts", "docs/install.md", "docs/AGENT-INSTALL.md", "docs/chat.md", "docs/adr/0030-loopback-pages-for-chat-and-overwatch.md", "docs/adr/toc.md"]
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# Local chat and overwatch pages served by dg-daemon, --ext for the extension pages

## Purpose
chat and overwatch are the last two skills that require the dg-ai-extension. dg-daemon already holds every session, message and board row and serves a stub /start page on loopback; this bundle makes it serve the chat page and the live board itself, token-gated on 127.0.0.1, so `dg-agent start --open` and `dg-agent overwatch open` land in a plain browser tab by default. `--ext` keeps the extension side panel and board page. The lint allowlist from bundle 014 empties and no SKILL.md declares requires: [extension] any more. The loopback-origin model is a one-way door and is marked [DECIDED] until ratified.

## Scope
### Included
- dg-daemon: /chat and /board HTML pages with their JS built from the extension's page code into a pkg/pages workspace; loopback-origin plus session-token gate for the routes those pages call
- dg-agent: start --open and overwatch open target the local pages by default and the extension with --ext
- chat and overwatch skills: no requires line, flags table, require-extension only under --ext; lint allowlist emptied; docs; ADR 0030
### Excluded
- Inbox Proton operations (they need the MAIN-world observer in a signed-in tab; see bundle 014 Open questions)
- Extension pairing, /pair and the pinned-origin store (unchanged for --ext)
- Phone snapshot publication (dg-skills overwatch-snapshot is unchanged)
- Remote (non-loopback) access of any kind

### Slice 1 — daemon-local-pages

#### Engineering
- [x] pkg/pages (@dg/pages, private): the chat page (entrypoints/chat/main.ts and its lib/features/chat-* modules) and the board page (entrypoints/overwatch/main.ts and lib/features/overwatch.ts) move here behind a PageRuntime seam { sendMessage?, onMessage?, storage } that the extension implements with browser.* and the daemon page implements with window.localStorage and fetch; the extension entrypoints become thin imports and wxt.config.ts gains the @dg/pages alias next to @dg/common; the chat-*.spec.ts and overwatch-page.spec.ts suites keep passing against the moved modules; build.ts produces dist/chat.html, dist/board.html and one JS file each (Bun.build, iife, minify) and the daemon embeds them as text assets (import ... with { type: 'text' })
- [x] [DECIDED] origin.ts: requireLocalPageOrigin(req, port, token): accepts a request when Origin is `http://127.0.0.1:<port>` or `http://localhost:<port>` AND the request carries the session token (Authorization: Bearer <token> for fetch, the `token` query for the WebSocket upgrade); the existing requirePinnedExtensionOrigin stays for extension origins; a route accepts either gate; a missing or wrong token on a loopback origin returns 403 with no body detail
- [x] http.ts: GET /chat serves dist/chat.html (the page reads #_chat= from the fragment exactly as the extension does and connects to /ws with the token); GET /board serves dist/board.html; GET /overwatch and POST /overwatch/action accept requireLocalPageOrigin in addition to the pinned extension origin; CHAT_START_PATH keeps the stub for old extensions
- [x] Security headers for the two pages: Content-Security-Policy default-src 'none'; script-src 'self'; connect-src 'self' ws://127.0.0.1:<port>; style-src 'self' 'unsafe-inline'; img-src 'self' data:, plus X-Frame-Options DENY and the existing NOSNIFF_HEADERS
- [x] The board page polls GET /overwatch every 5 s with the token and posts actions to /overwatch/action; the chat page uses the existing WebSocket frames unchanged, so dg-agent send/recv need no change
- [x] pkg/launcher/build.ts runs pkg/pages/build.ts before the bundle so the text assets exist; a size-budget line keeps the two page assets under 150 KB combined (the built extension chat chunk is 26.5 KB today)

#### Testing Criteria
##### Contracts
- [x] Contract: GET /chat and GET /board return 200 text/html with the CSP header and no token (the pages are public shells; data needs the token)
- [x] Contract: GET /overwatch with Origin http://127.0.0.1:<port> and a valid Bearer token returns the board JSON; the same request with no token returns 403; with a wrong token returns 403; from Origin https://evil.example returns 400 as today
- [x] Contract: the WebSocket upgrade with a loopback Origin and ?token=<valid> is accepted; with a stale token it is refused before any frame
- [x] Contract: an extension-origin request with the pinned origin still passes both routes (no regression for --ext)
- [x] origin.spec.ts: localhost and 127.0.0.1 with a mismatched port are refused
- [x] pkg/pages tests: the chat page renders a transcript from a recorded frame sequence in happy-dom; the board page renders lanes from a board fixture; neither imports wxt or chrome
- [x] size-budget.spec.ts: chat.html + chat.js + board.html + board.js under 150 KB; the daemon chunk does not include kokoro or playwright

#### Acceptance Criteria
- [x] Given a running daemon and a session token, when the human opens http://127.0.0.1:<port>/chat#_chat=<b64>, then the chat page connects and shows the agent's messages without any extension installed
- [x] Given the board page open, when a chat runs `dg-agent overwatch set ...`, then the lane updates within 5 s

### Slice 2 — agent-open-skills-docs

#### Engineering
- [x] dg-agent start: the printed bootstrap URL becomes http://127.0.0.1:<port>/chat#_chat=<b64> by default; --ext prints today's /start URL and hands the session to the extension; --open opens whichever URL was chosen with tryOpen; --json carries the same url field
- [x] dg-agent overwatch open: default opens http://127.0.0.1:<port>/board#_token=<b64> with tryOpen; --ext sends cli-overwatch-open to the extension as today
- [x] chat/SKILL.md and overwatch/SKILL.md: remove requires: [extension]; description leads with the local page; Flags table with an --ext row (Default `off (local is the default)`); the bootstrap block keeps the dg-agent gate and drops the unconditional require-extension line; the --ext section is one line: `--ext only: dg-skills require-extension chat || exit 1` then `dg-agent start --ext --open`; the extension-specific notes (side panel attach, mirrored WSL networking for a Windows-side browser) move to references/extension.md
- [x] require-extension/doctor.ts: skillFilesCheck(['chat', 'overwatch']) stays; the extension checks are extOnlyChecks
- [x] ext-opt-in.spec.ts: PENDING_LOCAL_MODE becomes [] and the constant is removed; cli-only.spec.ts expects no skill with a requires line
- [x] docs/install.md table: every skill is local by default, --ext needs the extension; AGENT-INSTALL.md extension paragraph rewritten; docs/chat.md explains the local page and the token; skills README rows for chat and overwatch lead with the local page
- [x] ADR 0030 loopback pages: context (chat and overwatch needed an extension-origin UI; the daemon already owns the data), decision (serve the pages from the daemon on loopback; token plus loopback-origin gate; extension stays as the --ext path), alternatives rejected (terminal chat: the human and the agent share the terminal; keep --ext only: breaks the local-default rule), links to origin.ts and pages/build.ts, a sequence diagram browser -> dg-daemon -> dg-agent; toc entry

#### Testing Criteria
##### Contracts
- [x] start-open.spec.ts: `dg-agent start` prints a /chat#_chat= URL; `start --ext` prints the /start#_chat= URL; --open calls tryOpen with the printed URL (seam)
- [x] overwatch-open.spec.ts: `overwatch open` calls tryOpen with the /board URL; `overwatch open --ext` sends cli-overwatch-open and does not call tryOpen
- [x] chat-skill.spec.ts and overwatch-skill.spec.ts: description order local before --ext; no requires line; --ext row; the require-extension line contains --ext
- [x] ext-opt-in.spec.ts passes with an empty allowlist; cli-only.spec.ts `marks the skills that need the extension` expects []
- [x] installed-skill-files.ts lists chat/references/extension.md and overwatch/references/extension.md

#### Acceptance Criteria
- [x] Given a machine with dg-agent and dg-daemon and no extension, when an agent runs `dg-agent start --open`, then the chat page opens in the default browser and `dg-agent send hi` appears in it
- [x] Given the repo, when `bun test pkg/skills-test` runs, then no SKILL.md declares requires: [extension] and ext-opt-in.spec.ts has no allowlist

## Slice Summaries

## Agent Notes

- (slice 1, orchestrator) The orchestrator freed /tmp and ran bun install; bun.lock is updated in the worktree and goes into the slice commit. /tmp is a small RAM disk shared with other sessions: run every test and build with TMPDIR=/home/detailedghost/.cache/dg-test-tmp, and never run the whole dg-daemon suite at once; run its spec files in small groups.
- (slice 1, orchestrator) Accepted: the extension keeps per-key canvas positions in chrome.storage.local through the PositionArea seam; the daemon page stores them under one JSON key through runtime.storage.
- (slice 1, orchestrator) The Green stage re-runs what never ran: pkg/pages/__tests__/local-session.spec.ts, the dg-daemon specs in small groups, the pkg/extension suite, and tsc in pkg/pages, pkg/dg-daemon and pkg/extension.

- (slice 1, orchestrator) Use the Code sample's signature: requireLocalPageOrigin(req, url, port, isLiveToken) and export isLocalPageOrigin(origin, port). A local-page origin never pins the extension origin.
- (slice 1, orchestrator) The loopback gate accepts any live session token (registry.tokenIsLive). A missing, unknown or stale token on a loopback origin returns 403. A foreign Origin keeps today's 400.
- (slice 1, orchestrator) renderChatPage({ root, createClient, loadBootstraps }) in pkg/pages/src/chat/main.ts and renderOverwatchPage({ root, connect, now, schedule, cancel }) in pkg/pages/src/board/main.ts keep the extension's option names. The PageRuntime is optional, and storage is { get(key): string | null; set(key, value): void }.
- (slice 1, orchestrator) pkg/pages/build.ts exports buildPages() with no arguments and writes pkg/pages/dist/{chat,board}.{html,js}. In the Yellow stage, add a dg-daemon test preload shim that rebuilds when pkg/pages/src or pkg/common/src is newer than dist, and list it in pkg/dg-daemon/bunfig.toml.
- (slice 1, orchestrator) The local-pages tests stay in pkg/dg-daemon/__tests__/server/ next to the other server specs.

- (build base, orchestrator, 2026-11-02) G1 (#115), G2 (#122) and the follow-ups are merged. G3 now builds from origin/master, not stacked on G2. The note below about stacking on G2 is superseded. On master, the --ext helpers, extOnlyChecks, the `info` doctor status and the PENDING_LOCAL_MODE allowlist (chat, overwatch) exist as described. demo and rerun already play locally.
- (build base, orchestrator) There is no pkg/launcher on master. dg-daemon builds with `bun build src/index.ts --compile` (pkg/dg-daemon/package.json). Run pkg/pages/build.ts from a dg-daemon `prebuild` script and from the release workflow's daemon build step, before compile. For tests, follow the pkg/tour-ui pattern from #122: a bun preload shim rebuilds the page assets when pkg/pages/src or pkg/common/src is newer than the built files (see pkg/skills-cli/__tests__/build-player-shim.ts). Import the built assets as text into the daemon.
- (build base, orchestrator) ADR numbers 0029 and 0030 are taken (demo WSL debug port; shared tour UI). Use the next free number (0031) for the loopback pages ADR, and update the plan's "ADR 0030" mentions in docs and tests to it.
- (build base, orchestrator) dg-agent already has tryOpen (src/index.ts, src/start.ts). Tests use a tryOpen seam and never open a real browser.
- (orchestrator) Agents never tick plan.md checkboxes and never raise a deferral about them; the orchestrator ticks them after each slice commits.

- (build base, orchestrator) The install work (E 007, F 008, B 010, D 012) moved to the end of the chain. G3 builds stacked on G2's branch (after 015), which sits on G1. G1 (014, branch feat/ext_opt_in_convention: 1ba48fde slice 1, 9bc12190 slice 2) gives: the --ext flag helpers in src/utils/ext-flag.ts, the flag-aware cli-only guard, extOnlyChecks and the `info` doctor status (no exit-code effect), the PlayDeps seam on registerDemo(program, deps) and registerRerun(program, deps) with noteExtDefault, the require-extension doctor on extOnlyChecks, and the PENDING_LOCAL_MODE allowlist in pkg/skills-test/__tests__/ext-opt-in.spec.ts.
- (build base, orchestrator) Map E/F names to master: pkg/launcher/build.ts does not exist; the page assets embed in dg-daemon through text imports, and dg-daemon builds with its own `bun build src/index.ts --compile` script. programCommand -> selfCommand; DgPaths/dataDir -> resolveDgPaths().stateDir; registerLazyRaw -> registerRawCommand (skills-cli) or the dg-agent command table as master has it; no exitAfterDrain. pkg/dg-daemon/src/server/pages.ts is new; http.ts and origin.ts exist on master.
- (build base, orchestrator) G3 must remove from G1: chat and overwatch leave PENDING_LOCAL_MODE, so the allowlist empties and no SKILL.md declares `requires: [extension]`. The require-extension doctor stays on extOnlyChecks (G1). docs/install.md and the skills README rows for chat and overwatch move to local by default.
- (security, orchestrator) An EDR alert (T1068) fired on this machine. Tests never start powershell.exe, cmd.exe, a Windows browser or a remote-debugging port, and never put stub programs on PATH. Use injected seams (spawn, launch, fetch, exists) and write files with an atomic rename. Never launch a headed browser on WSL; agents pass --wsl-headed only when the human asks. Real-browser checks run only behind PW_E2E=1. Command tests reuse pkg/skills-cli/__tests__/ext-command-harness.ts from G1. Never run git stash in any form.

- (ratified, orchestrator) Chat and overwatch become local through option A: dg-daemon serves both pages on loopback, gated by the session token plus a loopback Origin check. --ext keeps the extension pages.
- (ratified, orchestrator) Token transport is the URL fragment plus an Authorization Bearer header on fetch and ?token= on the WebSocket upgrade. No cookies.

- (slice 1 done, orchestrator) Slice 1 is committed as 55e97199 in the worktree. A request with no Origin and a live Bearer token counts as a local page, because browsers omit Origin on a same-origin GET. The query token works only on the WebSocket upgrade. The CSP img-src also allows blob:. The page keeps its bootstrap in sessionStorage, strips the fragment from the URL, and drops the bootstrap on a 403. inbox and proto already print /chat#_chat=.
- (slice 2, orchestrator) pkg/common/src/node/marker.ts still builds the /start#_chat= URL; slice 2 changes start. The board page reads #_chat= with the full SessionBootstrap, so `overwatch open` builds /board#_chat=<b64 SessionBootstrap>, not /board#_token=. Keep one fragment format for both pages.
- (slice 2 done, orchestrator) Slice 2 is committed as 1be553da. overwatch open uses the caller's live session through localBootstrap; --ext keeps the extension paths; inbox keeps /start#_chat= because it needs the extension. ADR 0031 is Accepted.
- (follow-up, orchestrator) Out of scope: with a pinned extension origin, a request with no Origin and no token still passes requirePinnedExtensionOrigin on /overwatch. Queued for the human as a separate fix.
- (infra, orchestrator) store/row-retention.spec.ts times out with TMPDIR on the main disk, on master too. It is not a slice failure.

## Issues Remediation
## Decisions

- [DECIDED] Local pages are served by dg-daemon on loopback and gated by the session token plus a loopback Origin check. The extension pages stay as the `--ext` path with the pinned-origin gate unchanged. This is the one-way door of the bundle; see Open questions.
- [DECIDED] The page code moves to `pkg/pages` behind a `PageRuntime` seam, and the extension entrypoints become thin imports, so the chat canvas, autocomplete, transcript and board rendering have one implementation. Rejected: a second board written in the daemon (the static `dg-skills overwatch-snapshot` renderer is read-only and has no actions).
- [DECIDED] The token travels in the URL fragment (`#_chat=` as today, `#_token=` for the board) and reaches the daemon as `Authorization: Bearer` on fetch and `?token=` on the WebSocket upgrade. No cookies, so no CSRF surface and no change to the loopback-only rule.
- [DECIDED] `dg-agent start --open` and `dg-agent overwatch open` open the local pages by default and the extension with `--ext`; `send`, `recv`, `progress` and the WebSocket frames are unchanged.
- [DECIDED] WSL note stays: a Windows-side browser reaches `127.0.0.1:<port>` only in mirrored networking mode, exactly as today's extension pages.
- [DECIDED] Inbox Proton is out of scope here (014 Open questions).

## Measured facts (origin/master v1.26.0)

- `requirePinnedExtensionOrigin` (`pkg/dg-daemon/src/server/http.ts:151`) refuses any Origin that is not the pinned extension origin on `/overwatch` and `/overwatch/action`; `GET /start` returns a one-line stub page (`bootstrapPageHtml`); `dg-agent overwatch open` sends `cli-overwatch-open` to the extension (`pkg/dg-agent/src/overwatch.ts:173-180`); `dg-agent start --open` opens the `/start#_chat=` URL with `tryOpen`.
- Built extension page chunks: chat 26.5 KB, dashboard 12.3 KB, options 6.6 KB; `entrypoints/overwatch/main.ts` already takes a `runtime` parameter (`RenderOverwatchOptions`), so the board page is close to runtime-agnostic; the chat page imports `wxt/browser` directly.
- `dg-skills overwatch-snapshot` renders a static HTML board for the phone artifact and writes under `/tmp/ai/dg-overwatch`.

## Code Structure

```text
pkg/pages/
  package.json                     @dg/pages, depends on @dg/common
  build.ts                         Bun.build iife -> dist/chat.js, dist/board.js + html shells
  src/runtime.ts                   PageRuntime seam (storage, fetch base, token)
  src/chat/**                      chat page (moved from pkg/extension entrypoints/chat + lib/features/chat-*)
  src/board/**                     board page (moved from entrypoints/overwatch + lib/features/overwatch.ts)
  __tests__/**                     happy-dom renders from frame and board fixtures; purity grep
pkg/dg-daemon/src/server/origin.ts     requireLocalPageOrigin(req, port, token)
pkg/dg-daemon/src/server/pages.ts      serves dist assets as text with CSP headers
pkg/dg-daemon/src/server/http.ts       GET /chat, GET /board; either gate on /overwatch* and /ws
pkg/dg-daemon/__tests__/local-pages.spec.ts, origin.spec.ts
pkg/extension/entrypoints/chat/main.ts, overwatch/main.ts   thin imports of @dg/pages with the WXT runtime
pkg/dg-agent/src/start.ts, index.ts    /chat URL by default, /start with --ext
pkg/dg-agent/src/overwatch.ts          open: tryOpen(/board) by default, cli-overwatch-open with --ext
plugins/dg/skills/chat/SKILL.md, references/extension.md
plugins/dg/skills/overwatch/SKILL.md, references/extension.md
pkg/skills-test/__tests__/ext-opt-in.spec.ts   allowlist removed
pkg/skills-test/__tests__/chat-skill.spec.ts, overwatch-skill.spec.ts
docs/chat.md, docs/install.md, docs/AGENT-INSTALL.md
docs/adr/0030-loopback-pages-for-chat-and-overwatch.md, docs/adr/toc.md
```

## Code sample: the board page end to end

```ts
// pkg/dg-daemon/src/server/origin.ts
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLocalPageOrigin(origin: string | null, port: number): boolean {
 if (origin === null) return false;
 let url: URL;
 try {
  url = new URL(origin);
 } catch {
  return false;
 }
 return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && Number(url.port) === port;
}

export function bearerToken(req: Request, url: URL): string | undefined {
 const header = req.headers.get("authorization");
 if (header?.startsWith("Bearer ")) return header.slice(7);
 return url.searchParams.get("token") ?? undefined;
}

export function requireLocalPageOrigin(req: Request, url: URL, port: number, validToken: (t: string) => boolean): Response | undefined {
 if (!isLocalPageOrigin(req.headers.get("origin"), port)) return undefined;
 const token = bearerToken(req, url);
 if (token && validToken(token)) return undefined;
 return new Response("refused", { status: 403, headers: { ...NOSNIFF_HEADERS, "Cache-Control": "no-store" } });
}
```

```ts
// pkg/dg-daemon/src/server/http.ts (route excerpt)
if (url.pathname === "/board" && req.method === "GET") return pageResponse(boardHtml, port);
if (url.pathname === "/chat" && req.method === "GET") return pageResponse(chatHtml, port);

if (url.pathname === "/overwatch" || url.pathname === "/overwatch/action") {
 const localRefusal = requireLocalPageOrigin(req, url, port, (t) => registry.tokenIsLive(t));
 const extensionRefusal = isLocalPageOrigin(req.headers.get("origin"), port) ? undefined : requirePinnedExtensionOrigin(req, paths);
 const refusal = localRefusal ?? extensionRefusal;
 if (refusal) return refusal;
 return handleOverwatchRoute(req, url, deps);
}
```

```ts
// pkg/dg-agent/src/overwatch.ts (open)
.command("open")
.option("--ext", "open the board in the dg-ai-extension instead of the local page")
.action(async (opts: { ext?: boolean }) => {
 if (opts.ext) return openBoard(dependencies, command);
 const { port, token } = await sessionForCwd(dependencies);
 const url = `http://127.0.0.1:${port}/board#_token=${base64url(JSON.stringify({ token }))}`;
 if (!(await tryOpen(url))) console.log(url);
});
```

The board page (`pkg/pages/src/board/main.ts`) reads `#_token=`, polls `GET /overwatch` every 5 s with the Bearer header, renders lanes through the same `stageCells`, `needYouCount` and `formatCountdown` the extension uses, and posts `{chat, action, note}` to `/overwatch/action`. The chat page reads `#_chat=` and opens the WebSocket to `/ws?token=` with the frames `dg-agent` already speaks.

## Size, speed and token impact

- Size: two page assets embedded in the daemon chunk, budget 150 KB combined (the extension's chat chunk is 26.5 KB; the board is smaller). No new runtime dependency.
- Speed: `dg-daemon --help` unchanged (pages are text constants inside the lazy serve chunk). Page serving is a static response.
- Tokens: chat SKILL.md loses the side-panel and pairing notes to references/extension.md (about 25 lines); the `start` output stays one URL line.

## Risks

- Origin model: a loopback Origin plus a valid token is the same trust the extension's token already carries, but it widens who can present it from "the pinned extension" to "any page on 127.0.0.1:<port>". Only the daemon serves that origin, so the widening is to pages the daemon itself serves. Signal: the origin.spec.ts matrix. Marked [DECIDED] for that reason.
- Moving the chat page out of WXT may surface `browser.*` uses in chat-client and chat-connection beyond the ones read here; the purity grep in `pkg/pages` finds them.
- WSL NAT mode: the local page is no better than the extension page there; the exit code 3 message stays.

## ADR 0030 draft: Loopback pages for chat and overwatch

Status: Proposed. Context: chat and overwatch were the last skills that required the extension, because their UI existed only as extension pages and the daemon refused every other origin. Decision: dg-daemon serves the chat and board pages itself on loopback; a request from a page it served is accepted with the session token and a loopback Origin; the extension pages remain behind `--ext` with the pinned-origin gate. Alternatives rejected: a terminal chat (the human and the agent share one terminal); keeping chat and overwatch as documented exceptions (breaks the local-default rule of ADR 0028). Consequences: no extension needed for chat or the board; two small page assets in the daemon; one page implementation in `pkg/pages` for both hosts. Links: `pkg/dg-daemon/src/server/origin.ts`, `pkg/pages/build.ts`. Diagram: sequence `browser (/board) -> dg-daemon -> dg-agent overwatch set`. Numbering assumes ADRs 0024 to 0027 from bundles 007, 008, 011 and 012 land first.

## Open questions

- RATIFIED (see Agent Notes): how chat and overwatch become local — (A) dg-daemon serves the pages on loopback with a token plus loopback-Origin gate (this bundle) vs (B) keep both skills `--ext`-only as a documented exception and drop the lint allowlist by exempting them permanently vs (C) a terminal chat in dg-agent — recommend A; B contradicts the rule the user set and C has no human on the other end of the terminal.
- RATIFIED (see Agent Notes): token transport for the local pages — URL fragment plus Bearer header and `?token=` on the WebSocket (no cookies, token never hits the server log) vs an HttpOnly cookie set by `/chat` (simpler page code, needs a CSRF story) — recommend the fragment plus Bearer form, which is how the extension already carries it.

## Chain position

- Branch `feat/local-chat-overwatch`. After 015 (shared root `package.json`, `pkg/launcher/build.ts`, `pkg/extension/__tests__/**`, the skills README, `ext-opt-in.spec.ts`, `installed-skill-files.ts` and the install docs), which itself follows 014 and A; F (008 slice 3 owns `pkg/dg-daemon/src/**` and `pkg/dg-agent/src/**`) is already upstream of 014.
- Gated on the first RATIFY item; if the answer is B, this bundle shrinks to the documentation change and the permanent lint exemption.
