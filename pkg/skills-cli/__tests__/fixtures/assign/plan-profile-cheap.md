---
feature: "Cheap fixture"
status: draft
execution:
  profile: cheap
slices:
  - id: 1
    name: "Plain"
    depends_on: []
    files: ["src/s1/**"]
    agents:
      primary: dg:js
      qa: [dg:qa-code, dba, security]
  - id: 2
    name: "Migration"
    depends_on: []
    files: ["src/s2/**"]
    agents:
      primary: dba
  - id: 3
    name: "Pinned effort"
    depends_on: []
    files: ["src/s3/**"]
    agents:
      primary: dg:js
      effort: medium
  - id: 4
    name: "Pinned opus"
    depends_on: []
    files: ["src/s4/**"]
    agents:
      primary: dg:js
      model: opus
  - id: 5
    name: "Pinned haiku"
    depends_on: []
    files: ["src/s5/**"]
    agents:
      primary: dg:js
      model: haiku
  - id: 6
    name: "Security only"
    depends_on: []
    files: ["src/s6/**"]
    agents:
      primary: dg:js
      qa: [dg:security]
---

# Cheap fixture

## Engineering

### Slice 1 — Plain
- [ ] Build

### Slice 2 — Migration
- [ ] Build

### Slice 3 — Pinned effort
- [ ] Build

### Slice 4 — Pinned opus
- [ ] Build

### Slice 5 — Pinned haiku
- [ ] Build

### Slice 6 — Security only
- [ ] Build
