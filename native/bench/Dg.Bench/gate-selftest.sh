#!/usr/bin/env bash
set -euo pipefail

bin="${1:?usage: gate-selftest.sh <dg-bench binary>}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

"$bin" --out "$work/report.json"

printf '{"ipcWarmP50Ms":0.001,"httpWarmP50Ms":1000,"ipcFreshProcessMs":1000,"httpFreshProcessMs":1000}\n' > "$work/tight.json"
set +e
output="$("$bin" --gate "$work/tight.json" --from "$work/report.json" 2>&1)"
code=$?
set -e
if [ "$code" -eq 0 ]; then
  echo "gate self-test: a tight IPC budget did not fail the gate" >&2
  exit 1
fi
if ! grep -Eq 'IPC warm p50 [0-9.]+ ms is over the budget 0\.001 ms' <<< "$output"; then
  echo "gate self-test: failure text lacks the transport and both numbers: $output" >&2
  exit 1
fi

printf '{"ipcWarmP50Ms":1000,"httpWarmP50Ms":1000,"ipcFreshProcessMs":1000,"httpFreshProcessMs":1000}\n' > "$work/loose.json"
"$bin" --gate "$work/loose.json" --from "$work/report.json"
echo "gate self-test: ok"
