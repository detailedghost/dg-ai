# Standalone mode (the default)

Input is prose, or the conversation itself. Run the common steps, print the recommendation, stop — **write nothing to
disk**, touch no frontmatter, scaffold no bundle. The caller decides what to do with the answer.

Roughly one line of reasoning per pick. This is a recommendation, not a report: no preamble, no restating the work back.

## Output

Nothing is written, so the contract is only what gets printed:

```text
primary: shell — dominant work is a POSIX rewrite of the backup script
qa: security — the script reads credential files
```

Field meanings and the `effort` rule are identical to spec mode (`references/spec-mode.md`): an `effort:` line appears
only when it overrides the tier default, and never says `high`. Drop the `qa:` line entirely when nothing warrants one.

Standalone mode asks no questions and writes no `confidence:`; the low-confidence question belongs to spec mode.
