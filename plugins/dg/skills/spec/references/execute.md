# Execute Mode — the `-s <NNN>_<slug>` contract

Execute mode is deliberately thin: the bundle already carries everything a build needs
(`slices[]`, agent assignments, the durable plan). This file's whole job is bridging that bundle
into `/dg:sdlc`'s slice-wave machinery without re-deriving anything plan mode already decided.

## 1. Resolve the bundle — read ONLY `context.md` + `plan.md`

The `-s` argument (`<NNN>_<slug>`) is the bundle directory's basename verbatim —
`.agents/spec/<NNN>_<slug>/`. Read, in this order:

1. `<bundle>/context.md` — the tidy pack (frontmatter projection: `feature`, `slices[]` with
   `agents`/`prototype`, `bundle`, `plan_path`, …). Fast orient.
1. `<bundle>/plan.md` — the full durable spec (Purpose, Scope, per-slice Engineering/Testing/
   Acceptance checklists, `## Code Structure` when plan mode's step 1.5 produced one,
   `## Slice Summaries`, `## Agent Notes`, `## Issues Remediation`).

`## Code Structure` carries the cross-slice code contracts ratified at plan time — type shapes,
module homes, error conventions. It is absent whenever step 1.5 collapsed or was skipped, which is
normal; when present, `/dg:sdlc`'s `slice-engineering.md` and `slice-engineering-proxy.md` templates
already point each slice's engineer at it, so no extra wiring is needed here.

**NEVER read `initial.md` or any `roundtable/slice-<N>.md`** — those are plan-mode sprawl, already
folded into `plan.md` by synthesis (plan.md step 6–7). Reading them here would defeat the entire
point of the read-boundary this bundle exists to create. If a bundle is missing `context.md` (plan
mode step 9 never ran), stop and tell the user to finish plan mode first — do not improvise a
context pack from the sprawl files.

An execution agent reads a slice's `prototype` asset **only if that slice's frontmatter has a
`prototype` key** (`slices[N].prototype.path` + `.variant`, set by `~/.dg/bin/dg-skills spec prototype-ref`). Do
not inject a prototype reference into a slice's brief when it has none.

## 2. Worktree — reuse `/dg:sdlc` setup.md Step 1 verbatim

`/dg:spec -s` always runs in worktree mode. `-T`/`--no-worktree` exists on `/dg:spec`, but is valid only
alongside `--fast` (see [fast.md](fast.md) F6) — there is no opt-out to honor here. Follow
[`sdlc/references/setup.md`](../../sdlc/references/setup.md) **Step 1** exactly: derive a slug, then
create the worktree and work in it exactly as that step describes. The session itself stays at the
launch directory — it does not relocate — so every command that touches the worktree from here on
carries its own `cd "$WORKTREE_PATH" && …` prefix.

**Bundle-visibility gotcha:** `~/.dg/bin/dg-skills worktree create` branches off a freshly fetched `origin/<base>` — it
does not carry uncommitted `.agents/` changes into the new worktree (it prints exactly this
warning: `"uncommitted .agents/ changes won't be visible in the worktree until merged"`). Plan
mode now commits the bundle unconditionally (plan.md step 10), but an older or manually-edited
bundle may still be ahead of `origin`, so **resolve the bundle against `$WORKTREE_ORIGIN`, not the
fresh worktree copy** — the same pattern its predecessor used for its own NNN scan.

```sh
SPEC_PATH="$(~/.dg/bin/dg-skills stash -C "$WORKTREE_ORIGIN" -m spec)/<NNN>_<slug>/plan.md"
```

This means per-slice `plan.md` writes (current_slice, `## Slice Summaries`, `## Agent Notes`) land
in the origin checkout's working tree, not inside the feature-branch worktree — intentional: the
bundle is durable planning history tied to the repo/branch active at plan-mode time, not to the
ephemeral feature branch. If the user wants the annotated `plan.md` committed alongside the code,
that's a manual follow-up, not part of this contract.

## 3. Scratch path

Durable root, keyed by the **main worktree** (matching `/dg:sdlc` setup.md Step 2) — a mid-run
reboot must not destroy the run's own notes, and the origin repo has to resolve the same path
after the worktree is gone, which is what lets `/dg:address` clean it up at merge:

```sh
SCRATCH_PATH="$(~/.dg/bin/dg-skills stash -s spec <NNN>_<slug>-scratch.md)"; touch "$SCRATCH_PATH"
```

## 4. SKIP setup.md Step 2 — no slice-derivation, no ephemeral spec

`plan.md` already has `slices[]` frontmatter and `/dg:assign` already ran (plan mode step 3). Do NOT
re-derive slices, do NOT synthesize an ephemeral spec — `SPEC_PATH` from step 2 above **is** the
spec `/dg:sdlc`'s machinery reads and writes. Also skip setup.md Step 3's launch-gate agent-assignment
half (already done) — but still show the token-cost/permissions confirmation it describes if
`permissions:` in `plan.md` is empty (a bundle scaffolded straight from `scaffold` has no
`permissions:` block yet; plan mode doesn't set one). Persist the granted keys with
`~/.dg/bin/dg-skills spec perms-batch <bundle>/plan.md --grant-all` (or `--from-scratch <slug>` after writing the
granular answers) — the same command `/dg:prd` documents for pre-granting permissions.

## 5. Drive the slice-wave

Run [`sdlc/references/engineering.md`](../../sdlc/references/engineering.md) **4.1–4.3** exactly
as written, with `SPEC_PATH`/`SCRATCH_PATH` from steps 2–3 above. Its Workflow call MUST reference
the `.js` script by absolute path in the installed `sdlc` skill — the sibling of this skill's base
directory (`<sdlc-skill-dir>` is the folder holding `sdlc/SKILL.md`):

```
scriptPath: "<sdlc-skill-dir>/references/templates/slice-wave.workflow.js",
```

**Proxied slices:** for any slice with `agents.proxy` set, its `agents.proxy_skills` (e.g. `["db", "polish"]`) must be inlined into that slice's `/dg:proxy` prompt as explicit instructions — `/dg:proxy`
only injects the persona file and cannot invoke `/db` or `/dg:polish` as slash-commands, so the
skill's behavior has to be spelled out in the prompt text itself (see
[decision-blob.md](decision-blob.md)).

Then run [`sdlc/references/finish.md`](../../sdlc/references/finish.md) **steps 5–6** (final
review + correction, test-name gate + docs) exactly as written.

## 6. Human review gate, then direct PR/MR launch (the last item)

Run `finish.md` **steps 7–8** exactly as written, including step 8's `/dg:spec` deltas (draft
unconditionally, `~/.dg/bin/dg-skills batch-open` afterward, dependent-PR/MR `~/.dg/bin/dg-skills chain plan`/`~/.dg/bin/dg-skills chain apply`
handling). [`/dg:pushup`](../../pushup/SKILL.md) runs the same push → PR → browser-open mechanics for
an ad-hoc branch. Do not fork to it here: it drops the PR-body template, the permission gating, and
the worktree bookkeeping that step 8 owns.

`finish.md`'s `REVIEW_MODE` decides how much of step 7 runs. `/dg:spec` sets no policy of its own —
it forwards `-l`/`--local` and follows whatever the mode says.

### `REVIEW_MODE = pr` (default)

Step 7 is skipped. Go straight to step 8, which opens the PR/MR as a draft. The run ends there and
the human reviews on the provider; `/dg:address` picks up the comments in a later session. `/dg:spec`
still passes `SPEC_PATH` (for `## Slice Summaries`) and the `<base>..<head>` range into the PR body
assembly step 8b describes — the body is the reviewer's only briefing in this mode, so it carries
more weight here than it did behind a local board.

### `REVIEW_MODE = local` (`-l`)

- **On `review_result.verdict == approve`** → proceed to step 8. `/dg:spec` doesn't re-review; it
  passes `SPEC_PATH` and the range into step 8b as above.
- **Any other verdict** (`request_changes` / `comment` / Hold) → handle per `finish.md` step 7's
  routing; step 8 never runs on these.

### Both modes

- **After step 8 captures the URL** → apply its `/dg:spec` delta for bookkeeping: persist the URL to
  `worktree.pr_url` in `plan.md` if it carries a worktree block (not the ephemeral spec step 8d
  otherwise writes to), leave the worktree intact for `/dg:address` — no `ExitWorktree` call is needed
  since the session never relocated out of `$WORKTREE_ORIGIN` (see setup.md Step 1) — then print
  step 8d's line for the active mode.

> **GATE:** in `local` mode, `/dg:review` approved first. Either mode: draft PR/MR opened and
> batch-opened in the browser; URL captured; cwd still at `$WORKTREE_ORIGIN`; worktree intact for
> `/dg:address`.

## Scope note

This contract only resolves `-s <NNN>_<slug>` (a numbered bundle under `.agents/spec/`). Parked
bundles under `.agents/spec/todo/` are a `/dg:pickup`-shaped resume flow, not this mode — out of scope
here.
