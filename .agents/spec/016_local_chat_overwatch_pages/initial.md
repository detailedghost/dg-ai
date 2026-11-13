# Local chat and overwatch pages served by dg-daemon, --ext for the extension pages — Initial Notes

## Purpose
chat and overwatch are the last two skills that require the dg-ai-extension. dg-daemon already holds every session, message and board row and serves a stub /start page on loopback; this bundle makes it serve the chat page and the live board itself, token-gated on 127.0.0.1, so `dg-agent start --open` and `dg-agent overwatch open` land in a plain browser tab by default. `--ext` keeps the extension side panel and board page. The lint allowlist from bundle 014 empties and no SKILL.md declares requires: [extension] any more. The loopback-origin model is a one-way door and is marked [ASSUMED] until ratified.

## Scope
### Included
- dg-daemon: /chat and /board HTML pages with their JS built from the extension's page code into a pkg/pages workspace; loopback-origin plus session-token gate for the routes those pages call
- dg-agent: start --open and overwatch open target the local pages by default and the extension with --ext
- chat and overwatch skills: no requires line, flags table, require-extension only under --ext; lint allowlist emptied; docs; ADR 0030
### Excluded
- Inbox Proton operations (they need the MAIN-world observer in a signed-in tab; see bundle 014 Open questions)
- Extension pairing, /pair and the pinned-origin store (unchanged for --ext)
- Phone snapshot publication (dg-skills overwatch-snapshot is unchanged)
- Remote (non-loopback) access of any kind
