---
feature: Scheduled jobs and job dashboard
feature_snake_case: job_dashboard
date: '2026-09-03'
version: '1.0'
status: draft
current_slice: 0
pr_strategy: single
bundle: /home/detailedghost/code/dg/.agents/spec/002_job_dashboard
plan_path: /home/detailedghost/code/dg/.agents/spec/002_job_dashboard/plan.md
slices:
  - id: 1
    name: job-store
    depends_on: []
    files:
      - pkg/dg-daemon/src/store/**
      - pkg/dg-daemon/__tests__/store/**
    agents:
      primary: dba
      qa:
        - qa-code
        - security
  - id: 2
    name: job-runner
    depends_on:
      - 1
    files:
      - pkg/dg-daemon/src/jobs/**
      - pkg/dg-daemon/src/server/bootstrap.ts
      - pkg/dg-daemon/__tests__/jobs/**
    agents:
      primary: js
      qa:
        - qa-code
  - id: 3
    name: job-http
    depends_on:
      - 1
      - 2
    files:
      - pkg/dg-daemon/src/server/http.ts
      - pkg/common/src/chat-format.ts
      - pkg/dg-daemon/__tests__/server/jobs-http.spec.ts
      - pkg/common/__tests__/chat-format.spec.ts
    agents:
      primary: js
      effort: xhigh
      qa:
        - security
        - qa-code
  - id: 4
    name: job-cli
    depends_on:
      - 1
      - 2
    files:
      - pkg/dg-daemon/src/index.ts
      - pkg/dg-daemon/src/commands/**
      - pkg/dg-daemon/__tests__/commands/**
    agents:
      primary: js
      qa:
        - qa-code
  - id: 5
    name: dashboard-page
    depends_on:
      - 3
    files:
      - pkg/extension/entrypoints/dashboard/**
      - pkg/extension/lib/features/dashboard.ts
      - pkg/extension/wxt.config.ts
      - pkg/extension/__tests__/dashboard.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
---

## === school pointers ===

- /home/detailedghost/code/dg/.agents/school/security.md
- /home/detailedghost/code/dg/.agents/school/engineering.md
- /home/detailedghost/code/dg/.agents/school/quality.md

## Slice Summaries
