---
feature: phone-friend v2
feature_snake_case: phone_friend_v2
date: '2026-10-19'
version: '1.0'
status: draft
current_slice: 0
pr_strategy: single
bundle: /home/detailedghost/code/worktrees/dg-ai-phone_friend/.agents/spec/006_phone_friend_v2
plan_path: /home/detailedghost/code/worktrees/dg-ai-phone_friend/.agents/spec/006_phone_friend_v2/plan.md
slices:
  - id: 1
    name: rename-and-verbs
    depends_on: []
    files:
      - pkg/dg-agent/src/phone-friend/**
      - pkg/dg-agent/__tests__/phone-friend/**
      - pkg/dg-agent/src/index.ts
      - pkg/common/src/node/paths.ts
      - pkg/common/__tests__/node-paths.spec.ts
    agents:
      primary: js
  - id: 2
    name: invite-and-dial
    depends_on:
      - 1
    files:
      - pkg/dg-agent/src/phone-friend/card.ts
      - pkg/dg-agent/src/phone-friend/chat.ts
      - pkg/dg-agent/src/phone-friend/store.ts
      - pkg/dg-agent/src/phone-friend/commands.ts
      - pkg/dg-agent/__tests__/phone-friend/card.spec.ts
      - pkg/dg-agent/__tests__/phone-friend/chat.spec.ts
      - pkg/dg-agent/__tests__/phone-friend/commands.spec.ts
    agents:
      primary: js
      qa:
        - security
        - qa-code
  - id: 3
    name: credential-store-key
    depends_on:
      - 2
    files:
      - pkg/dg-agent/src/phone-friend/keys.ts
      - pkg/dg-agent/src/phone-friend/commands.ts
      - pkg/dg-agent/src/phone-friend/store.ts
      - pkg/dg-agent/__tests__/phone-friend/keys.spec.ts
      - pkg/dg-agent/__tests__/phone-friend/commands.spec.ts
      - pkg/dg-agent/__tests__/phone-friend/store.spec.ts
    agents:
      primary: js
      qa:
        - security
  - id: 4
    name: skill-and-docs
    depends_on:
      - 3
    files:
      - plugins/dg/skills/phone-friend/SKILL.md
      - docs/phone-friend.md
      - pkg/skills-test/__tests__/phone-friend-skill.spec.ts
    agents:
      primary: lore
---

## Slice Summaries
