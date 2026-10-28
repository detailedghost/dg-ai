---
feature: "Proxy pin fixture"
status: draft
slices:
  - id: 1
    name: "Pinned"
    depends_on: []
    files: ["src/a/**"]
    agents:
      primary: js
      proxy: codex
      effort: xhigh
      confidence: high
  - id: 2
    name: "Plain"
    depends_on: []
    files: ["src/b/**"]
    agents:
      primary: js
      proxy: codex
      confidence: high
---

# Proxy pin fixture

## Engineering

### Slice 1 — Pinned
- [ ] Build

### Slice 2 — Plain
- [ ] Build
