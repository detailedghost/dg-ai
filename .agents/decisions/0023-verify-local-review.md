# 0023 — Review finished work on a local page

ADR: [docs/adr/0023-verify-local-review.md](../../docs/adr/0023-verify-local-review.md)

- `/dg:verify` is for finished work. `/dg:proto` is for variants that are not built yet.
- Manifest URLs stay on loopback. Seed headers and cookies only. Refuse `Authorization` and token-shaped values.
- Do not commit `.agents/verify/`. Shots and verdicts stay there.
- The review page is static `/verify.js` and `/verify.css`. No inline script. No CDN.
- Do not inject the picker into the app.
- `owner` is the assigned name: a persona, a `bc-` cloud agent id, or the branch.
- The parent agent delivers reject and tweak notes. `verify rerun` does not.
- `verify wait` claims the verdict. `verify status` does not.
- `allApproved` is true only when every item is `approve`.
- `verify rerun` recaptures reject and tweak items only, then bumps `.reload`.
- Playwright screenshots use `playwright-core`. Do not add a browser download.
- The axe summary is the local seven-rule check. Do not load axe-core from the network.
- This slice does not check out branches or start the app stacks.
