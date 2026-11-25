# Lean dg CLI: latency, binary and download size, skill token weight — Initial Notes

## Purpose
Make the dg CLI fast and lean. Cut hot-path latency (hooks run on every agent tool call), shrink the compiled binary and the per-update download, and cut the token weight of the skill texts that drive the CLI. Every change is measured against a committed baseline and held by CI gates. Slices 1-8 stay on Bun and help whatever language decision Dante makes later; slices 9-10 are optional native stages gated by RATIFY.

## Scope
### Included
- A baseline harness and CI gates: binary size per target, compressed download size, hot-path latency, RSS, skill tokens per flow
- Bundle cuts: duplicate and dead dependencies, lazy chunks, embedded assets
- Hot-path latency: dispatch order, JIT re-exec, lazy route for hooks and completion, Bun bytecode (RATIFY)
- Release and download size: compressed assets, zstd delta updates, optional companion bundles for pw and db (RATIFY)
- Skill text diet: lazy references/, less duplication, per-SKILL.md size cap test
- Browser default: --ext as the default with a --local Playwright fallback (RATIFY), the extension gap work and the docs
- An explicit language decision (options A-E) with measured floors
- Optional native front door and native long-running processes (RATIFY-gated, slices 9-10)
### Excluded
- A full port to Rust, Zig or C# (option E); later port stages after slice 10 are sketched only
- UPX or other self-extracting executable packers
- Changes to the browser extension's own bundle size
- Moving Snowflake, MSAL or Playwright off Bun or Node
