---
covers: ["pkg/skills-cli/src/utils/ext-flag.ts", "pkg/skills-test/__tests__/ext-opt-in.spec.ts", "plugins/dg/skills/proto/SKILL.md"]
---

[ADR 0028](../../docs/adr/0028-local-default-extension-opt-in.md)

- Every dg skill runs locally unless the caller passes `--ext`. `--ext` is the only switch.
- Add the flag to a command with the helper in `pkg/skills-cli/src/utils/ext-flag.ts`.
- The CLI guard and `dg-skills doctor` follow the flag. A command needs the extension only when `--ext` is present or the command is `--ext`-only, such as `launch`.
- Read parsed options for `--ext`. Do not scan `process.argv`.
- No `SKILL.md` outside `PENDING_LOCAL_MODE` declares `requires: [extension]`.
- Every line outside `PENDING_LOCAL_MODE` that runs `dg-skills require-extension` also carries `--ext`.
- `browser`, `proto`, and every skill whose references pass `batch-open --ext` (`pushup`, `deps-upgrade`) list `--ext` in their Flags table with the default `off (local is the default)`.
- `demo`, `chat` and `overwatch` join that rule when they leave `PENDING_LOCAL_MODE`. Remove a skill's name from the list when its local mode lands.
- `batch-open` without `--ext` opens plain tabs and never fails for a missing extension.
- The extension never writes a marker without `--ext`.
