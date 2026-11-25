# Pass error reports as data files

Status: Deprecated
Channel review left dg; see [ADR 0053](0053-job-sources-and-credentials.md).
Date: 2026-10-16
Topic: Automation

## Context

- Error messages and stack traces can contain text controlled by an external user.
- Including that text in the task prompt would blur data and instructions.
- Automation must bound report size and remove temporary report files.

## Decision

Error-fix automation caps report fields, removes control characters, and writes a mode-0600 JSON report beside
the clone. The fixed runner prompt names the file instead of embedding the error text. A separate system
instruction tells the runner to treat the report as untrusted data. Cleanup deletes the report in `finally`.
Notification text passes through bounded redaction.

## Consequences

- The task instruction stays separate from report content in `runners/index.ts`.
- The runner must read a temporary file outside the clone.
- This separation reduces prompt-injection exposure; it cannot prove that a model will ignore every embedded
  instruction. Notification links are appended separately from redacted text.

## Diagram

```mermaid
flowchart LR
    S["error sink"] --> B["cap fields and remove controls"]
    B --> F["private report JSON"]
    F --> R["runner reads as data"]
    P["fixed prompt and system instruction"] --> R
    R --> C["finally: delete report"]
    R --> N["redact notification text"]
```

## Other options

- Including error text in the prompt would place attacker-controlled content in the prompt.
- Environment variables would still mix large untrusted text into process inputs and could leak through diagnostics.

## References

- [pkg/channel-review/src/automation/fix-flow.ts](https://github.com/detailedghost/dg-ai/blob/v7.0.5/pkg/channel-review/src/automation/fix-flow.ts)
- [pkg/channel-review/src/runners/index.ts](https://github.com/detailedghost/dg-ai/blob/v7.0.5/pkg/channel-review/src/runners/index.ts)
- [pkg/channel-review/src/automation/notify.ts](https://github.com/detailedghost/dg-ai/blob/v7.0.5/pkg/channel-review/src/automation/notify.ts)
