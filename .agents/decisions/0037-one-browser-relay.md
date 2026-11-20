---
covers: ["pkg/common/src/relay-format.ts", "pkg/common/src/relay-features.ts", "pkg/dg-daemon/src/server/browser-relay.ts", "pkg/extension/lib/background/relay-dispatch.ts", "pkg/common/src/inbox-format.ts", "pkg/common/src/proto-format.ts", "pkg/common/src/pw-ext-format.ts", "pkg/dg-daemon/src/server/inbox.ts", "pkg/dg-daemon/src/server/proto.ts", "pkg/dg-daemon/src/server/pw-ext.ts"]
---

[ADR 0037](../../docs/adr/0037-one-browser-relay.md)

- Put the relay lifecycle for every feature in `pkg/dg-daemon/src/server/browser-relay.ts` and the extension dispatch in `relay-dispatch.ts`. Drive both from a per-feature table in `pkg/common`.
- Add a relay feature as one table entry. Do not copy relay lifecycle into a feature file.
- Keep frames, validator errors, refusal strings, check order and the request-id burn point byte-identical per feature. Do not bump `CHAT_PROTOCOL_VERSION` for relay refactors.
- Give every feature a replay guard. Opt into cancel and progress only where the frame exists.
- Attach feature-only logic through the optional daemon hooks `prepare`, `settled` and `salvage`.
- Let the relay catch a hook throw, log the error class and feature name, and continue. Settle a `prepare` throw as an error with fixed text and burn no request id.
- Generate the relay members of `ChatFrame`, `CHAT_FRAME_TYPES`, `INBOUND_FRAME_TYPES`, the relay validator cases and `CliFrame` from the feature tables. Hand-write chat-only frames.
- Make each extension handler take one object argument.
- Keep the relay lifecycle in the one relay contract spec. Keep validator and hook cases in the per-feature specs.
- Keep the three oversized-result behaviors (inbox, proto, pw-ext) apart until a later record unifies them.
