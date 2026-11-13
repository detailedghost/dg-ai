# dg-daemon outside services — Initial Notes

## Purpose
Let a program that lives outside this repository run as a dg-daemon service with no hand edit of the daemon config and no import of dg code. The owner declares the service with `dg-daemon service add` and starts the daemon with `dg-daemon start`. The service reads its credentials through one loopback HTTP route with a prefix-scoped grant. The change is additive and ships as a minor release.

## Scope
### Included
- `dg-daemon service add`, `service rm`, `service status --json`, and `job exec` (alias of `job run`)
- The service declaration keys `passEnv`, `stopTimeoutMs` and `grant`
- Supervisor: `passEnv` environment, a stop timeout for each service, the SIGKILL timer fix, the win32 hard kill, and autostart after the pid file
- `dg-daemon start` (idempotent, `--json`) on a shared start helper in `@dg/common/node` that `dg-agent start` also calls
- Service API v1 (provisional): the injected `DG_*` keys and `POST /service-api/v1/credentials` (get, list) with the ADR 0006 grant headers
- ADR 0043, `docs/service-api.md`, and corrections to `docs/jobs-and-services.md`, `SECURITY.md`, `docs/DEVELOPER.md`, `README.md` and the jobs skill
### Excluded
- Removal of channel-review, its skill sections, its credential names and its daemon.db tables (PR 2, major release)
- Supersession of ADR 0020 and Deprecated marks on ADR 0008 to 0019 (PR 2)
- Login autostart of dg-daemon
- A socket transport and a client library for services
- A grant mint at service spawn; `dg-skills credentials grant` stays the only mint
- `CHANGELOG.md` and the version stamps; `.github/workflows/release.yml` writes them from the commit subjects
- The edit of `.agents/spec/013_review_pipeline/plan.md` (decision D9); it is a separate commit, not a slice
- Stale `~/.dg` text outside `docs/jobs-and-services.md`
- Changes to `CHAT_PROTOCOL_VERSION`, `readConfig` and `writeConfig`
