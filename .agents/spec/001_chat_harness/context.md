---
feature: Chat Harness
feature_snake_case: chat_harness
date: '2026-08-18'
version: '1.0'
status: draft
current_slice: 0
pr_strategy: single
bundle: /home/detailedghost/code/dg/.agents/spec/001_chat_harness
plan_path: /home/detailedghost/code/dg/.agents/spec/001_chat_harness/plan.md
slices:
  - id: 1
    name: shared-contracts
    depends_on: []
    files:
      - pkg/common/src/chat-format.ts
      - pkg/common/src/assert.ts
      - pkg/common/src/proto-format.ts
      - pkg/common/src/node/**
      - pkg/common/src/index.ts
      - pkg/common/package.json
      - pkg/common/tsconfig.json
      - pkg/common/__tests__/chat-format.spec.ts
      - pkg/common/__tests__/node-paths.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 2
    name: dg-server-skeleton
    depends_on:
      - 1
    files:
      - pkg/dg-server/package.json
      - pkg/dg-server/tsconfig.json
      - pkg/dg-server/bunfig.toml
      - pkg/dg-server/src/index.ts
      - pkg/dg-server/src/server/**
      - pkg/dg-server/src/session/**
      - pkg/dg-server/src/utils/**
      - pkg/dg-server/scripts/**
      - pkg/dg-server/__tests__/server/**
      - pkg/dg-server/__tests__/session/**
      - pkg/dg-server/__tests__/utils/**
      - bun.lock
    agents:
      primary: js
      effort: xhigh
      qa:
        - security
        - qa-code
  - id: 3
    name: sqlite-store-and-encryption
    depends_on:
      - 1
      - 2
    files:
      - pkg/dg-server/src/store/**
      - pkg/dg-server/src/crypto/**
      - pkg/dg-server/__tests__/store/**
      - pkg/dg-server/__tests__/crypto/**
    agents:
      primary: js
      effort: xhigh
      qa:
        - security
        - dba
  - id: 4
    name: extension-marker-and-background
    depends_on:
      - 1
    files:
      - pkg/extension/utils/chat-marker.ts
      - pkg/extension/entrypoints/chat-marker-capture.content.ts
      - pkg/extension/lib/chat-messages.ts
      - pkg/extension/lib/background/chat.ts
      - pkg/extension/lib/background/index.ts
      - pkg/extension/lib/background/recording.ts
      - pkg/extension/entrypoints/background.ts
      - pkg/extension/wxt.config.ts
      - pkg/extension/__tests__/chat-marker.spec.ts
      - pkg/extension/__tests__/background-chat.spec.ts
    agents:
      primary: js
      qa:
        - security
        - qa-code
  - id: 5
    name: extension-chat-client
    depends_on:
      - 4
    files:
      - pkg/extension/lib/features/chat-client.ts
      - pkg/extension/lib/features/chat-sessions.ts
      - pkg/extension/lib/features/chat-transcript.ts
      - pkg/extension/__tests__/chat-client.spec.ts
      - pkg/extension/__tests__/chat-sessions.spec.ts
      - pkg/extension/__tests__/chat-transcript.spec.ts
    agents:
      primary: js
      qa:
        - security
        - qa-code
  - id: 6
    name: extension-chat-page
    depends_on:
      - 5
    files:
      - pkg/extension/entrypoints/chat/**
      - pkg/extension/lib/features/chat-node.ts
      - pkg/extension/__tests__/chat-node.spec.ts
      - pkg/extension/__tests__/chat-page.spec.ts
    agents:
      primary: js
      qa:
        - design
        - qa-code
    prototype:
      path: prototype/slice_6_index.html
      variant: A
  - id: 7
    name: agent-facing-cli
    depends_on:
      - 2
      - 3
    files:
      - pkg/dg-server/src/commands/**
      - pkg/dg-server/src/manifest/**
      - pkg/dg-server/__tests__/commands/**
    agents:
      primary: js
      qa:
        - qa-code
  - id: 8
    name: command-and-subagent-dispatch
    depends_on:
      - 5
      - 6
      - 7
    files:
      - pkg/dg-server/src/dispatch/**
      - pkg/extension/lib/features/chat-autocomplete.ts
      - pkg/dg-server/__tests__/dispatch/**
      - pkg/extension/__tests__/chat-autocomplete.spec.ts
    agents:
      primary: js
      effort: xhigh
      qa:
        - security
        - qa-code
  - id: 9
    name: asset-staging-and-serving
    depends_on:
      - 3
      - 6
    files:
      - pkg/dg-server/src/assets/**
      - pkg/extension/entrypoints/options/**
      - pkg/extension/lib/config.ts
      - pkg/dg-server/__tests__/assets/**
      - pkg/extension/__tests__/asset-settings.spec.ts
    agents:
      primary: js
      qa:
        - security
        - qa-code
  - id: 10
    name: distribution-skill-and-ci
    depends_on:
      - 1
      - 2
      - 3
      - 4
      - 5
      - 6
      - 7
      - 8
      - 9
      - 11
    files:
      - plugins/dg/skills/chat/**
      - plugins/dg/skills/README.md
      - .github/workflows/dg-server-blt.yml
      - .github/workflows/dg-server-release.yml
      - pkg/skills-cli/src/commands/install.ts
      - pkg/skills-cli/src/utils/lib.ts
      - pkg/skills-cli/bootstrap.sh
      - pkg/skills-cli/bootstrap.ps1
      - pkg/skills-test/**
      - README.md
      - docs/DEVELOPER.md
      - docs/AGENT-INSTALL.md
      - .agents/monolith.md
    agents:
      primary: devops
      proxy: codex
      proxy_skills:
        - polish
        - standard-test
      qa:
        - qa-devops
        - lore
  - id: 11
    name: extension-canvas-surface
    depends_on:
      - 6
    files:
      - pkg/extension/lib/features/chat-canvas.ts
      - pkg/extension/__tests__/chat-canvas.spec.ts
    agents:
      primary: js
      proxy: codex
      proxy_skills:
        - polish
        - standard-test
      qa:
        - design
        - qa-code
---

## === school pointers ===

- /home/detailedghost/code/dg/.agents/school/engineering.md
- /home/detailedghost/code/dg/.agents/school/quality.md

## Slice Summaries
