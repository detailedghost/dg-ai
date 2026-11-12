---
feature: "dg-daemon outside services"
feature_snake_case: "dg_daemon_outside_services"
date: "2026-11-11"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
execution:
  profile: "balance"
bundle: "/home/detailedghost/code/dg/.agents/spec/014_dg_daemon_outside_services"
plan_path: "/home/detailedghost/code/dg/.agents/spec/014_dg_daemon_outside_services/plan.md"
slices:
  - id: 1
    name: "service-decl-and-cli"
    depends_on: []
    files:
      - "pkg/dg-daemon/src/services/config.ts"
      - "pkg/dg-daemon/src/services/env-file.ts"
      - "pkg/dg-daemon/src/server/config-store.ts"
      - "pkg/dg-daemon/src/commands/service.ts"
      - "pkg/dg-daemon/src/commands/jobs.ts"
      - "pkg/common/src/chat-format.ts"
      - "pkg/dg-daemon/__tests__/services/config.spec.ts"
      - "pkg/dg-daemon/__tests__/server/config-store.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/service.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/jobs.spec.ts"
      - "pkg/common/__tests__/chat-format.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 2
    name: "supervisor-env-and-stop"
    depends_on:
      - 1
    files:
      - "pkg/dg-daemon/src/services/supervisor.ts"
      - "pkg/dg-daemon/src/dispatch/exec.ts"
      - "pkg/dg-daemon/src/server/bootstrap.ts"
      - "pkg/dg-daemon/__tests__/services/supervisor.spec.ts"
      - "pkg/dg-daemon/__tests__/dispatch/exec.spec.ts"
      - "pkg/dg-daemon/__tests__/server/service-autostart.spec.ts"
      - "pkg/dg-daemon/__tests__/server/service-shutdown.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:qa-code"
  - id: 3
    name: "daemon-start-stop"
    depends_on: []
    files:
      - "pkg/common/src/node/daemon-start.ts"
      - "pkg/common/src/node/index.ts"
      - "pkg/common/__tests__/node-daemon-start.spec.ts"
      - "pkg/dg-agent/src/start.ts"
      - "pkg/dg-agent/__tests__/start.spec.ts"
      - "pkg/dg-agent/__tests__/start-open.spec.ts"
      - "pkg/dg-agent/__tests__/start-program-command.spec.ts"
      - "pkg/dg-daemon/src/main.ts"
      - "pkg/dg-daemon/src/commands/start.ts"
      - "pkg/dg-daemon/src/commands/stop.ts"
      - "pkg/dg-daemon/__tests__/commands/start.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/stop.spec.ts"
      - "pkg/dg-daemon/__tests__/main.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:qa-code"
  - id: 4
    name: "service-api-v1"
    depends_on:
      - 2
    files:
      - "pkg/common/src/chat-format.ts"
      - "pkg/dg-daemon/src/server/service-api.ts"
      - "pkg/dg-daemon/src/server/http.ts"
      - "pkg/dg-daemon/src/server/credentials.ts"
      - "pkg/dg-daemon/src/server/bootstrap.ts"
      - "pkg/dg-daemon/src/services/supervisor.ts"
      - "pkg/dg-daemon/__tests__/server/service-api.spec.ts"
      - "pkg/dg-daemon/__tests__/server/credentials-frame.spec.ts"
      - "pkg/dg-daemon/__tests__/services/supervisor.spec.ts"
      - "pkg/dg-daemon/__tests__/services/outside-service.spec.ts"
      - "pkg/dg-daemon/__tests__/fixtures/outside-service.ts"
      - "pkg/dg-daemon/__tests__/utils/daemon-harness.ts"
      - "docs/service-api.md"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:security"
        - "dg:qa-code"
  - id: 5
    name: "docs-and-adr"
    depends_on:
      - 1
      - 2
      - 3
      - 4
    files:
      - "docs/adr/0043-outside-services.md"
      - "docs/adr/toc.md"
      - "docs/jobs-and-services.md"
      - "docs/DEVELOPER.md"
      - "SECURITY.md"
      - "README.md"
      - "docs/AGENT-INSTALL.md"
      - "plugins/dg/skills/jobs/SKILL.md"
    agents:
      primary: "dg:lore"
      complexity: "low"
---

## === school pointers ===

- /home/detailedghost/code/dg/.agents/school/security.md
- /home/detailedghost/code/dg/.agents/school/engineering.md
- /home/detailedghost/code/dg/.agents/school/quality.md

## Slice Summaries
