# PR guidance (load when opening a PR after polish)

Read this only when the polish pass is done and you're about to open a pull request.

## Description

Hard limits. Reviewers skim, and a wall of prose gets skipped entirely:

- **Prose: 4 sentences maximum.** Cover what changed and why, the impact, and how it was
  verified (tests/build run, or "not run" — be honest). Never a file-by-file restatement
  of the diff.
- **One simple table** once more than a single thing needs explaining — `Where | Issue |
  Effect | Fix` covers most fixes. Cite measured values over adjectives: "floor `09:20Z`
  not `16:20Z`, 7h early" beats "timezone handling was wrong".
- **Bullets only where each one carries a fact** a reviewer would otherwise have to dig
  for. A bullet that restates the title or the diff is noise.
- **Demo video or GIF for anything user-visible** — run the [demo](../../demo/SKILL.md) skill for
  in-browser tours. A 20-second capture replaces a paragraph of description.
- Include a JIRA / Linear ticket if it's there
- Over budget? A caveat or reviewer warning that would cost a sentence almost always
  fits as an extra **table row** instead. Keeps the limit without dropping the fact.
- Follow the sample as prescription *unless* there is a pre-defined pull_request_template.md file already defined

## Sample
```
## Summary
🎫 ticket

< what does your PR do? >

## QC Notes
< how to test said PR >

## Dev Notes
< notes for the devs >

## Demo

## References
< additional links that could be helpful >
```


## Writing the body

Heredoc it straight to `gh`; don't stage it as a `.md` file first:

```sh
gh pr create --base main --title "…" --body-file - <<'MSG'
…
MSG
```

A PR body is not a repo document. Written to disk it trips the markdownlint hook on long
table rows and line length, and the file is litter afterward. Stdin sidesteps both.

### De-slop the draft before it goes out

When the `unslop` skill is not installed, skip this step, print one line saying so, and go on to the prose check.

Otherwise run the `unslop` skill over the draft body as `cleanup`, then apply the suggestions you
agree with. The 4-sentence cap makes a body short, not human: "This PR introduces a
comprehensive refactor" fits the budget and still reads as generated.

Use `cleanup`, not bare `unslop` or `rewrite`. Those rewrite the prose in one pass and
will happily spend a fifth sentence, which breaks the cap above. `cleanup` returns
reviewable suggestions and leaves the sentence count yours to hold. Add `--report` when
you only want the tells listed.

Then run the prose check on the final text. It is a separate gate for passive voice
and wordiness ([pr-body-style.md](../../sdlc/references/pr-body-style.md)). Set `DG_PROSE_CHECK_CMD` to the
executable that scans stdin, or leave it unset to skip the check. Your host can wire the
same command to its PR and MR create and edit calls, so clearing it first saves a
rejected call:

```sh
printf '%s' "$PR_BODY" | "$DG_PROSE_CHECK_CMD"
```

Order matters: `unslop` first, prose check second. `unslop` rewords, and a reword can
reintroduce the passive voice the hook rejects.

## Stacked / dependent PRs — use `/dg:chain`

When a PR depends on another (same repo or cross-repo), don't hand-roll a prose
"depends on X" note or a one-off arrow chain — run the [chain](../../chain/SKILL.md)
skill. It renders the arrow-chain `## Stack (merge
order)` block, keeps refs bare/unfenced so GitHub autolinks them, and retargets each
downstream PR's base branch (`gh pr edit --base`) so its diff is delta-only and merge
is blocked until the upstream lands:

```
## Stack (merge order)

owner/repo#114 → #2382 → #2383 → main

- owner/repo#114 — merge first
- #2382 — depends on owner/repo#114
- **#2383 — this PR** — depends on #2382
```

Run `~/.dg/bin/dg-skills chain plan <layers...>` first (dry run, no `gh` calls — this is the PR-body draft to
show at the Batch PRs approval gate), then `~/.dg/bin/dg-skills chain apply <layers...>` after approval to
retarget bases and upsert this block into every PR in the chain. Add a
**"superseded by #N"** banner by hand to any PR the stack replaces — `/dg:chain` doesn't
manage that.

Default is still one PR per change — only stack when changes genuinely depend on each
other or span repos. PRs in the same batch with no real dependency between them are
not a stack; leave them out of `/dg:chain` entirely (or pass them via `--independent` if
they're being linked in the same board/summary — see `~/.dg/bin/dg-skills chain --help`).
