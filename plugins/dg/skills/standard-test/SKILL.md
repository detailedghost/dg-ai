---
name: standard-test
description: Portable, language-agnostic test-writing standard — apply when writing or reviewing tests in any language, when a test re-implements production logic, or when you see an always-passing assertion.
---

# Test-Writing Standard

Apply whenever writing new tests, reviewing existing tests, or diagnosing why tests pass but bugs still ship. Language- and framework-agnostic.

**Trigger signals:** authoring or reviewing a test file; spotting an always-true assertion, an empty test body, a logic block inside a test that mirrors production code, or copy-pasted fixtures.

## References (lazy-load)

| File | When to read |
|------|-------------|
| [references/principles.md](references/principles.md) | Always — authoritative rule set with TL;DR and principle bodies. |
| [references/examples-js.md](references/examples-js.md) | When writing JavaScript or TypeScript tests. |
| [references/examples-python.md](references/examples-python.md) | When writing Python tests. |
| [references/examples-csharp.md](references/examples-csharp.md) | When writing C# tests. |
| [references/examples-shell.md](references/examples-shell.md) | When writing shell or POSIX tests. |
| [references/examples-generic.md](references/examples-generic.md) | When writing tests and no language-specific file matches. |
| [references/principles-rationale.md](references/principles-rationale.md) | Never loaded — human documentation only. |
