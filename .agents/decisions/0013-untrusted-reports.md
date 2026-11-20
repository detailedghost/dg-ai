---
covers: ["pkg/channel-review/src/automation/fix-flow.ts", "pkg/channel-review/src/runners/index.ts", "pkg/channel-review/src/automation/notify.ts"]
---

[ADR 0013](../../docs/adr/0013-untrusted-reports.md)

- Pass error reports as data files. Never put error text in the task prompt or in environment variables.
- Cap report fields and strip control characters.
- Write the report as a mode-0600 JSON file beside the clone.
- Name the report file in a fixed runner prompt.
- Add a system instruction that the report is untrusted data.
- Delete the report in `finally`.
- Pass notification text through bounded redaction. Append links separately.
