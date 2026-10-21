<!-- markdownlint-disable MD013 MD033 MD041 MD060 -->

# Launching the `dg:copilot-antagonist` Agent

Resolve the full `dg:copilot-antagonist` contract from the host's configured
personas or explicit `DG_PERSONAS_DIR` / `DG_AGENTS_DIR`, else the packaged
`dg:copilot-antagonist` persona. If unavailable,
report the missing persona rather than inventing its verdict rules.
This file is the **launch recipe** — read it only when Phase 4 fires.

## Agent Launch

Launch the configured `dg:copilot-antagonist` persona through the host's
delegation facility with description "filter copilot comments" and the prompt
below. Read only the named persona and the lazy instructions needed for this
phase; no full conversation context.

Resolve the comments path with `~/.dg/bin/dg-skills stash review-loop <PR>.comments.json`. Fill the path into the prompt before delegation.

## Prompt Template

```text
You are running inside /dg:review-loop Phase 4.

Comments JSON: <absolute comments JSON path resolved by the caller>
Spec file: <absolute path OR the literal string "none">

Read the Comments JSON. For each comment, read just the diff hunk and
the narrow window of its `path:line`. Do NOT explore beyond that.

If a spec path is provided (not "none"), read ONLY its "Contracts" and
"Testing Criteria" sections. Ignore the rest of the spec.

Emit a single JSON array — one entry per input comment — with fields
{commentId, threadId, verdict, reason} per the verdict rules in your
system prompt. No prose, no code fences, no preamble.
```

## Verdict Reminder

- `accept` — hand to /dg:address
- `reject-illogical` — reply with `reason`, then resolve
- `reject-other` — resolve silently
- `strange` — security-sensitive or spec-contradicting; user decides

## Validation After Return

- Must be valid JSON.
- Array length equals input comment count.
- Every input `commentId` appears exactly once.
- `verdict` ∈ {accept, reject-illogical, reject-other, strange}.
- `reason` non-empty when `verdict` is `reject-illogical` or `strange`.

Any failure: print the raw output to the user, exit 1, do not proceed
to Phase 5.
