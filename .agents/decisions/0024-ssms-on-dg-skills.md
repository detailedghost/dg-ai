# 0024 — SMS providers on dg-skills

ADR: [docs/adr/0024-ssms-on-dg-skills.md](../../docs/adr/0024-ssms-on-dg-skills.md)

- Command is `dg-skills ssms <provider> <verb>`. Do not add it to `dg-agent`.
- Providers: `google` (Messages for Web via CDP), `signal` (`signal-cli` daemon JSON-RPC).
- Do not open Signal Desktop, its GUI, or its database key.
- Do not auto-install `signal-cli`. Missing binary: print the Arch hint and stop.
- Device name default `dg-cli`. `startLink` then `finishLink` with `deviceName`.
- Sends: `draft` then `send --draft ID --yes` or a TTY yes. Refuse `DG_HOOK`, `CLAUDE_HOOK`, `DG_SSMS_HOOK`.
- Cleanup never deletes and never sends. Keep rules win. Ambiguous rows are not changed.
- Logs: id and reason only. No phone numbers, `sgnl://` URIs, keys, or message bodies.
- Gaps and receive timeouts come from `nextGapMs`. Do not use a fixed sleep.
- Tests use the fake page and the fake JSON-RPC server. Do not call live Chrome or live signal-cli in unit tests.
