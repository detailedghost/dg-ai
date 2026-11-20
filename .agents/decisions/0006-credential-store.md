---
covers: ["pkg/dg-daemon/src/store/credentials-store.ts", "pkg/dg-daemon/src/server/credentials.ts", "pkg/common/src/credentials-format.ts", "pkg/common/src/node/credential-grants.ts", "pkg/common/src/node/credentials-client.ts"]
---

[ADR 0006](../../docs/adr/0006-credential-store.md)

- Keep credentials in `credentials.db` with a separate data key wrapped by the daemon KEK.
- Bind authenticated data to the credential table, column and name.
- Name credentials `<consumer>/<provider>[/<qualifier>]`.
- Let session-authenticated clients manage entries. Give services read-only grants for one consumer prefix.
- Store the grant token file with mode 0600 and check its SHA-256 hash.
- Never let a grant write a value of its own. Only `refresh` of [ADR 0052](../../docs/adr/0052-job-sources-and-credentials.md) stores a value, fetched by the daemon. Never reveal whether a denied name exists.
- Never print credential values from CLI management commands.
- Never put credentials in the chat database.
- Mint a form-intake code with the session-authenticated `intake` op. The code lives 120 seconds and works once.
- Store a form value only through `POST /secret-intake` ([0031](../../docs/adr/0031-loopback-pages.md)). Note the value for redaction before any refusal.
