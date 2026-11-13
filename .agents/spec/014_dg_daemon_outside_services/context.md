---
feature: "dg-daemon outside services"
feature_snake_case: "dg_daemon_outside_services"
date: "2026-11-11"
version: "1.0"
status: "complete"
current_slice: 5
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

- Slice 1 (`6f81366b`): `service add`, `service rm`, `service status --json` and `job exec` work. `passEnv`, `stopTimeoutMs` and `grant` parse with the declared errors. `readConfigStrict` and `writeServiceEntry` write the services table. Open after 2 correction rounds: a table test for the no-daemon text of `service status|start|stop`, the `--cwd` error shows the raw argument, and one unreachable `Bun.which` fallback.
- Slice 3 (`ce66f126`): `dg-daemon start`, `stop` and `restart`, each with `--force` where the plan says, on a shared `ensureDaemonRunning` in `@dg/common/node`. The orchestrator fixed `restart` so it prints the real `started` state. The size-budget failure of the skills chunk is on master too; the user put it out of scope.
- Slice 2 (`1075b68f`): `passEnv` reaches the service with a warning for each absent name at every launch, a per-service stop timeout, the group-wide SIGKILL timer, the win32 tree kill with seams on `executeCommand`, and autostart after the pid file. The orchestrator fixed a race in the test 'warns again on each launch' (it now counts the `started` log lines). The MiniQA stage did not run for this slice; the final review covers it.
- Slice 4 (`306ac830`): `POST /service-api/v1/credentials` with grant headers and prefix-scoped get and list, the supervisor-injected `DG_*` keys and grant preflight, a 64 KiB body cap (413), and docs/service-api.md. Security review: the `Origin: null` gap stays (user choice, LOW; a grant token is still required).
- Slice 5 (`9a85c048`): ADR 0043 and the doc updates, with the decisions taken during the build. The orchestrator fixed a doc-spec bug (numeric separators in config.ts) and removed a stray `teams-bot` service entry that a verification run wrote into a test home outside the worktree. The private-name search of the diff found nothing. The MiniQA stage did not run for this slice; the final review covers it.
- Final review (`b9565300`, `60e0b587`, `a146ac63`): agent reviews (quality, security, CI and perf) and three Codex rounds. Fixes: force stop of a hung daemon only after a command-line check, status hides removed services, pid guard and instanceId check on `/services` (older daemons without it are accepted), Windows force stop ends only the daemon pid, a 3 s bound on the service list, and `service rm` refuses when the daemon does not answer. Draft PR #173.
