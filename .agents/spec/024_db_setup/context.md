---
feature: "Guided database connection setup"
feature_snake_case: "db_setup"
date: "2026-11-20"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
bundle: "/home/detailedghost/code/worktrees/dg-ai-spec-024/.agents/spec/024_db_setup"
plan_path: "/home/detailedghost/code/worktrees/dg-ai-spec-024/.agents/spec/024_db_setup/plan.md"
slices:
  - id: 1
    name: "session-hint-doctor"
    depends_on: []
    files:
      - "pkg/common/src/node/session-tokens.ts"
      - "pkg/common/__tests__/session-tokens.spec.ts"
      - "pkg/skills-cli/src/doctor/checks.ts"
      - "pkg/skills-cli/src/credentials/doctor.ts"
      - "pkg/skills-cli/src/db/doctor.ts"
      - "pkg/skills-cli/__tests__/doctor-hints.spec.ts"
      - "pkg/skills-cli/__tests__/doctor-session.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 2
    name: "update-launcher-layout"
    depends_on: []
    files:
      - "pkg/skills-cli/src/update/run.ts"
      - "pkg/skills-cli/src/install/cli.ts"
      - "pkg/skills-cli/src/install/doctor.ts"
      - "pkg/skills-cli/__tests__/update.spec.ts"
      - "pkg/skills-cli/__tests__/install-bundle.spec.ts"
      - "pkg/skills-cli/__tests__/doctor-dg-launcher.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-devops"
  - id: 3
    name: "db-setup-core"
    depends_on:
      - 1
    files:
      - "pkg/skills-cli/src/db/setup.ts"
      - "pkg/skills-cli/src/db/session.ts"
      - "pkg/skills-cli/src/db/index.ts"
      - "pkg/skills-cli/src/db/credentials.ts"
      - "pkg/skills-cli/src/db/engines/postgresql.ts"
      - "pkg/skills-cli/__tests__/db-setup.spec.ts"
      - "pkg/skills-cli/__tests__/db-command.spec.ts"
      - "pkg/skills-cli/__tests__/db-credentials.spec.ts"
      - "pkg/skills-cli/__tests__/db-engines.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
        - "dg:security"
  - id: 4
    name: "db-aws-secret-ref"
    depends_on:
      - 3
    files:
      - "pkg/skills-cli/src/db/aws-secret.ts"
      - "pkg/skills-cli/src/db/credentials.ts"
      - "pkg/skills-cli/src/db/index.ts"
      - "pkg/skills-cli/__tests__/db-aws-secret.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:security"
  - id: 5
    name: "db-secret-form"
    depends_on:
      - 3
    files:
      - "pkg/common/src/cli-wire.ts"
      - "pkg/common/src/credentials-format.ts"
      - "pkg/common/src/node/credentials-client.ts"
      - "pkg/common/__tests__/credentials-client.spec.ts"
      - "pkg/dg-daemon/src/server/page-codes.ts"
      - "pkg/dg-daemon/src/server/secret-intake.ts"
      - "pkg/dg-daemon/src/server/credentials.ts"
      - "pkg/dg-daemon/src/server/http.ts"
      - "pkg/dg-daemon/src/server/pages.ts"
      - "pkg/dg-daemon/__tests__/server/secret-intake.spec.ts"
      - "pkg/dg-daemon/__tests__/server/page-codes.spec.ts"
      - "pkg/pages/build.ts"
      - "pkg/pages/src/secret/**"
      - "pkg/pages/__tests__/secret-page.spec.ts"
      - "pkg/skills-cli/src/db/setup-form.ts"
      - "pkg/skills-cli/src/db/setup.ts"
      - "pkg/skills-cli/__tests__/db-setup-form.spec.ts"
    agents:
      primary: "dg:js"
      effort: "xhigh"
      qa:
        - "dg:security"
        - "dg:qa-code"
  - id: 6
    name: "db-skill-setup-flow"
    depends_on:
      - 3
      - 4
      - 5
    files:
      - "plugins/dg/skills/db/**"
      - "plugins/dg/skills/doctor/**"
      - "pkg/skills-test/__tests__/db-skill-setup.spec.ts"
    agents:
      primary: "dg:lore"
      qa:
        - "dg:reviewer"
---

## === school pointers ===

- /home/detailedghost/code/worktrees/dg-ai-spec-024/.agents/school/security.md
- /home/detailedghost/code/worktrees/dg-ai-spec-024/.agents/school/engineering.md
- /home/detailedghost/code/worktrees/dg-ai-spec-024/.agents/school/quality.md
- /home/detailedghost/code/worktrees/dg-ai-spec-024/.agents/school/tooling.md

## Slice Summaries
