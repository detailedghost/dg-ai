---
covers: ["pkg/dg-daemon/src/server/**", "pkg/dg-daemon/src/store/**", "pkg/dg-daemon/src/services/**", "pkg/common/src/node/cli-client.ts"]
---

[ADR 0002](../../docs/adr/0002-daemon-hub.md)

- Keep sessions, message queues, assets, scheduled jobs and service supervision in `pkg/dg-daemon`.
- Connect the extension over `/ws`. Send `dg-agent` requests, authenticated, to `/cli`.
- Never put queue ownership in the extension or in direct agent-to-extension messages.
- Run channel review as a separate process, supervised as a service. Never run it inside the hub.
- Keep service recovery in `services/supervisor.ts` and browser reconnection in `server/connection.ts` as separate lifecycles.
- Let clients reconnect without owning the queue.
