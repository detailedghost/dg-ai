# 0023 — Review finished work on a local page with a claimed verdict

Status: Proposed
Date: 2026-10-28

## Context

- `/dg:proto` asks Dante to pick among variants of a design that is not built yet. A finished branch has no variants, so that picker does not apply.
- Agents already finish work in branches and worktrees. Dante still needs a before-and-after visual, per role, at desktop and mobile, in light and dark.
- That visual includes scrolled pages and open menus.
- The prototype flow already has a local page, a same-origin decision POST, sentinel files, and a reload token so one tab can show the next round.
- Verify needs the same shape for a different question.
- Screenshots of a running app can contain real user data. A review that fetches a public URL, or that commits the images, would take that data off the machine.
- The app under review often has a strict Content-Security-Policy. An inline script on the review page, or a CDN script, would not run.

## Decision

`dg-skills verify` reviews finished items on one loopback page.
The manifest lists before and after URLs, seed roles, and the owning agent's name.
An optional target URL is the prototype column.
`pkg/skills-cli/src/verify/` captures with `playwright-core` when a local Chromium is present.
The HTTP engine is an explicit fallback that stores HTML and says so on the page.
The review server sends a Content-Security-Policy of `'self'` only and serves `/verify.js` and `/verify.css` as static files.
Picks are Approve, Reject with a note, or Tweak with a note.
`verify status` reads them.
`verify wait` claims the verdict file the way `prototype wait` claims a selection.
`allApproved` is true only when every item is Approve.
`verify rerun` recaptures rejected and tweaked items, drops those picks, and bumps `.reload` so the open tab reloads.
Notes for the owning agent are JSON files under the session `notify/` directory.
The parent agent delivers them. The CLI does not send them.

## Consequences

- **Good:** Dante can approve or send a change back without a prototype that has no variants.
  The page, the picker, and the claim match the prototype flow he already uses.
- **Good:** Capture refuses non-loopback URLs and credential-shaped headers, and the session directory `.agents/verify/` is gitignored.
- **Good:** The review page does not inject a script into the app, so the app's CSP does not have to allow the review.
- **Bad:** This slice does not boot the before and after stacks. The agent starts them and passes URLs. A wrong URL fails the capture.
- **Bad:** The accessibility summary is a local check of seven axe rule ids. It is not full axe-core, and it does not compute color contrast.
- **Neutral:** Chrome stable can take screenshots here.
  `demo --verify` still refuses it, because that flow loads an extension and Chrome stable disables `--load-extension`.

## Alternatives considered

- **Reuse `/dg:proto` with a single variant.** Proto's question is which variant to build.
  A finished change has no variants, and the before/after pair would be forced into that model.
- **Inject the picker into the app under review.** That fights the app's CSP and mixes review controls with the product. A separate local page keeps them apart.
- **Add axe-core and load it in the page.** That is a new dependency and a script the CSP would have to allow.
  The local check covers the rules we can see from HTML.
  Full axe-core can be a later slice if the summary is not enough.

## Diagrams

```mermaid
sequenceDiagram
    participant Agent
    participant CLI as dg-skills verify
    participant Page as loopback review page
    participant Dante

    Agent->>CLI: start name --manifest
    CLI->>CLI: capture before, after, target
    CLI->>Page: serve static HTML, CSS, and JS
    Dante->>Page: Approve, Reject, or Tweak
    Page->>CLI: POST /decision
    Agent->>CLI: wait name
    CLI-->>Agent: claimed verdict and notes
    Agent->>Agent: deliver each note to item.owner
    Agent->>CLI: rerun name
    CLI->>Page: bump reload token
    Page->>Page: reload the same tab
```

## References

- `pkg/skills-cli/src/verify/`
- `pkg/skills-cli/src/prototype/sentinels.ts`
- `pkg/skills-cli/src/prototype/serve.ts`
- `plugins/dg/skills/verify/SKILL.md`
- `docs/adr/0021-proto-daemon-relay.md`
