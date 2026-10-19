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
```

## Self-check before you open or edit a PR/MR

The same rules cover GitHub and GitLab. Before step 8c, read the draft body once.

- Rewrite every passive sentence.
- Drop filler words and marketing adjectives.
- Split any sentence longer than about 25 words.
- Replace every unexpanded template placeholder with real text.

If the host runs a prose check when a PR/MR is created or edited, run the same scan on the draft
first. Catching a finding here means the create call is never blocked and retried afterward.
