# CLI (programmatic)

```sh
"$DG" viz --input <payload.json> [--no-open]              # render — returns final (namespaced) slug in VIZ_PATH/VIZ_URL
"$DG" viz get <slug> <section|--keys>                     # selective read (never load full payload)
"$DG" viz wait <slug> [--merge] [--resume] [--timeout <s>] # block until all_clear; --merge/--resume are accepted-but-inert (see below)
"$DG" viz merge <slug> [--no-open]                        # apply response.json → payload, re-render; prints JSON summary
"$DG" viz phase <slug> <phase-id> <status>                # plan only: set a phase's status, re-render (live progress)
"$DG" viz link <slug> <url|label> [--label s] [--kind pr|jira|doc|other] [--status s] [--remove]
                                                           # upsert/remove a top-of-board link (PRs, docs), re-render
"$DG" viz annotate <slug> <patch.json>                    # patch decision fields (rationale, notes) and re-render
"$DG" viz track <slug> <track-id> <status> [--progress N] [--detail s] [--label s] [--agent s]
                                                           # write a per-agent track sidecar (atomic, rev-safe)
"$DG" viz review --repo <path> --base <ref> --head <ref> [--spec <specfile>] [--comments <file.json>] [--no-open]
                                                           # build a full code-review payload from a git range, render it
"$DG" viz review-wait <slug> [--timeout <s>]              # alias for `wait` — blocks until a submitted review flips all_clear
"$DG" viz list                                            # JSON of all boards + server status (pending/stale/awaiting)
"$DG" viz clean <slug|--all|--orphans>                    # remove board(s); --orphans drops payload-only staging dirs
"$DG" viz stop                                            # kill Astro server
"$DG" viz doctor [--json]                                 # probe environment readiness before relying on viz
```

### `wait --merge`/`--resume` — actual behavior vs the flag names

`respond.ts` (the `/api/respond` SSR endpoint) already runs `doMerge` synchronously, server-side, on every POST — by the time a browser's `fetch()` to `/api/respond` resolves, `payload.json` has already been merged and `all_clear` is already set. `wait` itself never calls `doMerge`; it only polls `payload.json` for `all_clear === true`. `--merge` and `--resume` are accepted (not rejected) for call-site/doc compatibility but do nothing extra — the merge has already happened by the time `wait` would act on them. The CLI-side `merge` command (`merge.ts`/`runMerge`) is a separate, file-direct fallback path for when no server is running (direct `response.json` → `doMerge` → `payload.json`, no HTTP).

### `review` — deterministic, token-free payload build

```sh
"$DG" viz review --repo <path> --base <ref> --head <ref> [--spec <specfile>] [--comments <file.json>] [--no-open]
```

Runs `git log`/`git diff --numstat`/`git diff --name-status`/`git diff` (full unified patch, split per-file) to build `{range, commits[], files[{path,dir,status,additions,deletions,patch,slice,commitSha}]}` — zero model involvement, pure shell+Astro. `--spec` tags `slice` from the spec file's YAML frontmatter (`slices[].id/name/files`); files not covered by any slice get `"other"` when `--spec` was given, or `null` when no `--spec` was given at all. `--comments <file.json>` seeds the board's line comments from a JSON array of `{file, lineNumber?, side?, body}` (omit `lineNumber` for a file-scoped comment; `side` defaults to `"new"`) — written into `review.seedComments`, which the board pre-fills via the same code path a human's own click would take, so they're editable/removable like any other comment. Used by `/review -x` to seed findings from the `reviewer` agent. Prints `VIZ_URL`/`VIZ_PATH` exactly like `--input` render — grab the namespaced slug from `VIZ_PATH` for the follow-up `wait`/`review-wait` call. See `../SKILL.md`'s "Code review" section for the full 2-command flow and the returned JSON shape.

**Always use the slug returned in `VIZ_PATH`/`VIZ_URL` output for follow-up commands** — it is the namespaced slug. Never pass the original base slug to `wait`, `merge`, `phase`, etc.

Env (single CONFIG source): `VIZ_PORT` (default 4321), `VIZ_DIR` (default `$("$DG" stash -G viz)`), `VIZ_SKILL_DIR`, `VIZ_NO_BROWSER` (set `1` to never spawn a browser — used by the test suite). The CLI forwards these to the Astro server.

### `track` — per-agent progress sidecar (parallel execution)

```sh
"$DG" viz track <slug> <track-id> <status> [--progress N] [--detail s] [--label s] [--agent s]
```

Writes `${VIZ_DIR}/<slug>/tracks/<track-id>.json` directly (atomic write-tmp-then-rename) — it **never touches `payload.json`**, so many concurrent agents can each update their own track without contending on the shared board lock. The render route overlays every file in `tracks/` onto `payload.tracks` by id at read time. Use this instead of `phase` when several agents are working independent slices in parallel and each needs to report its own status (`/sdlc`'s parallel slice-wave is the reference caller). `status` shares the same vocabulary as `phase`: `pending|in_progress|done|partial|blocked|skipped`. `--progress` is 0–100.

### `doctor` — environment readiness probe

```sh
"$DG" viz doctor [--json]
```

Read-only capability check, no board involved — run this before a workflow commits to using viz, to fail fast into a terminal-only fallback instead of a confusing render/wait hang. Checks: Bun present, the configured port is free or already ours, the server responds, a browser opener is detectable, `VIZ_DIR` is writable. Also verifies **server identity**: `server_viz_dir`/`server_viz_dir_matches` compares the *running* server's actual `VIZ_DIR` (fetched from the live server) against this invocation's configured `VIZ_DIR` — a mismatch here is exactly how a stale server (started earlier with a different `VIZ_DIR` baked into its env) silently 404s every board it's asked to serve. If `usable` comes back false, or `server_viz_dir_matches` is false, don't trust the port — restart the server with the correct `VIZ_DIR` before rendering.

### Transport rule (reads vs writes)

Commands split by whether they mutate board state:

- **Mutating** (`merge`, `phase`, `annotate`, `track`, and the browser's `/api/respond`) take the per-board `${VIZ_DIR}/<slug>/.lock` before touching `payload.json`/`response.json`.
- **Read-only** (`get`, `list`, the `/api/boards` homepage) never lock or write — they work whether or not the server is up.

**Single-writer safety comes from one shared lock, not from a single process.** The Bun CLI (`common/lock.ts`) and the Astro SSR endpoint (`pages/api/respond.ts` → `withRespondLock`) both build on the same O_EXCL primitives in `astro-viewer/src/lib/respond-core.ts` and contend on the same `.lock` path, so a CLI write and an in-flight POST can never interleave. Writes stay file-direct (no server-up dependency); the lock — not an HTTP chokepoint — is the serialization point.

## Code review (GitHub-PR style board)

Deterministic, token-free — the whole payload is built from `git log`/`diff`, no model involvement. Two commands:

```sh
"$DG" viz review --repo <path> --base <ref> --head <ref> [--spec <specfile>] [--comments <file.json>] [--no-open]
"$DG" viz wait "$VIZ_SLUG" --timeout 600   # or: "$DG" viz review-wait "$VIZ_SLUG" --timeout 600
```

`review` prints `VIZ_SLUG`-bearing `VIZ_URL`/`VIZ_PATH` lines just like render — grab the namespaced slug from `VIZ_PATH` (same pattern as the planning loop). The board opens with GitHub-PR chrome: left dir-grouped file tree, right unified-diff pane, sticky "By commit / By file / By spec slice" tabs. The reviewer clicks lines to leave inline comments, toggles per-file Viewed/comment, and picks an overall verdict (Approve / Request changes / Comment) with a summary, then hits **Submit review**.

`wait`/`review-wait` block until that submit lands (same `all_clear` polling every other loop uses), then:

```sh
"$DG" viz get "$VIZ_SLUG" review_result
```

returns:
```json
{
  "verdict": "approve",
  "summary": "...",
  "fileApprovals": [{"path": "src/b.ts", "viewed": true, "comment": ""}],
  "lineComments": [{"file": "src/b.ts", "side": "new", "lineNumber": 1, "body": "..."}]
}
```

`--spec <specfile>` tags each file's `slice` from the spec's frontmatter `slices[].files[]` (falls back to `"other"` for unmatched files when a spec is given; `null` — no slice tab data — when no spec is given at all). Full flag/JSON reference: `references/cli.md`, `references/payload-schema.md`; round-trip mechanics: `references/loop-protocol.md`.
