# Layout check

An item that builds a prototyped slice is incomplete without `record`.
`verify capture` reads the record before it takes any shot. A missing or malformed record stops the run and names the path.
For each role, viewport, and theme, it reads the layout of the after page in the default state and compares it with the reading in the record.
A row has one of these kinds:

- `root-missing`: the page has no single visible feature root.
- `missing`: the prototype had a control that the build lacks.
- `extra`: the build has a control that the prototype lacked.
- `reordered`: a control is out of order against the others.
- `moved`: a control changed its top, middle, or bottom band, or its left, center, or right band, by a tenth of the root or more.
- `visibility`: a control is shown or hidden against the prototype.
- `occluded`: a control is covered by another element in the build but not in the prototype, or the other way round.
- `theme`: the build did not apply the theme that the record read.
- `not-checked`: the layout was not read. The http engine, an `--ext` record, and a record made with `--no-fingerprint` each give one row per role with the reason.

The board shows a Layout pill and a table of the rows.
Each row has an Accept box, and the header has one for all rows.
Approve is refused until every row is accepted or the verdict has a note.
An accepted row stays accepted in later rounds of the same item. A round added by hand shows the rows of the latest earlier round that has them.
`status` prints `| layout: N unaccepted` for an item with open rows. `ALL APPROVED` waits until N is 0.
A control that shows record data, such as a select of names or a button with a user title, needs a `data-testid`. The test id wins identity, so the row does not break when the data changes.
Pixel differences never fail a review.
When no prototype page runs, the board shows the reference shots from the prototype sandbox in the prototype column. A missing sandbox, a prototype name found in two worktrees, or a sandbox that accepted a different pick since, leaves the column empty.

