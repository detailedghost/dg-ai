---
feature: phone-friend Nostr chat
feature_snake_case: phone_friend_nostr_chat
date: '2026-10-19'
version: '1.0'
status: draft
current_slice: 0
pr_strategy: single
bundle: /home/detailedghost/code/worktrees/dg-ai-phone_friend/.agents/spec/005_phone_friend_nostr_chat
plan_path: /home/detailedghost/code/worktrees/dg-ai-phone_friend/.agents/spec/005_phone_friend_nostr_chat/plan.md
slices:
  - id: 1
    name: nostr-core
    depends_on: []
    files:
      - pkg/common/src/node/paths.ts
      - pkg/dg-agent/package.json
      - bun.lock
      - pkg/dg-agent/src/phone/chat.ts
      - pkg/dg-agent/src/phone/store.ts
      - pkg/dg-agent/__tests__/phone/chat.spec.ts
      - pkg/dg-agent/__tests__/phone/store.spec.ts
    agents:
      primary: js
      qa:
        - security
        - qa-code
  - id: 2
    name: phone-cli
    depends_on:
      - 1
    files:
      - pkg/dg-agent/src/phone/commands.ts
      - pkg/dg-agent/src/index.ts
      - pkg/dg-agent/__tests__/phone/commands.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 3
    name: phone-friend-skill
    depends_on:
      - 2
    files:
      - plugins/dg/skills/phone-friend/SKILL.md
      - plugins/dg/skills/README.md
      - .claude-plugin/plugin.json
      - plugins/dg/.codex-plugin/plugin.json
    agents:
      primary: lore
---

## Slice Summaries
