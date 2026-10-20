# viz CLI — agent usage

Quickstart (plan board, full loop):

```sh
OUT=$("$DG" viz --input payload.json --no-open)
VIZ_SLUG=$(echo "$OUT" | grep VIZ_PATH | sed 's|.*viz/\(.*\)/payload.*|\1|')
"$DG" viz wait "$VIZ_SLUG" --timeout 600     # blocks; returns on all_clear
"$DG" viz get "$VIZ_SLUG" all_clear          # sanity-check if needed
```

Always read the slug back out of `VIZ_PATH`/`VIZ_URL` output — it's namespaced (`<rawSlug>-<sessionId8>`), never the raw slug you wrote into the payload. Every follow-up command (`wait`, `get`, `merge`, `phase`, `link`, `annotate`, `track`) takes this namespaced slug.

## Render a board

```sh
"$DG" viz --input payload.json [--no-open]
```
Payload needs at minimum `slug` + `title`. `template` ∈ `plan|recap|spec` (default `plan`) — invalid value rejects before any write. Re-rendering the same raw slug from the same session hits the same board (idempotent) — safe to call repeatedly to push new content.
**Get back:** stdout `VIZ_URL=...` / `VIZ_PATH=<dir>/payload.json`. Exit 1 on bad input/slug/template.

## Wait for a human response

```sh
"$DG" viz wait <slug> [--timeout <secs>]        # default timeout 300
"$DG" viz review-wait <slug> [--timeout <secs>]  # identical; use after `review` for clarity
```
`--merge`/`--resume` flags are accepted but inert — the merge already happened server-side inside `/api/respond` before `wait` sees `all_clear`; don't expect them to trigger anything extra. If a board was already answered before you called `wait`, it returns immediately (no poll-interval floor).
**Get back:** exit 0, no stdout, once `all_clear: true`. Exit 1 + `.stale` marker on timeout — error text includes the literal resume command. A timeout never loses the response; rerun `wait` (or `merge`) any time after.

## Read one field (never load the whole payload)

```sh
"$DG" viz get <slug> --keys        # list available top-level fields
"$DG" viz get <slug> <field>       # e.g. review_result, all_clear, decisions
```
Read-only, no lock. **Get back:** JSON value of that field, or a sorted key array for `--keys`. Exit 1 if slug/session/section missing (error names what sections do exist).

## Merge a response file directly (no server up)

```sh
"$DG" viz merge <slug> [--no-open]
```
File-direct fallback: applies on-disk `response.json` → `payload.json` without going through the server. Requires `response.json` to exist; HMAC-validated on secured boards (all boards are secured post-render). Deletes `response.json` only after the merge actually persists — safe to retry on failure.
**Get back:** stdout pretty JSON — `resolved`, `threads`, `pending_decisions`, `open_questions_remaining`, `approved`, `approval_required`, `recommendations_triaged`, `recommendations_pending`, `all_clear`.

## Drive a `plan` board's implementation timeline

```sh
"$DG" viz phase <slug> <phase-id> <status>
# status ∈ pending|in_progress|done|partial|blocked|skipped
# phase-id matches a phase's id OR label
```
**Refuses `template: "spec"` boards outright** (hard error) — a spec board's truth lives in the spec `.md`, never the ephemeral board. Use this only for `plan` boards.
**Get back:** stderr `<slug>: phase '<id>' → <status> (<done>/<total> done)`. Exit 1 on bad status/spec-template/no-match.

## Report parallel-agent progress (no lock contention)

```sh
"$DG" viz track <slug> <track-id> <status> [--progress N] [--detail s] [--label s] [--agent s]
# status: same vocabulary as phase; --progress: 0-100
```
Writes `${VIZ_DIR}/<slug>/tracks/<track-id>.json` only — **never touches `payload.json`/its lock**. Use this (not `phase`) when N agents report concurrently on independent slices; they can't block each other or a concurrent `phase`/`merge` call. `track-id` is slug-validated (same charset rule as board slugs).
**Get back:** no stdout. Exit 1 on invalid slug/track-id/status/progress-range.

## Upsert/remove a top-of-board link (PR, Jira, doc)

```sh
"$DG" viz link <slug> <url|label> [--label s] [--kind pr|jira|doc|other] [--status s] [--remove]
```
Target is either a `http(s)://` URL (keyed by URL) or a bare label. Unsupplied flags on an update leave that field untouched; `kind` is always rewritten from the current call.
**Get back:** stderr `<slug>: link <added|updated|removed> — <label>`. Exit 1 on bad `--kind` or `--remove` with no match.

## Patch decision sub-fields (e.g. add rationale after resolution)

```sh
"$DG" viz annotate <slug> <patch.json>
# patch.json top level MUST be an array: [{"index": 0, "rationale": "..."}]
```
Unmatched indices are skipped silently (batch still applies the rest). No field allowlist — every key but `index` gets copied onto the decision as-is.
**Get back:** stderr `annotated → <url>`. Exit 0 even if some entries matched nothing; non-array/missing file throws non-zero.

## Review board flow (deterministic, no LLM)

```sh
OUT=$("$DG" viz review --repo <path> --base <ref> --head <ref> [--spec specfile.md] --no-open)
VIZ_SLUG=$(echo "$OUT" | grep VIZ_PATH | sed 's|.*viz/\(.*\)/payload.*|\1|')
"$DG" viz review-wait "$VIZ_SLUG" --timeout 600
"$DG" viz get "$VIZ_SLUG" review_result
```
Builds the whole payload from `git log`/`diff --numstat`/`diff --name-status`/full `diff` over `base..head` — zero model involvement. `--spec` tags each file's `slice` from the spec's frontmatter (`slices[].{id,name,files}`); unmatched files get `"other"`. Omit `--spec` entirely and `slice` is `null` on every file (not `"other"` — don't conflate the two). Slug is deterministic (`review-<repo>-<head>`), namespaced by session like render, but **mints a fresh nonce every call** (unlike render's mint-once).
**Get back:** same `VIZ_URL=...`/`VIZ_PATH=...` stdout shape as render. `review_result` (via `get`) → `{verdict, summary, fileApprovals[], lineComments[]}`. Exit 1 on missing repo/refs/git failure/bad spec.

## List all boards

```sh
"$DG" viz list
```
Read-only, never locks. **Get back:** JSON array of `{slug, title, template, pending, stale, awaiting, url}` — `url` is `""` when the server's down. Only directories with both `payload.json` and `.token` show up (no staging phantoms). Exit 0 always.

## Clean up

```sh
"$DG" viz clean <slug>       # remove one board
"$DG" viz clean --orphans    # remove payload-but-no-.token staging dirs only
"$DG" viz clean --all        # stop server + wipe everything under VIZ_DIR
```
**Get back:** stderr note of what was removed. Exit 1 only on invalid/not-found single slug.

## Stop the server

```sh
"$DG" viz stop
```
Verifies PID identity (`/proc/<pid>/cmdline` looks like astro/vite/bun for this `ASTRO_DIR`) before signaling — never kills an unrelated recycled-PID process. **Get back:** stderr outcome note. Exit 1 only if no PID file exists at all.

## Preflight check (run before trusting the environment)

```sh
"$DG" viz doctor [--json]
```
Read-only, no board touched. **Get back:** tick-table or (with `--json`) `{bun, port_free_or_ours, server_reachable, browser_openable, viz_dir_writable, usable, server_viz_dir, server_viz_dir_matches, server_pid_identity_ok}`. If `usable: false` or `server_viz_dir_matches: false`, don't render/wait against that port — restart the server with the correct `VIZ_DIR` first. Exit 0 always, even on total probe failure.

## Env vars

`VIZ_PORT` (default 4321), `VIZ_DIR` (default `$("$DG" stash -G viz)`), `VIZ_NO_BROWSER=1` (never spawn a browser), `VIZ_SKILL_DIR`. Same values forwarded to the Astro server — set once per session, keep consistent across all commands in that session.

## See also

- `payload-schema.md` — full field reference for payload.json / response.json
- `loop-protocol.md` — response-file shape, thread handling after `wait`, review-submit round-trip
- `cli.md` — command contracts with more prose (this doc is the terse action-first version)
