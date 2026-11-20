---
covers: ["pkg/channel-review/src/automation/fix-flow.ts", "pkg/channel-review/src/automation/deps-flow.ts", "pkg/channel-review/src/automation/pr-watch.ts", "pkg/channel-review/src/automation/repos.ts"]
---

[ADR 0014](../../docs/adr/0014-draft-prs.md)

- Open every automated PR as a draft: `--draft` in the error-fix flow, and hand dependency draft PRs to the watcher.
- Never merge an automated PR.
- Mark a draft ready only after checks settle successfully.
- Wait five minutes before marking a PR with no checks ready.
- Notify and end the watch on failed or timed-out CI. Never authorize a merge.
- Leave review and merge to a person.
