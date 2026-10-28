# 0023 — Review finished work round by round on a local board

ADR: [docs/adr/0023-verify-local-review.md](../../docs/adr/0023-verify-local-review.md)

- `/dg:verify` is for finished work. `/dg:proto` is for variants that are not built yet.
- Manifest URLs stay on loopback. Seed headers and cookies only. Refuse `Authorization` and token-shaped values.
- Do not commit `.agents/verify/`. Shots, `board.json`, and `verdicts.json` stay there.
- The board is the static `index.html`, `board.js`, and `board.css` in `verify/assets/`. No inline script. No CDN.
- Icons come from `proto/assets/dg-icons.js`. Do not copy the icon map into either skill.
- Verdicts are `approved`, `changes`, and `skip`. Approve with a note starts a follow-up round. `changes` needs a note.
- Rounds link with `follows`. A new capture of an item is a new round, never an overwrite.
- `verify wait` returns when every round has a verdict. It does not claim anything.
- `ALL APPROVED` needs every item to end in a plain approve and no pending entry.
- `verify rerun` captures only items sent back or approved with a note.
- `owner` is the assigned name: a persona, a `bc-` cloud agent id, or the branch. The parent agent delivers notes.
- Playwright screenshots use `playwright-core`. Do not add a browser download.
- The axe summary is the local seven-rule check. Do not load axe-core from the network.
- This slice does not check out branches or start the app stacks.
