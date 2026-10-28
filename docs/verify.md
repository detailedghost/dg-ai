# Verify a finished change

`/dg:verify` is the review after the work exists. `/dg:proto` is the review before it does.

```text
Claude Code: /dg:verify
Codex:      $dg:verify
```

The agent writes a manifest of finished items.
Each item has a before URL and an after URL on localhost, the roles to sign in as seed users, and the name of the agent who owns the change.
When a prototype is already running, its URL is a third column.

`dg-skills verify start <name> --manifest=<file>` captures desktop (1440) and mobile (390), light and dark.
It includes scrolled pages and open menus.
It serves one local page.
Dante picks Approve, Reject with a note, or Tweak with a note for each item.

```bash
dg-skills verify status <name>
dg-skills verify wait <name>
dg-skills verify rerun <name>
```

`status` reads the picks.
`wait` claims the verdict once every item has one.
`allApproved` is true only when every item is approved.
`rerun` recaptures the rejected and tweaked items and reloads the same tab.

Screenshots stay in `.agents/verify/<name>/` and are not committed. The page loads no CDN. Its script is a static file.

See the [verify skill](../plugins/dg/skills/verify/SKILL.md) and [ADR 0023](adr/0023-verify-local-review.md).
