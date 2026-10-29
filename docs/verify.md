# Verify a finished change

`/dg:verify` is the review after the work exists. `/dg:proto` is the review before it does.

```text
Claude Code: /dg:verify
Codex:      $dg:verify
```

The agent writes a manifest of finished items.
Each item has a before URL and an after URL on localhost, the roles to sign in as seed users, and the name of the agent who owns the change.
When a prototype is already running, its URL is a third column.

`dg-skills verify capture <name> --manifest=<file>` captures desktop (1440), tablet (768), and mobile (390), light and dark.
It includes scrolled pages and open menus.
`dg-skills verify serve <name>` opens one local board.
The board steps through one round of one item at a time.
Dante approves, approves with a note, sends back with a note, or skips. On a round with versions, Dante can also ask for more versions.
The browser tab and its icon show how many rounds wait. A bell button turns on desktop alerts.
A round can hold more than one version. Dante flips between them and approves the one to keep.
The board checks for changes every 5 seconds and shows light or dark screenshots to match its theme.

```bash
dg-skills verify status <name>
dg-skills verify wait <name>
dg-skills verify rerun <name>
```

`status` prints one line per item.
`wait` blocks until every round has a verdict.
`ALL APPROVED` shows only when every item ends in a plain approve and no agent work is pending.
`rerun` captures the next round for items that were sent back or approved with a note.
The open tab finds the new round by itself.

Screenshots stay in `.agents/verify/<name>/` and are not committed. The board loads no CDN. Its scripts are static files.

See the [verify skill](../plugins/dg/skills/verify/SKILL.md) and [ADR 0023](adr/0023-verify-local-review.md).
