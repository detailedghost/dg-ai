# Owning agent

Each item's `owner` is a label, not a lookup. Use the same name the work was assigned with:

- A persona from `/dg:assign`, such as `dg:implementer`.
- A Cursor cloud agent id, such as `bc-…`.
- The branch that agent pushed, such as `feat/settings-nav`, when no persona was recorded.

The parent is the agent that ran `/dg:verify`. After `verify wait` returns:

1. Run `verify status <name> --json`.
2. For each item where `done` is false and `note` is set, send `note` to that item's `owner` as their next instruction.
3. Say which item and whether Dante sent it back or approved it with a note.
4. Run `verify pending add` with `--follows` set to the item's latest round, so the board shows the agent at work.

A skipped item has no note to send. Leave it until Dante reviews it.

How to deliver it:

- Cloud agent id: post a follow-up to that agent. Do not open a second review.
- Persona: resume that persona with the note, the same way `/dg:address` names an agent.
- Branch label: resume the session that has that worktree and pass the note as the task.

`verify rerun` does not deliver the note. The parent does. Rerun only captures the next round.
