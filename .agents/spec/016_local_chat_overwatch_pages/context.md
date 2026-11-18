---
feature: "Local chat and overwatch pages served by dg-daemon, --ext for the extension pages"
feature_snake_case: "local_chat_overwatch_pages"
date: "2026-10-29"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
bundle: "/home/detailedghost/code/dg/.agents/spec/016_local_chat_overwatch_pages"
plan_path: "/home/detailedghost/code/dg/.agents/spec/016_local_chat_overwatch_pages/plan.md"
slices:
  - id: 1
    name: "daemon-local-pages"
    depends_on: []
    files:
      - "pkg/pages/**"
      - "pkg/dg-daemon/src/server/http.ts"
      - "pkg/dg-daemon/src/server/pages.ts"
      - "pkg/dg-daemon/src/server/origin.ts"
      - "pkg/dg-daemon/src/assets/**"
      - "pkg/dg-daemon/__tests__/local-pages.spec.ts"
      - "pkg/dg-daemon/__tests__/origin.spec.ts"
      - "pkg/extension/lib/features/overwatch.ts"
      - "pkg/extension/lib/features/chat-client.ts"
      - "pkg/extension/lib/features/chat-connection.ts"
      - "pkg/extension/entrypoints/chat/main.ts"
      - "pkg/extension/entrypoints/overwatch/main.ts"
      - "pkg/extension/wxt.config.ts"
      - "pkg/extension/package.json"
      - "pkg/extension/__tests__/chat-*.spec.ts"
      - "pkg/extension/__tests__/overwatch-page.spec.ts"
      - "pkg/launcher/build.ts"
      - "package.json"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
        - "dg:security"
  - id: 2
    name: "agent-open-skills-docs"
    depends_on:
      - 1
    files:
      - "pkg/dg-agent/src/start.ts"
      - "pkg/dg-agent/src/index.ts"
      - "pkg/dg-agent/src/overwatch.ts"
      - "pkg/dg-agent/__tests__/start-open.spec.ts"
      - "pkg/dg-agent/__tests__/overwatch-open.spec.ts"
      - "pkg/skills-cli/src/require-extension/doctor.ts"
      - "pkg/skills-cli/__tests__/cli-only.spec.ts"
      - "plugins/dg/skills/chat/SKILL.md"
      - "plugins/dg/skills/chat/references/extension.md"
      - "plugins/dg/skills/overwatch/SKILL.md"
      - "plugins/dg/skills/overwatch/references/extension.md"
      - "plugins/dg/skills/inbox-cleanup/references/providers.md"
      - "plugins/dg/skills/README.md"
      - "pkg/skills-test/__tests__/ext-opt-in.spec.ts"
      - "pkg/skills-test/__tests__/chat-skill.spec.ts"
      - "pkg/skills-test/__tests__/overwatch-skill.spec.ts"
      - "pkg/common/__tests__/installed-skill-files.ts"
      - "docs/install.md"
      - "docs/AGENT-INSTALL.md"
      - "docs/chat.md"
      - "docs/adr/0030-loopback-pages-for-chat-and-overwatch.md"
      - "docs/adr/toc.md"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
        - "dg:lore"
---

## === school pointers ===

- /home/detailedghost/code/dg/.agents/school/security.md
- /home/detailedghost/code/dg/.agents/school/engineering.md
- /home/detailedghost/code/dg/.agents/school/quality.md

## Slice Summaries
