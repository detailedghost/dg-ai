---
covers: ["pkg/extension/lib/features/pw-ext-banner.ts", "pkg/extension/lib/background/session-control.ts", "pkg/extension/lib/background/site-key.ts", "pkg/extension/lib/background/approval.ts", "pkg/extension/lib/background/popup-sender.ts", "pkg/extension/lib/background/dialog-shim.ts", "pkg/extension/lib/features/popup.ts"]
---

[ADR 0045](../../docs/adr/0045-pw-ext-driving-banner-and-sites.md)

- Show the "Agent is driving this tab" banner in each agent tab, in the isolated world, with its text in a closed shadow root. Give it the lifecycle of the dialog shim.
- Render the banner as a compact pill fixed 12 pixels from the bottom-left corner, at most 440 pixels wide. Never change page styles or push page content.
- Set the group title as text, never HTML. Strip control and format characters and cap it at 40 characters. Show the short session id when the title is empty.
- Send the Stop message only from a trusted click. Accept it only from this extension and from a tab.
- Accept the popup Stop (`MSG.pwExtStop`) only from the extension's own `popup.html`, by sender id and URL, and only for a session that holds an agent tab group.
- Make Stop mark the session stopped in `storage.session`, end its verbs in flight, drop its unmask grants and allowed sites, and forget its agent tab record. Fail each later verb of that session with an error that names Stop.
- Never make Stop drop Web MCP grants.
- Ask the person once per site and session before the first verb on a new http or https origin. Make `open` and `new` ask for their target origin. Never ask for `tabs`, `select` and `close`.
- Never let the site allowlist gate `tools` and `call`.
- Run the mailbox guard before the site question.
- Key each allowed site by scheme and registrable domain (eTLD+1) from `siteOf` in `site-key.ts`, with the Public Suffix List private section. Keep a non-default port in the key.
- Key an IP address, `localhost`, a single-label host, a bare public suffix and a host with a trailing dot by exact origin, port included.
- Share one popup between concurrent verbs that ask for one site of one session. After a Deny, fail verbs sent before the answer with no new popup.
- Import `tldts` only in the background worker. Bump `tldts` and `tldts-core` together.
