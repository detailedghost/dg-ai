---
feature: "Demo local player: /dg:demo plays the tour in a Playwright-driven browser by default, --ext keeps the extension flow"
feature_snake_case: "demo_local_player"
date: "2026-10-29"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
bundle: "/home/detailedghost/code/dg/.agents/spec/015_demo_local_player"
plan_path: "/home/detailedghost/code/dg/.agents/spec/015_demo_local_player/plan.md"
slices:
  - id: 1
    name: "tour-ui-shared-package"
    depends_on: []
    files:
      - "pkg/tour-ui/**"
      - "pkg/extension/lib/features/demo-tour.ts"
      - "pkg/extension/lib/tour-host.ts"
      - "pkg/extension/lib/picker.ts"
      - "pkg/extension/lib/ui-helpers.ts"
      - "pkg/extension/lib/video-timing.ts"
      - "pkg/extension/lib/narration-progress.ts"
      - "pkg/extension/wxt.config.ts"
      - "pkg/extension/package.json"
      - "pkg/extension/__tests__/**"
      - "package.json"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 2
    name: "local-player"
    depends_on:
      - 1
    files:
      - "pkg/skills-cli/src/demo/cli.ts"
      - "pkg/skills-cli/src/demo/local.ts"
      - "pkg/skills-cli/src/demo/player-process.ts"
      - "pkg/skills-cli/src/demo/bridge.ts"
      - "pkg/skills-cli/src/demo/paths.ts"
      - "pkg/skills-cli/src/demo/result.ts"
      - "pkg/skills-cli/src/demo/verify-local.ts"
      - "pkg/skills-cli/src/demo/doctor.ts"
      - "pkg/skills-cli/src/demo/player-asset.ts"
      - "pkg/skills-cli/src/rerun/cli.ts"
      - "pkg/skills-cli/src/rerun/doctor.ts"
      - "pkg/skills-cli/src/utils/demo-verify.ts"
      - "pkg/skills-cli/src/utils/cdp-harness.ts"
      - "pkg/skills-cli/__tests__/demo-*.spec.ts"
      - "pkg/skills-cli/__tests__/rerun.spec.ts"
      - "pkg/skills-cli/build.ts"
      - "pkg/launcher/build.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
        - "dg:security"
  - id: 3
    name: "local-narration"
    depends_on:
      - 2
    files:
      - "pkg/tour-ui/src/narration/**"
      - "pkg/tour-ui/src/hosts/player-entry.ts"
      - "pkg/skills-cli/src/demo/narration.ts"
      - "pkg/skills-cli/src/demo/narration-assets.ts"
      - "pkg/skills-cli/src/demo/mux.ts"
      - "pkg/skills-cli/src/demo/bridge.ts"
      - "pkg/skills-cli/__tests__/demo-narration*.spec.ts"
      - ".github/workflows/release.yml"
      - "scripts/pack-narration-assets.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-perf"
        - "dg:qa-devops"
  - id: 4
    name: "demo-skill-docs-adr"
    depends_on:
      - 2
      - 3
    files:
      - "plugins/dg/skills/demo/SKILL.md"
      - "plugins/dg/skills/demo/references/extension.md"
      - "plugins/dg/skills/demo/references/authoring.md"
      - "plugins/dg/skills/README.md"
      - "pkg/skills-test/__tests__/demo-skill.spec.ts"
      - "pkg/skills-test/__tests__/ext-opt-in.spec.ts"
      - "pkg/common/__tests__/installed-skill-files.ts"
      - "docs/demo-and-proto.md"
      - "docs/AGENT-INSTALL.md"
      - "docs/install.md"
      - "docs/adr/0029-shared-tour-ui-and-local-player.md"
      - "docs/adr/toc.md"
    agents:
      primary: "dg:lore"
      qa:
        - "dg:qa-code"
---

## === school pointers ===

- /home/detailedghost/code/dg/.agents/school/security.md
- /home/detailedghost/code/dg/.agents/school/engineering.md
- /home/detailedghost/code/dg/.agents/school/quality.md

## Slice Summaries
