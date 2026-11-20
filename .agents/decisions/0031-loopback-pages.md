---
covers: ["pkg/pages/**", "pkg/dg-daemon/src/server/origin.ts", "pkg/dg-daemon/src/server/http.ts", "plugins/dg/skills/chat/**", "plugins/dg/skills/overwatch/**"]
---

[ADR 0031](../../docs/adr/0031-loopback-pages.md)

- Serve the chat page at `/chat` and the board page at `/board` from `dg-daemon` on 127.0.0.1, built from the shared `pkg/pages` package.
- Keep the page shells public. The token never reaches the server through the fragment.
- Accept API and WebSocket requests only from a loopback origin or a request with no `Origin`, and only with the token of a live session. A dead token gets 403. A foreign origin gets 400.
- Accept the query token only on the WebSocket upgrade.
- Make the page strip the fragment from the address bar and keep the bootstrap in `sessionStorage`.
- Keep the strict CSP and the origin gate in `origin.ts`.
- Make `dg-agent start --ext` print the daemon `/chat` URL, and `--open` open it. Make `dg-agent overwatch open --ext` open `/board`.
- Treat `--ext` as "the browser must be paired with the extension". Do not open `/start` or a side panel.
- Let a page that holds one live token call `POST /attach` with a bearer header. Return one active agent-role session whose presence is `cli`, other than the caller's own. The Origin check binds browsers only.
- Keep the `ext-opt-in.spec.ts` allowlist empty. `chat` and `overwatch` must work with no extension.
