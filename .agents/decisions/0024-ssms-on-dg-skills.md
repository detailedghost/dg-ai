# 0024 — SMS providers on dg-skills

ADR: [docs/adr/0024-ssms-on-dg-skills.md](../../docs/adr/0024-ssms-on-dg-skills.md)

- Command is `dg-skills ssms <provider> <verb>`. Do not add it to `dg-agent`.
- Providers: `google` (Messages for Web via CDP), `signal` (`signal-cli` daemon JSON-RPC).
- Do not open Signal Desktop, its GUI, or its database key.
- Do not auto-install `signal-cli`. Missing binary: print the Arch hint and stop.
- Device name default `dg-cli`. `startLink` then `finishLink` with `deviceName`.
- Sends: `draft` shows the approval token on the terminal only and stores a hash. `send` needs an interactive yes on a real TTY, or `--approve` with that token. `--yes` does not send. The gate blocks accidental and non-interactive sends. Same-user code that evades it, for example by allocating its own pty, is out of scope. `allow_send` is read only from `~/.dg/ssms/config.yaml` in the account's passwd home, not from `$HOME` or `$DG_HOME`. `allow_send: false` never sends.
- Cleanup never deletes and never sends. Keep rules win. Ambiguous rows are not changed.
- Logs: id and reason only. No phone numbers, `sgnl://` URIs, keys, or message bodies.
- Gaps and receive timeouts come from `nextGapMs`. Do not use a fixed sleep.
- Tests use the fake page and the fake JSON-RPC server. Do not call live Chrome or live signal-cli in unit tests.
