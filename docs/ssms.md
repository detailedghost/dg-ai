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
- `ssms <provider> send --draft ID [--approve TOKEN]`
- `ssms google classify [--config PATH]`
- `ssms google cleanup [--dry-run] [--config PATH]`

```sh
dg-skills ssms --help
dg-skills ssms google status
dg-skills ssms google list
dg-skills ssms google classify
dg-skills ssms google cleanup --dry-run
dg-skills ssms google draft --conversation ID --text "hello"
dg-skills ssms google send --draft ID
dg-skills ssms signal link
dg-skills ssms signal list
dg-skills ssms signal read CONVERSATION --limit 20
dg-skills ssms signal receive --limit 20
dg-skills ssms signal draft --conversation ID --emoji "👍" --target-timestamp 123 --target-author ID
dg-skills ssms signal send --draft ID
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
`--data-dir $DG_HOME/ssms/signal-data` and
`daemon --receive-mode=manual --socket=<data-dir>/daemon.sock`. The socket
directory is mode 0700 and owned by the current user. The socket's owner is
checked; its mode bits are not, because `signal-cli` creates the socket as
0755 under umask 022. Receive stays manual so the daemon does not download
messages in the background.
The account id in output is the ACI, not the phone number.

If `signal-cli` is missing, the command prints an install hint and stops. It
does not install the package. On Arch Linux the package is `signal-cli`
(`sudo pacman -S signal-cli`). `DG_SIGNAL_CLI` points at a binary that is not
on `PATH`.

## Drafts

`draft` writes a pending draft under `$DG_HOME/ssms/drafts`. The approval
token is shown only on the terminal device (`/dev/tty`), never on stdout and
never in `--json`. The draft file stores a hash of that token, not the token.
`send --draft ID` sends that one draft only after an interactive yes on a real
terminal, or after `--approve` with the token from the terminal. `--yes` does
not send. The gate blocks accidental and non-interactive sends. Same-user code
that evades it, for example by allocating its own pty, is out of scope.
`allow_send` is read only from `~/.dg/ssms/config.yaml` in the account's passwd
home. Linux uses `getent` or `/etc/passwd`. macOS uses `id -P` or `dscl`. If
that home cannot be resolved, send stays off. `$HOME` and `$DG_HOME` do not
choose it. `--config` cannot set it. `google.send_enabled` in that same file
defaults to false. Google send is unverified against a signed-in Messages for
Web session until someone runs it there, so leave the flag false until then.
`false` means never send, and that is the default when the fixed file is
missing. If `/dev/tty` cannot be opened, `draft` fails and does not keep the
draft. A Google draft stores the contact's display name and matches the open
thread header to that name exactly, after trimming and collapsing whitespace.
The list item for that conversation id must be selected, and a
`data-conversation-id` inside the message-pane container must equal the
conversation id stored when the draft was created. The compose form, a
participant id, and the conversation list are not that container. The check
runs again immediately before Send. If the pane does not expose an id, send
is refused. Load more is polled, with jitter, until the row count grows or
stops. A display name shared by more than one loaded conversation, or a list
that never finishes loading, is refused before the page is asked to send.
Cleanup never sends and never deletes. `--dry-run` leaves the draft pending.

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
