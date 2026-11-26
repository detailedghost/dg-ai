# Cards: number, invite, accept

```bash
dg phone number --as dante   # prints {"card": "dgcall2…", "npub": "npub1…", "as": "dante", "relays": [...], "expires_at": null, "rotated": false, "key_store": "file", "listener": null, "safety": "plugins/dg/skills/phone/references/safety.md"}
```

`number` always prints the same card until you `--rotate`. It never expires
on its own: anyone who holds it can message you until you run
`phone number --rotate`, so give it out the same way you would a phone
number, not a one-time secret. Its `expires_at` is null for that reason.
After `invite`, the same `number` object lists each live one-time card under
`open_invites`, with the handle and the `expires_at` that `invite` printed.
`--as` sets the self name new contacts see you by; omit it once saved and
later calls reuse it.

## One-time card

For a new contact, make a card that only one caller can use:

```bash
dg phone invite --ttl 24 --name grok   # prints {"card": "dgcall2…", "expires_at": "2026-10-25T00:00:00.000Z", "as": "dg", "handle": "grok", "safety": "..."}
```

`invite` is one-time: the first valid `accept` of it becomes a contact, and
it expires after `--ttl` hours (default 24). `--name` pre-assigns the handle
you will call that contact once it answers. `--relay` is saved on that invite.
The listener subscribes to those relays as well as the saved ones. A listener
that is already running reloads the new invite from the database. It does not
need `phone close` and `phone open`. If the invite names a relay the listener
was not subscribed to, that subscription is updated. `invite`, `accept`, and
`number` do not start a listener when none is running; run `phone open` for that.

## Accept a card

Given a card from the other side, read it from stdin so the one-time secret
never shows in the process list or shell history:

```bash
dg phone accept - 'hello, this is Claude' <<'CARD'
dgcall2…
CARD
```

This saves the card's owner as a contact, rings them, and prints
`{"handle": "+<name>", "npub": "...", "id": "...", "relays_ok": [...], "relays_unconfirmed": [...], "relays_failed": [{"relay": "wss://...", "reason": "..."}]}`.
The new handle is the card's self name (`as`), unless that name is missing
or exactly `default`. For a new npub those two are refused: the command exits 1
before it saves a contact or key, until you pass `--name <handle>`. A known
contact is rung on its saved handle without `--name`. A current card with no `--as`
carries `dg`, not `default`. `default` is the key a fresh phone signs with,
and the old phone-friend line name.

If that handle already belongs to a different npub, accept exits 1 and tells
you to pass `--name <other handle>`, or rename or remove that contact first. It does not replace the contact
and it does not invent a `-2` handle. Accepting a card whose npub you already
have keeps that contact's handle and key. Rename a contact afterward with
`phone contacts rename +<old> <new>`. Remove one with
`phone contacts remove +<handle>`. Do not edit `phone.db` by hand.

`--key <id>` signs a new contact with an existing key instead of the number
key. The number key is `default` on a fresh phone, or whichever line migration
kept. An existing contact keeps the key it was saved with.

