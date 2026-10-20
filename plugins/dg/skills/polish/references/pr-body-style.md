# PR Body Style

Plain English, active voice, short sentences. Say what changed, why, and how you verified it.
Skip marketing adjectives, passive voice, and filler.

## Template

```markdown
## Summary
- <1-3 bullets: what changed>

## Why
<1-2 sentences: the reason or the ticket>

## Test plan
<how you verified it: command run, output, or a checklist>
```

## Self-check before you open or edit a PR or MR

The same rules cover GitHub and GitLab. Run the scan on the draft body first. Set
`DG_PROSE_CHECK_CMD` to the executable that reads the body from stdin. Leave it unset
to skip the check.

```sh
printf '%s' "$PR_BODY" | "$DG_PROSE_CHECK_CMD"
```

Exit 0 means clean. A nonzero exit prints the findings. Fix them in the draft, then
re-run the check. Catching them here means a configured PR hook never blocks the
create call.
