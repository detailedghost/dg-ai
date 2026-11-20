---
covers: ["pkg/extension/lib/background/webmcp-approval.ts", "pkg/extension/lib/background/webmcp-grant-nonces.ts", "pkg/extension/lib/background/webmcp-signing.ts", "pkg/extension/lib/background/pw-ext.ts", "pkg/extension/lib/background/approval.ts", "pkg/extension/lib/background/daemon-link.ts", "pkg/extension/lib/features/popup.ts", "pkg/extension/entrypoints/approve/main.ts"]
---

[ADR 0046](../../docs/adr/0046-webmcp-approvals-apart-from-pw-ext.md)

- Gate Web MCP `call` only with Web MCP approvals from `requestWebMcpApproval`. Skip the pw --ext site question for `tools` and `call` (`NO_SITE_ASK`).
- Apply the tool class: `read` runs, `area` and `session` ask once, `each` asks every time. Treat a tool with no `dg_` name as `each`.
- Key a Web MCP grant by session, registrable-domain site (`siteOf`) and tool. Never include a tab group.
- Offer an unticked "Remember for 30 days" checkbox only on a `session` approval popup. Never remember `each` tools.
- Store a remembered grant in `storage.local` with site, tool, approval time, expiry time, a random nonce and an HMAC over a `webmcp-grant:v1` payload. Use the non-extractable key of `webmcp-signing.ts`.
- Keep live nonces in the extension origin's IndexedDB, with site and tool. Make Revoke delete every nonce of that site and tool there.
- Never extend a remembered grant on use.
- End session grants with the dg session (`forgetAgentTabs`). Never end Web MCP grants on pw --ext Stop.
- List grants in the toolbar popup with Revoke and Revoke all. Answer those messages only from the extension's own `popup.html` (`isOwnPageSender`).
- Carry `webmcp-tools` and `webmcp-call` as relay verbs with no tab id (`PW_EXT_WEBMCP_VERBS`). Refuse them when an older extension does not list them.
- Scan only the person's tabs that an enabled built-in script or an approved, validly signed third-party script covers. Skip private-window, discarded and browser-page tabs. Read at most 20 tabs and list at most 100 tools.
- Read only `dg_` tools. On a mailbox tab, read only those of an enabled built-in that covers it.
- Never open, focus, move or group a tab for a Web MCP call. Never add a banner or dialog shim, and never ask a pw --ext site question for it.
- Send a call to the first tab that exposes the tool: the active tab of the focused window, then the most recently used tab.
- Refuse the Web MCP verbs for a session after pw --ext Stop.
- Return tool names and descriptions only in the list. Mask the tab title on mail sites with the `pw --ext tabs` rule.
- Store an area grant under the synthetic tool key `area:<area>` in the same `{site, tool}` record (ADR 0047).
