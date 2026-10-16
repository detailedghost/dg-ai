# Test Examples — Shell

BATS (Bash Automated Testing System) idioms. Assumes bats-core v1.x with
bats-support and bats-assert v2.x. Shebang: `#!/usr/bin/env bats`.

---

## 1. Exercise real production code

```bash
# bad
@test "formats currency" {
  result=$(printf "%.2f" 1234.5)  # re-implements format_currency
  [ "$result" = "1234.50" ]
}

# good — load helpers and source library in setup()
setup() {
  load 'test_helper/bats-support/load'
  load 'test_helper/bats-assert/load'
  source "$BATS_TEST_DIRNAME/../lib/currency.sh"
}

@test "formats currency" {
  run format_currency 1234.5
  assert_success
  assert_output "1234.50"
}
```

---

## 2. No unconditional or placeholder assertions

```bash
# bad
@test "parses config" {
  run parse_config config.toml
  assert_success  # always passes — parse_config could be a no-op
}

# good
@test "parses config and returns db host" {
  run parse_config fixtures/config.toml
  assert_success
  assert_output --partial "db_host=localhost"
}
```

---

## 3. Builders/factories and generators

```bash
# bad — env var block duplicated in every test
@test "creates admin user" {
  export USER_NAME="alice"; export ROLE="admin"; export QUOTA=100
  run create_user
  assert_success
}

@test "creates regular user" {
  export USER_NAME="bob"; export ROLE="user"; export QUOTA=50
  run create_user
  assert_success
}

# good — setup helper in test_helper.bash
# test_helper.bash
setup_user() {
  export USER_NAME="${1:-alice}"
  export ROLE="${2:-user}"
  export QUOTA="${3:-50}"
}

# suite file — bats-core load strips .bash; file on disk is test_helper.bash
load 'test_helper'

@test "creates admin user" {
  setup_user "alice" "admin" 100
  run create_user
  assert_success
}
```

---

## 4. Test through the public interface

```bash
# bad
@test "temp file is created" {
  source ./lib/processor.sh
  _process_internal /tmp/input.txt
  [ -f "$_INTERNAL_TMPFILE" ]
}

# good
@test "process produces output" {
  run ./bin/processor fixtures/valid_input.txt
  assert_success
  assert_output --partial "processed:"
}
```

---

## 5. Share setup

```bash
# bad — setup() block duplicated across every test file
setup() {
  load 'test_helper/bats-support/load'
  load 'test_helper/bats-assert/load'
  export CONFIG_DIR="$BATS_TEST_DIRNAME/fixtures"
  export LOG_LEVEL="quiet"
}

# good — single shared file loaded by all suites
# test_helper.bash
setup() {
  load 'test_helper/bats-support/load'
  load 'test_helper/bats-assert/load'
  export CONFIG_DIR="$BATS_TEST_DIRNAME/fixtures"
  export LOG_LEVEL="quiet"
}

# currency.bats — bats-core load strips .bash; file on disk is test_helper.bash
load 'test_helper'

@test "converts EUR to USD" {
  run convert_currency 1 EUR USD
  assert_success
}
```

---

## 6. Assert on derived values

```bash
# bad — hardcodes value that duplicates data source
@test "sums monthly report" {
  run monthly_report sales.csv
  assert_output "Total: 4821.00"
}

# good — derive expected from the same data source
@test "sums monthly report" {
  expected=$(awk -F, 'NR>1{s+=$3} END{printf "Total: %.2f", s}' fixtures/sales.csv)
  run monthly_report fixtures/sales.csv
  assert_output "$expected"
}
```

---

## 7. Red is local-only

```bash
# bad — currency_red.bats committed
# currency_red.bats
@test "handles negative amounts" {
  run format_currency -50
  assert_output "-50.00"  # fails: fix not yet implemented
}

# good — currency.bats (fixed and renamed)
# currency.bats
@test "handles negative amounts" {
  run format_currency -50
  assert_success
  assert_output "-50.00"
}
```

---

## 8. Name tests after code, not the plan

```bash
# bad — file: slice_1_JIRA-4892.bats
@test "ticket 4892 scenario A" {
  run ./bin/processor input.txt
  assert_success
}

# good — file: processor.bats
@test "processor exits 0 on valid input" {
  run ./bin/processor fixtures/valid_input.txt
  assert_success
}

@test "processor exits 1 on missing file" {
  run ./bin/processor /nonexistent
  assert_failure
}
```
