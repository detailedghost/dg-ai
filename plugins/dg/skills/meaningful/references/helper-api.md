# meaningful-helper API Reference

Command: `"$DG" meaningful`. Resolve `DG` using [the runtime setup](../SKILL.md#runtime-and-skill-paths) in every fresh shell before running the examples below.

## Subcommands

### `info [--base <ref>]`

```
"$DG" meaningful info [--base <ref>]
```

Returns JSON to stdout. Fields:

| Field | Type | Description |
|---|---|---|
| `branch` | string | Current branch name |
| `base_branch` | string | The base branch (typically `main`) |
| `base_sha` | string | SHA of the merge base commit |
| `head_sha` | string | SHA of HEAD |
| `upstream` | string | Remote tracking ref, or an empty string if none |
| `ahead` | int | Number of commits ahead of base |
| `commits[]` | array | `{sha, author, subject}` in chronological order — `author` is the human name from `.mailmap` |
| `files[]` | array | All files touched since base — **renames appear as two entries: old path (deleted) + new path (added)** |
| `file_authors` | object | Map of `file → [authorName, ...]` — distinct human names who touched each file; AI authors (name starts with "claude") are excluded |

Stop with a message if `ahead < 2`.

**`--base <ref>`**: Override the base ref. Any ref or SHA accepted by `git rev-parse`. When omitted, base is computed as `git merge-base HEAD origin/<default>` using the remote-tracking branch so a stale local main never widens the range. A stderr warning is emitted if local and remote default branches have diverged.

### `apply-json [--base <ref>] <plan-file>`

```
"$DG" meaningful apply-json [--base <ref>] <plan-file>
```

Plans are JSON files with distinct `subject`/`body`/`author`/`coauthors` fields, so the commit message is assembled directly (`subject` + `"\n\n"` + body when a body is present). Co-author trailers are kept as written, including AI ones.

The helper:

- Refuses if the working tree is dirty.
- Validates that the union of files in the plan equals the diff from base (rename detection **disabled** — renames count as old path + new path; both must appear in the plan).
- Captures current HEAD as a backup ref (printed to stderr and as the final stdout line).
- Captures the pre-reshape tree SHA for integrity verification.
- Soft-resets to base, then per group: stages just that group's files (literal pathspecs — see [File-Set Convention](#file-set-convention-renames)) and commits with the supplied message.
- **Before pushing**: asserts `git status --porcelain` is clean AND `HEAD^{tree}` matches the pre-reshape tree. On failure, hard-resets to the backup ref and exits non-zero — never pushes a mismatched reshape.
- Force-pushes with `--force-with-lease` (or `-u origin <branch>` if no upstream).

**`--base <ref>`**: Same semantics as `info --base`. If omitted, the JSON plan's own top-level `"base"` field is used (see below); if both are omitted, base falls back to the default `info` merge-base computation.

Exit codes on validation failure: malformed JSON, a missing/empty `groups` array, a group missing `subject`/`files`, or a malformed `author`/`coauthors` entry all exit `2` (USAGE) before touching the working tree. A file-set mismatch against the diff exits `1` (ERR), also before any reset.

### `abort`

```
"$DG" meaningful abort <backup-sha>
```

Restores branch to backup SHA. Use after a failed `apply` if the user prefers this over `git reset --hard <backup>`.

## File-Set Convention (Renames)

The helper runs `git -c diff.renames=false diff --name-only` everywhere it computes the expected file set. With rename detection off, a renamed file appears as **two entries**: the old path (as a deletion) and the new path (as an addition). Plans must list both paths explicitly. `git add -- <old> <new>` correctly stages both the deletion and the addition.

**Bracket/glob characters in paths** — a repository may have paths like `src/items/[itemId]/details/page.tsx`. Git's pathspec matching treats `[...]` as an fnmatch glob, so a plain `git add -- <bracketed path>` matches nothing and silently stages no changes (the tree-equality guard then correctly aborts). The helper prefixes every staged path with `:(literal)` pathspec magic before `git add`, so bracketed paths are always matched literally — this applies to both `apply` and `apply-json`, no special handling needed in the plan itself.

## Plan File Format (JSON)

Path: `$("$DG" stash -s -u meaningful .json)` ().

Top-level object:

| Field | Type | Required | Description |
|---|---|---|---|
| `base` | string | no | Base ref/SHA, same semantics as `--base`. CLI `--base` wins if both are given. |
| `groups[]` | array | yes | One or more group objects (see below). At least one required. |

Each group:

| Field | Type | Required | Description |
|---|---|---|---|
| `subject` | string | yes | Commit subject line, e.g. `feat(search): add query validation`. |
| `body` | string | no | Commit body. Joined to the subject as `subject\n\nbody` — always a real paragraph break, never glued or dropped. |
| `author` | string | no | `Name <email>` — commits with `git commit --author=...` when present, `Name <email>` format. |
| `coauthors[]` | string array | no | Each entry becomes a `Co-Authored-By: <entry>` trailer, appended as its own paragraph after the body. |
| `files[]` | string array | yes | Files for this group. Union must equal the diff; see the rename convention above. |

```json
{
  "base": "origin/main",
  "groups": [
    {
      "subject": "feat(search): add query validation",
      "body": "Rejects empty search terms before querying the catalog.\n\nKeeps validation shared between the form and request handler.",
      "author": "Alex Example <alex@example.invalid>",
      "coauthors": [
        "Sam Example <sam@example.invalid>"
      ],
      "files": [
        "src/search/validate.ts",
        "src/search/validate.spec.ts"
      ]
    },
    {
      "subject": "feat(items): display item details",
      "files": [
        "src/items/[itemId]/details/page.tsx"
      ]
    }
  ]
}
```

A full example is saved at [references/example-plan.json](example-plan.json).

## Failure Recovery

If the helper exits non-zero mid-apply (`apply-json`), the branch may be partially reshaped. Report the backup SHA and suggest either:

```
git reset --hard <backup-sha>
```

or:

```
"$DG" meaningful abort <backup-sha>
```

The tree-equality guard hard-resets automatically on mismatch before exiting, so the branch is restored to the backup ref in that case. Validation failures (bad plan schema, file-set mismatch) exit before any reset happens at all — HEAD is untouched, no recovery needed.

## Status and recovery details

An invocation without a verb prints usage to stdout and exits `2`; help prints usage to stdout and
exits `0`; an unknown verb prints usage to stderr and exits `2`. Missing CLI
arguments and malformed plan schemas exit `2`. Missing plan files, unresolved
bases and file-set mismatches exit `1`. An empty staged group exits `3` and may
leave a partial reshape; use the captured backup to recover. Push failures exit
`1` and also leave the reshaped local history available for inspection or abort.
`abort` always performs a local hard reset, discarding tracked worktree edits;
it never pushes. Apply always pushes after its integrity check; there is no
`--push` or `--no-push` flag.

Scratch commit-message files live in a private project-scoped state directory
under the configured durable state root and are removed when the pipeline
unwinds. The backup printed by the helper is the original commit SHA, not a
new persistent Git ref; keep it in the session's recovery report.
