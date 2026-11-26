---
covers: ["native/src/Dg.Core/Plugins/**","native/src/Dg.Core/Transport/**","native/src/Dg.Plugins/**","pkg/skills-cli/src/plugin/**","pkg/skills-cli/src/hooks/plugins.ts","pkg/common/src/plugins/**","pkg/dg-daemon/src/jobs/**"]
---

[ADR 0061](../../docs/adr/0061-dg-plugin-admission-is-signed-and-transport-bound.md)

- Admit a plugin only when its record MAC verifies with the `dg/plugin-approval-key` credential; never trust `approvedSha256` alone.
- Create approvals only from `dg plugin verify <name> --approve` behind the stdin TTY gate.
- Never send a plugin token over TCP; a plugin with a token uses IPC or HTTPS.
- Pin job plugins by a full commit SHA and check the commit and the tree hash at install and at load.
- Sign the admission stat cache with the same key and hash the tree again on any stat change and once a day.
