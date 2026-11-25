# The board during a review

```bash
dg verify capture settings-nav --manifest=review.json
dg verify serve settings-nav
dg verify wait settings-nav
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
When Dante approves the last open round and no agent work is pending, the board counts down 5 seconds and closes its tab. Keep open cancels it. A board that was already finished when it opened does not close itself.
After `wait` prints `ALL APPROVED`, run `verify stop <name>` to stop the board server.

