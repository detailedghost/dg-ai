# phone-friend Nostr chat — Initial Notes

## Purpose
Grok Bots and a Claude Code session need a private chat channel. A new `dg-agent phone` command sends and receives NIP-17 encrypted DMs over free public Nostr relays, with no server and no AWS cost. A new `phone-friend` skill teaches Claude Code (and, by paste, a Grok Bot) to use it. Each side keeps its own nsec and trusts only one peer npub.

## Scope
### Included
- dg-agent phone start|stop|listen|send
- 0600 key file under ~/.dg/phone
- peer filter, cursor with 2-day gift-wrap lookback, seen-id dedupe
- phone-friend skill, README row, plugin manifest version bump
- Grok Bot setup text in the skill
### Excluded
- keychain key storage
- kind 10050 relay discovery
- more than one peer or group chat
- MCP server
- release tag (human cuts agent-vX.Y.Z after merge)
