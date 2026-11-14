# Web MCP

Web MCP lets an agent call the WebMCP tools of a page in your real browser,
such as the built-in `dg_` tools of a mail site, instead of clicking through
the page. It is a separate feature from browser control with
[`pw --ext`](pw.md#real-browser---ext). It has its own approvals and its own
revoke.

## How an agent reaches Web MCP

- `dg-agent mcp` serves the `dg_` tools of the agent's tabs as an MCP server
  on stdio. Each tool call goes through the dg-daemon to the paired
  dg-ai-extension.
- `dg-skills pw --ext tools` and `dg-skills pw --ext call <tool> <json-args>`
  are the CLI bridge to the same tools.
- Both run the tool in a tab of the agent's own tab group. The agent gets those
  tabs through `pw --ext open` or `new`, or when you hand it a tab in the
  extension popup.

## Approvals

The pw --ext site allowlist does not gate Web MCP. Each tool has an approval
class:

| Class | Tools | What happens |
|---|---|---|
| `area` | `dg_` tools that read one area of a site. Mail is `dg_outlook_list` and `dg_outlook_search`; mail-body is `dg_outlook_read` | Asks once; the Allow holds for that MCP session, site and area, so it covers every tool of the area |
| `session` | `dg_` tools that change little, such as `dg_outlook_move` | Asks once; the Allow holds for that MCP session, site and tool |
| `each` | send, delete, reply, forward, event changes, unknown `dg_` tools, third-party tools, and any tool without a `dg_` name | Asks every time |

- The approval popup names the tool, the site, the agent and the arguments.
  Deny, no answer in 60 seconds, or a closed window runs nothing.
- A site is the scheme and registrable domain, the same key that the pw --ext
  allowlist uses, so one grant covers `outlook.live.com` and `mail.live.com`.
  A grant is not tied to a tab group.
- One mail `area` grant lets the agent list and search mail on that site. It
  does not cover message bodies. The mail-body area asks apart, also when a
  mail grant holds. The popup says what each grant covers.
- On a mailbox tab, only the enabled built-in `dg_` tools for that site run.
  Other tools are refused or left out of `tools`. Signed-in Proton Mail and
  Outlook tabs are mailbox tabs: pw --ext shows them with no address or
  title and refuses `snapshot`, `click`, `fill` and the other page verbs.
- `tools` asks nothing. It shows the tool list of any page in the agent's
  group, also a page the tab reached by a link or a redirect.

## Remember for 30 days

The popup of a `session` or `area` tool has a "Remember for 30 days" checkbox. It is not
ticked by default.

- Without it, the grant ends when the MCP session ends.
- With it, the grant holds for that site and tool, or that site and area, for
  30 days, for every agent session, also after a browser restart. Use on the
  grant does not extend it.
- An `each` tool never shows the checkbox and never stores a grant.
- Remembered grants live in the extension's `storage.local`, each one signed
  with the extension's HMAC key from IndexedDB. Each record also carries a
  random nonce that must still be in the extension's own IndexedDB. A record
  with a bad or missing signature, a revoked nonce, or a past expiry grants
  nothing, so a revoked grant cannot be written back.
- Removing the extension or clearing its data removes them.

## Outlook on the web

The Outlook built-in is off by default. Turn it on in the Options MCP tab. It
runs on `outlook.live.com`, `outlook.office.com`, `outlook.office365.com` and
`outlook.cloud.microsoft`, and adds these tools when the page has no WebMCP
tools of its own:

| Tool | Class | What it does |
|---|---|---|
| `dg_outlook_list` | `area` (mail) | Newest messages of a folder: id, subject, sender address, date, read, flagged, preview |
| `dg_outlook_search` | `area` (mail) | The same fields for an Outlook search query over the six distinguished mail folders |
| `dg_outlook_read` | `area` (mail) | One message as plain text, body capped at 50,000 characters; the read state does not change |
| `dg_outlook_mark_read` | `session` | Marks messages read or unread |
| `dg_outlook_flag` | `session` | Flags or unflags messages |
| `dg_outlook_move` | `session` | Moves messages to a folder by its distinguished id or exact name |
| `dg_outlook_archive` | `session` | Moves messages to Archive |
| `dg_outlook_draft` | `session` | Saves a plain-text draft; nothing is sent |
| `dg_outlook_delete` | `each` | Moves messages to Deleted Items, never a permanent delete |
| `dg_outlook_reply` | `each` | Sends a plain-text reply or reply to all |

- The tools call the Outlook web service from the page with the sign-in
  headers that the page itself sends. Those headers stay in the page and never
  reach the extension background, the agent or a log.
- Sender and recipient fields hold addresses only. The extension masks them
  unless an unmask grant holds. Write tools echo only counts and ids.
- An id list holds at most 50 ids, and `limit` is at most 50. At most 4
  calls run at once in a tab.
- A tool that runs before the page has sent its first service call waits up
  to 10 seconds and then fails with "Outlook is still loading; retry.".
- A failed call of an enabled built-in `dg_` tool shows the agent the tool's
  own error, with addresses masked. This lets the agent tell a retry ("Outlook
  is still loading; retry.", "Outlook refused the request (429)") from bad
  input. Any other page error on a mailbox tab, such as a failed tool list,
  shows a fixed failure text.

## Revoke

The toolbar popup has a "Web MCP grants" section. It lists each active session
grant (session, site, tool) and each remembered grant (site, tool, expiry
date), with a Revoke button per grant and a Revoke all button. A mail area
grant shows as "mail (list and search)", and a mail-body area grant shows as
"mail-body (read message bodies)". The Options MCP tab has the same list. Only
the extension's own popup and Options pages can list or revoke grants.

pw --ext Stop, on the banner or in the toolbar popup, ends browser control
only. It does not revoke Web MCP grants. After Stop the session's tabs return
to you, so its Web MCP calls have no tab to run in, but its grants stay until
the session ends or you revoke them.

See [ADR 0046](adr/0046-webmcp-approvals-apart-from-pw-ext.md) and
[ADR 0047](adr/0047-webmcp-area-approval-class.md).
