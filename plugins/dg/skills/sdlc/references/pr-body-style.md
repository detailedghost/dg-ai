<!-- vale off -->

# PR Body Style

Plain English, active voice, short sentences — what changed, why, how it was verified.
No marketing adjectives, no passive voice, no filler ("all of", "in order to").

## Template

```markdown
## Summary
- <1-3 bullets: what changed>

## Why
<1-2 sentences: the reason or the ticket>

## Test plan
<how you verified it — command run, output, or a checklist>

## Risk
<1-2 sentences: what could break, and who would notice>

## How to revert
<the one step that undoes it, such as "Revert this PR" or the flag to turn off>
```

Keep Risk and How to revert even for a small change. A docs-only PR can say "None" and "Revert this PR".

## Self-check before you open or edit a PR/MR

The same rules cover GitHub and GitLab. Before you create or edit the PR/MR, read the draft body once.

- Rewrite every passive sentence.
- Drop filler words and marketing adjectives.
- Split any sentence longer than about 25 words.
- Replace every unexpanded template placeholder with real text.

Then run the scan on the draft body. Set `DG_PROSE_CHECK_CMD` to the executable that reads the
body from stdin. Leave it unset to skip the check.

```sh
printf '%s' "$PR_BODY" | "$DG_PROSE_CHECK_CMD"
```

Exit 0 means clean. A nonzero exit prints the findings. Fix them in the draft, then re-run the
check. Catching a finding here means a configured PR hook never blocks the create call.
