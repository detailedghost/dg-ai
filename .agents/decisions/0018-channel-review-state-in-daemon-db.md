---
covers: ["pkg/common/src/node/daemon-db.ts", "pkg/common/src/node/daemon-schema.ts", "pkg/common/src/node/sqlite.ts", "pkg/channel-review/src/state.ts", "pkg/dg-daemon/__tests__/store/channel-review-state.spec.ts"]
---

[ADR 0018](../../docs/adr/0018-channel-review-state-in-daemon-db.md)

- Store channel-review state in `daemon.db`. Open it only through the shared opener in `@dg/common/daemon-db`.
- Keep one ordered migration list in `pkg/common/src/node/daemon-schema.ts`. Let only the shared runner update `PRAGMA user_version`.
- Never import one workspace package from the other to open the store.
- Keep one `channel_review_state` snapshot row per `env`. Derive `channel_review_requests` and `channel_review_current` as views of that row.
- Reject a stale writer with the revision predicate.
- Use `BEGIN IMMEDIATE` for schema steps and recheck the version under the write lock.
- Never initialize `crypto_meta`, resolve keys or open `credentials.db` from the opener.
- Import legacy JSON once per environment in one immediate transaction. An existing row always wins.
- Never modify or delete the legacy JSON file.
- Fail visibly on malformed legacy JSON. Create no initialized row.
- Keep status reads read-only. Never create or migrate a database from a status read.
- Fail with a named status error and exit 1 on a state read failure.
- Keep recovery: prune handled entries older than 24 hours, fail surviving pending or running requests, report CR-205, clear current.
- Coalesce replay cursor writes for at most one second. Flush held cursors on job writes and orderly close.
- Refuse independent writers for the same environment.
- Ship `dg-daemon` and `dg-skills` builds that both support schema 12 as a pair.
