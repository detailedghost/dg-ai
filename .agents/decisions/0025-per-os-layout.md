---
covers: ["pkg/common/src/node/dg-paths.ts", "pkg/skills-cli/src/install/**", "pkg/dg-agent/src/phone/migrate.ts", "scripts/skill-bootstrap-block.ts", "docs/install.md"]
---

[ADR 0025](../../docs/adr/0025-per-os-layout.md)

- Resolve every dg root and file through `resolveDgPaths` in `pkg/common/src/node/dg-paths.ts`. Never build a dg path by hand.
- A set `DG_HOME` maps each role to `<DG_HOME>/<role>`. An empty `DG_HOME` counts as unset.
- Install writes `dg` to `~/.local/bin` on Linux and macOS, and `%LOCALAPPDATA%\dg\bin` on Windows.
- Install moves the old `~/.dg` into the new roots: copy, check, then remove (ADR 0036).
- `phone __refresh` checks the copied database and keys before it removes the old phone folder. `dg phone __rollback-home` rolls the move back.
- Skills call `dg` by name, with one generated first-run block that falls back to `${DG_HOME:-$HOME/.local}/bin/dg` (ADR 0055).
- Install removes the `~/.dg/bin/*` notice launchers (ADR 0055).
- The daemon keychain account is scoped by the state root. Copy the old entry, read it back, compare, and only then delete it. A failed step keeps the old entry and reads from it.
- Do not move the AI scratch and state roots in `scratch-paths.ts`.
- The staged extension folder and `ssms` use the new layout.
- When a user's allow rule names `~/.dg/bin/dg-skills`, `doctor` names the replacement rule.
