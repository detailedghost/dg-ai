---
name: dg-proto
description: Build a throwaway prototype as an artifact, with radically different UI variants, a clickable walkthrough of a plan, or an interactive state model. Pick and refine through chat replies.
---

# Prototype (chat)

The chat version of DeeGee's `proto` skill. A prototype is **throwaway code that answers
a question**. Here every prototype is one HTML artifact in this chat, and every pick is a
chat reply. The artifact keeps the round history, so the pick carries from round to round.

## Options

The user can ask for these in plain words or with the same short flags as `/dg:proto`:

| Ask | Flag | Effect | Default |
| --- | --- | --- | --- |
| "three options" | `-n 3` | Number of UI variants, 1 or more | 5 |
| "try stacked, wizard and inline" | `-o "stacked,wizard,inline"` | Build exactly those directions, one variant each, named that way. Overrides `-n`. | none |

## Pick a branch

Work out which question is being asked, from the request or by asking:

- **"What should this look like?"** Several radically different UI variants of one page or
  component. Read [references/variants.md](references/variants.md).
- **"Does this whole plan hang together?" or "show me all the workflows."** One clickable
  walkthrough with a screen for each workflow in a plan. Read
  [references/walkthrough.md](references/walkthrough.md).
- **"Does this logic or state model feel right?"** An interactive model the user drives by
  hand. Read [references/logic.md](references/logic.md).

When it's unclear and the user isn't around to ask, pick the branch that fits the input: a
page is variants, a plan or spec is a walkthrough, a state machine or data model is logic.
State the assumption in the reply.

## Build the artifact

Copy [assets/proto-shell.html](assets/proto-shell.html) as the artifact. Don't write a
viewer or decision bar from scratch. Then:

1. Replace the `DG:THEME` comment with the full contents of
   [assets/dg-theme.css](assets/dg-theme.css), and the `DG:ICONS` comment with the full
   contents of [assets/dg-icons.js](assets/dg-icons.js). Both unchanged.
2. Put the variants, screens or model into `#dg-items`, one `.dg-item` section each.
3. Fill the `#dg-chain` JSON: name, kind, question, round. See
   [references/chain.md](references/chain.md).
4. Replace `PROTO_NAME` everywhere with a short slug, such as `signup-form`.

Keep the bar as it is: its light and dark toggle, width menu, note box, and Approve, Tweak,
Reject and More buttons. Style the prototype content against `html.dark` so the toggle
themes it too. A reviewer who can't see both modes approves a variant that breaks in the
other.

**Self-contained.** Inline every style and script. Never load a CDN script, a web font, or
a remote image: the artifact renders blank when that's blocked. Use inline SVG for icons
and realistic seed data.

**Build from the real thing.** When the user shares code, screenshots or a design system,
match its components, spacing, type and colors. Variants judged against a generic shell
don't tell you anything about the real page.

Before you publish, read the artifact through once: every `.dg-item` has a `data-key` and
a `data-label`, keys are unique, and each UI variant has exactly one `data-verify-root`
element. Never ask "does this look right?" about something you haven't checked.

## Hand it over and take the pick

Publish the artifact. Then end the reply with the choices as reply options. If this chat
offers a multiple-choice question tool, use it. Otherwise list the replies the user can send:

- `approve C`: C is the final pick. The chain ends.
- `approve C: <note>`: C becomes the base of a new round, changing only what the note asks.
- `tweak C: <note>`: edit C in place in this round, then show it again.
- `reject: <note>`: rework this round. A reject needs a note.
- `more` or `more: <note>`: build new variants in a new round, from the same base.
- `done`: end the chain with the last picked variant.

The bar's buttons write the same replies and copy them, so the user can paste one or just
pick the option. The artifact never sends anything by itself.

**Act on a pick without re-asking.** A reply in this grammar is the user's decision.

## Refine chain

Every round updates **the same artifact**. Never start a new one mid-chain, because the
history lives in it. Follow [references/chain.md](references/chain.md):

1. Add the decision just made to `history`.
2. Build the next round: new items, a bumped `round`, and `base` set to the pick, such as `1C`.
3. Republish the same artifact and offer the choices again.

Example, a form and then its buttons:

1. "prototype a signup form" builds round 1, variants A to E.
2. `approve C: organize the buttons` builds round 2: five variants of C with only the buttons changed.
3. `approve B: tighten the spacing` builds round 3 from round 2 B.
4. `approve D` ends the chain on round 3 D.

## When the chain ends

Set `status` to `accepted` and fill `accepted` in the chain JSON. Then republish so the
artifact opens on the winner with the bar locked, and reply with:

- the question and the answer: which variant won, and why, in the user's words where you have them
- the round history in a few lines
- an `ACCEPTED.md` block (format in [references/chain.md](references/chain.md)) the user can
  keep next to the design

To carry the pick into a repo, the user can save the artifact as
`.agents/prototype/<name>/index.html` and `ACCEPTED.md` next to it. That's the folder
DeeGee's `/dg:proto` and `/dg:spec` use in Claude Code and Codex.

## What this version leaves out

Mounting variants inside the running app, the local server and its saved picks, resuming a
chain from another chat (`-c`), `--light`, `--series`, `--self-contained`, `--publish` (every
prototype here is already an artifact), and `--ext`. Use `/dg:proto` in Claude Code or Codex
for those.
