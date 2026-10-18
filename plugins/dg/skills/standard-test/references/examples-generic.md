# Test Examples — Generic (Pseudocode)

Language-neutral sketches. Loaded when no language-specific file matches. Translate to your stack's idioms.

---

## 1. Exercise real production code

```
# bad — re-implements the production formatter in the test
def format_amount(n): return "$" + round(n, 2)
assert format_amount(5) == "$5.00"

# good — imports/calls the real thing
from currency import format_amount
assert format_amount(5) == "$5.00"
```

---

## 2. No unconditional or placeholder assertions

```
# bad
test "formats amount": assert true == true
# also bad — empty body passes silently
test "formats amount": (nothing)

# good
test "formats amount": assert format_amount(5) == "$5.00"
```

---

## 3. Builders/factories and generators over longhand fixtures

```
# bad — same shape hand-built in every test
user = { id: 1, name: "Alice", role: "admin", created_at: "2024-01-01" }

# good — factory with per-test overrides
user = build_user(role: "admin")

# good — generator explores the full input space
for_all(dates) check that to_iso(d) round-trips
```

---

## 4. Test through the module's interface, not its internals

```
# bad — pokes private cache directly
service._cache["x"] = 42
assert service._cache["x"] == 42

# good — drives the public API, observes the public outcome
service.set("x", 42)
assert service.get("x") == 42
```

---

## 5. Share setup; don't copy-paste it

```
# bad — the same harness pasted into every test file
def setup_with_providers(ui): wrap(ui, Theme, QueryClient, Router)

# good — import once from a shared test-utility module
from test_utils import setup_with_providers
```

---

## 6. Assert on derived values, not duplicated production formatting

```
# bad — literal duplicates production behavior
assert format_currency(1234.56) == "$1,234.56"

# good — round-trip through an independent inverse
assert parse_currency(format_currency(1234.56)) == 1234.56
# or compare with a value computed another way
assert format_currency(1234.56) == format_cents_with_separators(123456)
```

---

## 7. Red is local-only — never commit a failing test

```
# discovered a bug: amounts over 1000 lose the thousands separator
# bad — committed test that enshrines the bug
test "formats large amount": assert format_currency(1234.5) == "$1234.50"

# good — write the failing test locally, FIX the code, then commit it passing
test "formats large amount": assert format_currency(1234.5) == "$1,234.50"
```

---

## 8. Name tests after the code under test, not the plan

```
# bad — named for the plan artifact
slice_1.test
phase2_cleanup.test

# good — named for the module/behavior it exercises
currency_formatter.test
dashboard_filters.test
```
