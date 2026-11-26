---
name: verify
description: Review finished work before it lands. Capture before-and-after screenshots at desktop, tablet and mobile, light and dark, per role, then show them round by round on a local board with test results. Dante approves, sends back or skips each item. Use when an agent has finished a branch or page, or the user says "verify this" or "show me before and after".
---

First run: the block installs the CLI when it is missing. It prints an upgrade hint when the CLI is too old. Each Bash call works alone:

```bash
dg verify --help >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg" verify --help >/dev/null 2>&1 ||
  { { dg --version >/dev/null 2>&1 || "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } && echo "run dg upgrade"; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg` in every later step. If `dg` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg` instead. If the block prints "run dg upgrade", run `dg upgrade`, then run the step again.

If a step fails, run dg doctor verify pw.

# Verify

`/dg:proto` compares variants of a design that does not exist yet.
`/dg:verify` reviews a change that is already built.
Each item has a before and an after. A prototype, when one exists, is a third column.

The review is one local board.
It steps through one section at a time. Each section is one round of one item.
Dante picks a verdict per round:

| Verdict | Meaning |
|---|---|
| Approve, no note | The item is done. |
| Approve with a note | Approved. The note starts a follow-up round. |
| Needs changes | A note is required. The owning agent reworks the item. |
| Skip | The item stays open. |
| More versions | Only on a round with versions. The button next to Needs changes rejects these versions. Add a new round with more versions. |

`verify status` and `verify wait` read the verdicts.
`verify rerun` captures the next round for each item that was sent back or approved with a note.
The open tab finds the new round by itself.

## Commands

| Command | Effect |
|---|---|
| `serve <name> [--port=N] [--no-open]` | Start the board in the background and print its URL. A second call reuses the running server. |
| `status <name> [--json]` | One line per item: its rounds, its state, and the latest note. The last line is `ALL APPROVED` or `<n> open`. With `--json`, a captured item also has `itemId` and `owner`. |
| `wait <name> [--timeout=SEC] [--json]` | Block until every round has a verdict, then print the same lines as `status`. Exit 1 and print `timeout` when time runs out. The default is 900 seconds. |
| `watch <name>` | Print one line per new verdict until stopped. |
| `stop <name>` | Stop the board server. |
| `title <name> <text>` | Set the board title shown in the nav and the browser tab. Empty text clears it, and the board then shows `<name> · review`. |
| `capture <name> [--manifest=FILE] [--items=a,b] [--summary=S]` | Capture items from the manifest. An item with no round gets round 1. An item with rounds gets the next round. |
| `rerun <name> [--summary=S]` | Capture the next round only for items whose latest round was sent back or approved with a note. Prints `nothing-to-recapture` when there are none. |
| `add <name> <id> --title=T ...` | Add a round from screenshots you took yourself. Use `--shots=DIR --prefix=P` to pair `P*before-<x>.png` with `P*after-<x>.png`, or repeat `--img="label\|before\|after[\|reason]"`. Add `--follows=ID --round=N` for a later round. Add `--variant=KEY [--variant-label=L] [--variant-summary=S]` to add one version of the round; see [Versions](#versions). |
| `pending add <name> <key> --title=T [--detail=D] [--follows=ID]` | Show an "agent working" entry. `--follows` puts it under that round. |
| `pending done <name> <key>` | Remove that entry. `add --pending=KEY` also removes it. A plain `add` with `--follows` also removes the entry under that round. |

Every command takes `--dir=PATH`. The default session is `.agents/verify/<name>/` in the current repo.
`capture` and `rerun` take `--engine=http|playwright`. The default is `playwright`. `http` records HTML only and labels every image `html fetch`.

## Build the manifest

Write a JSON file. Every URL must be loopback (`127.0.0.1`, `localhost` or `::1`). Never point at production. Never put real sessions, passwords or tokens in headers or cookies. Use seed roles, or a saved sign-in with `"state": "<name>"` (needs the `playwright` engine). The manifest holds the state name only.
Each item has `id`, `title`, `beforeUrl`, `afterUrl` and `roles`, and may have `what`, `owner`, `beforeRef`, `afterRef`, `targetUrl`, `record` and `rootSelector`. The top level has `name`, `stackUrl` and `tests`. `owner` is the agent who owns the after side: [references/owners.md](references/owners.md).
Full example and every field: [references/manifest.md](references/manifest.md). Capture details and viewports: [references/capture.md](references/capture.md).

## Browser mode

Capture runs a Playwright browser, so it stays local even when `pw.mode` is `auto`. It never drives the human's real browser through the extension.

## Run the review

```bash
dg verify capture settings-nav --manifest=review.json
dg verify serve settings-nav
dg verify wait settings-nav
```

Each item becomes a section `<item>-r<round>`. Rounds of one item link through `follows`. `wait` returns when every round has a verdict. Read its lines: they name each item, its rounds, and the latest note.
`ALL APPROVED` shows only when every item ends in a plain approve and no agent work is pending. Then run `verify stop <name>` to stop the board server.
Board controls, tab alerts, notes, themes and highlights: [references/board.md](references/board.md).

## Layout check

An item that builds a prototyped slice needs `record`. `verify capture` reads the layout of the after page and compares it with the record. The board shows a Layout pill and a table of rows. Approve is refused until every row is accepted or the verdict has a note. Pixel differences never fail a review. Row kinds and rules: [references/layout-check.md](references/layout-check.md).

## Versions

A round can hold more than one version, like `/dg:proto` variants. Run `add` once per version with the same round id and `--variant=KEY`. Dante picks one; `status` prints `picked B`. Commands and rules: [references/versions.md](references/versions.md).

## Send notes back and rerun

For each item that is not done, send the latest note to that item's `owner` as their next instruction.
See [references/owners.md](references/owners.md).
This command does not message anyone itself.

While the owner works, show it on the board:

```bash
dg verify pending add settings-nav settings-r2 --title="Settings" --detail="Fixing the menu" --follows=settings-r1
```

After the owner updates the after stack:

```bash
dg verify rerun settings-nav --summary="Menu no longer clips"
```

`rerun` captures only those items and adds each one as the next round, with `follows` set to the round before.
It clears the pending entry for that round.
Approved items are not captured again, and earlier rounds keep their screenshots and verdicts.
The open tab checks for new rounds every 5 seconds and opens the next one.
Use `--summary` to say in a few words what changed. Without it, the summary is the start of Dante's note.

## Local only

The board is static files in `assets/` with no inline script, a strict Content-Security-Policy and no CDN. Screenshots and verdicts stay in `.agents/verify/<name>/`, which is gitignored: never commit them. Never copy real user data into the manifest. Details: [references/local-only.md](references/local-only.md).
