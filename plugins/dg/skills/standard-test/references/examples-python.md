# Test Examples — Python

pytest, factory_boy, model_bakery, and Hypothesis idioms.

---

## 1. Exercise real production code

```python
# bad
def test_parse_amount():
    raw = "£1,234.56"  # re-implements parse logic
    result = raw.replace("£", "").replace(",", "")
    assert float(result) == 1234.56

# good
from myapp.currency import parse_amount

def test_parse_amount():
    assert parse_amount("£1,234.56") == 1234.56
```

---

## 2. No unconditional or placeholder assertions

```python
# bad
def test_user_created():
    user = User(name="Alice")
    assert True  # placeholder; can never fail

# good
from myapp.models import User

def test_user_created():
    user = User(name="Alice")
    assert user.name == "Alice"
    assert user.id is not None
```

---

## 3. Builders/factories and generators

```python
# bad
def test_order_total_a():
    user = User(id=1, name="Alice", email="a@example.com", role="buyer")
    order = Order(user=user, items=[Item(price=10), Item(price=5)])
    assert order.total() == 15

# good — model_bakery: zero boilerplate, auto-fills required fields
from model_bakery import baker
from myapp.models import Order, Item

def test_order_total():
    user = baker.make("myapp.User", role="buyer")
    order = Order(user=user, items=[Item(price=10), Item(price=5)])
    assert order.total() == 15

# good — Hypothesis: property-based, explores edges a single value never reaches
from hypothesis import given, strategies as st
from myapp.currency import parse_amount, format_amount

@given(st.decimals(min_value=0, max_value=1_000_000, places=2, allow_nan=False, allow_infinity=False))
def test_format_parse_roundtrip(amount):
    assert parse_amount(format_amount(amount)) == amount
```

---

## 4. Test through the public interface

```python
# bad
def test_cache_populated():
    service = CacheService()
    service._cache["x"] = 42  # private state
    assert service._cache["x"] == 42

# good
from myapp.services import CacheService

def test_cache_roundtrip():
    service = CacheService()
    service.set("x", 42)
    assert service.get("x") == 42
```

---

## 5. Share setup

```python
# bad — duplicated setup in every test file
def test_create_order():
    db = Database(url="sqlite:///:memory:")
    db.migrate()
    user = User(name="Alice")
    db.save(user)
    ...

# good — shared conftest.py
# conftest.py
import pytest
from myapp.db import Database
from myapp.models import User

@pytest.fixture
def db():
    database = Database(url="sqlite:///:memory:")
    database.migrate()
    yield database
    database.drop_all()

@pytest.fixture
def alice(db):
    return db.save(User(name="Alice"))

# test_orders.py
def test_create_order(alice, db):
    ...
```

---

## 6. Assert on derived values

```python
# bad
def test_invoice_due_date():
    invoice = Invoice(issued_on=date(2024, 1, 15), net_days=30)
    assert str(invoice.due_date) == "2024-02-14"  # hardcoded format literal

# good
from datetime import date, timedelta
from myapp.billing import Invoice

def test_invoice_due_date():
    issued = date(2024, 1, 15)
    invoice = Invoice(issued_on=issued, net_days=30)
    assert invoice.due_date == issued + timedelta(days=30)
```

---

## 7. Red is local-only

```python
# bad — skip-decorated placeholder with _red filename marker committed
# test_currency_formatter_red.py
import pytest

@pytest.mark.skip(reason="not implemented yet")
def test_format_negative_amounts():
    from myapp.currency import format_amount
    assert format_amount(-50) == "-£50.00"

# good — fix the production code, commit the passing test with _red stripped
# test_currency_formatter.py
from myapp.currency import format_amount

def test_format_negative_amounts():
    assert format_amount(-50) == "-£50.00"
```

---

## 8. Name tests after code, not the plan

```python
# bad
def test_slice_1_user_story_42(): ...
def test_PROJ_1234_checkout_thing(): ...

# good
# tests/billing/test_invoice.py
from myapp.billing import Invoice

def test_invoice_due_date_is_net_days_after_issue():
    ...

def test_invoice_total_sums_line_items():
    ...

def test_invoice_raises_on_negative_amount():
    ...
```
