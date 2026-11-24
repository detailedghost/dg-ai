---
covers: ["scripts/ram-budget.ts",".github/workflows/compiled-dg.yml"]
---

[ADR 0056](../../docs/adr/0056-long-running-dg-processes-run-without-the-jit.md)

Superseded in part by [ADR 0057](0057-every-dg-command-runs-without-the-jit.md): every command now re-executes without the JIT, not only the long-running ones.

- The JIT re-exec keeps a `BUN_JSC_useJIT` the caller set. ADR 0057 now applies the re-exec to every command.
- Run `bun scripts/ram-budget.ts --dg <compiled dg>` before and after a change that adds startup imports or a long-running process, and keep each case under its budget.
