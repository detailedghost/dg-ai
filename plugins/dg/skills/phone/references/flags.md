# Phone flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--image <path>` | none | On `text`, send one PNG, JPEG, or WebP (5 MiB at most) instead of text. Needs `phone files on`. | off |
| `--phi` | none | On `text`, mark the text or image as PHI. Only when the human asks for that send. The sent row keeps only `[PHI: not stored]`. | off |
| `--vault <name>` | none | On `text`, send a vault item, text or image, without printing it. Implies `--phi`. The sent row keeps only `[PHI: vault item <name>]`. | off |
| `--env <var>` | none | On `vault exec`, pass a text item under 64 KiB with no NUL byte in this env var instead of stdin. | off |
| `--stdin` | none | On `vault exec`, pass the item on stdin. | on |
| `--out <name>` | none | On `vault exec`, the new item that gets the command's stdout. Never overwrites. | `<name>-out` |
| `--timeout <seconds>` | none | On `ping`, seconds to wait for the receipt, 1 to 600. On `vault exec`, seconds before the command is killed, 1 to 3600; it then stores nothing and exits 124. | ping: `30`. vault exec: `120` |
| `--as <name\|ext>` | none | On `number` or `invite`, the self name the card carries, saved for next time. On `text`, `unread`, `messages`, `watch`, and `vault list`, your own extension (see [Extensions](groups.md)). | number and invite: `dg`. Others: `DG_PHONE_AS`, else none |
| `--rotate` | none | On `number`, roll a new secret so every card printed before this stops admitting. | off |
| `--relay <url>...` | none | Relays a `number` or `invite` card should use instead of the saved ones. | the saved relay list |
| `--ttl <hours>` | none | Hours until an `invite` card expires. | `24` |
| `--name <handle>` | none | On `invite`, the handle to store for whoever answers. On `accept`, the handle to give a new contact. `accept` requires it for a new npub when the card's self name is missing or `default`. | invite: the caller's self name. accept: the card's self name |
| `--key <id>` | none | On `accept`, an existing key id to sign a new contact with. Accept will not create a key you name, and it will not switch a contact you already have. | the number key |
| `--subject <text>` | none | On `group new`, the subject stored on the group and sent with each message. | empty |
| `--count <n>` | `-n` | How many `messages` rows to print. | `50` |
| `--meta` | none | On `messages`, print metadata only and omit message text. | off |
| `--for <seconds>` | none | Seconds `watch` keeps checking unread messages. | `120` |
| `--new` | none | On `watch`, skip the unread backlog and print only messages that arrive after it starts. | off |
| `--on-message <exe> [args...]` | none | Command `open` runs for each delivered message, saved for next time; stdin carries the message JSON. | none (messages wait for `unread`/`messages`) |
| `--on-message-timeout <seconds>` | none | Seconds before a running `--on-message` command is killed. | `30` |
| `--ensure` | none | On `open`, start a detached listener when the pidfile is not a live copy of this binary. Also restart it when the recorded version or keys drifted, if this binary is the same version or newer. An older binary does not replace a newer listener that shares the phone directory. Safe to repeat from cron. Does not call systemd and does not edit the crontab. | off |
| `--print-cron` | none | On `open`, include a `*/5` crontab line for `--ensure` in the JSON. Does not change the crontab. | off |
| `--install-cron` | none | On `open`, install that crontab line. Never implied by `--ensure` or `--print-cron`. | off |
| `--with <handle>` | none | On `close`, the paired machine to hang up, as a `+handle`. Does not stop the listener. | off |
| `--clear` | none | On `close`, with `--with`, remove every contact that machine's roster added. | off |

