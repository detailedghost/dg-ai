---
feature: Overwatch board
feature_snake_case: overwatch_board
date: '2026-10-02'
version: '1.0'
status: draft
current_slice: 0
pr_strategy: single
bundle: /home/detailedghost/code/dg-ai/.agents/spec/003_overwatch_board
plan_path: /home/detailedghost/code/dg-ai/.agents/spec/003_overwatch_board/plan.md
slices:
  - id: 1
    name: overwatch-wire-types
    depends_on: []
    files:
      - pkg/common/src/chat-format.ts
      - pkg/common/src/cli-wire.ts
      - pkg/common/__tests__/*overwatch*
    agents:
      primary: js
      proxy: codex
      qa:
        - qa-code
  - id: 2
    name: daemon-board-store-and-routes
    depends_on:
      - 1
    files:
      - pkg/dg-daemon/src/store/*
      - pkg/dg-daemon/src/dispatch/*
      - pkg/dg-daemon/src/server/*
      - pkg/dg-daemon/__tests__/**/*overwatch*
    agents:
      primary: js
      proxy: codex
      qa:
        - qa-code
        - security
  - id: 3
    name: dg-agent-overwatch-commands
    depends_on:
      - 1
    files:
      - pkg/dg-agent/src/commands.ts
      - pkg/dg-agent/src/overwatch.ts
      - pkg/dg-agent/__tests__/overwatch.spec.ts
    agents:
      primary: js
      proxy: codex
      qa:
        - qa-code
  - id: 4
    name: extension-overwatch-page
    depends_on:
      - 1
      - 2
    files:
      - pkg/extension/entrypoints/overwatch/*
      - pkg/extension/lib/background/chat.ts
      - pkg/extension/lib/chat-messages.ts
      - pkg/extension/lib/features/overwatch*.ts
      - pkg/extension/__tests__/overwatch-page.spec.ts
    agents:
      primary: js
      proxy: codex
      qa:
        - qa-code
  - id: 5
    name: overwatch-skill-and-phone-snapshot
    depends_on:
      - 3
    files:
      - plugins/dg/skills/overwatch/SKILL.md
      - pkg/skills-cli/src/commands/overwatch-snapshot.ts
      - pkg/skills-cli/__tests__/*overwatch*
    agents:
      primary: js
      proxy: codex
      qa:
        - reviewer
---

## Slice Summaries
