---
covers: ["pkg/dg-daemon/src/server/http.ts", "pkg/dg-daemon/src/server/origin.ts", "pkg/dg-daemon/src/server/connection.ts", "pkg/dg-daemon/src/server/bootstrap.ts", "pkg/dg-agent/src/start.ts", "pkg/dg-agent/src/commands.ts", "pkg/common/src/node/page-code.ts", "pkg/common/src/chat-format.ts", "pkg/extension/lib/background/daemon-link.ts", "pkg/extension/lib/background/pairing-store.ts"]
---

[ADR 0039](../../docs/adr/0039-zero-touch-pairing.md)

- Pair with no code and no human step. Keep one `/ws` link socket open from the extension worker to the daemon, found through `findDaemonPort`, even with zero pairings. The daemon pushes each new session as a `session-adopt` frame.
- Admit and pin only `chrome-extension://<DG_CHROME_EXTENSION_ID>` (`gnjpjelfpbmfphhloebocaafhkfmflhd`, derived from the manifest `key`). Refuse any other `chrome-extension:` origin with 400. Replace any other stored `chrome-extension:` pin with the fixed origin. Keep the test that recomputes the ID from the manifest key.
- Keep first-contact pinning through `pinOriginIfUnset` for `moz-extension:` only.
- Count a socket as an extension peer only while its origin equals the current pin.
- Store the first `/healthz` `daemonId` under `daemon:id` in `storage.local`. Refuse a port that reports another id. After a daemon home reset, show "The daemon changed" with **Trust this daemon**.
- Drop inbound frames until `admitPort` ends. Then send `link-ready`. Replay active sessions only on `link-ready`, only to extension peers, never at socket open.
- Send `link-ping` about every 20 s while the socket is open. The daemon accepts it and ignores it.
- Keep the `chrome.alarms` alarm `dg-link-retry` at 30 s while the link is not admitted. Clear it once the link is admitted. Set it again when the link drops.
- Make **Unpair** send `session-disconnect` and write `dismissed:<sessionId>`. Never adopt a dismissed session again on reconnect. Clear the key only on a `session-closed` frame. Skip `session-closed` for extension sockets on `daemon-shutdown`.
- Put `extensionLinked` in the `/start` reply. Make `dg-agent start` print `Paired <identity> (<id8>) with the browser extension.` or `No browser extension is connected. Install it with: dg-skills install` on stderr and nothing on stdout. Print `{sessionId, port, extensionLinked}` with `--json`. Print the id with `--print-session-id`.
- Print no URL that carries a session token. Mint a one-time code through `mintPageCode` for `dg-agent start --open`, `dg-agent overwatch open` and `dg-skills inbox bootstrap-url`, and use `/chat#_chatcode=<code>`. A code works once within 60 seconds. Do not read the legacy `_chat` fragment.
- Make `POST /chat/code` accept the owner token with `{ sessionId }` and no `Origin`. Share the attach rate limit. Answer with `nosniff` and `no-store`.
- Make `dg-agent spawn [opts] -- <command...>` create a session, run the command with `DG_SESSION_ID` set, and exit with its exit code. Without `--`, print `{"sessionId":"<id>"}` and no token. Resolve the CLI session from `--session`, then `DG_SESSION_ID`, then the one session for the current directory.
- Keep `POST /pair/offer`, `POST /pair/offer/<id>` and `POST /pair/claim` at 404. Add no `dg-daemon pair`, `dg-agent pair`, popup code, QR, paste form, or `code` and `all` branches of `POST /attach`.
- Keep the origin pin and the owner token of ADR 0004 and ADR 0038.
- Update the binaries and the extension together. A mismatched pair does not pair.
