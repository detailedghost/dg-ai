---
covers: ["pkg/launcher/src/dispatch.ts","pkg/launcher/src/dg.ts","pkg/launcher/build.ts","scripts/ram-budget.ts"]
---

[ADR 0057](../../docs/adr/0057-every-dg-command-runs-without-the-jit.md)

- Call `reexecWithoutJit` only from the dg entry, never from `dispatch()`.
- Keep `DG_JIT=1` and a caller's `BUN_JSC_useJIT` as ways to keep the JIT. Drop the variables in the re-executed process.
- `bun:ffi` needs the JIT. A command that reaches a module importing `bun:ffi` must be in `FFI_COMMANDS`.
- Keep `autoloadDotenv` and `autoloadBunfig` off in `buildCompiled`.
- Keep the hook latency budgets in `scripts/ram-budget.ts` next to the RSS budgets.
