# Pull Request

## Summary

<!-- What changed and why. Link the spec/issue. -->

## Testing

<!-- How you verified. -->

### Test standard checklist

See `docs/contributing.md`.

- [ ] Tests import real production code — no re-implemented / shadowed logic
- [ ] No placeholder or always-true assertions, no empty test bodies
- [ ] Builders/factories used instead of longhand duplicated fixtures
- [ ] Known bugs captured as `*.red.*` (CI-quarantined), not green tests
- [ ] Test files/suites named after the code under test, not the plan
