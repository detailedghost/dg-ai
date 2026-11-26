---
covers: ["pkg/skills-cli/src/pw/**","pkg/extension/lib/background/pw-verbs/**","pkg/common/src/pw-ext-verbs/**"]
---

[ADR 0060](../../docs/adr/0060-pw-auto-mode-and-ext-verbs-for-the-real-browser.md)

- Pick the browser in this order: a local-only verb runs local; `--local` or `--ext`; `DG_BROWSER=ext|local`; `browser.mode` in config.toml; then auto.
- Auto sends a call to the extension only when it is paired and connected, the verb has an ext verb, and the call has no options and no session. Otherwise it runs local with no error.
- Keep `select`, `close`, `tab-select`, `upload` and `tab-close <index>` local in auto mode.
- Keep cookie, state, route, video, tracing, pdf and attach verbs local-only in every mode; `--ext` with one exits 2.
- Ask before the first visit to each new site. Never prompt for `eval` or a storage write; refuse a site that is not allowed.
- A PHI-flagged site refuses `snapshot` and `screenshot` for the session.
- Pass every ext result through the same secret scrub.
- Use `DG_VERIFY_BROWSER` for a browser binary path, never `DG_BROWSER`.
