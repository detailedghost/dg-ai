# Memory Migration Protocol

## Steps

1. **Identify** source and target agent names
1. **Read** both `~/.claude/agent-memory/<name>/MEMORY.md` files — show contents to user
1. **Confirm** — ask explicit approval: "Merge [source] into [target]? (yes/no)"
1. **Merge** — append source content under a new heading in target:
   ```
   ## Merged from [source] ([YYYY-MM-DD])

   [source MEMORY.md content]
   ```
   - Deduplicate verbatim lines (exact match only)
   - Target content wins on conflicts
1. **Delete** source directory after successful merge
1. **Log** the migration in the history section below, from a source checkout only —
   see the skill's "Source checkout vs. installed" section. From an installed plugin,
   append the same line to the stash history file instead.

## Merge Conflicts

If both files have entries that contradict each other:

- Keep the target's version (it is the surviving agent)
- Note the conflict in the merge heading: `## Merged from [source] ([date]) — conflicts resolved in favor of target`

## Migration History

<!-- Append new migrations here (source checkout only). Format: - [YYYY-MM-DD] source -> target (reason) -->
