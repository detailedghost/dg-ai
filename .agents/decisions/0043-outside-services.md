---
covers: ["pkg/dg-daemon/src/services/**", "pkg/dg-daemon/src/server/service-api.ts", "pkg/dg-daemon/src/server/credentials.ts", "pkg/dg-daemon/src/commands/stop.ts", "pkg/common/src/node/daemon-start.ts", "docs/service-api.md"]
---

[ADR 0043](../../docs/adr/0043-outside-services.md)

- Treat service API v1 as provisional. Ship a breaking change as a new environment key or a v2 route. Never change a v1 key or route in place.
- Build a service environment in this order: allowlist (`PATH`, `HOME`, `LANG`, `TZ`), `passEnv`, `envFile`, injected keys. Let injected keys win.
- Inject `DG_SERVICE_API`, `DG_SERVICE_LABEL`, `DG_DAEMON_URL`, `DG_CREDENTIAL_GRANT_PREFIX`, `DG_CREDENTIAL_GRANT_FILE`, `DG_SERVICE_STATE_DIR` and, when set, `DG_HOME`.
- Never put a grant token in the environment. Put its file path there.
- Serve credentials only at `POST /service-api/v1/credentials`, with `get`, `list` and `refresh` below the grant prefix. `refresh` is the addition of [ADR 0052](../../docs/adr/0052-job-sources-and-credentials.md).
- Require `X-Dg-Grant-Prefix` and `X-Dg-Grant-Token`. Refuse a browser `Origin` with the `isBrowserOrigin` gate, and answer each denial with one text.
- Never echo request body text or headers in a response or log line.
- Parse `grant`, `passEnv` and `stopTimeoutMs` (default 5000, maximum 240000) with the parser the daemon uses.
- Write the service table through `readConfigStrict` and `writeServiceEntry`. Keep `service add` and `service rm` working with no daemon.
- Keep `dg-daemon start` idempotent through the shared `ensureDaemonRunning`.
- Make `dg-daemon stop` send SIGTERM and wait. Make `--force` kill the daemon and each service process tree at once, and leave running job and dispatch commands alone.
- Make `dg-daemon restart` start only `autostart` services and print the real state.
- Use the job noun of ADR 0049 for new work.
