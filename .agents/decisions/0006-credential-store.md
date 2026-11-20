---
covers: ["pkg/dg-daemon/src/store/credentials-store.ts", "pkg/dg-daemon/src/server/credentials.ts", "pkg/common/src/credentials-format.ts", "pkg/common/src/node/credential-grants.ts", "pkg/common/src/node/credentials-client.ts"]
---

[ADR 0006](../../docs/adr/0006-credential-store.md)

- Keep credentials in `credentials.db` with a separate data key wrapped by the daemon KEK.
- Bind authenticated data to the credential table, column and name.
- Name credentials `<consumer>/<provider>[/<qualifier>]`.
- Let session-authenticated clients manage entries. Give services read-only grants for one consumer prefix.
- Store the grant token file with mode 0600 and check its SHA-256 hash.
- Never let a grant write credentials. Never reveal whether a denied name exists.
- Never print credential values from CLI management commands.
- Never put credentials in the chat database.
