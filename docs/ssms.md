# SMS providers

`dg-skills ssms` reads and cleans SMS through a provider. The command lives on
`dg-skills`, the same binary as `dg-skills inbox`. `dg-agent` stays the chat
client. [ADR 0024](adr/0024-ssms-on-dg-skills.md) records that split.

Command lines, matching `ssms --help`:

- `ssms <provider> link [--name NAME]`
- `ssms <provider> status`
- `ssms <provider> list [--config PATH]`
- `ssms <provider> read <conversation> [--limit N]`
- `ssms <provider> receive [--limit N] [--timeout-ms N] [--conversation ID]`
- `ssms <provider> watch [--limit N] [--timeout-ms N]`
- `ssms google archive <conversation> [--dry-run] [--config PATH]`
- `ssms google block-report <conversation> [--dry-run] [--config PATH]`
- `ssms <provider> draft --conversation ID [--text TEXT] [--emoji EMOJI] [--attachment PATH] [--quote-timestamp N]`
- `ssms <provider> send --draft ID [--yes]`
- `ssms google classify [--config PATH]`
- `ssms google cleanup [--dry-run] [--config PATH]`

```sh
dg-skills ssms --help
dg-skills ssms google status
dg-skills ssms google list
dg-skills ssms google classify
dg-skills ssms google cleanup --dry-run
dg-skills ssms google draft --conversation ID --text "hello"
dg-skills ssms google send --draft ID --yes
dg-skills ssms signal link
dg-skills ssms signal list
dg-skills ssms signal read CONVERSATION --limit 20
dg-skills ssms signal receive --limit 20
dg-skills ssms signal draft --conversation ID --emoji "👍" --target-timestamp 123 --target-author ID
dg-skills ssms signal send --draft ID --yes
```

## Providers

| Provider | What it drives | Verbs it refuses |
| --- | --- | --- |
| `google` | Messages for Web, through the CDP browser harness demo uses | reactions, quotes, attachments, delete |
| `signal` | `signal-cli` in daemon JSON-RPC mode | archive, block-report |

A provider reports a capability as false when it cannot do that verb. The CLI
prints the provider name and the capability, and it does not invent a fallback.

`google` keeps a browser profile under `$DG_HOME/ssms/google-profile` so a
paired Messages for Web session can be reused. Sign-in stays with the user.
`DG_SSMS_HEADLESS=1` starts that browser headless.

`signal` does not read Signal Desktop, its GUI, or its database key. `link`
calls `startLink`, prints the `sgnl://` URI and a QR, then `finishLink` with
the device name `dg-cli` unless `--name` says otherwise. Later calls use
`--data-dir $DG_HOME/ssms/signal-data` and `daemon --tcp=127.0.0.1:PORT`.
The account id in output is the ACI, not the phone number.

If `signal-cli` is missing, the command prints an install hint and stops. It
does not install the package. On Arch Linux the package is `signal-cli`
(`sudo pacman -S signal-cli`). `DG_SIGNAL_CLI` points at a binary that is not
on `PATH`.

## Drafts

`draft` writes a pending draft under `$DG_HOME/ssms/drafts` and prints it.
`send --draft ID` sends that one draft only after `--yes`, or after an
interactive yes on a terminal. A hook (`DG_HOOK`, `CLAUDE_HOOK`, or
`DG_SSMS_HOOK`) cannot send, even with `--yes`. Cleanup never sends and never
deletes. `allow_send: false` is the cleanup default; a draft the user approves
is the per-message approval.

Signal drafts can be plain text, a reaction (`--emoji`), an image
(`--attachment`), or a reply (`--quote-timestamp`, `--quote-author`,
`--quote-text`). Reading those shapes back uses `receive` and `read`. `read`
shows messages already stored by `receive`.

## Cleanup rules

`google classify` and `google cleanup` use the config in the
[google-sms-cleanup skill](../plugins/dg/skills/google-sms-cleanup/SKILL.md).
Keep rules win. Ambiguous threads are listed and left alone. `--dry-run`, or
`dry_run: true` in the config, reports the plan and does not archive or block.

Polling and signal-cli receive timeouts use irregular gaps. The CLI does not
sleep on a fixed stride.

## Logs

Stdout is the operator result: a linking URI, a draft body, a message you asked
to read. Stderr logs are one JSON object per event, with an id and a reason.
Phone numbers, linking URIs, keys, and message bodies are not logged.

## Tests

From the repo root:

```sh
mise run test:ssms
mise run test:ssms:google
mise run test:ssms:signal
mise run test:ssms:mutate
```

The suites use a fake Messages page and a fake signal-cli JSON-RPC server.
They do not start Chrome or the real `signal-cli`.
