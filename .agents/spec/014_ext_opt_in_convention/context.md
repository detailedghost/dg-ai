---
feature: "Local mode by default, --ext opt-in for the dg-ai-extension across every dg skill"
feature_snake_case: "ext_opt_in_convention"
date: "2026-10-29"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
bundle: "/home/detailedghost/code/dg/.agents/spec/014_ext_opt_in_convention"
plan_path: "/home/detailedghost/code/dg/.agents/spec/014_ext_opt_in_convention/plan.md"
slices:
  - id: 1
    name: "ext-flag-and-guard"
    depends_on: []
    files:
      - "pkg/skills-cli/src/utils/ext-flag.ts"
      - "pkg/skills-cli/src/utils/cli-only.ts"
      - "pkg/skills-cli/src/commands/batch-open.ts"
      - "pkg/skills-cli/src/batch-open/doctor.ts"
      - "pkg/skills-cli/src/commands/launch.ts"
      - "pkg/skills-cli/src/commands/rerun.ts"
      - "pkg/skills-cli/src/commands/demo.ts"
      - "pkg/skills-cli/src/doctor/checks.ts"
      - "pkg/skills-cli/__tests__/ext-flag.spec.ts"
      - "pkg/skills-cli/__tests__/cli-only.spec.ts"
      - "pkg/skills-cli/__tests__/batch-open.spec.ts"
      - "pkg/skills-cli/__tests__/doctor-ext-only.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 2
    name: "skills-callers-lint-docs"
    depends_on:
      - 1
    files:
      - "plugins/dg/skills/browser/SKILL.md"
      - "plugins/dg/skills/browser/references/install.md"
      - "plugins/dg/skills/browser/references/extension.md"
      - "plugins/dg/skills/pushup/SKILL.md"
      - "plugins/dg/skills/deps-upgrade/references/steps.md"
      - "plugins/dg/skills/sdlc/references/finish.md"
      - "plugins/dg/skills/spec/references/execute.md"
      - "plugins/dg/skills/spec/SKILL.md"
      - "plugins/dg/skills/inbox-cleanup/SKILL.md"
      - "plugins/dg/skills/inbox-cleanup/references/providers.md"
      - "plugins/dg/skills/README.md"
      - "pkg/skills-test/__tests__/ext-opt-in.spec.ts"
      - "pkg/skills-test/__tests__/browser-skill.spec.ts"
      - "pkg/skills-cli/__tests__/cli-only.spec.ts"
      - "pkg/common/__tests__/installed-skill-files.ts"
      - "docs/install.md"
      - "docs/AGENT-INSTALL.md"
      - "docs/browser.md"
      - "docs/adr/0028-local-default-extension-opt-in.md"
      - "docs/adr/toc.md"
    agents:
      primary: "dg:lore"
      qa:
        - "dg:qa-code"
  - id: 3
    name: "proton-pw-profile"
    depends_on:
      - 1
      - 2
    files:
      - "pkg/inbox/src/protonmail/page-operations.ts"
      - "pkg/inbox/src/protonmail/pw-client.ts"
      - "pkg/inbox/src/protonmail/client.ts"
      - "pkg/inbox/src/runtime.ts"
      - "pkg/extension/lib/features/inbox-proton.ts"
      - "pkg/skills-cli/src/commands/inbox.ts"
      - "pkg/skills-cli/src/inbox/proton-pw.ts"
      - "pkg/skills-cli/src/inbox/doctor.ts"
      - "pkg/inbox/src/protonmail/__test__/page-operations.spec.ts"
      - "pkg/inbox/src/protonmail/__test__/pw-client.spec.ts"
      - "pkg/skills-cli/__tests__/inbox-proton-pw.spec.ts"
      - "plugins/dg/skills/inbox-cleanup/SKILL.md"
      - "plugins/dg/skills/inbox-cleanup/references/providers.md"
      - "docs/inbox-cleanup.md"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
        - "dg:security"
---

## === school pointers ===

- /home/detailedghost/code/dg/.agents/school/security.md
- /home/detailedghost/code/dg/.agents/school/engineering.md
- /home/detailedghost/code/dg/.agents/school/quality.md

## Slice Summaries
