---
feature: "String id fixture"
status: draft
slices:
  - id: A
    name: "Alpha"
    depends_on: []
    files: ["src/a/**"]
    agents:
      primary: js
      confidence: high
  - id: A2
    name: "Alpha two"
    depends_on: []
    files: ["src/b/**"]
    agents:
      primary: js
      confidence: high
---

# String id fixture

## Engineering

### Slice A — Alpha
- [ ] Build alpha

### Slice A2 — Alpha two
- [ ] Build alpha two

## Testing

### Slice A — Alpha
- [ ] Test alpha
