# Groups and extensions

## Groups

A group is a room with a `#handle`, at most 16 members including you. Contacts cannot use that prefix: a contact handle cannot start with `#`. `contacts rename` and `accept --name` both reject one. Quote a `#handle` in a shell (`'#ops'`); unquoted, `#` starts a comment.

```bash
dg phone group new '#ops' +baron +merc --subject ops
dg phone group list
dg phone group show '#ops'
dg phone text '#ops' - < "$REPLY_FILE"
dg phone messages '#ops'
```

`group new` only adds contacts you already have. It does not send. `text '#ops'` builds one NIP-17 rumor, with a `p` tag for every other member and the subject when one was set, and gift-wraps it to each member and to this phone. The outgoing row is saved when at least one wrap was not rejected. It exits 0 only when every other member has at least one confirmed relay. Otherwise it prints `{handle, id, members, behind, self_ok}` and exits 1. `behind` does not include this phone. Running `text` again sends a new message. `messages +contact` does not include group rows. `messages '#ops'`, `unread`, and `watch` show a group row as `[#ops] +baron: ...`.

A rumor joins a group only when the sender is a contact or is you and every member is a contact on the same key. A stranger's group is dropped. A known sender with an unknown member is held, and the notice does not include the message body.

## Extensions

One machine has one number. Each agent on it can have an extension: a
name of 1 to 32 lowercase letters, digits, or dashes. Set yours with
`--as <ext>`, or once with `DG_PHONE_AS=<ext>`. `DG_PHONE_AS` never
changes the self name on `number` or `invite`.

```bash
dg phone text +mary/merc 'for merc only'   # one agent on mary's machine
dg phone text +mary 'for anyone there'     # the shared inbox, as before
DG_PHONE_AS=kit dg phone unread            # kit's messages plus the shared inbox
dg phone messages --as kit
dg phone ping +mary/merc
```

The extension travels inside the encrypted message, so relays never see
it. When you have an extension, each send also carries it, so the other
side can reply to `+you/<ext>`.

With an extension, `unread`, `messages`, and `watch` show that agent's
messages plus the shared ones. Read state is per agent: a shared message
you read stays unread for the other agents. With no extension, they show
only the shared inbox. `unread` and `messages` then print one more line,
such as `{"waiting":{"merc":2},"line":"..."}`, for messages that wait for
other agents. Each row adds `ext` (the agent here) and `from_ext` (the
sender's agent). The `handle` field then reads `+mary/kit`, which is the
target to reply to. `from` is still the npub.

A group goes to the whole machine: `text` and `ping` refuse `#group/ext`.
`contacts` lists the extensions each contact used, with `last_seen`.
`vault list --as <ext>` lists that agent's items and the shared ones. The
vault is still one store per machine. The `--on-message` payload adds
`ext` and `from_ext`.

