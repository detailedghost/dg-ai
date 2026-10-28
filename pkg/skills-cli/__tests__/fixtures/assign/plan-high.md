---
feature: "Tier fixture"
feature_snake_case: tier_fixture
status: draft
slices:
  - id: 1
    name: "Parser"
    depends_on: []
    files: ["src/parser/**"]
    agents:
      primary: dg:js
      qa: [dg:qa-code]
      confidence: high
  - id: 2
    name: "Migration"
    depends_on: []
    files: ["src/db/**"]
    agents:
      primary: dba
      effort: xhigh
      qa: [security]
      confidence: high
  - id: 3
    name: "Report"
    depends_on: [1, 2]
    files: ["src/report/**"]
    agents:
      primary: python
      proxy: codex
      proxy_skills: [polish]
      confidence: high
---

# Tier fixture

## Engineering

### Slice 1 — Parser
- [ ] Parse input

### Slice 2 — Migration
- [ ] Add table

### Slice 3 — Report
- [ ] Render report

## Testing

### Slice 1 — Parser
- [ ] Parser round-trips

### Slice 2 — Migration
- [ ] Table exists

### Slice 3 — Report
- [ ] Report renders
