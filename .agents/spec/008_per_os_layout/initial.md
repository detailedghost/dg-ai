# Per-OS directory layout — Initial Notes

## Purpose
Move every dg path to the standard per-OS layout: XDG on Linux, Library folders on macOS, APPDATA and LOCALAPPDATA on Windows, with one shared path helper in pkg/common that every package uses and that DG_HOME still overrides as a whole. Skills call the bare `dg-skills` launcher with a uniform fallback, phone keys and the phone database move with a verify step, and the old ~/.dg launcher paths keep working for two minor releases.

## Scope
### Included
- pkg/common/src/node/dg-paths.ts replaces paths.ts and the home logic in install-skills.ts
- Launchers in the per-OS bin dir; runtime, bundles and the downloaded browser in the data dir; config in the config dir; phone and daemon state in the state dir; caches in the cache dir
- Migration of ~/.dg contents on the first install after this release, with verify and kept-until-verified copies for phone keys and phone.db
- Compatibility launchers at ~/.dg/bin/* for two minor releases with a one-line stderr notice
- Bare `dg-skills` bootstrap block in every SKILL.md, generated and linted
- ADR 0025 and docs
### Excluded
- Moving scratch and state roots managed by scratch-paths.ts (already XDG aware)
- Changing the chat daemon database schema or the credential store format
- New commands
