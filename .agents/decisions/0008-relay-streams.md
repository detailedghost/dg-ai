---
covers: ["pkg/channel-review/src/providers/**", "pkg/channel-review/src/daemon/serve.ts", "pkg/channel-review/README.md"]
---

[ADR 0008](../../docs/adr/0008-relay-streams.md)

- Consume one SSE stream per chat and resume with `Last-Event-ID`.
- Run an independent stream pump for each chat. A failing chat must not stop the others.
- Reconnect after 45 seconds without data or pings. Use capped backoff with jitter.
- Use the relay's direct mode for direct messages.
- Supply chat resolution, subscriptions, reactions, replies, direct messages and reaction listing through `ChatProvider`.
- Keep the engine independent of relay HTTP shapes in `providers/types.ts`.
- Never require an inbound webhook endpoint. Never share one stream across chats.
