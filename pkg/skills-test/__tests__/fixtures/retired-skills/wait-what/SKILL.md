---
name: wait-what
description: "Stop. That last message did not land: re-pitch it with context, in plain words and the project's own vocabulary. Use when the user says \"wait what\", \"I am lost\", \"back up\", \"re-pitch that\", or invokes /dg:wait-what."
disable-model-invocation: true
---

# /dg:wait-what — Re-pitch the Last Message

The user is lost. Your last message assumed context they do not have. Stop forward work and
re-pitch it. Do not run tools that change state in this turn.

No argument: re-pitch your whole last message. With an argument: re-pitch only that part.

## Scope: one answer

This mode covers **this answer only**. The next message is normal mode again.

## Vocabulary

Use the project's own words, not words you made up during the session.

1. Read `.agents/monolith.md` if it exists. If it is an index, read only the
   `.agents/monolith/<domain>.md` file for the current topic.
2. Else read `GLOSSARY.md` (follow `GLOSSARY-MAP.md` if the repo has more than one).
3. Else use the names in the code and the user's own words from this conversation.

A term from the glossary wins over a synonym. A name you invented this session gets one
plain-word gloss the first time, or gets cut.

## Answer shape — this order, nothing else

1. **Where we are** — the goal, and the step we are on. 1 to 2 sentences.
2. **What I said** — your last message again, in plain words. 3 to 6 short bullets.
3. **Why it matters** — one sentence that connects it to the goal.
4. **What I need from you** — the one decision or answer you wait for. If you need
   nothing, say what you do next.

No apology, no preamble, no new findings, no new options.

## Word rules

- ASD-STE100 Simplified Technical English: short sentences, active voice, one idea each.
- Code, commands, file paths and error text stay **exact**.
- Shorter than the message it replaces. If it is not shorter, cut again.
