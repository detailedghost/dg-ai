---
feature: "Nested fixture"
feature_snake_case: nested_fixture
status: draft
slices:
  - id: 1
    name: "One"
    depends_on: []
    files: ["src/one/**"]
    agents: {primary: dg:js}
  - id: 2
    name: "Two"
    depends_on: []
    files: ["src/two/**"]
    agents: {primary: dg:js}
  - id: 3
    name: "Three"
    depends_on: []
    files: ["src/three/**"]
    agents: {primary: dg:js}
---

# Nested fixture

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

### Slice 3 — S3

#### Engineering
- [ ] DIRECTIVE-3 build it

#### Testing Criteria
- [ ] CRITERIA-3 holds

## Slice Summaries

SUMMARY-TAIL

## Agent Notes

NOTES-TAIL
