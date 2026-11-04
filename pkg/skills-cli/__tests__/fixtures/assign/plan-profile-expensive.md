---
feature: "Expensive fixture"
status: draft
execution:
  profile: expensive
slices:
  - id: 1
    name: "Low"
    depends_on: []
    files: ["src/s1/**"]
    agents:
      primary: dg:js
      complexity: low
      qa: [dg:qa-code, security]
  - id: 2
    name: "Medium"
    depends_on: []
    files: ["src/s2/**"]
    agents:
      primary: dg:js
      complexity: medium
  - id: 3
    name: "High"
    depends_on: []
    files: ["src/s3/**"]
    agents:
      primary: dg:js
      complexity: high
  - id: 4
    name: "Migration"
    depends_on: []
    files: ["src/s4/**"]
    agents:
      primary: dba
      complexity: high
---

# Expensive fixture

## Engineering

### Slice 1 — Low
- [ ] Build

### Slice 2 — Medium
- [ ] Build

### Slice 3 — High
- [ ] Build

### Slice 4 — Migration
- [ ] Build
