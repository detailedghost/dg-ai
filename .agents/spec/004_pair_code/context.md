---
feature: Pair code and release pipeline fix
feature_snake_case: pair_code
date: '2026-10-02'
version: '1.0'
status: draft
current_slice: 0
pr_strategy: single
bundle: /home/detailedghost/code/worktrees/dg-ai-pair_code/.agents/spec/004_pair_code
plan_path: /home/detailedghost/code/worktrees/dg-ai-pair_code/.agents/spec/004_pair_code/plan.md
slices:
  - id: 1
    name: daemon-pair-code
    depends_on: []
    files:
      - pkg/dg-daemon/src/**
      - pkg/dg-daemon/__tests__/**
      - pkg/common/src/**
      - pkg/common/__tests__/**
    agents:
      primary: js
      proxy: codex
      qa:
        - qa-code
        - security
  - id: 2
    name: extension-pair-ui
    depends_on:
      - 1
    files:
      - pkg/extension/**
    agents:
      primary: js
      proxy: codex
      qa:
        - qa-code
  - id: 3
    name: release-pipeline-fix
    depends_on: []
    files:
      - .github/workflows/**
      - pkg/*/package.json
      - plugins/dg/**
    agents:
      primary: devops
      proxy: codex
      qa:
        - qa-devops
---

## Slice Summaries
