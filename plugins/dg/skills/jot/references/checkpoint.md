# Checkpoint section shape

One section per checkpoint in `~/doc/checkpoint.md`. The CLI creates `~/doc/` and the file, appends the section, and writes by temp file plus rename under a lock. It never edits another section. `--replace` swaps only the section with the same id. `kick-take` prints a section, then removes only that section; the file is deleted when no section remains and only the CLI header is left.

The id format is `YYYY-MM-DD HHMM — <project> — <title>`. The em dash (`—`) is required as the separator. A hyphen (`-` or `--`) makes the CLI reject the id.

The CLI rejects a section with a bad id, a second `## ` heading, or a missing line or sub-section.

```markdown
## 2026-10-13 1432 — sample-portal — retire demo workload
summary: one line for the pickup list
repo: ~/code/sample-portal

### Branches and PRs
- branch `spec/retire-demo-workload`, worktree `/path`
- PR #183 <url>

### Done
- finished work, with commits or paths

### In progress
- half-done work and its exact state

### Next steps
1. exact command or file to start with

### Open questions
- waiting on the user

### Gotchas
- traps a fresh agent would hit
```

- Id: `YYYY-MM-DD HHMM — <project> — <short title>`. The pair of date and title keeps it unique; the CLI refuses a repeat.
- No `## ` line inside the body. Use `###`.
- Link, don't duplicate: point to specs, PRs, commits.
- Test with `--file <scratch path>` after the subcommand (for example `kick --file <path>`); never write a test section to the real file.
