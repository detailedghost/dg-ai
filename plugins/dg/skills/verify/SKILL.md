---
name: verify
description: Review finished work before it lands. Capture before-and-after screenshots of each change at desktop, tablet, and mobile, light and dark, per role, including scrolled pages and open menus, then show them round by round on a local board with test results and an accessibility summary. Dante approves, approves with a note, sends back, or skips each item. Use when an agent has finished a branch, worktree, or page and a person needs to see it, or when the user says "verify this", "show me before and after", or "let me approve the change".
---

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills verify --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor verify.

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
| `status <name> [--json]` | One line per item: its rounds, its state, and the latest note. The last line is `ALL APPROVED` or `<n> open`. |
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

Write a JSON file. Every URL must be loopback (`127.0.0.1`, `localhost`, or `::1`).
Do not point at production.
Do not put real sessions, passwords, or access tokens in headers or cookies.
Use seed roles only.

```json
{
  "name": "settings-nav",
  "stackUrl": "http://127.0.0.1:3000/",
  "tests": { "summary": "12 passed", "passed": 12, "failed": 0 },
  "items": [
    {
      "id": "settings",
      "title": "Settings",
      "what": "Moves the settings links into a side menu.",
      "owner": "dg:implementer",
      "beforeRef": "master",
      "afterRef": "feat/settings-nav",
      "beforeUrl": "http://127.0.0.1:4001/settings",
      "afterUrl": "http://127.0.0.1:4002/settings",
      "targetUrl": "http://127.0.0.1:4321/",
      "roles": [
        { "id": "admin", "headers": { "x-seed-role": "admin" } },
        { "id": "member", "headers": { "x-seed-role": "member" } }
      ]
    }
  ]
}
```

`what` is optional. It is one or two sentences on what changed, shown under the title.
`owner` is the agent who owns the after side. Name them the way the work was assigned. See [references/owners.md](references/owners.md).

`beforeRef` and `afterRef` are labels (a branch or a worktree).
This command does not check out branches or boot apps.
Start the before stack and the after stack yourself, then put their URLs in the manifest.
`stackUrl` is the after stack Dante can click.
`targetUrl` is optional.
Set it only when a prototype page is already running.
The column says there is no prototype target when the field is absent.

`tests` is the suite result for the change. A `cmd` array is an argv, never a shell. A `summary` is enough when the suite already ran.

Capture details, viewports, and the accessibility check: [references/capture.md](references/capture.md).

## Run the review

```bash
~/.dg/bin/dg-skills verify capture settings-nav --manifest=review.json
~/.dg/bin/dg-skills verify serve settings-nav
~/.dg/bin/dg-skills verify wait settings-nav
```

Each item becomes a section with the id `<item>-r<round>`.
Rounds of one item link through `follows`.
The left panel shows the title, the progress, and one entry per item with a timeline of its rounds.
Overview and Needs attention stay pinned at the top. Needs attention goes to the next round with no verdict.
Drag the panel edge, or focus it and use the arrow keys, to change its width. Enter or a double-click resets it.
The board checks for changes every 5 seconds. A changed round that is open updates in place and keeps the note draft. A new round opens by itself, unless Dante is typing a note.
The theme button shows the board and the screenshots in light or dark.
A screenshot is dark when its label or file name has the word `dark`. Every other screenshot is light.
Put `light` or `dark` in the names of shots you add yourself.
Each pair shows side by side. The board marks what changed with numbered boxes on both images and a count such as `2 changed areas` in the card header. The highlight button in the picker turns the boxes off and on, and the board remembers the choice. Each pair also has a Side by side, Before, and After switch to see one image at full width. A pair with no before has no highlights.
The collapse button in the panel head shrinks the panel to an icon rail. Expanding it resets the panel to the default width.
The note field grows with its text and can be resized. Shift+Enter adds a line. Enter alone does not save.
Each screenshot has its own "Note on this" button.
A verdict keeps the screenshot notes in `shotNotes` and the main note in `mainNote`.
`note` holds the main note and one `[label] text` line per screenshot note, so `status`, `wait`, and `watch` show all of them.
A screenshot note alone counts as a note: Approve becomes approve with a note, and Needs changes is allowed.
When several items wait, only the first one in each list animates.
The browser tab shows the number of rounds that wait, the open round, and the board title, for example `(2) Settings r2 · Settings polish`.
It adds `● New round` when a round arrives while the tab is in the background.
The tab icon shows the same count in a red dot.
Needs attention is also the alert bell. The first click asks the browser once for alert permission. After that, a click goes to the next waiting round. An alert shows only when a round arrives and the tab is in the background.
`status` and `watch` print `more versions` for a round where Dante asked for more versions. `rerun` treats it like a round that was sent back.
`wait` returns when every round has a verdict. Read its lines. They name each item, its rounds, and the latest note.
`ALL APPROVED` shows only when every item ends in a plain approve and no agent work is pending.

## Versions

A round can hold more than one version, like `/dg:proto` variants.
Run `add` once per version with the same round id:

```bash
~/.dg/bin/dg-skills verify add settings-nav nav-r2 --title="Nav" --follows=nav-r1 --round=2 --variant=A --variant-label="Tabs" --shots=./shots/a
~/.dg/bin/dg-skills verify add settings-nav nav-r2 --title="Nav" --follows=nav-r1 --round=2 --variant=B --variant-label="Rail" --shots=./shots/b --pending=nav-r2
```

A version key is 1 to 16 letters or digits.
Dante flips versions with the switcher, the arrow keys, or the keys 1 to 9. The captions read "Now" and "Version B".
Approve records the shown version. `status` and `watch` print `picked B`.
A version `add` clears a pending entry only when you pass `--pending=KEY`.

## Send notes back and rerun

For each item that is not done, send the latest note to that item's `owner` as their next instruction.
See [references/owners.md](references/owners.md).
This command does not message anyone itself.

While the owner works, show it on the board:

```bash
~/.dg/bin/dg-skills verify pending add settings-nav settings-r2 --title="Settings" --detail="Fixing the menu" --follows=settings-r1
```

After the owner updates the after stack:

```bash
~/.dg/bin/dg-skills verify rerun settings-nav --summary="Menu no longer clips"
```

`rerun` captures only those items and adds each one as the next round, with `follows` set to the round before.
It clears the pending entry for that round.
Approved items are not captured again, and earlier rounds keep their screenshots and verdicts.
The open tab checks for new rounds every 5 seconds and opens the next one.
Use `--summary` to say in a few words what changed. Without it, the summary is the start of Dante's note.

## Local only

The board is static files that ship with the skill in `assets/`: `index.html`, `board.js`, and `board.css`.
The icons come from `/dg:proto`'s `assets/dg-icons.js`, so both skills draw the same toolbar.
The HTML has no inline script and no inline style.
The server sends a Content-Security-Policy that allows only `'self'` for scripts, styles, and connections. Images also allow `data:`, so the board can draw its tab icon.
Nothing is loaded from a CDN.

Screenshots and verdicts stay in `.agents/verify/<name>/`.
That directory is gitignored. Do not commit them.
Do not copy real user data into the manifest or the fixture.

The page does not inject a script into the app under review. Capture navigates and screenshots. The app's own CSP is left alone.
