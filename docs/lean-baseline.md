# Lean baseline and gates

Numbers that the lean gates compare against, and the exact commands to re-run each gate on your machine. The budgets live in `scripts/*.json`, `native/budgets/*.json` and `native/bench/Dg.Bench/budgets/*.json`. The gates run on every pull request in `.github/workflows/compiled-dg.yml` (Linux x64 gates; macOS and Windows report only). `.github/workflows/budgets.yml` then runs the ratchet over the measurements.

## Baseline

### Release assets (v7.0.5, linux-x64, before this spec)

| Measure | Value |
| --- | --- |
| Raw | 92,845,536 B |
| gzip -9 | 39,445,982 B |
| zstd -19 | 31,805,174 B |
| zstd patch from v7.0.5 to a master build | 4,738,851 B |
| Compiled Bun hello (floor) | 81.3 MB raw, 36.5 MB gzip |

Other targets, raw: linux-arm64 92.8 MB, darwin-arm64 73.9 MB, darwin-x64 80.9 MB, windows-x64 97.7 MB, windows-arm64 89.2 MB.

### Release build now (bytecode, no companions, linux-x64, Bun 1.4.2, 2026-11-25)

| Measure | Budget before | Measured | Budget now |
| --- | ---: | ---: | ---: |
| Raw | 94,703,000 | 99,374,560 | 101,400,000 |
| zstd -19 | 32,442,000 | 35,677,831 | 36,400,000 |
| Patch from v7.0.5 | 4,976,000 | 10,412,359 | 10,700,000 |

Bytecode trades size for startup. The patch budget measures against the latest release, so it drops again once a release ships with bytecode.

### Startup (p50 of 40 runs, before)

| Step | ms |
| --- | ---: |
| `dg --version` | 19.3 |
| `dg hooks run pr-confirm` | 33.8 |
| `dg completion --help` | 17.8 |
| `dg agent phone status` / `dg stat` | 50.6 / 51.3 |
| Bytecode build `--version` / hooks | 6.7 / 11.7 |

### Skill tokens (bytes / 4)

| Flow | Tokens (now) |
| --- | ---: |
| spec-plan | 13,138 |
| spec-exec | 6,559 |
| phone | 2,043 |
| stat | 2,040 |
| thrash | 2,047 |
| verify | 3,743 |
| review-loop | 3,360 |
| jot | 1,405 |
| Skill descriptions (every session) | 4,959 |

### RAM and latency

Per-case peak RSS, idle growth and latency budgets are in `scripts/ram-budgets.json`. Latency budgets were seeded on a loaded dev machine. CI runners differ, so the first CI run re-seeds them. The CI step "Print the measured latency against its budget" prints measured p50, p90 and budget for every latency case.

## Run each gate locally

Run from the repository root after `bun install --frozen-lockfile`. Gates exit 1 when a budget is over; drop `--gate` to report only.

### Build the compiled dg the way the release does

```sh
(cd pkg/launcher && bun run build.ts --outdir "$TMPDIR/dg-new" --compiled linux-x64 --without-companions)
```

### RAM, idle growth and latency

```sh
bun scripts/ram-budget.ts --dg "$TMPDIR/dg-new/dg-linux-x64" --idle 120 --gate
```

`--idle 120` matches CI. Use the default `--idle 5` for a quick pass. Linux and macOS only; only Linux gates.

### Size: raw, zstd and patch

```sh
mkdir -p "$TMPDIR/dg-prev"
gh release download --pattern dg-linux-x64 --dir "$TMPDIR/dg-prev"
bun scripts/lean-size.ts --dist "$TMPDIR/dg-new" --previous "$TMPDIR/dg-prev" --gate
```

Needs `zstd` on the path. The patch step takes about two minutes.

### Skill tokens

```sh
bun scripts/skill-tokens.ts --gate
```

### Per-package size report and diff

```sh
bun pkg/launcher/build.ts --report size-report.json
git worktree add "$TMPDIR/base" origin/master
(cd "$TMPDIR/base" && bun install --frozen-lockfile --ignore-scripts && bun pkg/launcher/build.ts --report "$PWD/size-report-base.json")
bun scripts/size-diff.ts "$TMPDIR/base/size-report-base.json" size-report.json
```

### Ratchet

CI uploads one JSON per budget file as the `budget-measurements` artifact: `ram-budgets.json`, `lean-budgets.json`, `skill-token-budgets.json`, `size-report.json` and `size-report-base.json`. The native workflow adds `native-budget-measurements-<rid>`. To run the ratchet on a downloaded set:

```sh
gh run download <compiled-dg run id> --name budget-measurements --dir budget-measurements
bun scripts/budget-ratchet.ts --measured budget-measurements
```

Raise a budget only with a `Budget-Increase: <file>:<path> <old> -> <new> because <reason>` line in the pull request body. Drop a budget entry only with a `Budget-Removal: <key> because <reason>` line in the same place.
