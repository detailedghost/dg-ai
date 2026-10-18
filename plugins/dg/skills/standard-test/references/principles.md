# Test-Writing Principles

Language- and framework-agnostic. For *why* each principle exists, see [principles-rationale.md](principles-rationale.md) (human ref, not loaded). For concrete bad/good examples, see the language-specific examples files.

## 0. Code Economy

Before writing any test or test helper, run this checklist top-to-bottom:

1. **Does this need to exist?** — YAGNI; if not, skip it.
2. **Already in this codebase?** — reuse it, don't rewrite.
3. **Standard library / stdlib / framework / language has this feature?** — use it.
4. **Native platform feature?** — use it.
5. **Installed dependency does it?** — use it.
6. **One line?** — one line.
7. **Only then** — write the minimum that works.

---

## TL;DR

1. **Exercise the real module** — import/call the production code under test; never re-implement its logic inside the test.
2. **Every test must be able to fail** — no placeholder or tautological assertions, no empty bodies.
3. **Use builders/factories** — no longhand fixture duplication; use property/fuzz generators to explore edges.
4. **Test through the public interface** — observe outcomes across the seam; don't reach into private state.
5. **Share setup** — extract repeated wrappers, fixtures, and stubs into a shared test-utility module.
6. **Derive expected values** — compute the expectation from the same transform production uses; don't hardcode a literal that duplicates it.
7. **Never commit `green_`/`red_` file or class name markers** — strip them before any commit reaches a PR. Flip red tests to green (fix the code) or delete them.
8. **Name tests after the code under test** — files and suites mirror the module/function/behavior they exercise, not a plan artifact.

---

## 1. Exercise real production code

Import and call the actual module under test. A test that re-implements the same logic it's testing drifts from the original — assertions then pass even when production breaks.

---

## 2. No unconditional or placeholder assertions

A test that cannot fail catches nothing. An empty body is worse than no test — it reads as coverage. Every assertion must be falsifiable by a production bug.

---

## 3. Builders/factories and generators

Extract repeated harnesses, provider trees, network stubs, and entity factories into a shared test-utility module co-located with tests.

---

## 4. Test through the module's interface, not its internals

Observe the outcome through the public seam.

---

## 5. Share setup; don't copy-paste it

Extract repeated setup into shared fixtures, helpers, or `conftest`/`IClassFixture` patterns.

---

## 6. Assert on derived values, not duplicated production formatting

Hardcoding the formatter's output in the test silently duplicates it. When the formatter changes, the test fails for the wrong reason — or still passes while production is broken. Compute the expected value from the same transform production uses, or assert round-trip equivalence.

When the expected value comes from a pure helper that has its own unit tests, asserting `received == expected` via that helper is fine. The trap is only when the literal *is* the format and lives solely in the test.

---

## 7. Never commit `green_`/`red_` file or class name markers

`green_` and `red_` are TDD waypoint labels. Strip them before any commit reaches a PR:

- **`green_` prefix** has no meaning in a committed test file — all committed tests must pass by definition. A file named `green_Foo` is redundant at best, misleading when it contains failing tests.
- **`red_` prefix** means a test is currently failing. Failing tests must not be committed — flip them to green (fix the code) or delete them.
- Do **not** build runner ignore/quarantine config to exclude red tests from CI.
- For a genuine won't-fix limitation, encode it as a normal passing test with an inverted assertion (assert it throws / is rejected because the case is deliberately unsupported).

A PR must never contain a failing or CI-excluded test.

---

## 8. Name tests after the code under test, not the plan

Tests outlive the plan that produced them. Mirror the production module, function, or behavior in both the filename and the suite/`describe` label. A reader should locate the test from the code (and vice-versa) without consulting any plan document.

No ticket numbers, sprint names, or "slice N" in filenames or suite names.
