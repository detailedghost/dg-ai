# Shared runtime and bundle — Initial Notes

## Purpose
Replace the three compiled 78-93 MB binaries with one pinned Bun runtime installed once and one minified, code-split JS bundle per release, reached through three launcher names (dg-skills, dg-agent, dg-daemon) that dispatch on the invoked name. Every command loads only its own code, so `dg-skills --version` runs under 50 ms. The install footprint drops from about 250 MB to about 90 MB and the release asset list drops from 18 platform binaries to one platform-independent tarball plus a runtime pin.

## Scope
### Included
- pkg/launcher: dispatcher entry dg.js, bundle build with splitting and minify, runtime pin (runtime.json), shim templates
- Lazy command registration in pkg/skills-cli (wrappers import their feature inside the action) and a static test that enforces it
- main(argv) exports for dg-skills, dg-agent, dg-daemon; program name recorded for selfCommand
- dg-skills install: fetch runtime (verified) and bundle (verified), link current, write shims, retire the compiled binaries
- bootstrap.sh and bootstrap.ps1 install the runtime, the bundle and the shims
- release.yml: one bundle asset, runtime.json asset, per-OS smoke matrix running the bundle on the pinned runtime
- Startup budget test and size budget test on the built bundle
- ADR 0024 and docs
### Excluded
- Per-OS directory layout (PR F); PR E keeps ${DG_HOME:-~/.dg} so the diff stays small
- New commands or skills (PR A, C, D)
- Changing hook or unit command shapes beyond what the shims require
