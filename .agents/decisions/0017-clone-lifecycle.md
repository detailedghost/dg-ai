---
covers: ["pkg/channel-review/src/config.ts", "pkg/channel-review/src/address.ts", "pkg/channel-review/src/automation/repo-job.ts", "pkg/channel-review/src/engine.ts"]
---

[ADR 0017](../../docs/adr/0017-clone-lifecycle.md)

- Use an absolute configured clone root outside `~/code` for automation clones.
- Never reuse the user's working checkout.
- Delete clones only through `removeCloneDir`. It resolves paths and refuses the root itself and any path outside it.
- Remove interrupted address clones and sweep abandoned automation clones on recovery.
- Sweep after dependency completion.
- Run normal job cleanup after the job, in `finally`.
