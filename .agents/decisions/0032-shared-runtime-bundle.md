---
covers: ["pkg/launcher/**", "pkg/common/src/node/program.ts", "pkg/skills-cli/src/install/**", "pkg/skills-cli/bootstrap.sh", ".github/workflows/release.yml", "scripts/bump-runtime.ts"]
---

[ADR 0032](../../docs/adr/0032-shared-runtime-bundle.md)

Superseded in part by [ADR 0055](0055-one-dg-program-with-flat-commands.md): the runtime and bundle stay only as the 6.3 bridge.

- Install one pinned Bun runtime under `<root>/runtime/bun-v<version>/` and one minified, code-split bundle under `<root>/lib/<version>/`. `<root>` comes from `resolveDgPaths`.
- Point `runtime/current` and `lib/current` at the active versions with symlinks (junctions on Windows). Replace them by create-then-rename.
- Write no `bin/dg-skills`, `bin/dg-agent` or `bin/dg-daemon` file. `bin/dg` runs the compiled program (ADR 0055).
- Make `pkg/launcher/src/dg.ts` import only the named program. Import each command's code inside its action so `--version` and `--help` load almost nothing.
- Start a sibling program with `programCommand()`. Name service units and detached listeners with `launcherCommand()`, which uses the stable `current` links.
- Never spawn a `.cmd` shim from in-tree code. Never use the user's own `bun` on PATH.
- Pin the Bun version and the sha256 of each platform zip in `pkg/launcher/runtime.json`. Ship `dg-lib-<v>.tar.gz` and `runtime.json` in the release, both listed in `SHA256SUMS`.
- Verify `runtime.json` against `SHA256SUMS`, the Bun zip against `runtime.json`, and run the staged bundle's `--version` before any link changes.
- Keep `--version` within the budget in `startup-budget.spec.ts`.
