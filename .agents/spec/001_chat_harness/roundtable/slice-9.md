# Slice 9 — asset-staging-and-serving

Per-slice review findings (plan.md step 5).

Reviewed against: plan.md (full bundle, all 10 slices, Code Structure section), and the live
codebase — `pkg/skills-cli/src/commands/proto.ts` (`ensureSafeAnswerPaths`, `copyNoFollow`,
`O_NOFOLLOW`), `pkg/extension/lib/config.ts`, `pkg/extension/lib/options-nav.ts`,
`pkg/extension/entrypoints/options/main.ts`. `pkg/dg-server/**` does not exist yet — slices 1-8
are unbuilt, so this is a pre-implementation soundness check, not a code review.

1. **[PATH TRAVERSAL — must resolve before build]** The plan's wording ("an id that escapes the
   session's asset directory") is ambiguous between two designs with very different risk: `<id>`
   as an opaque primary key looked up in the `assets` table (safe by construction — attacker input
   never reaches a path join), versus `<id>` used directly as, or concatenated into, a filesystem
   path (unsafe, needs traversal + symlink defenses). Recommend pinning the engineering checklist
   to the first: `GET /assets/<id>` parses `<id>`, looks it up in the `assets` table scoped to the
   requesting session, and uses the row's *own stored filename* to locate the file — never
   re-derives a path from the URL segment. Apply `ensureSafeAnswerPaths`'s pattern as defense in
   depth on top of the DB lookup: per-component `lstat` symlink rejection plus a final `realpath`
   containment check against the resolved session directory, exactly as `proto.ts` does for writes.
   An unknown or foreign-session id then fails uniformly at the DB-lookup step, which also answers
   the "wrong session's token" and "traversal id" contracts with one code path.

2. **[PATH TRAVERSAL — write side]** The same symlink race that `copyNoFollow`/`O_NOFOLLOW` guard
   against on write applies when the daemon *stages* an asset into the session directory, not just
   when it serves one. Recommend reusing that write-guard (`O_CREAT|O_EXCL`-style no-follow open,
   not a bare `writeFile`) for the staging path itself, rather than re-deriving new write logic.

3. **[TOKEN TRANSPORT]** `<img src>` cannot set headers, which rules out a header-based credential
   for the actual asset fetch. A shared loopback cookie is also structurally wrong here: slice 2's
   design is one daemon origin hosting *many concurrent sessions* (the canvas renders several live
   session nodes on one page at once), each with its own minted token — a single cookie cannot
   disambiguate N simultaneously-valid session tokens on one origin the way it could for a
   traditional single-session web app. That leaves a query-string token (`?t=<token>`) as the only
   channel `<img src>` has left to carry a per-request, per-session credential — this is a forced
   conclusion given the constraints, not a preference. Recommend making this explicit in the
   engineering checklist (it is currently unstated) and mitigating the residual exposure: don't
   persist full request URLs (with token) to any daemon access log, and reuse the existing
   per-session token as-is rather than inventing a new derived credential type, since the Testing
   Criteria ("a request... with another session's token, is refused") already assumes the literal
   session token is the credential being checked.

4. **[ENCRYPTION VS SERVING]** Slice 3's "per-record iv and auth tag" phrasing (singular, one
   IV/tag per asset) means AES-GCM here is whole-file, not chunked — there is no way to verify a
   byte range's auth tag in isolation. Range requests (video seeking) can still be served
   *correctly*: the server fully decrypts the file into memory, then slices the plaintext buffer
   according to the `Range` header before writing a 206 response. Correctness is preserved but cost
   is not: every ranged sub-request re-decrypts the whole file, which is fine for images (browsers
   don't range-request images) but would be expensive for any future large/video asset with
   frequent seeking. Since the current Acceptance Criteria only ever mention "an image," this is a
   documented limitation rather than a blocker — recommend noting it explicitly rather than leaving
   it implicit, so a future video asset type doesn't silently inherit a bad-perf path. Separately,
   recommend an explicit engineering bullet that decrypted bytes are held only in an in-memory
   buffer for the life of the response and never written to a temp file — the plan doesn't say this
   today, and it's the one behavior that would quietly defeat at-rest encryption if skipped.

5. **[OPEN — escalate]** How does the options page reach the daemon's port at all? The daemon binds
   an OS-assigned ephemeral port (slice 2) and writes it only to a lockfile on disk. The extension
   only ever learns a port via the `_chat` marker capture flow (slice 4), which stashes
   `port/token/sessionId` in `chrome.storage.session` — populated only after at least one chat
   session has been bootstrapped *this browser session*. Native messaging is explicitly excluded
   from this bundle's scope, so there is no other channel for the extension to discover a running
   daemon's port. A user opening Settings before ever running `dg:start` (e.g., right after
   install, to pre-configure the asset directory) has no known port to connect to, regardless of
   whether a daemon happens to be running. Options: (a) options page falls back to the last known
   port from a longer-lived `storage.local` cache (accepting it may be stale after a daemon
   restart, needs a liveness ping), (b) accept and document that the asset-directory setting is
   only reachable after a session has been started once this browser session, (c) some other
   discovery mechanism not currently in any slice's scope. This is a product/architecture call, not
   a slice-9-local implementation detail — recommend surfacing it before slice 9 is built, since it
   determines what the options page's empty/first-run state even looks like.

6. **[SETTINGS UX]** Related to #5: the plan doesn't specify what the field shows when the daemon
   is unreachable (whether from #5's cold-start case or a daemon that was running and stopped).
   The existing `options/main.ts` pattern (`load()` catching errors into `fail()`, a status line
   with an `.err` class) is the right shape to extend — recommend an explicit bullet: on load
   failure, disable the field and show a "dg-server is not running" hint rather than showing a
   stale or blank value that looks editable but will fail to save.

7. **[SETTINGS TRANSPORT / STRUCTURE]** The "reject an unwritable directory... report the reason
   rather than failing silently at first use" wording already implies validate-then-persist (not
   write-then-discover), which is correct — recommend making that ordering an explicit bullet
   rather than leaving it implied. Two structural points on the round trip itself: (a) the
   Code Structure "Result convention" decision lists slice 9 as an applicable slice for the
   `{ok, error}` frame envelope — recommend the read/write exchange use that same envelope shape
   for consistency, and (b) the actual settings round trip cannot be a *new* `ChatFrame` type,
   because `pkg/common/src/chat-format.ts` is not in slice 9's file list (it's slice 1's). Recommend
   the checklist state explicitly that this is a small dedicated HTTP JSON endpoint on the daemon's
   existing HTTP server (alongside `/start` and `/assets/<id>`), not a WebSocket frame — this also
   means the options page doesn't need a live chat session's socket, just a plain `fetch()` to the
   known port, which is simpler than it currently reads.

8. **[OPEN — escalate, completeness]** No slice defines the actual trigger for staging an asset
   (writing bytes + registering the `assets` row). Slice 7's CLI surface is `recv`/`send`/`status`/
   `spawn`; slice 8's dispatch is `$`-commands and `@`-mentions — neither lists an asset/upload
   verb. Slice 9 cannot add one itself: `pkg/dg-server/src/commands/**` and `src/dispatch/**` are
   slice 7/8's files, not slice 9's. As scoped, slice 9 can fully build the directory, the GET
   endpoint, and cleanup, but the Acceptance Criterion "given the agent stages an image" has no
   implemented path anywhere in the bundle to make that stage happen. This needs a decision: add a
   `stage`/`asset` verb to slice 7's checklist, or extend slice 9's file scope to include one
   narrowly-targeted command file. Flagging rather than assuming, since it changes another slice's
   already-fixed file list.

9. **[OPEN — escalate, completeness]** Symmetric gap on the render side. Slice 9's acceptance
   criterion — "the chat node renders it... with no base64 in the transcript" — requires the
   transcript renderer to recognize an asset reference and emit an `<img src>` pointing at
   `/assets/<id>?t=...`. That renderer is `pkg/extension/lib/features/chat-transcript.ts`, owned by
   slice 5, which is not in slice 9's file list and whose own engineering checklist ("renders whole
   agent messages, folds progress frames...") never mentions assets or images. Recommend resolving
   the *reference* mechanism without a schema change if possible — e.g. the agent embeds a
   well-known URI form directly in the message body text, so neither `chat-format.ts` (slice 1) nor
   the `messages` table (slice 3) needs a new field/column — but the rendering logic itself is still
   a real gap that only slice 5 (or 6) can close, and needs an explicit bullet added there before
   slice 9 can claim this acceptance criterion is achievable within its own file boundary.

10. **[OPEN — escalate, design gap]** "Session ends" has no concrete trigger anywhere in the plan.
    A dropped WebSocket is explicitly *not* an end (slice 5: reconnect with backoff, replay
    unacknowledged messages). Slice 6's canvas has no close/delete-node affordance. Slice 7 has no
    CLI verb to end a session (only `spawn` to create one). The only unambiguous session-ending
    event in the plan is the daemon itself exiting (idle-TTL or `stop`), which slice 9's own
    "prune orphans on startup" already covers on the next launch. If that is genuinely the only
    trigger, "ending a session removes its staged assets" and "startup prunes orphans" collapse
    into the same mechanism, but the Testing Criteria phrase them as two distinct guarantees
    ("Ending a session removes its staged assets; startup prunes orphans" — worded as two separate
    behaviors). Recommend clarifying whether a live, mid-daemon-run session-close event is actually
    in scope anywhere (and if so, where it's produced), or whether slice 9's "clean up... when the
    session ends" bullet should be reworded to mean "on daemon shutdown/restart" only.

11. **[DESIGN GAP]** Message history is durable (slice 3: SQLite is the only store of record, no
    scope item deletes transcripts). If asset bytes are deleted on session-end/orphan-prune while
    the message that presented them survives indefinitely, that message permanently references a
    now-missing asset — a dangling image forever after, once the session is gone. Embedding the
    asset in the transcript as base64 is explicitly excluded by this slice's own acceptance
    criteria, so the bytes can't be preserved that way either. Recommend two concrete additions
    (partly in slice 9's scope, partly not): (a) in scope — `GET /assets/<id>` for a
    pruned/unknown id returns a distinguishable 404 reason (not a bare failure), so a client can
    tell "gone" apart from "wrong token"/"traversal"; (b) out of slice 9's scope but worth flagging
    to whoever owns the renderer (slice 5/6) — show a labeled "asset removed" placeholder rather
    than a generic broken-image icon. This is a real, currently-unaddressed gap per the task's own
    framing, not a nice-to-have.

12. **[STRUCTURE, minor]** Slice 2's file glob `pkg/dg-server/__tests__/**` is a superset that
    nominally overlaps every later dg-server slice's own test glob, including slice 9's
    `__tests__/assets/**`. In practice no actual collision is expected — slice 2 will only populate
    its own subdirectories (`__tests__/server/**`, `__tests__/session/**`) — but the documented
    globs as written are not strictly disjoint. Recommend tightening slice 2's glob for clarity;
    not a blocker.

13. **[REUSE, minor]** Searched `pkg/extension/lib`, `pkg/common/src`, `pkg/skills-cli/src` for an
    existing extension-to-content-type helper; none exists (`capture-quality.ts`'s
    `preferredMimeType` is MediaRecorder codec selection, unrelated). Recommend hand-rolling a small
    fixed lookup for the expected staged-asset types (png/jpg/jpeg/gif/webp/svg, etc.) rather than
    adding a `mime-types`-style dependency — also avoids touching `pkg/dg-server/package.json`,
    which is slice 2's file, not slice 9's.

14. **[SIBLING DISJOINTNESS — confirmed clean]** Slice 9's files
    (`pkg/dg-server/src/assets/**`, `pkg/extension/entrypoints/options/**`,
    `pkg/extension/lib/config.ts`, both `__tests__` globs) do not overlap slice 4's
    (`chat-marker.ts`, `chat-marker-capture.content.ts`, `chat-messages.ts`, `lib/background/**`,
    `entrypoints/background.ts`, `wxt.config.ts`) or slice 6's (`entrypoints/chat/**`,
    `chat-canvas.ts`, `chat-node.ts`). On the daemon side, `src/assets/**` is a sibling namespace to
    slice 2's `src/server/**`/`src/session/**`/`src/utils/**`, slice 3's `src/store/**`/
    `src/crypto/**`, slice 7's `src/commands/**`/`src/manifest/**`, and slice 8's `src/dispatch/**`
    — no overlap. (See #12 for the one non-blocking glob-breadth caveat on slice 2's `__tests__/**`.)
