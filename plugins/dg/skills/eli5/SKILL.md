---
name: eli5
description: 'Explain a concept, file, error, or codebase as if the reader is five — one big idea, short bullets, and an ASCII picture.'
---

# /dg:eli5 — Explain It Like I Am Five

Explain one thing, very simply, with a picture. Then stop.

A plain `/dg:eli5 <thing to explain>` needs no CLI at all. Only `-v`/`-p` (stash) or `--erd`
(erd) need it; install or refresh it first, when it is missing or too old:

```bash
~/.dg/bin/dg-skills stash --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor erd stash.

## Usage

**Usage:** `/dg:eli5 <thing to explain> [-v|--viz] [-p|--publish] [--erd [path-or-concept]]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--viz` | `-v` | Also write a self-contained card to `$(~/.dg/bin/dg-skills stash eli5 <slug>.html)` and open it. | inline answer only |
| `--publish` | `-p` | Publish the same card as an Artifact instead of opening it locally. | do not publish |
| `--erd [target]` | none | Run `/dg:erd` first, then redraw its graph as a kid-simple picture. | explain without an architecture scan |

No `<thing to explain>` — explain the last thing discussed in the conversation.

## Scope: one answer

This mode covers **this answer only**. The next message is normal mode again. Never carry
kid-words into later turns; the user re-invokes `/dg:eli5` when they want it again.

## Answer shape — this order, nothing else

1. **Big idea** — one sentence, 15 words or fewer, no jargon. What the thing *is*.
2. **How it works** — 3 to 7 bullets. One idea per bullet, 15 words or fewer each.
3. **Picture** — exactly one drawing. Boxes and arrows. 6 boxes or fewer.
4. **Like...** — one everyday comparison (mail, kitchen, toys, a line at a shop).
5. **Big words you may hear** — a 2 to 5 row table, real term to kid words, so the user can
   still talk to grown-ups.

No preamble, no caveats section, no "it depends", no next-steps list.

## Word rules

- Short, common words: "get" not "retrieve", "box" not "container", "ask" not "invoke".
- Each jargon word either dies or goes in the glossary table. Never leave one bare in the text.
- Active voice, second person: "you ask, it answers".
- 15 words or fewer per sentence.
- Code, commands, file paths and error text stay **exact**. Never simplify a thing the user
  must type or read — explain around it.
- This layers on the global ASD-STE100 rule; both point the same way.

## Simple is not wrong

- Never invent a mechanism to make the story tidy.
- Read the real code before you explain real code. Do not guess from names.
- Where a simplification drops something that matters, mark it once: "(kind of — really it
  is X)". One of these per answer, at most.
- If you do not know, say "I do not know yet" and name the file or doc you would read.

## Drawing

Unicode box-drawing characters only: `┌ ┐ └ ┘ │ ─ ► ◄ ▼ ▲ ┬ ┴ ├ ┤`. Every box gets a real
name and a plain-word gloss below it. Every arrow gets a verb. Recipe, worked examples and
the `--erd` collapse rules: `references/drawing.md`.
