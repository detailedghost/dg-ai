# Arguments

| Form | Effect |
|---|---|
| `/pickup` | No arg. List every candidate (`status: deferred` or `status: in-progress` numbered `.agents/spec/<NNN>_<slug>/` dirs, plus every `.agents/spec/todo/<slug>/` dir) and prompt via `AskUserQuestion`. |
| `/pickup <arg>` | Match `<arg>` against the `<NNN>` prefix (numbered candidates only) or a slug substring (either location). No match → error: `No parked bundle found matching '<arg>' under .agents/spec/.` |

A parked bundle already has its plan. Implement that plan. There is no lighter pipeline to forward and no extra worktree flag.
