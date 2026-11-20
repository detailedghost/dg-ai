---
covers: ["pkg/channel-review/src/automation/deps-flow.ts", "pkg/channel-review/src/automation/schedule.ts", "pkg/channel-review/src/automation/ticker.ts", "pkg/channel-review/src/automation/pr-watch.ts"]
---

[ADR 0016](../../docs/adr/0016-scheduled-dependencies.md)

- Run dependency automation once per repository window, with no catch-up.
- Skip a repository that has an open PR matching the configured branch prefix.
- Run `/deps-upgrade --cooldown-days N` in a fresh clone through the serial queue.
- Run the draft PR watcher every two minutes. Mark ready only under the policy in [0014](../../docs/adr/0014-draft-prs.md).
- Notify the configured target on failure or CI timeout.
- Never merge dependency PRs automatically.
