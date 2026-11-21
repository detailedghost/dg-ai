# One dg binary and one config file — Initial Notes

## Purpose
Put every dg command under one flat `dg <command>` surface and ship it as one compiled program, which revives the single-binary decision of ADR 0020 and reverses that part of its 2026-11-18 amendment. Today dg already ships one minified bundle and one pinned Bun runtime (ADR 0032) behind four launchers, and the release already uses one `v<x>` tag, so the work is the flat command surface, a `bun build --compile` program, the stored-argv bridge, and skill texts. A second, separable slice set moves every dg config item into one `config.toml` in the dg config folder, with a `[plugins]` section, secrets kept in the credential store, and `dg config get/set/edit/path`.

## Scope
### Included
- Flat `dg <command>` for every dg-skills top-level command, plus agent `phone`, `overwatch`, `memory`, `mcp` and daemon `job`, `autostart`, `service`, derived from the three generated completion trees
- A collision rule: daemon lifecycle verbs (`serve`, `status`, `start`, `stop`, `restart`, `sessions`, `origin`) stay under `dg daemon`; agent session verbs (`start`, `send`, `recv`, `progress`, `spawn`, `stage`, `close`, `manifest`) stay under `dg agent`; a test fails on any new unowned collision
- `dg skills`, `dg agent` and `dg daemon` stay as group mounts, so every command keeps one full path
- One compiled `dg` program per platform with `bun build --compile --splitting --minify`; `dg-skills`, `dg-agent` and `dg-daemon` stay as links to it and dispatch on the invoked name
- Install, bootstrap.sh, bootstrap.ps1 and self-update install the compiled program under `<data>/bin/<version>/` with a `current` link, keep old version folders for rollback, and keep the runtime and bundle for the two-minor bridge
- Rewrite of stored argv that names `runtime/current/bun lib/current/dg.js` (autostart unit, phone listener unit, jobs) to the compiled form, with a backup
- Release builds eight compiled assets, keeps the `v<x>` tag, and keeps publishing `dg-lib-<v>.tar.gz` and `runtime.json` for two minor releases
- One new ADR that supersedes ADR 0020 and one new ADR for the config file, both written with `dg-skills adr new`, plus link lines on ADRs 0020, 0025, 0032 and 0049
- Skill texts move from `dg-skills <cmd>`, `dg-agent phone` and `dg-daemon job` to `dg <cmd>`, with a guard test
- One `config.toml` at `resolveDgPaths().configDir` (default `~/.config/dg/config.toml`, XDG_CONFIG_HOME respected, `<DG_HOME>/config/config.toml` when DG_HOME is set), a loader in pkg/common, migration with backup, precedence, validation messages with a next step, secret references, and a `[plugins]` section
- `dg config get/set/edit/path` registered in pkg/skills-cli, so the flat surface exposes it
### Excluded
- The chat-skills zip fix in release.yml (branch fix/release_chat_zip); no slice edits the `Package the chat skills` step or scripts/package-chat-skills.ts
- Channel review config: channel review leaves dg in a later major release
- The daemon jobs table and job sources (`state/daemon/config.json`, `data/jobs/sources.json`) stay daemon-owned state (pending RATIFY)
- The exec-allowlist file stays a separate 0600 security file (pending RATIFY)
- Removal of the old program names; that waits for a later major release
- Rewriting `dg-skills hooks run` lines already written into Claude settings files; the old names stay as links
- The browser extension and its `ext` artifact
