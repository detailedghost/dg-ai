---
covers: ["pkg/skills-cli/src/pw/cli.ts", "pkg/skills-cli/src/pw/tab-verbs.ts", "pkg/common/src/node/install-skills.ts", "plugins/dg/skills/pw/**"]
---

[ADR 0050](../../docs/adr/0050-fold-browser-skill-into-pw.md)

- Expose `batch-open` and `launch` only as pw verbs (`dg-skills pw batch-open`, `dg-skills pw launch`). Add no top-level aliases.
- Route both verbs to `pw/tab-verbs.ts` in `pw/cli.ts` before the `--ext` relay branch. Reuse `runBatchOpen` and `runLaunch`.
- Refuse `pw launch` and `pw batch-open --ext` on a CLI-only install.
- Keep plain `batch-open` local by default and `launch` `--ext`-only.
- Keep tab-work detail in `plugins/dg/skills/pw/references/tabs.md`. Never add a browser skill.
- Keep `dg-skills install` top-level, and demo and rerun with `/dg:demo`.
- Prune a stale `browser` skill on a skills-only install when its SKILL.md matches a shipped dg copy.
- Keep the doctor ids `batch-open` and `launch`.
