---
name: jot
description: Write a short note down and read it back later, or save a session handoff so a fresh agent can resume. Default `/dg:jot` writes a temporary agent note to scratch (lost on reboot, 14-day TTL). `-s` / `--save` writes a durable handoff. `-p` / `--previous` lists and resumes. `-k` / `--kick` writes "where we are" as its own section in the shared `~/doc/checkpoint.md` ("kick", "checkpoint"); `-k -p` / `-kp` / `--kick --previous` takes one back, removes it and resumes ("pick up where we left off"). Each jot file is capped at 2 KB; larger jots split into a folder of parts.
---

# Skill: jot

Two kinds, one CLI: `~/.dg/bin/dg-skills jot`. Never hardcode storage paths; the CLI owns them.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills jot --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.1/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor jot.

| Kind | Flag | Where | Lives |
|---|---|---|---|
| note | none | `<scratch>/jot/<cwd-hash>/` | until reboot or 14 d |
| save | `-s` / `--save` | `.agents/jot/` in the main worktree, or `<state>/jot/<project-hash>/` | 30 d in state; kept in `.agents/jot/` |
| kick | `-k` / `--kick` | one section in `~/doc/checkpoint.md`, shared by all sessions | until taken with `-k -p`; never pruned |

A save written from a linked worktree always goes to state, so it never changes the main checkout.

## Usage

**Usage:** `/dg:jot [text...] | -s|--save [intent...] | -p|--previous | -k|--kick [title...] | -k -p [id or text]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--save` | `-s` | Write a durable handoff (`add`), or list saves only (`ls`). | off (note) |
| `--previous` | `-p` | List jots and resume one. With `-k`, take a kicked checkpoint instead. | off |
| `--kick` | `-k` | Write or take a section of `~/doc/checkpoint.md`. `-kp` combines it with `--previous`. | off |
| `--note` | `-n` | `ls` only: list notes only. | off |
| `--all` | none | `ls` only: show every row. | 10 rows |
| `--replace` | none | `kick` only: update the section with the same id. | off (append) |
| `--file <path>` | none | `kick`, `kick-list`, `kick-take`: use this checkpoint file. Put it after the subcommand. | `~/doc/checkpoint.md` |

## CLI

| Command | Effect |
| --- | --- |
| `~/.dg/bin/dg-skills jot add [-s] <<'EOF'` | Read the body from stdin and print the new path. |
| `~/.dg/bin/dg-skills jot ls [-s or -n] [--all]` | List kind, age, name and title, newest first, 10 rows. |
| `~/.dg/bin/dg-skills jot read <name>` | Print the body. A split jot prints its index. |
| `~/.dg/bin/dg-skills jot read <name>/<NN>` | Print one part of a split jot. |
| `~/.dg/bin/dg-skills jot kind <path or name>` | Print `note` or `save`. |
| `~/.dg/bin/dg-skills jot done <name>` | Remove the jot. |
| `~/.dg/bin/dg-skills jot kick [--replace] [--file <p>]` | Read a section from stdin and print its id. |
| `~/.dg/bin/dg-skills jot kick-list [--file <p>]` | Print id and summary rows. |
| `~/.dg/bin/dg-skills jot kick-take <id or text> [--file <p>]` | Print the section, then remove it. Several matches remove nothing. |

**Cap:** 2048 B per jot file; checkpoint sections have no cap. Over the cap, `add` splits at each `## ` into `<name>/NN-<slug>.md` plus `00-index.md`. One section over the cap fails; shorten it and retry.

## Write

- `/dg:jot <text>`: pipe a terse note to `~/.dg/bin/dg-skills jot add`. H1 = title. Bullets over prose. Print the path.
- `/dg:jot -s [intent]`: pipe the save shape below to `~/.dg/bin/dg-skills jot add -s`. Print the path. Do not commit.
- `/dg:jot -k [title]`: pipe one section in the shape in [references/checkpoint.md](references/checkpoint.md) to `~/.dg/bin/dg-skills jot kick`. Print the id. To update a section you wrote earlier, reuse its id and add `--replace`.

## Save shape

Bullets only. Every section is required. Link, don't duplicate: point to files, PRs, commits.

```markdown
# <one-line intent>

created: <ISO> · cwd: <path> · repo: <name>@<branch>

## Context
- what we did, what is decided, current state

## Open threads
- unresolved questions, pending decisions

## Suggested next skills
- /dg:<skill> - why

## References
- paths/URLs already on disk or remote
```

## Read (`-p` / `--previous`)

1. Run `~/.dg/bin/dg-skills jot ls -s` for handoffs (`~/.dg/bin/dg-skills jot ls` for all). Empty: print `No jots found for this project.` and stop.
2. One row: use it. 2+ rows: `AskUserQuestion`, label = name, description = title.
3. Run `~/.dg/bin/dg-skills jot read <name>`. For a split jot, read the index, then only the parts you need.
4. For a save: after you have the context, run `~/.dg/bin/dg-skills jot done <name>`. For a note: keep it unless told otherwise.

## Pickup (`-k -p` / `-kp` / `--kick --previous`)

`-p` alone is the handoff read above. With `-k`, it takes a kicked section.

1. No argument: run `~/.dg/bin/dg-skills jot kick-list` and always `AskUserQuestion`, even for one row. Label = id, description = summary. Never take on a bare call. Empty list: print `No checkpoints found.` and stop.
2. An argument: run `~/.dg/bin/dg-skills jot kick-take <arg>`. On several matches (exit 1, rows printed), ask the same way, then `~/.dg/bin/dg-skills jot kick-take <full id>`.
3. `kick-take` prints the section, then removes it from the file. When no section is left and the file holds only the CLI header, it deletes the file. Keep the printed text; it is the only copy.
4. Start work: check the repo, branch and PR state against it. Ask the user about "Open questions" first, then work through "Next steps".
