---
covers: ["pkg/dg-daemon/src/server/**", "pkg/common/src/node/session-tokens.ts"]
---

[ADR 0004](../../docs/adr/0004-loopback-pairing.md)

- Bind the daemon to `127.0.0.1` and check the Host authority.
- Require an extension-scheme Origin on extension WebSockets, and pin the authenticated origin.
- Require a session ID and token for normal `/cli` requests and asset reads. Compare them in constant time.
- Use the narrower credential exception in [0006](../../docs/adr/0006-credential-store.md) for credential service grants only.
- Keep the six-digit pairing code, its five-minute life and its five-attempt limit.
- Create sessions through offer and claim: the extension calls `POST /pair/offer` and polls `POST /pair/offer/<id>`; the agent claims with `POST /pair/claim` and the owner token.
- Refuse any `Origin` header on `POST /pair/claim`.
- Expire every pending offer when the fifth wrong claim lands in one five-minute window. Hold at most 8 pending offers.
- Never restore `POST /pair`, `handlePair` or `pkg/dg-daemon/src/pairing.ts`.
- Keep the origin pin as the trust anchor. Offer and claim bootstrap only the first pairing.
- Never let a valid local connection alone grant session access.
- Apply the loopback-origin check to `POST /secret-intake` too. The `/secret` page holds an intake code, never a session token.
