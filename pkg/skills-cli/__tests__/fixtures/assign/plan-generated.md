---
feature: "Generated fixture"
feature_snake_case: generated_fixture
status: draft
slices:
  - id: 1
    name: "One"
    depends_on: []
    files: ["schema/*.json"]
    agents: {primary: dg:js}
  - id: 2
    name: "Two"
    depends_on: []
    files: ["src/two/**"]
    agents: {primary: dg:js}
serializing:
  - writes: "gen/out/*.ts"
    when: ["schema/*.json"]
---

# Generated fixture

## Slices

### Slice 1 — S1

#### Engineering
- [ ] DIRECTIVE-1 build it

#### Testing Criteria
- [ ] CRITERIA-1 holds

### Slice 2 — S2

#### Engineering
- [ ] DIRECTIVE-2 build it

#### Testing Criteria
- [ ] CRITERIA-2 holds
