# Arguments

| Form | Effect |
|---|---|
| `/pickup` | No arg — list every candidate (`status: deferred` or `status: in-progress` numbered `.agents/spec/<NNN>_<slug>/` dirs, plus every `.agents/spec/todo/<slug>/` dir) and prompt via `AskUserQuestion`. |
| `/pickup <arg>` | Match `<arg>` against the `<NNN>` prefix (numbered candidates only) or a slug substring (either location). No match → error: `No parked bundle found matching '<arg>' under .agents/spec/.` |

The usage line in `SKILL.md` carries these forms; keep it in sync with this table.

**Not supported:**

- `--viz` — selection is a single `AskUserQuestion`, not a multi-phase board sequence.
- `-l`/`--light`, `-a`/`--all` — no light-mode bundle path exists under `/spec`'s model (see
  `/kick`'s `references/args.md`). `/spec --fast` is a lighter *pipeline*, not a lighter bundle, and
  a parked bundle already has its plan — so there is nothing for `/pickup` to forward it to.
- `-t`/`--worktree`, `-T`/`--no-worktree` — `/pickup` hands off to `/spec -s`, which always creates
  its own worktree; `/spec`'s `-T` is `--fast`-only, so there is no opt-out to forward.
