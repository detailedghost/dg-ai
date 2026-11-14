# Arguments

| Form | Effect |
|---|---|
| `/dg:pickup` | No arg — list every candidate (`status: deferred` or `status: in-progress` numbered `.agents/spec/<NNN>_<slug>/` dirs, plus every `.agents/spec/todo/<slug>/` dir) and prompt via `AskUserQuestion`. |
| `/dg:pickup <arg>` | Match `<arg>` against the `<NNN>` prefix (numbered candidates only) or a slug substring (either location). No match → error: `No parked bundle found matching '<arg>' under .agents/spec/.` |
| `/dg:pickup [<arg>] --no-land` | Same selection. `--no-land` is never a match argument; it passes through to `/dg:spec -s`, which then stops at the draft PR/MR and skips `/dg:land`. |

The usage line in `SKILL.md` carries these forms; keep it in sync with this table.

**Not supported:**

- `-l`/`--light`, `-a`/`--all` — no light-mode bundle path exists under `/dg:spec`'s model (see
  `/dg:kick`'s `references/args.md`). `/dg:spec --fast` is a lighter *pipeline*, not a lighter bundle, and
  a parked bundle already has its plan — so there is nothing for `/dg:pickup` to forward it to.
- `-t`/`--worktree`, `-T`/`--no-worktree` — `/dg:pickup` hands off to `/dg:spec -s`, which always creates
  its own worktree; `/dg:spec`'s `-T` is `--fast`-only, so there is no opt-out to forward.
