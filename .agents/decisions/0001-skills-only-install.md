---
covers: ["pkg/skills-cli/src/install/skills-only.ts", "pkg/skills-cli/bootstrap.sh", "pkg/skills-cli/bootstrap.ps1", "pkg/common/src/skill-files.ts", "pkg/common/src/node/install-skills.ts", "plugins/dg/skills/README.md"]
---

[ADR 0001](../../docs/adr/0001-skills-only-install.md)

- Make a skills-only install a file copy: copy every immediate child of `plugins/dg/skills` that has `SKILL.md`, plus every regular file under it.
- Leave the skills root `README.md` out of the copy.
- Copy skills that declare `requires: [extension]` too.
- Choose paths with `filesToInstall` in `@dg/common`. Write them with `installSkillTree` in `@dg/common/node`.
- Write files with mode `0644`. Refuse symlinks. Never spawn skill content.
- Never call the GitHub releases API from the skills copy.
- Keep `bootstrap.sh` and `bootstrap.ps1` copy loops equal to the TypeScript copy; both must produce the same paths.
- Return from `--skills-only` and `DG_SKILLS_ONLY=1` before any release-asset download, except the `dg-skills` CLI.
- Use the destination `$DG_SKILLS_DEST`, then `$DG_HOME/skills`, then `~/.dg/skills`.
- Install the `dg-skills` CLI from the latest `skills-v*` release into `${DG_HOME:-~/.dg}/bin` with the SHA256SUMS check.
- Never fetch `dg-daemon`, `dg-agent` or the extension, and never run `dg-skills install`, in a skills-only install.
- Leave `~/.dg/bin` as it was except for the CLI, and leave the `cli-only` marker alone.
- Keep `--cli-only` as the install that hides `requires: [extension]` skills from the Codex copy.
- Update the end-to-end expected path list when a skill file is added or removed.
