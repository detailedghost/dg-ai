---
covers: ["pkg/dg-daemon/src/store/**", "pkg/common/src/node/sqlite.ts", "pkg/channel-review/src/state.ts"]
---

[ADR 0003](../../docs/adr/0003-storage-by-writer.md)

- Use `bun:sqlite`, STRICT tables, ordered schema migrations and immediate write transactions for daemon state.
- Update claims and delivery state in one transaction.
- Replace channel-review state atomically and validate its shape on load. [ADR 0018](../../docs/adr/0018-channel-review-state-in-daemon-db.md) moves that state to the daemon database.
- Coalesce only event-cursor updates, for one second. Save every other state change at once.
- Keep older state files readable when fields are added.
- Keep a handled-message check as a duplicate guard separate from event cursors.
