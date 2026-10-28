# Owning agent

Each item's `owner` is a label, not a lookup. Use the same name the work was assigned with:

- A persona from `/dg:assign`, such as `dg:implementer`.
- A Cursor cloud agent id, such as `bc-…`.
- The branch that agent pushed, such as `feat/settings-nav`, when no persona was recorded.

The parent is the agent that ran `/dg:verify`. After `verify wait` returns `needs-rework`:

1. Run `verify status <name> --json`.
2. For each object in `notifications`, send `note` to `owner` as that agent's next instruction.
3. Say which item and which action (`reject` or `tweak`).

How to deliver it:

- Cloud agent id: post a follow-up to that agent. Do not open a second review.
- Persona: resume that persona with the note, the same way `/dg:address` names an agent.
- Branch label: resume the session that has that worktree and pass the note as the task.

`verify rerun` does not deliver the note. The parent does. Rerun only recaptures and reloads the open tab.

An Approve does not create a notification. A later Approve deletes a previous note for that item.
