# Proposal Format Reference

## Subagent Brief

Spawn a subagent using the host's configured `reviewer` persona to read per-commit diffs and return ≥3 distinct regrouping options.

Brief the subagent with:

- The commit list (`sha + subject`) in chronological order.
- Per-commit `git show --stat` output (run this first or let the subagent run it).
- The full file list (from helper `files[]`).
- The goal: each new commit should be atomically reviewable — one concern, working state at each step, clear `<type>(<scope>): subject` per the project's commit convention.
- **Rename handling**: the `files[]` list has rename detection disabled. A renamed file appears as **two entries** — the old path (deleted) and the new path (added). Both paths must be assigned to a group; omitting either will cause the helper to reject the plan.

## Required Output Format

The subagent MUST return options in this exact `===` block format:

```
=== Option N: <one-line label> ===
Tradeoff: <one sentence on what this optimizes for>

Group 1
  MSG: <type>(<scope>): <subject>
  <optional body>
  FILES:
  path/one
  path/two

Group 2
  MSG: ...
  FILES:
  ...
```

## Authorship

The `info` JSON now includes `commits[].author` and `file_authors` (file → [authorName, ...]). Use these to assign each group's primary author and preserve human attribution across the reshape:

1. **Primary author** — for each group, identify which human author wrote the majority of its files using `file_authors`. Emit an `AUTHOR:` line per group (before `FILES:`). When files in a group are split across multiple authors, pick the dominant contributor as the primary author.
1. **Co-authors** — if other humans touched files absorbed into this group, add them as `Co-Authored-By: Name <email>` trailers in the MSG body.
1. **Keep** every `Co-Authored-By:` trailer from the original commits, AI ones included. The helper does not strip trailers.

The `AUTHOR:` line must use `Name <email>` format. `commits[].author` contains
only the name; obtain the matching email from `git log --format=%aE` for the
original commit before preparing the proposal.

## Transcribing into the plan file (step 4)

This `=== Option N ===` block format is presentational — for the host's user-question interface and human review — not a plan file. When the user picks an option, transcribe it:

- **JSON plan** — `MSG:` first line → `subject`; any lines between the subject and `FILES:` that are *not* `Co-Authored-By:` trailers → `body` (joined with `\n`); `AUTHOR:` line → `author`; any `Co-Authored-By: Name <email>` trailer lines → one entry per name in `coauthors[]` (drop the `Co-Authored-By:` prefix, keep `Name <email>`).

## Constraints

1. **Union of files** across all groups MUST equal the full file list from the helper — no omissions, no duplicates. The helper validates the file union; the proposal review must also reject duplicates, since duplicate files may later produce an empty staged group. For renames, include **both** the old (deleted) path and the new (added) path.
1. **Each option must have a different shape** — not three near-identical proposals. Target one tight (1–2 commits), one balanced (3–5), one per-concern (more granular).
1. **Reuse existing scopes** from the project's commit log style. Do not invent new scope names.
