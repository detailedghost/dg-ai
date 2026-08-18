# Slice 3 — sqlite-store-and-encryption

Per-slice review findings (plan.md step 5).

Reviewed against plan.md (all 10 slices, dependency graph, `## Scope`, `## Code Structure`), the
sibling reviews for slices 1, 2, 7 and 9, and the live codebase: `pkg/skills-cli/src/utils/lib.ts`
(`run`, `isWSL`), `pkg/skills-cli/src/utils/proto-paths.ts` (`protoScratchPath`),
`pkg/skills-cli/package.json`, `pkg/skills-cli/bunfig.toml`, `pkg/extension/utils/recording-db.ts`,
`.agents/monolith.md`, `.agents/school/quality.md`. `pkg/dg-server/**` does not exist yet
(`current_slice: 0`), so this is a pre-implementation soundness check, not a code review.

`bun:sqlite` and `node:crypto` API facts came from context7 (`/oven-sh/bun`
`docs/runtime/sqlite.mdx`; `/websites/nodejs_latest-v24_x_api` `crypto.json`) and were then
**verified empirically on this box** (Bun 1.2.22, SQLite 3.50.4, WSL2). Every claim marked
*(proven)* below is a recorded result from one of five probe scripts in the session scratchpad:
`probe-sqlite.ts`, `probe-sqlite2.ts`, `probe-conc.ts`, `probe-crypto.ts`, `probe3.ts`,
`probe4.ts`, `probe5.ts`, plus a `bun build --compile` binary (`dgprobe-bin`).

Confirmed up front, per the brief: **`bun:sqlite` supports everything the checklist assumes.**
`new Database(path, {create, strict})`, `PRAGMA journal_mode = WAL` (returns `{journal_mode:"wal"}`
and persists across reopen without re-issuing the pragma), and `PRAGMA user_version` read/write all
work *(proven)*. `db.transaction()`, `RETURNING`, `AUTOINCREMENT` and `VACUUM INTO` work. A
`bun build --compile` single-file binary carries `bun:sqlite` **and** `node:crypto` AES-256-GCM with
AAD with no native dependency *(proven: `dgprobe-bin` encrypted, stored a BLOB, and decrypted)*. And
`pkg/extension/utils/recording-db.ts` is genuinely untouched: slice 3's four globs are all
`pkg/dg-server/**`, every importer of `recording-db` is under `pkg/extension/**` (7 files, none in
slice 3's list), and `## Scope > Excluded` names it explicitly.

---

## Crypto correctness

1. **[CRYPTO — NONCE] Make nonce reuse structurally impossible rather than test-detectable: the
   public encrypt surface must take no IV parameter at all.** — "never reuse a nonce" is currently a
   prose instruction, and prose does not survive a later refactor. Recommend
   `encryptRecord(plaintext: Uint8Array, aad: Uint8Array): EncryptedRecord` generating its own
   `randomBytes(12)` internally on every call, with the IV appearing only inside the returned record
   and in `decryptRecord(record, aad)`. Then add the three rules that a signature cannot express:
   (a) an UPDATE of an already-encrypted column re-encrypts with a **fresh** IV, never the row's
   stored one; (b) a migration that copies or rebuilds an encrypted table copies the
   `(iv, tag, body)` triple **verbatim** or re-encrypts with fresh IVs — never re-encrypts new
   plaintext under a stored IV, which is the single realistic way this design produces a catastrophic
   nonce reuse; (c) counter/deterministic IVs are prohibited outright, because slice-2 finding 7
   shows two daemons can transiently race, and two processes sharing a counter is exactly nonce
   reuse. Random 96-bit IVs are the right choice here for that reason: at chat volumes the birthday
   bound is irrelevant, and randomness is the only scheme that is safe under an accidental second
   writer.

2. **[CRYPTO — AAD] Yes — bind the row identity into AAD, as
   `"<domain>|<formatVersion>|<sessionId>|<rowId>"`, and restrict AAD to immutable columns.** —
   Verified that Bun's `node:crypto` enforces this properly: decrypting with a different AAD, and
   decrypting with no AAD at all, both throw `Unsupported state or unable to authenticate data`
   *(proven)*. Cost is zero and it buys three real properties: a ciphertext cannot be moved between
   rows of `messages`, cannot be moved between sessions, and — because of the `<domain>` tag — cannot
   be moved between tables (an `assets` blob pasted into `messages.body`, or a `command_invocations`
   output pasted into a message the user then reads as if the agent had said it). Two constraints to
   write down: AAD must contain **only immutable** fields (`id`, `session_id` — never `kind`, `role`
   or a timestamp a migration might normalise, which would make every historical row
   undecryptable), and the `<formatVersion>` component is what lets the record layout change later
   without ambiguity.

3. **[CRYPTO — TAG] Store the 16-byte tag in its own `BLOB NOT NULL` column, not appended to the
   ciphertext, and assert its length on read.** — context7 confirms GCM's tag defaults to 16 bytes
   and `authTagLength` is optional for GCM (required only for CCM/OCB); *(proven)* the default tag is
   16 bytes and `authTagLength: 12` genuinely produces a 12-byte tag, so a truncated tag is
   reachable by accident. A separate column makes the "tampered auth tag fails loudly" contract a
   two-line test, makes a truncation bug a schema error rather than a silent security downgrade, and
   keeps `SELECT length(body)` meaningful. Also note two Bun behaviours that are helpfully strict and
   should be relied on rather than worked around: `getAuthTag()` before `final()` throws, and
   `setAAD()` after `update()` throws *(proven)* — so there is no silent "AAD was ignored" failure
   mode to defend against.

4. **[CRYPTO — IV LENGTH] Assert `iv.length === 12` in code and in a test — the library will not do
   it for you.** — `createCipheriv("aes-256-gcm", key, iv)` accepted 8-, 12-, 16- **and** 32-byte
   IVs without complaint *(proven)*. A wrong-length IV is therefore a silent security regression, not
   a crash: non-96-bit nonces go through GHASH-based derivation and lose the clean uniqueness
   argument the design depends on. One `if` plus one contract test closes it.

5. **[OPEN — escalate] There is no key-rotation story at all today; decide now whether the key is
   permanent, because retrofitting rotation after rows exist is the expensive direction.** — As
   written, the key resolved at first run encrypts every row forever: nothing records *which* key a
   row used, so even identifying rows for re-encryption is impossible after the fact.
   Options: (a) accept a permanent key and say so explicitly in the plan and in
   `docs/AGENT-INSTALL.md` (cheapest; means a suspected key compromise has no remedy short of
   deleting the store); (b) single-tier rotation — add a `key_id` column to every encrypted row and
   a `dg-server rekey` verb that walks and re-encrypts (simple, but O(rows) with a long
   non-atomic window); (c) envelope encryption — a random per-database DEK stored **wrapped** by the
   keychain/file KEK in a `crypto_meta` row, so rotating the KEK is a single re-wrap and rotating
   the DEK is a lazy per-row migration keyed off `dek_id`. Recommendation: (c). It is roughly one
   extra table and one integer column now, it makes KEK rotation O(1) instead of O(rows), and it is
   the same mechanism that lets the file-key → keychain migration in finding 9 happen without
   touching a single message row. Whichever is chosen, finding 6's key fingerprint is required
   regardless.
   ⚑ RATIFY: Is the chat store's encryption key permanent for the life of the database, or is key
   rotation a supported operation? — Options: (a) permanent, documented as such, no remedy for a
   suspected key compromise beyond deleting the store; (b) `key_id` per row plus a `dg-server rekey`
   verb that re-encrypts every row; (c) envelope encryption — a wrapped per-database DEK in
   `crypto_meta`, so KEK rotation is a single re-wrap. — Recommendation: (c); it costs one table
   and one column now, and it is the only option where rotation is O(1) and where the file-key →
   keychain upgrade in finding 9 touches no message rows.

6. **[SCHEMA — COMPLETENESS] The table list has no home for crypto metadata; add a `crypto_meta`
   table (or single-row `meta` table) holding `format_version`, `key_id`, `key_source`, and — under
   finding 5(c) — the wrapped DEK with its own iv/tag.** — The enumerated tables are sessions,
   messages, status_events, assets, command_invocations. Without a `key_id` recorded next to the
   ciphertext, the key-mismatch failure in finding 9 is *undetectable* — the daemon cannot tell
   "wrong key" from "corrupt data", and every subsequent decrypt just throws. `key_id` must be a
   non-secret fingerprint (e.g. `hkdfSync("sha256", key, salt, "dg-key-id", 16)` — `hkdfSync` is
   available in Bun *(proven)*), never the key or a bare hash of it.

## Key resolution

7. **[KEY — LOGIC GAP] Nothing in the checklist ever *writes* a key into the keychain, so the
   keychain branch as specified is dead code.** — The bullet is "Resolve the key from the OS keychain
   first; on failure fall back to `~/.dg/key`". A read-only keychain path never finds anything on a
   first run, falls back to the file, and the file then wins forever. Add the missing half
   explicitly: on a genuinely fresh store (no `crypto_meta` row), mint a key with `randomBytes(32)`
   and **store it in the keychain when the keychain is reachable**, falling back to the file only
   when the *store* fails — and record which source succeeded in `crypto_meta.key_source`. Without
   this bullet, the "prefers the keychain" contract test can only pass against a keyring some other
   tool populated.

8. **[KEY — CRITICAL] A failed keychain read is indistinguishable from absence at the exit-code
   level; I proved it on this box, and treating them the same is the data-loss path.** —
   `secret-tool lookup` exits **1 with empty stdout** when the secret is absent, and exits **1** with
   `secret-tool: Could not connect: No such file or directory` on stderr when the D-Bus session is
   unavailable — including the case where the secret *does* exist and only the daemon is unreachable
   *(all three cases proven)*. A resolver that reads "non-zero exit → not in keychain → fall back to
   file" therefore mints a brand-new `~/.dg/key` on a machine whose real key is sitting in the
   keychain, after which every existing message body is permanently undecryptable. Recommend the
   resolution order be driven by **key identity, not by source**: (1) read `crypto_meta.key_id`;
   (2) collect candidate keys from every source that answers; (3) use the candidate whose fingerprint
   matches `key_id`; (4) if no candidate matches, **refuse to start** with a message naming the
   recorded source/id and the resolved source/id; (5) mint-and-store (finding 7) only when there is
   no `crypto_meta` row at all. Additionally: never infer "absent" from exit status alone — require
   an affirmative reachability signal (a `secret-tool search`/canary probe, or exit-1 **with empty
   stderr**), and report "keychain unreachable" as its own distinct state in `dg-server status`,
   separate from "keychain has no key".

9. **[KEY — CRITICAL] "The keychain later becomes available" must be an explicit, non-silent
   migration, and a source change must never be inferred silently.** — With finding 8's identity-first
   resolution the dangerous case becomes benign: a machine running on `~/.dg/key` that later gains a
   working keyring finds no matching key in the keychain, finds a matching one in the file, and keeps
   using the file. Recommend making the upgrade deliberate — a `dg-server key --migrate-to-keychain`
   style step (or a one-line prompt in `status` output) that copies the *existing* key into the
   keychain and updates `crypto_meta.key_source`, never a startup-time auto-switch. The symmetric
   downgrade (keychain key becomes permanently unavailable, e.g. a wiped keyring) must land in
   finding 8's step (4) refusal rather than a fresh key: the ciphertext is unrecoverable either way,
   but refusing preserves the operator's chance to restore the keyring, while minting silently
   converts a recoverable situation into a permanent one and hides that it happened.

10. **[KEY — BACKENDS] Pin one shell-out backend per platform, and define "unreachable" per backend
    as a distinct outcome from "absent" — there is no native-module option available.** — Confirmed
    slice-2 finding 22's premise: a `bun build --compile` binary carries `bun:sqlite` and
    `node:crypto` fine *(proven)* but cannot carry a native keychain addon, so shelling out is the
    only path. Concretely: **Linux** `secret-tool` (libsecret/Secret Service) — present and fully
    working on this WSL box (`store`/`lookup`/`clear` all exit 0, `DBUS_SESSION_BUS_ADDRESS` set,
    `/run/user/1000/keyring` exists) *(proven)*; unreachable = binary missing, no session bus, or
    collection locked. **macOS** `security add-generic-password` / `find-generic-password -w` —
    always present, but two hazards to handle: the first access by a *new binary identity* raises a
    GUI ACL prompt, and slice-2 finding 6 makes the daemon a detached process with
    `stdio: "ignore"`, so that prompt appears with no terminal attached to explain it; a dismissed
    prompt returns an error that must land in finding 8's "unreachable", not "absent". Also prefer
    not to pass the secret in `argv` (`-w <secret>`) where a same-machine `ps` can see it. **Windows**
    has no built-in CLI that *reads a secret back* (`cmdkey` writes only; the `CredentialManager`
    PowerShell module is not shipped), so the realistic built-in is DPAPI
    (`System.Security.Cryptography.ProtectedData`, `CurrentUser` scope) over a
    `~/.dg/key.dpapi` blob — which is a protected file, not a keychain, and should be named as such
    in `status` output rather than reported as "keychain". Recommend the checklist enumerate these
    three plus the plain-file fallback as four named, testable key sources.

11. **[REUSE / STRUCTURE] The existing `run()` helper cannot implement the keychain backend, and the
    helper it needs has no declared file home in this slice.** — `pkg/skills-cli/src/utils/lib.ts`'s
    `run()` uses `spawnSync` with **no stdin**, **throws** on non-zero with stdout/stderr merged into
    an Error string, and **trims** stdout. All three break slice 3: `secret-tool store` needs the
    secret on **stdin** (passing it in argv exposes it via `/proc/<pid>/cmdline`), finding 8 needs
    `{status, stdout, stderr}` kept **separate** to tell absence from unreachability, and trimming
    would corrupt any non-text key material (a further reason the key file/keychain value should be
    base64 text, never raw bytes). Recommend a `runCapture(cmd, args, {stdin})` returning the triple
    rather than throwing, hoisted into `@dg/common/node` alongside slice-2 finding 21's
    `isWSL`/`run`/`tryOpen` hoist — **not** duplicated into `src/crypto/**`, per the project's
    shared-utilities rule. Note the scope consequence: `pkg/common/src/node/**` is slice 1's glob, so
    this needs adding to slice 1's Engineering checklist (same route as slice-2 finding 21), and
    slice 3's dependency on it should be visible in the plan rather than discovered mid-build.

12. **[KEY — FILE MODE] "Created mode 0600" is not sufficient; verify the mode on every read, and
    mint with `O_EXCL`.** — Two proven mechanics: `writeFileSync(path, data, {mode: 0o600})` leaves
    an **existing** file's mode untouched — rewriting a file that is already 0644 keeps it 0644
    *(proven)* — so a key file created by an earlier/buggier version, or loosened by a stray
    `chmod`, silently stays world-readable forever; and `open(path, "wx", 0o600)` throws `EEXIST`
    *(proven)*, which is the guard the mint path needs, because slice-2 finding 7 shows two
    `dg-server start` invocations can race and last-writer-wins on two independently minted keys
    would orphan whichever ciphertext was written first. Recommend: mint with `O_CREAT|O_EXCL|0600`
    and on `EEXIST` re-read instead of overwriting; on every read `fstat` the file and refuse (or
    `chmod` and warn loudly, ssh-style) when the mode is not `0600`; store base64 plus the `key_id`
    and a format version so the fingerprint check in finding 8 works even when the DB is absent.

13. **[PERMISSIONS] "Create the database file with restrictive permissions" is not achievable by
    chmod'ing the database file — the containment has to be a 0700 directory.** — Measured on this
    box with umask 022: the main DB file, the `-wal` file, the `-shm` file, and a `VACUUM INTO`
    backup are **all created 0644** *(proven)*, and the sidecars appear and disappear on their own
    schedule (they were absent after `close(true)`, present after `close(false)`, and removed again
    by `PRAGMA wal_checkpoint(TRUNCATE)` *(proven)*) — so chasing them with `chmod` is a losing game.
    `~/.dg` is **0755 today** on this machine and already shared with `bin/` and `demos/`. Recommend
    the DB and key live in a dedicated directory created 0700 (e.g. `~/.dg/state/`) with the mode
    asserted on every startup, and that the resolver expose that directory as a named field — which
    lands on slice-1 finding 7's request to pin the resolver's exact shape (`dbPath`/`keyPath`/…)
    rather than a bare root other slices join onto.

14. **[THREAT MODEL] Write down what this encryption does and does not defend, in the plan, next to
    where it is called a requirement.** — It defends: another user on a multi-user box reading a
    0644 file; a cloud-sync/backup client replicating `~/.dg` off the machine; casual disk or
    external-`sqlite3` inspection (the stated acceptance criterion). It does **not** defend against
    the same OS user, who can read the key by construction — the identical trust model slice-2
    finding 12 accepts for the session-token file, and it should be an *accepted* risk in the plan
    rather than an unstated one. One sharp consequence worth stating: when the fallback key lives at
    `~/.dg/key` **beside** the database, any backup or sync of `~/.dg` copies both, and at-rest
    encryption buys nothing against exactly the threat it is most plausibly there for. That is an
    argument for preferring the keychain wherever reachable (finding 7), and for documenting the
    file-key mode as the weaker configuration rather than an equivalent one.

## What is NOT encrypted

15. **[SPLIT — the real gap] The plaintext/ciphertext split is defensible for ids, `sessionId`,
    `role`, `kind` and timestamps, but `command_invocations` and `status_events` are the bigger leak
    and are currently outside it — extend encryption to them.** — Answering the brief's three
    sub-questions in order. *(a)* Plaintext `kind` and `role` leak conversation shape only, and they
    genuinely earn it: they are what makes the queue query in finding 23 an index seek. Accept.
    *(b)* The message-length side channel is unavoidable with GCM (CTR-mode ciphertext length equals
    plaintext length exactly), and combined with plaintext timestamps it yields a precise
    typing/length trace. For a single-user local tool that is a fair trade; recommend stating it as
    an accepted limitation so nobody later assumes the store is length-hiding. Bucket padding is
    cheap if the human disagrees, but I would not spend it. *(c)* **`$` command strings and their
    captured output are not covered by "message bodies and asset bytes", and they are the most
    secret-bearing content in the whole store.** Slice 8 records every invocation in
    `command_invocations` and caps captured output — that output is arbitrary command stdout/stderr
    (`.env` contents, tokens echoed by a tool, `gh auth status`), and the argv can itself carry a
    secret the user typed into the composer. Recommend encrypting `command_invocations`' argv and
    captured stdout/stderr, and `status_events`' progress text (agent-authored prose that routinely
    quotes file and error content), using the same record helper with distinct AAD domain tags. Two
    smaller items in the same class: an asset's **display filename** is user/agent-authored and
    should be encrypted, with the on-disk name being the opaque asset id (this also directly serves
    slice-9 finding 1's "look the row up, never re-derive a path from the URL segment"); and the
    command manifest slice-7 finding 7(a) asks this slice to persist is a list of command lines, so
    it belongs on the encrypted side too.

## Migrations

16. **[MIGRATION — ATOMICITY] One transaction per migration step with the `user_version` bump
    *inside* it, and migration callbacks must be strictly synchronous.** — This is the answer to "how
    is a mid-way failure recovered", and it is stronger than expected: SQLite makes DDL and
    `PRAGMA user_version` transactional together, so a step that throws leaves **both** the schema
    and the version untouched — verified by rolling back an `ALTER TABLE ... ADD COLUMN` plus a
    `user_version` bump in one failed `db.transaction()` and observing the column absent and the
    version unchanged *(proven)*. Recovery is therefore "re-run and it resumes at the last completed
    step", with no repair code. **But** `db.transaction(async () => …)` is a trap: it returns a
    Promise and **commits before the async body finishes**, so a late throw does not roll back — my
    probe left the row committed *(proven)*. Recommend the migration runner be typed to reject async
    steps, and the same rule stated for every store write. Also guard concurrent migrators (two
    daemons, slice-2 finding 7): open the step with `BEGIN IMMEDIATE` and re-read `user_version`
    *inside* the transaction before acting, so the loser becomes a no-op instead of double-applying.

17. **[MIGRATION — MECHANICS] `PRAGMA user_version` cannot be parameterised; interpolate a validated
    integer constant.** — `db.run("PRAGMA user_version = ?", [4])` fails with
    `near "?": syntax error` *(proven)*; only a literal works. Recommend the version be a
    module-level `const` array index (or `Number.isInteger` asserted) interpolated into the SQL, with
    a comment naming the reason — otherwise the first person to "fix" the inconsistency by binding a
    parameter gets a runtime syntax error, and the second one reaches for a template string over an
    unvalidated value.

18. **[MIGRATION — SKEW] Forward-only, and the daemon must refuse to open a database whose
    `user_version` is greater than the highest version it knows.** — `PRAGMA user_version = 99` is
    settable with nothing to stop it *(proven)*, so an older daemon meeting a newer DB after a
    downgrade is a live scenario the moment slice 10 ships releases. As written the plan only covers
    "an older one migrates forward"; the reverse case would have the old binary write rows against a
    schema it does not understand — silent corruption. Recommend: state forward-only explicitly (no
    down-migrations); on `user_version > CURRENT` exit non-zero with a message naming both versions
    and the remediation (reinstall the newer `dg-server`, or move the store aside); add contract
    tests for both directions, since only the forward one is covered today.

19. **[MIGRATION — RECOVERY] Take a `VACUUM INTO` snapshot before any step that cannot be a single
    transaction, and never call `db.close(true)` on a failure path.** — `VACUUM INTO '<path>'` works
    in `bun:sqlite` *(proven)* and is a hot, atomic, single-statement backup — the right escape hatch
    for a future table-rebuild migration that has to span statements, and worth wiring in now while
    the migration runner is being written rather than after the first destructive step exists. Note
    the backup file is created 0644 *(proven)*, which is finding 13's argument again. Separately, and
    reproducible: after a `db.transaction()` callback throws, `db.close(true)` itself throws
    `database is locked` while `db.close(false)` succeeds *(proven, Bun 1.2.22)* — the rollback did
    happen (0 rows) and a second connection could write immediately afterwards *(proven)*, so this is
    a close-path artefact, not a leaked lock. Recommend the shutdown path use `close(false)`, or
    catch around `close(true)`, so a failed migration reports *its own* error instead of being masked
    by a confusing secondary one.

20. **[MIGRATION — VERSIONING] `user_version` is a **fourth** independently-versioned artefact;
    keep it decoupled from the protocol version and report all of them in `dg-server status`.** —
    Slice-2 finding 9 identified three (package version, `protocolVersion`, extension) and
    recommended gating attach on `protocolVersion`. The DB adds a fourth with a different lifetime:
    a frame-shape change needs no migration, and a schema change need not break the wire. Recommend
    they never be conflated in one number, that `status` print all four, and that the protocol-mismatch
    refusal in slice-2 finding 9 and the schema-too-new refusal in finding 18 be two distinct,
    separately-worded errors — an operator who sees one generic "version mismatch" cannot tell
    whether to upgrade the daemon or restore a database.

21. **[SCHEMA — PRAGMAS] Set `foreign_keys`, `busy_timeout` and the single-writer invariant
    explicitly; keep `synchronous` at its default.** — Three measured defaults that all need
    action. `PRAGMA foreign_keys` is **0 (OFF)** *(proven)*, and it is per-connection and a no-op
    inside a transaction — so the sessions→messages/assets references the table list implies are not
    enforced unless it is set at open time, outside any transaction (with FKs on, inserting a message
    for an unregistered session is correctly rejected *(proven)*, which is a cheap invariant given
    slice 2 owns registration and slice 3 owns the store of record). `PRAGMA busy_timeout` is **0**
    *(proven)*, so a second writer gets an immediate `database is locked` throw rather than waiting —
    set it explicitly (a few seconds) and state the single-writer invariant: exactly one `Database`
    instance in the daemon, and no other process opens the store for writing. `PRAGMA synchronous`
    is already **2 (FULL)** and WAL does not lower it *(proven)* — that is what actually backs
    slice 7's "durably stored before `recv` reports it delivered", so recommend an explicit note not
    to lower it for throughput.

22. **[AMBIGUITY — "strict mode"] Say which strict mode, because there are two unrelated ones and
    the slice wants both.** — Bun's `new Database(path, {strict: true})` is about **parameter
    binding** (throws on a missing/typo'd named parameter, and lets you bind without the `$` prefix)
    per context7. SQLite's `STRICT` is a **table** keyword enforcing column types — with it, storing
    an integer into a `BLOB` column is rejected (`cannot store INT value in BLOB column t.iv`
    *(proven)*), which is exactly the guardrail an iv/tag/body schema wants. They are independent.
    Recommend the checklist say "Bun `strict: true` **and** `STRICT` on every `CREATE TABLE`", and
    note *(proven)* that `STRICT` composes fine with `INTEGER PRIMARY KEY AUTOINCREMENT` and
    `REFERENCES`, which finding 23 depends on.

## Read semantics

23. **[READ SEMANTICS] Expose peek-then-ack with a claim lease — not a transactional consume — and
    the schema needs three columns and an ordering key it does not currently have.** — Answering
    slice-7 finding 4 directly, and concurring with it: for this direction, at-least-once with an
    occasional duplicate after a crash is strictly better than at-most-once with a silent drop,
    because the payload is a human's typed message and the store is the only copy. Concretely
    recommend: `messages` gains `seq INTEGER PRIMARY KEY AUTOINCREMENT` as the **ordering key**, a
    separate client-generated `id TEXT NOT NULL UNIQUE` (needed anyway as finding 2's AAD input,
    and it cannot be the rowid because the AAD must exist *before* the INSERT), plus
    `claim_id TEXT`, `claimed_at INTEGER`, `delivered_at INTEGER`. Ordering must be by `seq`, not by
    timestamp — the current criterion "plaintext metadata columns remain queryable by sessionId and
    timestamp" is fine for indexing but timestamps are neither unique nor monotonic, so "returned in
    order" cannot rest on them; and `AUTOINCREMENT` (rather than a bare `INTEGER PRIMARY KEY`)
    matters if any pruning is ever added, since plain rowids are reused after deletion and a
    late-arriving ack would then target the wrong row. The claim is one statement —
    `UPDATE messages SET claim_id=$c, claimed_at=$now WHERE seq = (SELECT MIN(seq) FROM messages
    WHERE session_id=$s AND delivered_at IS NULL AND (claimed_at IS NULL OR claimed_at < $stale))
    RETURNING seq, id, iv, tag, body` — verified end to end: two concurrent readers claimed two
    *different* rows, and an expired lease was re-claimable *(proven, SQLite 3.50.4)*. `recv` then
    claims → decrypts → writes stdout → flushes → `ack(seq, claimId)` sets `delivered_at`. Three
    consequences to record: the lease is what stops two live `recv` calls on one session from both
    getting the same message (a plain peek would); the duplicate window is bounded by the lease TTL,
    so the TTL must be documented and shorter than slice 7's `--timeout`; and the store API surface
    should be exactly `claimNext` / `ack` / `peekAll` — deliberately **no** atomic pop, so slice 7
    cannot accidentally reintroduce the crash window.

## Persistent root

24. **[ROOT] Concurring with slice-1 finding 6 and slice-2 finding 19 — pin the store and key to
    `~/.dg` unconditionally and use `DG_HOME` for test isolation; slice 3 adds the failure they do
    not name.** — The sharper slice-3 case is that the **key and the database must move together or
    not at all**, and an env-var-derived root guarantees they sometimes do not. Two concrete
    outcomes, both silent: if the keychain holds the key, a shell with `AI_SCRATCH_DIR` set and one
    without resolve the *same* key against *two different databases*, so transcript history splits
    in half with no error anywhere and slice 3's "SQLite is the ONLY store of record" claim is simply
    false; if the file fallback is in use, the second root **mints a different key** (finding 12),
    and any later attempt to consolidate or restore the two roots yields a database whose rows cannot
    be decrypted by the key sitting next to it. Add the reboot case slice 1 already named and the
    result is that the durability requirement ("a message sent while no agent is listening is
    delivered by the next `recv`") and the key-continuity requirement are both void whenever a
    routine dev-machine env var is set. Recommend `DG_HOME` (slice-2 finding 18) as the *only*
    override, honoured by slice 1's resolver, and no `AI_SCRATCH_DIR` influence on the persistent
    root at all. One objection pre-empted: this is not a filesystem-capability problem — I created a
    WAL database on a DrvFs path under `/mnt/c` and wrote to it successfully *(proven)*, so the case
    against an env-var root is durability and split-brain, not "SQLite can't live there".

## Structure conformance and scope

25. **[STRUCTURE — OWNERSHIP CONFLICT] Two of slice 3's own Engineering bullets require editing
    slice 2's files; resolve it before build.** — "Surface the active key source in `dg-server
    status` output" and "warn loudly at startup naming which source is in use" both land outside
    `src/store/**` and `src/crypto/**`: `status` is registered in `src/index.ts` and the startup path
    is `src/server/**`, both slice 2's. Because slice 3 `depends_on: [1,2]`, slice 2 is already
    merged when slice 3 runs, so as written slice 3 must edit a merged sibling's file. Recommend
    slice 2 pre-build the seam — a status "sections" contributor list or a `keySource` field the
    status renderer prints if present — and slice 3 supply only a
    `describeKeySource(): {source, keyId, reachable}` export from `src/crypto/**`. Note this
    compounds with slice-2 finding 25: a detached daemon with `stdio: "ignore"` has nowhere to be
    "loud", so the warning's real destination is that finding's `~/.dg/dg-server.log` plus `status` —
    also slice 2's to build.

26. **[STRUCTURE — DISJOINTNESS] Confirmed: narrowing slice 2's glob to
    `pkg/dg-server/__tests__/{server,session,utils}/**` fully resolves the collision for slice 3.** —
    Verified against the frontmatter: slice 2's unscoped `pkg/dg-server/__tests__/**` (plan.md:20) is
    today a strict superset of both of slice 3's test globs; the proposed narrowing leaves
    `__tests__/store/**` and `__tests__/crypto/**` owned by slice 3 alone. Source side is already
    clean — `src/store/**` and `src/crypto/**` do not overlap slice 2's `src/{server,session,utils}/**`,
    slice 7's `src/{commands,manifest}/**`, slice 8's `src/dispatch/**` or slice 9's `src/assets/**`.
    Two residual notes. Slice 3 needs **no** `package.json` change, which is fortunate because it
    does not own one: `bun:sqlite` and `node:crypto` are built-ins and both survive
    `--compile` *(proven)*. But slice 3 also owns no `bunfig.toml` (slice-2 finding 20 flagged the
    missing home; `pkg/skills-cli` needs one for a test preload), and the nested `__tests__/store/`
    subdirectory is a departure from `.agents/monolith.md`'s flat `__tests__/*.spec.ts` convention —
    consistent across five dg-server slices, so keep it, but it should be recorded as intentional.

27. **[CROSS-SLICE — accepting three sibling asks that land in this slice's tables]** — (a) Slice-7
    finding 7(a) is right that the validated command manifest needs somewhere to live for the
    session's lifetime; recommend a `manifests` table (or `sessions.manifest_blob`) here, on the
    encrypted side per finding 15. (b) Slice-9 finding 11(a) needs `GET /assets/<id>` to distinguish
    "pruned/gone" from "wrong token"; that requires the `assets` row to **survive** the byte deletion
    — recommend an explicit `deleted_at`/`state` column so a pruned asset is a known-gone row rather
    than a missing one, which is the only way slice 9 can return a distinguishable reason and the
    only way a durable transcript's asset reference can render an honest "asset removed" placeholder.
    (c) Slice-9 finding 4 is correct that one iv/tag per asset means whole-file GCM; the crypto
    module should make that explicit and add the safety rule the plan lacks — decrypt fully into
    memory, **verify the tag, then** emit bytes (a streaming decrypt would hand the browser
    unauthenticated plaintext before the tag is checked), and enforce a maximum asset size so one
    large file cannot OOM the daemon. Chunked GCM with the chunk index in AAD is the correct design
    if video ever enters scope; record it as the deferred option rather than discovering it then.

28. **[TESTABILITY] Three of this slice's stated criteria cannot be honestly tested as written; give
    the module a keychain seam, a `DG_KEY_SOURCE` override, and a byte-scan assertion.** — (a)
    "Given no keychain (WSL/CI), when the daemon starts, then it warns, uses `~/.dg/key` at 0600" is
    **factually false on this WSL box** — `secret-tool` is installed and working *(proven)* — so the
    criterion would pass in CI and fail on the developer's own machine. Reword it to force the
    fallback deliberately: a `DG_KEY_SOURCE=file|keychain|auto` env override (needed anyway because
    slice-2 finding 18's contracts drive the **compiled binary** as a subprocess, where in-process
    seams are unreachable), plus an injected `KeychainBackend` seam so unit tests never touch a real
    keyring — I wrote and cleared a probe secret in this user's actual login keyring while
    researching this review, which is exactly the side effect a test suite must not have. (b) "the
    stored body column is ciphertext — assert the plaintext does not appear in the raw column" is
    near-tautological: reading the BLOB back returns ciphertext by construction, so the assertion
    cannot fail even if encryption were removed and the column held plaintext of a different shape.
    The meaningful test is the acceptance criterion's own framing — a **byte scan of the files on
    disk** for the plaintext needle, and it must include the `-wal` sidecar, not just the main
    database, since recent writes may not be checkpointed yet. (c) The nonce criterion should assert
    the *API shape* (no caller-supplied IV, per finding 1) in addition to "N encryptions produced N
    distinct IVs", since the latter cannot catch the migration-time reuse that is the actual risk.

---

## Summary

The slice is buildable and every library assumption in it checks out — `bun:sqlite` gives strict
mode, WAL, `user_version`, `STRICT` tables, `RETURNING` and `VACUUM INTO`, and a compiled Bun binary
carries `bun:sqlite` plus `node:crypto` AES-GCM-with-AAD and no native dependency. The problems are
all in what the checklist does not say.

Four items are the expensive-to-reverse ones the brief was worried about. **Key resolution is the
worst**: a keychain read that fails and a keychain that is empty are the same exit code (proven), so
the specified "on failure fall back to `~/.dg/key`" silently mints a second key and orphans every
existing message body — and separately, nothing in the checklist ever *writes* a key into the
keychain, so that branch cannot work at all as specified (findings 7, 8, 9). **Nothing records which
key encrypted a row**, which makes that failure undetectable rather than merely bad, and makes
rotation impossible to retrofit (findings 5, 6). **`$` command strings and their captured output are
outside the encryption boundary** while being the most secret-bearing content in the store
(finding 15). And **file permissions cannot be delivered as specified** — the `-wal`, `-shm` and
`VACUUM INTO` files are all 0644 and come and go on SQLite's schedule, so only a 0700 directory
contains them, and `~/.dg` is 0755 today (finding 13).

On the questions the brief asked me to answer rather than escalate: **read semantics** should be
claim-lease peek-then-ack with `claimNext`/`ack`/`peekAll` and deliberately no atomic pop, ordered
by an `AUTOINCREMENT` seq — verified as a single `UPDATE … RETURNING` that two concurrent readers
cannot collide on (finding 23, concurring with slice-7 finding 4). **Migration recovery** is
genuinely free: SQLite rolls back DDL and the `user_version` bump together, so re-running resumes at
the last completed step — provided every step is synchronous, because `db.transaction(async …)`
commits before the body finishes (finding 16); the missing half is refusing to open a
`user_version` newer than the binary knows (finding 18). **The persistent root** — I concur with
slice-1 finding 6 and slice-2 finding 19 and add the failure they do not name: the key and the
database must move together, and an env-derived root means they sometimes do not, which is either a
silently split transcript or ciphertext that no adjacent key can decrypt (finding 24). **Sibling
disjointness** is resolved for slice 3 by slice-2 finding 20's narrowing, confirmed against the
frontmatter (finding 26).

One item needs the human before implementation: whether the encryption key is permanent, or whether
rotation is designed in now via envelope encryption (finding 5). Two of slice 3's own Engineering
bullets also require editing slice 2's already-merged files and need a seam agreed first
(finding 25), and three of its stated test criteria cannot be honestly tested as written
(finding 28).
