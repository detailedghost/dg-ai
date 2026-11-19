---
feature: "Fold /dg:browser into /dg:pw"
feature_snake_case: "browser_into_pw"
date: "2026-11-19"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
execution:
  profile: "balance"
bundle: "/home/detailedghost/code/worktrees/dg-ai-browser-pw/.agents/spec/022_browser_into_pw"
plan_path: "/home/detailedghost/code/worktrees/dg-ai-browser-pw/.agents/spec/022_browser_into_pw/plan.md"
slices:
  - id: 1
    name: "pw-tab-verbs"
    depends_on: []
    files:
      - "pkg/skills-cli/src/pw/**"
      - "pkg/skills-cli/src/commands/batch-open.ts"
      - "pkg/skills-cli/src/commands/launch.ts"
      - "pkg/skills-cli/src/launch/cli.ts"
      - "pkg/skills-cli/src/utils/cli-only.ts"
      - "pkg/skills-cli/src/register-all.ts"
      - "pkg/skills-cli/src/completion/tree.json"
      - "pkg/skills-cli/__tests__/batch-open.spec.ts"
      - "pkg/skills-cli/__tests__/launch-ext.spec.ts"
      - "pkg/skills-cli/__tests__/lazy-commands.spec.ts"
      - "pkg/skills-cli/__tests__/cli-only.spec.ts"
      - "pkg/skills-cli/__tests__/ext-command-harness.ts"
      - "pkg/skills-cli/__tests__/doctor-command.spec.ts"
      - "pkg/skills-test/__tests__/cli-smoke.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 2
    name: "skills-docs-move"
    depends_on:
      - 1
    files:
      - "plugins/dg/skills/browser/**"
      - "plugins/dg/skills/pw/**"
      - "plugins/dg/skills/pushup/**"
      - "plugins/dg/skills/sdlc/**"
      - "plugins/dg/skills/spec/**"
      - "plugins/dg/skills/land/**"
      - "plugins/dg/skills/deps-upgrade/**"
      - "plugins/dg/skills/doctor/**"
      - "plugins/dg/skills/overwatch/**"
      - "plugins/dg/skills/channel-review/references/setup.md"
      - "plugins/dg/skills/proto/references/commands.md"
      - "plugins/dg/skills/inbox-cleanup/references/providers.md"
      - "plugins/dg/skills/README.md"
      - "README.md"
      - "docs/**"
      - "pkg/extension/README.md"
      - "pkg/skills-cli/src/utils/installed-skill-files.ts"
      - "pkg/skills-test/__tests__/**"
    agents:
      primary: "dg:lore"
      complexity: "medium"
      qa:
        - "dg:reviewer"
---

## Slice Summaries
