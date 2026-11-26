# Lean dg CLI: latency, binary and download size, skill token weight, and the C# front door — Initial Notes

## Purpose
Make the dg CLI fast and lean: hot-path latency, binary and download size, and skill token weight, each held by CI gates. Start the staged C# NativeAOT port (Dante's R1 choice) with stage 1: a C# front door that runs hooks, --version, completion, config and routing natively and execs the Bun dg for the rest. Slices are small and file-disjoint so each wave builds in parallel worktrees and all land in one PR.

## Scope
### Included
- Baseline harness and CI gates
- Bundle split, bytecode, companions
- Hook, --version and completion fast paths
- Compressed release assets, delta patches, gzip bootstrap
- Skill diet by group and a size cap
- Browser auto mode, ext gap verbs (TypeScript and Bun), agent window
- Relay protocol contract with shared fixtures
- C# stage 1 front door (opt-in) with parity tests, 6-runner NativeAOT CI, two-binary install
### Excluded
- C# stages 2+ (phone listener, daemon, command groups): later bundles
- Any change to the extension toolchain; it stays TypeScript and Bun
- UPX, the 6.x shared runtime
- Snowflake and Playwright off Bun
