---
covers: ["pkg/dg/src/**","pkg/launcher/**","pkg/common/src/node/program.ts","pkg/skills-cli/src/install/**","pkg/skills-cli/bootstrap.sh","pkg/skills-cli/bootstrap.ps1",".github/workflows/release.yml"]
---

[ADR 0055](../../docs/adr/0055-one-dg-program-with-flat-commands.md)

- Ship one compiled `dg` per platform. Write no `dg-skills`, `dg-agent` or `dg-daemon` file, and remove the old launchers on install.
- Derive flat routes from the three completion trees in `pkg/dg/src/flat.ts`. Add a name to `OWNERS` or `GROUPED` only for a collision.
- Keep daemon lifecycle verbs under `dg daemon` and agent session verbs under `dg agent`.
- Build or rewrite stored argv only through `launcherCommand` and `rewriteLauncherArgv` in `pkg/common/src/node/program.ts`.
- Keep the `<program> ...args` dispatch form only for the bundle bridge, with a notice.
- Keep `dg-lib-<v>.tar.gz` and `runtime.json` in the release until the bridge ends; a 6.3 self-update needs both.
- Write `dg <command>` in skill texts, docs and messages, never an old program name.
