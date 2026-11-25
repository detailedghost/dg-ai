# Local only

The board is static files that ship with the skill in `assets/`: `index.html`, `board.js`, and `board.css`.
The icons come from `/dg:proto`'s `assets/dg-icons.js`, so both skills draw the same toolbar.
The HTML has no inline script and no inline style.
The server sends a Content-Security-Policy that allows only `'self'` for scripts, styles, and connections. Images also allow `data:`, so the board can draw its tab icon.
Nothing is loaded from a CDN.

Screenshots and verdicts stay in `.agents/verify/<name>/`.
That directory is gitignored. Do not commit them.
Do not copy real user data into the manifest or the fixture.

The page does not inject a script into the app under review. Capture navigates and screenshots. The app's own CSP is left alone.
