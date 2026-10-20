---
name: walk
description: 'Walk the user through every open question in the current conversation, one question at a time, each with a recommendation. Use when the user says "walk me through the open questions", "what is still open", "go through the open items", or invokes /dg:walk. Optional topic filter: /dg:walk <word>.'
---

# /dg:walk — Walk the Open Questions

Collect every open question in this conversation. Ask them one at a time. Each one carries a recommendation. Run this in the main loop only, because only the main loop has `AskUserQuestion`.

**Usage:** `/dg:walk` (all open questions) · `/dg:walk <filter>` (only questions that match the topic word, for example `/dg:walk dg`)

## 1. Collect

Scan the conversation for questions that are still open:

- Questions you asked that the user never answered.
- `⚑ RATIFY:` items that subagents returned and that nobody relayed or answered.
- "Fix X?" or "want Y?" offers at the end of agent replies.
- Decisions marked `[OPEN]` or `[ASSUMED]` in a plan or spec the conversation uses.

Drop a question when:

- The user already answered it, even in passing.
- Later work made it moot.

Merge duplicates. With a filter, keep only questions that match the topic word.

## 2. List

Print a short numbered list. One line per question. The user sees the total.

No open questions: say so in one line and stop.

## 3. Order

1. Blocking questions first. They gate running work.
2. One-way doors next.
3. Everything else last.

## 4. Walk

For each question, make one `AskUserQuestion` call with one question. Never batch.

- Before the call, write one or two sentences: what the question is about, and why you recommend your pick.
- Give 2 to 4 options.
- Put the recommended option first. End its label with "(Recommended)".
- Each description states the trade-off in one line.
- Honor the answer as written. If the answer changes the question or asks for info, handle that first. Then continue.

## 5. Act

After each answer:

- Do the cheap, safe follow-up right away when it is clear. Examples: relay the answer to a running subagent with `SendMessage`, or update a plan file.
- Confirm first before any action that is hard to undo or that reaches outside the machine. Examples: push, post, send, delete.
- Do not start large new work in the middle of the walk. Queue it.

## 6. Wrap up

Print a short table:

| Question | Answer | Action |
|---|---|---|

The Action column says what you did or what is queued. Then start the queued work, or say what is queued and wait.

## Rules

- Self-serve first. If the code or docs answer a question, answer it yourself and drop it from the list. Ask only what the human uniquely knows.
- Never invent a question to fill the list.
- Never decide a one-way door for the user.
- A subagent cannot run this skill. If you are a subagent, emit `⚑ RATIFY:` items and stop.
