---
covers: ["native/**","pkg/launcher/**","scripts/ram-budget.ts"]
---

[ADR 0058](../../docs/adr/0058-dg-moves-to-c-nativeaot-in-stages.md)

- In native/, a group project references only Dg.Core and registers through one `AddX(this IServiceCollection)`.
- No reflection: System.Text.Json source generation, [GeneratedRegex], [LoggerMessage], the binding source generator.
- Any IL2xxx or IL3xxx warning fails the build.
- config.toml is the only user config; no appsettings.json, launchSettings, .env or JSON providers.
- Every native command keeps a parity fixture that also runs through the Bun dg.
- Never raise a budget JSON without a `Budget-Increase:` line in the PR body.
