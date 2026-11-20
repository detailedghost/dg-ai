---
covers: ["pkg/extension/lib/background/agent-tabs.ts", "pkg/extension/lib/background/daemon-link.ts", "pkg/extension/lib/background/pairing-store.ts", "pkg/dg-daemon/src/server/http.ts", "pkg/dg-daemon/src/server/connection.ts"]
---

[ADR 0038](../../docs/adr/0038-extension-pairing-only.md)

- Keep the pairing popup as the extension's one visible surface. Ship no chat, dashboard or overwatch pages in the extension. The daemon `/chat` page replaces them.
- Pair automatically as ADR 0039 defines. The offer, claim and code flow of this record is superseded.
- Keep each agent session in its own tab group titled `<agentIdentity> · <first four characters of sessionId>`. `pw --ext` acts on that group.
- Offer `Add this tab` in the per-agent popup menu. Check pairing, page rules and ownership first. Refuse a tab that another agent owns while that agent has pending runs.
- Make `POST /start` refuse any `Origin` header with 400, and answer 401 without the owner token in `OWNER_TOKEN_HEADER`.
- Accept `session-create` only from `/cli` sockets.
- Keep each pairing in `storage.local` under `pairing:<id>`, written on the first confirming `session-list`. The daemon-side session expiry is the bound.
- Keep the [ADR 0004](../../docs/adr/0004-loopback-pairing.md) origin pin as the trust anchor for a paired extension.
- Pin each pairing to the `daemonId` read at adoption, from `daemon.id` reported on `/healthz`. Check the pin before a socket sends any token and when the extension discovers a port. Refuse a port that reports another `daemonId`.
- Let `POST /attach` from the `/chat` switcher send `{ intent: "attach", sessionId }` with a bearer and a local page `Origin`. The `Origin` header is required. Refuse `all` and `code` on that path. Require a live bearer. Limit to 30 requests per minute per token.
- Return from `POST /attach` only one active agent-role session with presence `cli`, other than the caller's own, per request. Never return a closed session or a non-`cli` session. The same-origin check binds browsers only.
- Never treat the pinned `Origin` header as a replacement for the owner token or a live bearer.
- Open extension pages through a one-time code: `POST /chat/code` needs a pinned extension-scheme `Origin` and a live session bearer. The code lives 60 seconds, works once, and at most 16 stay outstanding.
- Make `POST /chat/exchange` need the daemon's own page `Origin`. It trades the code for the bootstrap and answers a second use with 404. Make the page strip the fragment before it posts the code.
- Keep schema 13 without `awaiting_agent`. Write a `pre-migration-v13-` snapshot before the migration.
