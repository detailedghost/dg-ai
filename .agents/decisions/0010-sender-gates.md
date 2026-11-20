---
covers: ["pkg/channel-review/src/trigger.ts", "pkg/channel-review/src/engine.ts", "pkg/channel-review/src/config.ts"]
---

[ADR 0010](../../docs/adr/0010-sender-gates.md)

- Require the configured `owner.token` in the sender's text before parsing a command.
- Require `from.id` in `owner.senderIds` for `$address` and `$emoji`, unless `address.allowAnySender` is set.
- Return CR-106 for a rejected address sender and CR-107 for a rejected emoji sender.
- Fail closed when the relay omits the sender ID and the override is off.
- Never use display names as sender identity.
- Never treat the owner token as a substitute for sender identity.
- Treat `address.allowAnySender` as a widening of emoji access too. Say so wherever the setting is documented.
