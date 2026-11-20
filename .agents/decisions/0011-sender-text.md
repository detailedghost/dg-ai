---
covers: ["pkg/channel-review/src/trigger.ts", "pkg/channel-review/src/engine.ts"]
---

[ADR 0011](../../docs/adr/0011-sender-text.md)

- Remove HTML blockquotes before recognizing commands in trigger and readiness parsing.
- Never let quoted content introduce a new command.
- Let quoted content identify the blocked PR and recover its stored options.
- Resolve quoted context in the engine, apart from command parsing.
