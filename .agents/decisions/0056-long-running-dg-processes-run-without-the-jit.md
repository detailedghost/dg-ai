---
covers: ["pkg/launcher/src/dispatch.ts","scripts/ram-budget.ts",".github/workflows/compiled-dg.yml"]
---

[ADR 0056](../../docs/adr/0056-long-running-dg-processes-run-without-the-jit.md)

- `dispatch` re-executes the long-running commands in `NO_JIT` through `process.execve` with `BUN_JSC_useJIT=0`. Add a new long-running command there.
- Keep a `BUN_JSC_useJIT` the caller set. Never re-execute short commands.
- Run `bun scripts/ram-budget.ts --dg <compiled dg>` before and after a change that adds startup imports or a long-running process, and keep each case under its budget.
