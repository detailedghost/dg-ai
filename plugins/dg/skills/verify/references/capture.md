# Capture

`verify capture` and `verify rerun` take one shot for every combination of:

| Axis | Values |
|---|---|
| Side | `before`, `after`, and `target` when `targetUrl` is set |
| Role | every role in the item |
| Viewport | desktop `1440×900`, tablet `768×1024`, mobile `390×844` |
| Theme | `light` and `dark` |
| State | `default`, `scrolled`, and `menu` |

The captured URL gains `dg-theme` and `dg-state`.
The Playwright engine also sets the viewport, `colorScheme`, scrolls to the bottom, and clicks the menu control.
The default menu control is `[data-verify-menu]`.
Set `menuSelector` when the control uses another selector.
Each after shot is paired with the before shot (and the target shot) of the same role, viewport, theme, and state.
The pair label starts with the viewport, so the board's width menu can filter it.
A missing menu still saves the shot and the label says `menu not found`.
A page that does not scroll says `page did not scroll`.

## Engines

`playwright` uses `playwright-core`, which the CLI already depends on, and a local Chromium.
It prefers the same browsers as the demo verifier (Brave, Chromium, Chrome for Testing).
Chrome stable is also accepted here because capture does not load an extension.
Set `DG_VERIFY_BROWSER` to force a binary.
In a container, set `DG_VERIFY_NO_SANDBOX=1`.

`http` only fetches the HTML. The image is a placeholder. The page says so.
Use it when no browser is installed.
Do not hand Dante an HTTP capture and call it a screenshot.

## Accessibility

Each after shot's HTML is checked locally.
The summary uses axe rule ids: `document-title`, `html-has-lang`, `image-alt`, `button-name`, `link-name`, `label`, and `duplicate-id`.
This is not the full axe-core engine.
It does not load a CDN script, so it stays inside the review page's CSP.
A violation on any after shot is a violation for that round.
The board shows the rule ids in an Accessibility pill under the title.

## Tests

The manifest `tests` object is shown as a Tests pill on each round.
`summary` records a suite that already ran.
`cmd` is an argv of a bare executable. It goes to spawn directly, never through a shell, but the manifest author is trusted to run it like any command.
It runs in the current working directory with a 15 second limit. A timeout kills the command and every child it started.
Output keeps the last 4000 characters, where test runners print their totals.
Item `tests` replace the session summary for that item when they are present.

## Seed data

Roles may set headers and cookies.
`Authorization`, `Cookie`, and `Proxy-Authorization` are rejected.
Values that look like a GitHub token, a Slack token, an AWS access key, a bearer token, or a long `sk-` key are rejected.
Point every URL at a local server that serves seed accounts.
