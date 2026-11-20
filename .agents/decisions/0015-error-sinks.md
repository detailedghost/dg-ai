---
covers: ["pkg/channel-review/src/sinks/**"]
---

[ADR 0015](../../docs/adr/0015-error-sinks.md)

- Implement every error provider as an `ErrorSink` with `name`, `poll({since, signal})` and `detail(issue)`.
- Record issues as seen on the first poll. Start no fixes.
- Hand off only new issues, deferred issues, or regressions newer than the stored transition. Exclude work already fixing.
- Normalize provider-specific regression fields in the adapter, before the poller decides.
- Persist cursors for provider retries and deferred work.
- Poll. Never add inbound tracker webhooks.
