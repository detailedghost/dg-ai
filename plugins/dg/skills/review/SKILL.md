---
name: review
description: Human-in-the-loop code review for a git range — renders a GitHub-style review board via /viz, blocks until the reviewer submits a verdict, and hands verdict + comments back to the agent. Deterministic and token-free (built from two git refs). `-x`/`--external <pr>` reviews a GitHub PR instead — the reviewer agent's findings seed the board, and the submitted verdict posts as a real PR review.
---

# /review

Resolve the CLI before using the commands below:

```bash
DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.16.0/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

Human-in-the-loop **code review** for a git range. Renders a full-width, GitHub-style review board (via `/viz`) — file-tree nav, colorized diffs, per-line comments, per-file + overall approve / request-changes / comment — then **blocks until the reviewer submits** (re-arming on timeout, never proceeding without a verdict — same await-decision discipline as the prototype skill), and hands the verdict + comments back so the agent can act on them.

Deterministic + token-free: the board is built entirely from two git refs by `"$DG" viz` (git + Astro, zero model involvement). [`/viz`](../viz/SKILL.md) is the dumb rendering client; `/review` is the driver — resolve refs → render → **wait (loop until submitted)** → act. The wait is not optional: a rendered board with no collected verdict is an unfinished review.

## Usage

```
/review                     # default range (see references/local-mode.md for resolution)
/review <base>..<head>      # explicit range, e.g. main..HEAD
/review <base> <head>       # same, space-separated
/review -x <pr>             # external: review a GitHub PR (number or URL), post verdict to GitHub
/review -x                  # bare -x: current branch's open PR
/review --external <url> --repo OWNER/REPO
```

`--spec` and `--no-wait` are covered in `references/local-mode.md`, `--demo` in `references/board-ui.md`. `-x`/`--external` is its own mode — see `references/external.md`; it does not combine with `--spec`.

## References (load on demand)

| When you need to… | Read |
|---|---|
| Resolve the ref/repo for a local-range review; act on approve/request_changes/comment | `references/local-mode.md` |
| Run `-x`/`--external`: PR resolution, reviewer-agent prompt, comment seeding, verdict→GitHub field mapping | `references/external.md` |
| Caveats: board ephemerality/namespacing, one-round-trip semantics, viz internals, `/spec`+`/sdlc` wiring | `references/details.md` |
| How the tabs/slice-accordion/sticky-nav/file-tree sync actually behave | `references/board-ui.md` |
| Attaching `/demo` output as a Demo tab (`--demo`) | `references/board-ui.md` |

## Flow (3 commands)

```sh
# 1. Build + render the board (deterministic, no tokens). Capture the namespaced slug.
out=$("$DG" viz review --repo "$REPO" --base "$BASE" --head "$HEAD" ${SPEC:+--spec "$SPEC"} ${DEMO:+--demo "$DEMO"})
SLUG=$(printf '%s' "$out" | sed -n 's#.*/viz/\([^/]*\)/payload.*#\1#p')   # from VIZ_PATH
# (share the VIZ_URL with the reviewer; on mobile it must be opened in a browser at claude.ai/code, not the Claude app)

# 1b. ARM THE GATE — discard any verdict from a previous round, then prove none is readable.
#     A submitted verdict lives in the session dir and can survive a re-render, so skipping this
#     lets the PREVIOUS round's approve satisfy this round's wait. See "Verdict staleness" below.
rm -f "${VIZ_DIR:-$("$DG" stash -G viz)}/$SLUG/response.json"
"$DG" viz get "$SLUG" review_result >/dev/null 2>&1 \
  && { echo "GATE NOT ARMED: a verdict is still readable for $SLUG — do not wait on it"; exit 1; }

# 2. WAIT for the reviewer to click "Submit review". Launch this in the BACKGROUND
#    (Bash `run_in_background: true`) — the harness re-invokes you when it exits, so you
#    do not burn foreground tool calls holding a timer. `wait` exits 0 on submit and
#    non-zero on timeout; a timeout is NOT "done", so relaunch it.
"$DG" viz wait "$SLUG" --resume --timeout 3600

# 3. Read the submitted review — only after step 2 exited 0.
"$DG" viz get "$SLUG" review_result --require-fresh "$(git rev-parse HEAD)"
```

> **Wait is mandatory.** After rendering you MUST NOT proceed to step 3, act on the change, summarize, or end your turn until `review_result` is present. The only ways out are: (a) the reviewer submits a verdict, (b) the caller passed `--no-wait`, or (c) the user explicitly tells you to stop — and in cases (b) and (c) you must release the marker with `"$DG" viz dismiss "$SLUG"`. A timeout is **not** an exit; relaunch the wait. Never fabricate or assume a verdict.
>
> Backgrounding is safe because it cannot fail silently: `"$DG" viz review` sets an `.awaiting-verdict` marker at render time, and until a successful `get review_result` clears it (or you `dismiss` it), the `review-wait-guard` Stop hook blocks turn-end and `pr-confirm-hook` denies `git push` / `gh pr create`. If a background wake is ever missed, you get stopped rather than shipping unreviewed. The marker self-expires after 24h so an abandoned board traps nothing permanently.
>
> A foreground `until "$DG" viz wait …; do …; done` loop still works if you prefer it, but budget for it: each iteration blocks a tool call for its full timeout.

`review_result` shape: `{ verdict: "approve" | "request_changes" | "comment", summary, fileApprovals: [{path, approved}], lineComments: [{file, side, lineNumber, body}] }`.

### Verdict staleness — read this before acting on any verdict

`wait` polls `payload.all_clear`; `/api/respond` sets that flag **and** writes `payload.review_result` when the reviewer submits, having stored the raw answer in the session's `response.json`. Nothing in that chain is bound to the revision under review, which has two consequences:

- **A verdict outlives the code it judged.** Re-render the same slug after fixing feedback and a verdict from an earlier round can still be readable — so `wait` may return instantly and `get` may hand back an approve for code the reviewer never saw. Always arm the gate (step 1b) before waiting.
- **Identical content is not evidence of freshness.** A bare `approve` — empty summary, no line comments, nothing marked viewed — serializes byte-for-byte identically no matter when it was submitted, as long as the changed-file list is unchanged. Comparing verdict bodies cannot tell two rounds apart.

So a verdict is only trustworthy when it was submitted **after** the gate was armed for the current head. Do not eyeball that — make `get` prove it:

```sh
"$DG" viz get "$SLUG" review_result --require-fresh "$(git rev-parse HEAD)"
```

`--require-fresh` refuses to print the verdict unless the board was rendered for that exact commit **and** the response post-dates the render marker. It fails loudly rather than handing back something stale, so there is nothing left to cross-check by hand. If it reports a **board defect** (the stored head is not a resolved sha), the board predates the fix that resolves refs at render time — re-render it rather than falling back to a manual check.

Never reconstruct a verdict by parsing `response.json` yourself — `get` is the only reader that goes through the payload the board actually merged into.

Acting on the result, and `-x`/`--external` mode: see References above.
