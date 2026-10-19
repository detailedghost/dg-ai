# Test-Writing Principles — Rationale

Human-reference only. Never loaded by the skill. Explains *why* each principle is what it is.

---

## 1. Exercise real production code

A copy of logic inside the test drifts from the original. Assertions then test the copy, not the code, so they pass even when production breaks.

## 2. No unconditional or placeholder assertions

A test that cannot fail is a confidence illusion — it reads as coverage but catches nothing. An empty body is worse than no test: it looks like coverage.

## 3. Builders/factories and generators over longhand fixtures

Hand-built objects repeated across files drift individually; a single factory with overrides stays consistent. Property/fuzz generators explore edges a single hardcoded value never reaches.

## 4. Test through the module's interface, not its internals

Tests that reach into private state couple to implementation. A pure refactor — same behavior, different internals — should never break a test.

## 5. Share setup; don't copy-paste it

Duplicated setup is maintenance debt — one change needs N edits, and they drift.

## 6. Assert on derived values, not duplicated production formatting

Hardcoding the formatter's output in the test silently duplicates it. When the formatter changes, the test fails for the wrong reason — or, after a copy-paste, still passes while production is broken.

## 7. Red is local-only — never commit a failing test

"Document a bug by asserting the buggy output" makes a passing test that locks in wrong behavior and reads as correct. A *red* test instead asserts the desired behavior and fails until you fix the code — but it is a local TDD waystation, not a committed artifact. Committing a known-failing (or CI-excluded) test rots the signal: the channel fills with expected failures and no one notices a *new* one.

## 8. Name tests after the code under test, not the plan

Tests outlive the plan that produced them. A file named for the work item ("slice 1", "phase 2", a ticket id) tells a future reader nothing about what it protects, and goes stale the moment the plan is forgotten.
