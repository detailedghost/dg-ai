# Slice 2 — dg-server-skeleton

Per-slice review findings (plan.md step 5).

Reviewed against plan.md (all 10 slices, dependency graph, `## Scope`, `## Code Structure`), the
sibling reviews for slices 1, 5, 7 and 9, and the live codebase: `pkg/skills-cli/package.json`,
`pkg/skills-cli/tsconfig.json`, `pkg/skills-cli/src/index.ts`, `pkg/skills-cli/src/utils/lib.ts`,
`pkg/skills-cli/src/utils/proto-paths.ts`, `pkg/common/src/serial-queue.ts`,
`pkg/extension/wxt.config.ts`, `.github/workflows/skills-blt.yml`, `.agents/monolith.md`.
`pkg/dg-server/**` does not exist yet (`current_slice: 0`), so this is a pre-implementation
soundness check.

Bun HTTP/WebSocket API facts were taken from context7 (`/oven-sh/bun`, `docs/runtime/http/server.mdx`
and `docs/runtime/http/websockets.mdx`), not from memory. Three claims were additionally verified by
running code on this WSL box; those experiments are named inline and the scripts are in the session
scratchpad (`probe.ts`, `race.ts`).

---

1. **[LOAD-BEARING — EVIDENCE] The WSL→Windows loopback criterion is not CI-testable, but it IS
   scriptable, and I have now proven it on this machine — make that script the slice's evidence
   artifact rather than leaving the AC to a human eyeball.** No GitHub-hosted runner can host the
   pairing: `ubuntu-latest` (the runner `skills-blt.yml` uses today, and the one slice 10 will mirror)
   has no Windows browser, and `windows-latest` has no WSL. So the AC as written ("a Windows-side
   browser ... opens the printed URL") is manual-only. However, the load-bearing part is the *network
   boundary*, not the browser: I bound `Bun.serve({hostname:"127.0.0.1", port:47823})` inside this WSL
   distro and reached it **from the Windows side** via `powershell.exe`, for both plain HTTP and a
   real WebSocket upgrade — `Invoke-WebRequest` returned the body, and
   `System.Net.WebSockets.ClientWebSocket` reached `state=Open` and received the server's first
   frame. Recommend slice 2 ship that probe as a committed, runnable script (e.g.
   `pkg/dg-server/scripts/verify-wsl-loopback.ts`: bind, then drive `powershell.exe -NoProfile` for
   an HTTP GET and a WS handshake, print PASS/FAIL) plus a `dg-server doctor`-style readout, and
   record the evidence as: the script's committed output pasted into the slice's Agent Notes, with a
   one-line note that the browser-in-the-loop half was confirmed by hand. That turns an unverifiable
   AC into a reproducible one that any developer (and the human reviewer) can re-run in seconds. Two
   observations from the probe that feed later findings: the Windows-side request arrived with
   `Host: 127.0.0.1:47823` (so a Host-header allowlist is viable — finding 15) and with no `Origin`
   header at all (so `Origin: null` must be an explicit case, not a default-allow — finding 16).

2. **[OPEN — escalate] The proof in finding 1 holds only because this box sets a non-default
   `.wslconfig`, and the fix for the default configuration directly contradicts slice 2's own
   "bind on 127.0.0.1" security requirement.** `/mnt/c/Users/dburgos/.wslconfig` contains
   `[wsl2] networkingMode=mirrored`, and `ip link` shows the `loopback0` interface that mode creates
   — i.e. Windows and WSL share the loopback namespace, which is *why* a `127.0.0.1`-only bind was
   reachable. The WSL default is NAT mode with `localhostForwarding`, whose relay is well-reported to
   forward ports bound to `0.0.0.0`/`::` but not ports bound *only* to `127.0.0.1`; mirrored mode
   additionally requires Windows 11 22H2+ and WSL 2.0+. I could not test NAT mode without restarting
   WSL and killing this session, so treat "works on default WSL" as unproven, not disproven. The
   escape hatches all have costs: binding `0.0.0.0` would satisfy NAT mode but puts the daemon on
   every interface including the LAN (`eth2 10.202.58.142/24` here), which is exactly what the
   loopback requirement exists to prevent; `netsh interface portproxy` needs admin, so an install
   script cannot use it; and falling back to the WSL VM's own IP is a dead end for three independent
   reasons — the address changes on every WSL restart, slice 4's content script matches
   `http://127.0.0.1/*` only so a non-loopback bootstrap URL would never be captured, and
   `ws://<non-loopback>` from a `chrome-extension://` page is mixed content (only loopback literals
   are "potentially trustworthy" origins), so the socket would be blocked even if the page loaded.
   ⚑ RATIFY: Is `networkingMode=mirrored` a documented prerequisite of the chat harness (daemon
   preflights it, `dg-server status` reports it, `docs/AGENT-INSTALL.md` requires it, and the daemon
   refuses to start on NAT-mode WSL with a pointer to the fix), or must the daemon support default
   NAT-mode WSL by binding `0.0.0.0` there and accepting LAN exposure mitigated only by the session
   token? — Options: (a) require mirrored mode, loopback-only bind everywhere; (b) detect WSL via
   the existing `isWSL()` and bind `0.0.0.0` on WSL only, documenting the exposure; (c) probe at
   startup (bind loopback, self-test from the Windows side with the finding-1 harness) and fall back
   to (b) automatically with a loud warning. Recommendation: (a) — the whole design already assumes
   loopback is a trust boundary, and (b) silently converts a single-user tool into a network service.
   This is a one-way door on the security model and on what the install docs promise, so it needs the
   human.

3. **[PORT] Replace the OS-assigned port with a fixed default port plus a small deterministic
   fallback range, published as a constant in `@dg/common`, and add an unauthenticated-but-scoped
   `GET /health` so the browser can rediscover a restarted daemon.** This is the single change that
   closes both sibling escalations at once: slice-5 finding 8 (a restarted daemon gets a new port and
   every open page's `chrome.storage.session` snapshot is stranded, with native messaging out of
   scope so nothing can read the lockfile) and slice-9 finding 5 (the options page has no port at all
   before any session exists). Concretely: default to one fixed high port; on `EADDRINUSE` walk a
   fixed contiguous range of ~8–10 ports; write the chosen one to the lockfile as today. The
   extension then discovers the daemon by probing the known range (cheap on loopback, and it can try
   a `storage.local` last-known-port first), matching a daemon identity in the `/health` body rather
   than trusting that *something* answered. `/health` must return the minimum needed to identify the
   daemon — `{daemon:"dg-server", protocolVersion, instanceId}` — and never a session list or a
   token; return `204` with no body to any caller failing the Host/Origin checks, so an arbitrary web
   page cannot fingerprint the daemon even though it can observe the port being open. Neither the
   fixed port nor the range breaks slice 4: Chrome match patterns cannot contain a port and ignore it
   entirely, so `http://127.0.0.1/*` matches every port either way. A fixed port also buys the
   cold-start mutex in finding 7 for free, and removes the readiness handshake problem in finding 6.

4. **[PORT] State `hostname: "127.0.0.1"` explicitly and add a test that asserts it — Bun's default
   is `0.0.0.0`.** Per context7 (`docs/runtime/http/server.mdx`), `Bun.serve` defaults `hostname` to
   `0.0.0.0` and reads the port from `$BUN_PORT`/`$PORT`/`$NODE_PORT` when not given. Both defaults
   are wrong here: omitting `hostname` silently publishes the daemon on the LAN, and an inherited
   `$PORT` from the agent's shell would silently move the daemon off the port the extension probes.
   Recommend pinning both explicitly, ignoring `$PORT`, and adding a contract test that the server is
   not reachable on a non-loopback local address. There is no existing `Bun.serve` usage anywhere in
   the repo (`rg` over `pkg/` found none), so nothing establishes this by precedent.

5. **[BOOTSTRAP] The `#_chat=` marker must live in the fragment of the URL the CLI prints, and
   `GET /start` must be a static, tokenless page — slice 2's own testing criterion currently
   specifies the opposite, and the opposite cannot work.** The criterion reads "GET /start returns
   the bootstrap page with a marker whose decoded payload matches the registered session", i.e. the
   server injects the marker into the response body. That breaks on ordering and on secrecy. Ordering:
   slice 4's capture content script runs at `document_start`, which is *before* any inline script in
   the served HTML executes, so a page that sets its own `location.hash` sets it after the only
   listener has already run and missed it — and a later hash change does not re-run the content
   script. Secrecy: a marker in the response body means any local process (and any tool that can GET
   loopback) can read a live session token out of `http://127.0.0.1:<port>/start`. Both problems
   vanish if `dg-server start` prints `http://127.0.0.1:<port>/start#_chat=<payload>` and the browser
   navigates to that: fragments are never sent to the server, so the daemon never serves the token at
   all, and the content script reads it from `location.hash` at `document_start` exactly as
   `demo-marker`/`proto-marker`/`marker` already do for every other marker in this repo. Recommend
   rewording the criterion to "the printed bootstrap URL carries a `#_chat=` fragment whose decoded
   payload matches the registered session, and `GET /start` itself returns no session data", and
   giving `/start` a human-readable fallback line for the case where the extension is not installed
   (otherwise the user sees a blank page and has nothing to act on).

6. **[COMPLETENESS — largest gap] Nothing in the plan says which process becomes the daemon, and
   that is the first thing that has to work.** Slice 2 says `dg-server start` "registers a session
   ... and returns or opens the marked bootstrap URL" and separately that the daemon must reuse a
   live one — but `start` is invoked by an agent that needs its shell back, so `start` cannot *be*
   the server. Recommend an explicit engineering bullet for the daemonize path: `start` re-execs the
   compiled binary as a detached child on a hidden subcommand (`dg-server __serve`) with
   `detached: true, stdio: "ignore"` and `unref()` — the same pattern `tryOpen` in
   `pkg/skills-cli/src/utils/lib.ts` already uses to survive its parent — then waits for readiness
   before printing the URL. Readiness must be an affirmative signal, not a sleep: with the fixed port
   from finding 3 the parent polls `GET /health` until the `instanceId` appears, which is also the
   only way to distinguish "my child came up" from "someone else's daemon was already there". Note
   two platform hazards to cover in the same bullet: on Windows a detached child still needs
   `windowsHide` and a real detach or it dies with the console, and `bun build --compile` produces a
   single file with no `package.json` beside it, so the child must be launched via `process.execPath`
   and its own version must be a compiled-in constant (see finding 9). Add contract tests for
   "`start` returns before the daemon exits" and "`start` prints a URL only after `/health` answers".

7. **[CONCURRENCY] Make the cold-start race impossible at the OS level rather than with a
   check-then-act on the lockfile — and forbid `reusePort`, which I verified silently defeats it.**
   Two simultaneous `dg-server start` calls both see no lockfile and both proceed. With an
   OS-assigned port both binds succeed on *different* ports, producing two daemons, two SQLite
   writers on one database, and two disjoint session registries — the canvas would then show only
   whichever daemon its socket reached, and slice 3's "SQLite is the ONLY store of record" invariant
   is quietly broken. With the fixed port from finding 3 the loser gets a hard failure instead: I
   confirmed on this box that a second `Bun.serve` on an already-bound port throws
   `Failed to start server. Is port 47824 in use?`, so the OS itself is the mutex. Recommend layering
   two atomic steps: create the lockfile with `O_CREAT|O_EXCL` (treat `EEXIST` as "another starter is
   racing or a daemon exists" and fall through to the attach path), then bind — and on `EADDRINUSE`,
   poll `/health` for a bounded window and attach to the winner rather than erroring out to the
   agent. Also verified and worth an explicit prohibition plus a test: `Bun.serve({reusePort: true})`
   lets **both** processes bind the same port on Linux with no error, after which requests are
   load-balanced between two daemons at random — the worst possible failure mode here, and a
   plausible thing for someone to add later while chasing a bind error. Assert `reusePort` is never
   set.

8. **[LOCKFILE] Liveness must be proven over the port, not inferred from the pid — and the current
   testing criterion tests the wrong predicate.** The criterion is "a stale lockfile whose pid is
   dead is reclaimed rather than treated as a live daemon", which encodes `kill(pid, 0)` as the
   liveness test. That predicate is wrong in both directions: a recycled pid now belonging to an
   unrelated process reads as *alive* (so `start` attaches to nothing and the agent hangs), and the
   parent's question — pid dead but port still bound — is a real state reachable by a forked child
   inheriting the listening socket or by an unrelated process squatting the fixed port. Recommend the
   only reclaim rule be: probe `GET /health` on the lockfile's port and require the response's
   `instanceId` to equal the lockfile's; if it matches, the daemon is live regardless of the pid; if
   the probe fails or the identity differs, the lockfile is stale. Reclaim by writing
   `lockfile.tmp` + `rename()` so two concurrent reclaimers cannot interleave a half-written file,
   and if the port is bound but the identity does not match, do not kill anything — advance to the
   next port in the range and log which port was squatted. Keep the pid in the lockfile for
   diagnostics and for `stop`'s fallback signal, but never as the liveness predicate. Reword the
   criterion to "a lockfile whose daemon does not answer `/health` with a matching instance id is
   reclaimed".

9. **[VERSION SKEW] Put a `protocolVersion` in the lockfile separate from the package version, and
   never auto-restart a daemon that other repos are using.** Slice 2 writes "daemon version" to the
   lockfile but the plan never says what a newer CLI does when it meets an older running daemon —
   and the answer matters because the daemon is shared: silently restarting it to match would kill
   every other repo's live chat sessions mid-conversation. Recommend gating on a hand-maintained
   `protocolVersion` (frame shape + lockfile shape + `/health` shape), not the package version, so
   patch releases never force a restart; on a protocol mismatch, refuse to attach and print the exact
   remediation (`dg-server stop` then retry), naming how many sessions the stop would end so the user
   makes an informed choice. `dg-server stop` must therefore work across protocol versions — it is
   the escape hatch, so its wire surface should be the narrowest, most stable thing in the daemon
   (and should fall back to signalling the lockfile pid if the graceful path is unrecognised). Also
   note for the same bullet: because `bun build --compile` leaves no `package.json` next to the
   binary and nothing in this repo reads `package.json` at runtime today (`rg` confirms zero
   matches), both versions must be compiled-in constants.

10. **[LIFECYCLE] Define idle-TTL as "zero registered sessions AND zero open connections for the
    whole window", not "no traffic" — otherwise it fires on a page that is merely quiet.** The
    parent's two cases are both real under a traffic-based timer: a canvas left open while the human
    reads generates no frames, and slice 7's `recv --block --timeout 300` parks a connection
    deliberately (slice-7 finding 10 raised the same concern from the other side). Both would let the
    daemon exit under the user, after which slice 5's backoff reconnect loops against nothing.
    Recommend the predicate be structural — an open WebSocket or an in-flight blocking `recv` pins
    the daemon alive for its whole duration, and the TTL clock starts only when the last session
    closes *and* the last connection drops. Add contract tests for "an idle-but-connected page does
    not trigger self-exit" and "a parked blocking recv does not trigger self-exit", since the
    existing criterion ("Idle-TTL expiry exits the daemon and removes the lockfile") passes trivially
    under the wrong predicate.

11. **[TIMEOUTS] Bun's own idle timeouts constrain slice 7's `--timeout 300`, and the numbers decide
    the transport question in finding 12.** Per context7: `Bun.serve`'s HTTP `idleTimeout` defaults
    to **10 seconds** and accepts a **maximum of 255** (or `0` to disable), and it applies to pending
    handler execution, not just streaming; the WebSocket `idleTimeout` defaults to **120 seconds**,
    and `sendPings` defaults to **true** so Bun's own keepalive traffic keeps a parked socket alive.
    Consequences slice 2 must handle explicitly: an HTTP long-poll physically cannot hold one request
    open for the 300 seconds slice 7's acceptance criteria use as the example — you would have to set
    `idleTimeout: 0` and then hand-roll a reaper for hung sockets, or cap `--timeout` below 255, or
    have the CLI transparently re-issue ~200s segments; whereas a parked WebSocket survives
    arbitrarily long waits because of the automatic pings. Whichever transport is chosen, set both
    timeouts explicitly rather than inheriting a 10-second default, and add a contract test that a
    wait longer than the default survives.

12. **[TRANSPORT] The CLI should reach the daemon over the same WebSocket server on a dedicated
    upgrade path, with a per-session token file at 0600 — I disagree with slice-7 finding 1's
    HTTP-long-poll recommendation, on the timeout evidence in finding 11.** Slice 7 escalated this as
    an undefined one-way door and preferred a local HTTP long-poll on the reasoning that a one-shot
    process should not need WebSocket machinery. That reasoning is sound in the abstract but loses to
    the concrete numbers: the long-poll path needs `idleTimeout: 0` plus a hand-rolled reaper, or
    request-chunking, purely to express the timeout the skill is documented to use, while the
    WebSocket path gets it from Bun's default pings. Reusing one transport also means one frame
    validator, one place the Host/Origin/token checks live, and one code path for `spawn` and the
    page's `session create` (slice-7 finding 11 already wants those unified). Concretely, recommend:
    a distinct upgrade route (`/cli`) that requires a valid session token and **rejects any request
    carrying a browser `Origin`**, versus `/ws` which requires an allowed extension origin — the two
    client classes then never share an auth path, and neither check has to be weakened to admit the
    other. For the token itself, the CLI is a fresh process each invocation so it cannot hold the one
    `start` minted: recommend `~/.dg/sessions/<id>.json` at mode 0600 inside a 0700 directory,
    matching the `~/.dg/key` precedent slice 3 already sets, plus a `DG_SESSION_TOKEN` env override
    so the skill can pass it in-band without touching disk. Write down explicitly that any process
    running as the same OS user can read that file and therefore read and inject messages — that is
    the accepted local trust model, identical to `~/.dg/key`, and it should be an accepted risk in
    the plan rather than an unstated one. A unix domain socket (`Bun.serve({unix})`, confirmed
    available) would remove the token file entirely by making filesystem permissions the
    authentication, and is the better design *if* Windows-native support is dropped — but slice 10
    publishes `dg-server-windows-x64.exe`, so recommend TCP+WS as the portable answer and record the
    unix option as the thing that would improve it.

13. **[LIFECYCLE — the gap slice 9 found] Define the session state machine in this slice's registry;
    slice 1 already has the `session closed` frame but nothing in the bundle produces it.**
    Slice-9 finding 10 is correct that no slice defines what ends one session while the daemon keeps
    running: a dropped socket is explicitly *not* an end (slice 5 reconnects), slice 6 has no
    close-node affordance, and slice 7's verbs are only `recv`/`send`/`status`/`spawn`. Recommend
    slice 2 own and document: states `active → closed`, `closed` terminal; three legitimate closers —
    an explicit CLI verb (needs adding to slice 7's list), a `session close` frame from a canvas
    affordance (needs adding to slice 6's list), and daemon shutdown; and on close the registry must
    (i) mark the `sessions` row closed, (ii) emit slice 1's `session closed` frame to every connected
    socket, (iii) invalidate the session token so later frames and CLI calls are refused with a
    distinct "session closed" reason rather than a generic auth failure, (iv) release any parked
    blocking `recv` on that session with a distinct closed result instead of letting it hang to its
    timeout, (v) trigger slice 9's asset cleanup, and (vi) leave the transcript in SQLite — messages
    are durable and are not deleted. Closing the last session is what starts finding 10's TTL clock.
    Getting (iv) wrong is the visible bug: an agent whose session was closed from the canvas would
    otherwise block for its full 300 seconds and then report a timeout, which reads as "no reply
    yet" rather than "this conversation is over".

14. **[OPEN — escalate] What happens when the agent's own process dies is undefined, and the honest
    answers differ in user-visible behavior.** A terminal agent crashes or its shell is closed; the
    daemon and the session survive, the canvas still shows the node as live, and the human types into
    a chat nobody will ever read. The registry records the invoking cwd already (slice 2's own
    bullet), so recording the registering pid alongside it is nearly free — but acting on it is a
    product call, and pid liveness is a weak signal (finding 8's recycling problem applies here too,
    though here a false positive only mislabels a node rather than corrupting state).
    ⚑ RATIFY: When the process that registered a session is gone, should the daemon (a) auto-close
    the session (assets cleaned, node disappears, transcript retained), (b) keep it open but mark it
    `agent gone` so the canvas can grey the node and the composer can warn before sending, or
    (c) ignore it entirely and rely on idle-TTL? — Recommendation: (b). It is recoverable if the
    liveness check is wrong, it never destroys state on a bad signal, and it turns a silent
    dead-letter into visible information; but it needs a status value in slice 1's frame and a badge
    in slice 6, so it cannot be decided inside slice 2 alone.

15. **[SECURITY] Add a `Host`-header check alongside the origin allowlist — the plan has no
    DNS-rebinding defense, and the origin check alone does not provide one.** An origin allowlist
    stops a page on `http://evil.example` from opening a socket under its own origin, but the classic
    bypass is to make DNS resolve `evil.example` to `127.0.0.1`, after which the browser considers
    the request same-origin and the `Origin` check no longer helps. The defense is to require the
    `Host` header to be exactly `127.0.0.1:<port>` or `localhost:<port>` on every HTTP request and on
    the WebSocket upgrade, and to refuse anything else. My probe in finding 1 confirms this is
    workable across the WSL boundary specifically: the request that arrived from the Windows side
    carried `Host: 127.0.0.1:47823`, the loopback literal, not a translated hostname. Recommend an
    explicit engineering bullet and a contract test, since neither the Engineering list nor the
    Testing Criteria mention `Host` at all today.

16. **[OPEN — escalate] The origin allowlist cannot be written down, because neither browser gives
    the extension a knowable, stable origin — this needs a decision before the security QA pass.**
    Chrome pages present `Origin: chrome-extension://<32-char id>`; `pkg/extension/wxt.config.ts`
    declares **no `key`** in the Chrome branch, so for an unpacked install the ID is derived from the
    extension directory's absolute path — stable for a given machine and path, but different for
    every user and unknowable to the daemon in advance. Firefox is worse: the config does set
    `browser_specific_settings.gecko.id`, but the *origin* is `moz-extension://<per-install random
    UUID>`, which is unrelated to that ID and is regenerated on reinstall (and on each temporary
    load during development). So a static allowlist is not expressible, and "allow any
    `chrome-extension:`/`moz-extension:` origin" degrades the allowlist to a scheme check where the
    token does all the real work. Note also that `Origin` is fully attacker-controlled from any
    non-browser local process (my probe arrived with `Origin: null` from PowerShell) — the allowlist
    is a browser-scoped defense against a malicious *web page*, never access control, and the plan
    should say so where it calls the allowlist a "hard requirement", so nobody treats it as the
    thing keeping other local software out.
    ⚑ RATIFY: How is the extension origin established? — Options: (a) trust-on-first-use pinning —
    accept an upgrade whose origin is an extension scheme, pin the first origin that completes a
    token-authenticated handshake into `~/.dg/config.json`, and refuse mismatches afterward (the
    token, delivered only via the fragment of the URL the CLI printed, is what authorizes the pin);
    (b) add a `key` to the Chrome manifest branch so the Chrome extension ID becomes fixed and can be
    hard-coded, accepting that this changes the extension's identity and orphans existing installs'
    storage, and still leaves Firefox unsolved; (c) user-configured allowlist in the daemon config,
    with a documented first-run step; (d) scheme check only, token is the sole credential.
    Recommendation: (a) with (d) as the pre-pin state, and treat (b) as a separate question for
    whoever owns `wxt.config.ts` (slice 4). Whichever is chosen, the daemon's own loopback origin
    (`http://127.0.0.1:<port>`, the `/start` page) must be allowed as well.

17. **[SECURITY] Tighten the token handling the plan leaves implicit: CSPRNG, constant-time compare,
    never logged, and a failed-frame budget.** Slice 2's bullet says "reject and log, never partially
    process", which is right about atomicity but invites writing the rejected frame — and therefore a
    token or a near-miss token — into a log. Recommend: mint with `crypto.randomBytes`-grade entropy
    at 128 bits or more; compare with `crypto.timingSafeEqual` (a naive `===` on a per-frame check
    that an attacker can drive thousands of times is a real oracle, not a theoretical one); log only
    a short redacted fingerprint of a rejected token, never the value; and close the connection after
    a small budget of failed frames rather than validating forever, plus a per-origin rate limit on
    upgrades. The existing criterion "a frame bearing a wrong or absent token is rejected without side
    effects" should gain a sibling: "repeated invalid frames close the connection" and "no rejected
    token appears in any log output".

18. **[TESTABILITY — blocking] The slice needs `DG_HOME` and `DG_PORT` overrides or its own contract
    tests will fight the developer's real daemon and write into the real `~/.dg`.** Slice 2's
    contracts include "a cold machine binds a port, writes the lockfile", "a second `start` reuses
    the live daemon", "idle-TTL expiry removes the lockfile" and "`stop` is idempotent" — every one
    of them is an integration test that needs a private root and a private port. Slice 1's resolver
    takes injected seams (`homeDir`, `env`), which covers in-process unit tests, but these contracts
    have to drive the **compiled binary as a subprocess**, where seams are unreachable and only
    environment variables cross the boundary. Without an override, running `bun test` on this package
    would clobber the developer's lockfile, kill or attach to their live daemon, and collide on the
    fixed port from finding 3. Recommend `DG_HOME` (root override, honoured by slice 1's resolver —
    its file, so it needs flagging there) and `DG_PORT` (port/range override, slice 2's own), both
    documented as test/dev seams; and note this is a strictly better-behaved mechanism than
    `AI_SCRATCH_DIR`, which finding 19 argues against for this purpose.

19. **[OPEN — escalate — seconding slice 1] `AI_SCRATCH_DIR` must not move the lockfile, because the
    failure it causes is worse than the reboot-wipe slice 1 identified: it is an env-var-dependent
    split brain during normal operation.** Slice-1 finding 6 flagged the durability risk (the SQLite
    store and the AES-GCM key living somewhere cleaned on reboot). From slice 2's side the lockfile
    makes it sharper. The lockfile is the *rendezvous* record — the single thing that makes "one
    daemon, many sessions" true — and the daemon deliberately outlives the shell that started it.
    `AI_SCRATCH_DIR` is a per-shell environment variable. So the moment one shell has it set and
    another does not, the two processes resolve different roots and therefore different lockfiles:
    `dg-server status` reports no daemon while one is running, `stop` silently no-ops, and the next
    `start` binds a second daemon with a second SQLite writer on a different database — the exact
    invariant violation finding 7 works to prevent, reintroduced by an environment variable. Any
    env-derived root is structurally wrong for a daemon rendezvous.
    ⚑ RATIFY (same decision as slice-1 finding 6, with this additional evidence): pin the lockfile,
    database and key to `~/.dg` unconditionally, and confine any scratch override to a genuinely
    ephemeral staging directory. Recommendation: strongly (a) do not let `AI_SCRATCH_DIR` affect the
    persistent root at all; use the explicit `DG_HOME` seam from finding 18 for test isolation
    instead, which is opt-in and named for what it does.

20. **[STRUCTURE] Narrow slice 2's `pkg/dg-server/__tests__/**` to
    `pkg/dg-server/__tests__/{server,session,utils}/**` — confirmed as a strict superset of every
    later dg-server slice's test glob.** Verified against the frontmatter: the unscoped glob at
    plan.md:20 contains slice 3's `__tests__/store/**` and `__tests__/crypto/**`, slice 7's
    `__tests__/commands/**`, slice 8's `__tests__/dispatch/**` and slice 9's `__tests__/assets/**` —
    slice-7 finding 8 and slice-9 finding 12 both flagged it and both are right. Mirroring slice 2's
    own `src/` subdirectories makes ownership actually disjoint. One thing to decide consciously while
    doing it: these subdirectories diverge from the repo's documented convention —
    `.agents/monolith.md` records "Tests carry a `.spec.ts` suffix in `__tests__/` folders" and there
    are zero subdirectories under any existing `__tests__/` (`pkg/common`, `pkg/skills-cli`,
    `pkg/skills-test`, `pkg/extension` are all flat). Slices 3/7/8/9 have already committed the bundle
    to subdirectories for `dg-server`, so the consistent move is to narrow slice 2 to match rather
    than flatten five slices — but it should be a decision, not an accident. Separately, slice 2's
    file list has no `pkg/dg-server/bunfig.toml`; `pkg/skills-cli` needs one for a test preload, and
    if any dg-server test needs a preload there is no declared home for it.

21. **[REUSE] `isWSL`, `run`, `tryOpen` and `openers` must be hoisted into `@dg/common/node` (inside
    slice 1's existing `pkg/common/src/node/**` glob) rather than duplicated in slice 2 or imported
    from `@dg/skills-cli/lib`.** Slice 2 needs `tryOpen`/`openers` for its "returns or opens the
    marked bootstrap URL" bullet and `isWSL` for finding 2's preflight; all four live today in
    `pkg/skills-cli/src/utils/lib.ts`. Importing them via that package's `"./lib"` export would make
    the daemon depend on the CLI's utils — precisely the inversion `## Code Structure` already
    rejected for `proto-paths.ts` ("inverts the dependency, making the daemon rely on the CLI's
    private utils"), and it would apply with equal force here. Duplicating them violates the
    project's shared-utilities rule. Hoisting is clean and needs no scope change to slice 2, because
    slice 1's declared `pkg/common/src/node/**` is a glob that accommodates a second module — but it
    does need adding to slice 1's Engineering checklist, and note the sequencing: `lib.ts` can only be
    reduced to a re-export in slice 10 (it is in slice 10's file list, not slice 1's or 2's), so the
    duplicate lives on harmlessly for the duration of the bundle. Worth stating so nobody
    re-derives `openers()`' WSL powershell-escaping logic, which is security-relevant and already
    correct where it is.

22. **[STRUCTURE] Slice 2 owns the only `package.json` and `tsconfig.json` for a package that four
    later slices build into — enumerate their dependencies now, and note that "OS keychain" has no
    `--compile`-compatible library.** Slices 3, 7, 8 and 9 add source directories but cannot add a
    dependency. Most needs are built-ins (`bun:sqlite`, `node:crypto`, `node:fs`), and `commander` +
    `@dg/common` cover slices 2 and 7 — but slice 3's "resolve the key from the OS keychain first" has
    no portable answer: the usual libraries are native modules, which a `bun build --compile`
    single-file binary cannot carry. The realistic implementation is shelling out per platform
    (`security` on macOS, `secret-tool`/`libsecret` on Linux, PowerShell/CredMan on Windows), which
    means slice 3 depends on `run()` and therefore on finding 21's hoist — a dependency chain worth
    making visible now rather than discovering in slice 3. The `tsconfig.json` should copy
    `pkg/skills-cli/tsconfig.json` verbatim, including both `@dg/common` and `@dg/common/*` path
    mappings and `include: ["src/**/*", "__tests__/**/*"]`; note slice-1 finding 9's caveat that the
    wildcard mapping means `tsc --noEmit` will happily resolve `@dg/common/node`, which is correct and
    desirable for this package but is what makes it invisible to the extension's lint.

23. **[QUEUE] Use one `createSerialQueue` per socket, not one for the daemon, and await Bun's
    backpressure signal inside it.** `pkg/common/src/serial-queue.ts` is a single promise chain with
    no partitioning — correct for its MV3 origin, where there is one context. A single daemon-wide
    instance would serialize every session's outbound frames behind every other session's, so one
    stalled socket head-of-line-blocks the whole canvas; that is the opposite of the
    "many sessions, one daemon" promise. Per-socket instances satisfy the `## Code Structure`
    "Outbound frame ordering" decision (reuse the primitive, introduce no new one) while keeping
    sessions independent. Two mechanical notes: `createSerialQueue` swallows task errors by design,
    so a send failure must be surfaced through the `onError` hook rather than assumed to propagate;
    and `ServerWebSocket.send` signals backpressure (`backpressureLimit` defaults to 16MB, with a
    `drain` handler), so the queued task should await drain rather than fire-and-forget — otherwise
    ordering is guaranteed at enqueue time but not on the wire. Bun's built-in pub/sub
    (`ws.subscribe` / `server.publish`) is the natural fit for fanning one session's frame out to
    several sockets and is worth naming as the reuse candidate, but it bypasses the per-socket queue,
    so pick one mechanism per direction and say which.

24. **[CONTRACT] `src/index.ts` is slice 2's file, so slice 2 must build the top-level error handler
    so slice 7 can have its distinct timeout exit code.** `pkg/skills-cli/src/index.ts` ends in a
    blanket `.catch(err => { console.error(...); process.exit(1) })`, and slice-7 finding 2 correctly
    identified that this collides with slice 7's thrice-repeated requirement for a distinct
    machine-readable timeout exit code. If slice 2 copies the blanket handler literally, slice 7 has
    to either edit slice 2's merged file or bypass the handler with a bare `process.exit` buried in an
    action — both worse than designing for it once. Recommend slice 2's handler recognise a typed
    error that carries its own exit code, defaulting to 1, and that the `registerStart`/
    `registerStatus`/`registerStop` shape plus `showHelpAfterError()` mirror
    `pkg/skills-cli/src/index.ts` exactly, per the `registerX` convention in `.agents/monolith.md`.

25. **[OBSERVABILITY] A detached daemon with `stdio: "ignore"` has nowhere to put slice 3's "loud
    startup warning" or a crash trace — give it a log file.** Slice 3 requires warning loudly when it
    falls back to `~/.dg/key`, and slice 2 requires `dg-server status` to report daemon state, but the
    process that would print the warning has no terminal (finding 6). Recommend a size-capped
    `~/.dg/dg-server.log` written by the daemon, with `status` surfacing the key source, the last
    error, the bound port, the WSL networking mode from finding 2, and the session count. This costs
    almost nothing now and is the difference between a diagnosable daemon and an invisible one; it is
    also what makes the "given a killed daemon, `status` reports no live daemon" acceptance criterion
    actionable rather than merely true.

26. **[CONTRACT] Pin what the outer `sessionId`/token authenticate on an inbound `session create`
    frame — slice 1 raised the same tension and slice 2 is the enforcing side.** Slice-1 finding 4
    notes that "every frame carries sessionId and the session token" cannot literally hold for a
    request to create a session that does not exist yet. Slice 2's handler is where the resolution
    becomes code, so it should be written down here too: the outer `sessionId`/token belong to the
    **requesting** session (so `session create` is only accepted on an already-authenticated socket),
    the new session's id and freshly minted token travel back in a nested field of the response, and
    the very first session in a browser is only ever minted through the CLI plus bootstrap-marker
    path. Recommend a contract test for the negative case — a `session create` bearing an unknown or
    closed session's token is refused and creates nothing — because the positive case in the current
    criteria ("a session-create frame registers a new session and returns its id and token") passes
    even with no authentication at all.

27. **[CLEAN] Source-directory ownership is genuinely disjoint, and the layer names are a deliberate
    departure worth not "fixing".** `src/server/**`, `src/session/**` and `src/utils/**` do not
    overlap slice 3's `src/store|crypto/**`, slice 7's `src/commands|manifest/**`, slice 8's
    `src/dispatch/**` or slice 9's `src/assets/**`. Note that `dg-server` therefore uses a
    domain-module layout rather than `skills-cli`'s two-layer `commands/` + `utils/` shape and rather
    than the extension's `entrypoints → lib/features → utils` layering recorded in
    `.agents/monolith.md`; that is consistent across all five dg-server slices and is the right call
    for a daemon, but it is a third layout in the repo and should be recorded in `monolith.md` by
    slice 10 so it reads as intentional. The only overlap anywhere in slice 2's file list is the
    `__tests__` glob in finding 20.

---

## Summary

The slice is buildable, but not as currently written: five of the eight areas pressed on contain
gaps that would each surface as a real defect. Two are outright errors in the current criteria —
`GET /start` cannot serve the marker (finding 5, ordering plus token exfiltration) and pid liveness
is the wrong reclaim predicate (finding 8). One is a missing engineering step for the very first
thing that must work: nothing says which process becomes the daemon or how readiness is signalled
(finding 6). One resolves two sibling escalations at once and should be treated as the slice's main
design change: a fixed port with a fallback range plus `/health`, which fixes slice-5 finding 8's
stranded clients and slice-9 finding 5's portless options page, and incidentally buys the cold-start
mutex (findings 3, 7). And the session lifecycle slice-9 finding 10 could not locate is this
registry's to define (finding 13).

Four items need the human before implementation starts: the WSL networking-mode decision, which is
the load-bearing assumption and pits loopback-only binding against default-configuration WSL
(finding 2); the extension-origin allowlist, which cannot be expressed statically in either browser
(finding 16); `AI_SCRATCH_DIR` on the daemon's persistent root, where I am seconding slice-1
finding 6 with a sharper failure mode than the one it named (finding 19); and what happens when the
registering agent process dies (finding 14).

On the two questions the parent asked me to answer rather than escalate: the CLI should reach the
daemon over the same WebSocket server on a dedicated `/cli` upgrade route with a 0600 per-session
token file — I am disagreeing with slice-7 finding 1's HTTP long-poll preference, on the measured
grounds that Bun's HTTP `idleTimeout` caps at 255 seconds while slice 7's own documented example
waits 300 (findings 11, 12). And the load-bearing WSL criterion is manually provable but not
CI-provable; I proved the network half of it from the Windows side on this box and recommend
committing that probe as the slice's evidence artifact (finding 1).
