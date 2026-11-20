---
covers: ["pkg/channel-review/src/engine.ts", "pkg/common/src/serial-queue.ts", "pkg/channel-review/src/state.ts", "pkg/channel-review/src/automation/start.ts"]
---

[ADR 0009](../../docs/adr/0009-serial-work.md)

- Route review, address, error-fix and dependency jobs through one serial queue.
- Keep in-flight keys so duplicate PR or automation work cannot start.
- Persist child identity, including process start time, for restart recovery.
- Inspect persisted child identity before terminating a leftover runner or cleaning abandoned work.
- Never add a per-chat queue or a worker pool.
- Never treat the queue as a durable broker.
