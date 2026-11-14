# Web MCP

Web MCP lets an agent call the WebMCP tools of a page in your real browser,
such as the built-in `dg_` tools of a mail site, instead of clicking through
the page. It is a separate feature from browser control with
[`pw --ext`](pw.md#real-browser---ext). It has its own approvals and its own
revoke.

## How an agent reaches Web MCP

- `dg-agent mcp` serves the `dg_` tools of your own open tabs as an MCP server
  on stdio. Each tool call goes through the dg-daemon to the paired
  dg-ai-extension. It needs no pw --ext session and no agent tab group. It
  shows no "Agent is driving" banner and asks no pw --ext site question.
- `dg-skills pw --ext tools` and `dg-skills pw --ext call <tool> <json-args>`
  still run a tool in a tab of the agent's own tab group, inside a pw --ext
  session.

### Which tabs `dg-agent mcp` uses

- It looks only at tabs whose site an enabled built-in script or an approved
  third-party script covers, such as a signed-in Outlook tab when the Outlook
  script is on. It reads the `dg_` tools those tabs expose. Site tools without
  a `dg_` name are left out.
- It never uses a tab in a private window, a discarded tab, or a browser page.
- It never opens, focuses, moves, groups or reloads a tab, and it adds no
  banner or dialog hook to the page.
- When several tabs expose the tool, the call goes to the active tab of the
  focused window, else to the tab you used most recently.
- It looks at no more than 20 tabs per list or call.
- If no tab exposes the tool, the call fails and asks you to open the site in
  a normal tab.
- pw --ext snapshot, click and the other browser-control verbs still work only
  in the agent's own tab group. They are refused on your other tabs.

## Approvals

The pw --ext site allowlist does not gate Web MCP. Each tool has an approval
class:

| Class | Tools | What happens |
|---|---|---|
| `area` | `dg_` tools that read one area of a site. Mail is `dg_outlook_list` and `dg_outlook_search`; mail-body is `dg_outlook_read` | Asks once; the Allow holds for that MCP session, site and area, so it covers every tool of the area |
| `session` | `dg_` tools that change little, such as `dg_outlook_move` | Asks once; the Allow holds for that MCP session, site and tool |
| `each` | send, delete, reply, forward, event changes, unknown `dg_` tools, third-party tools, and any tool without a `dg_` name | Asks every time |

- The approval popup names the tool, the site, the agent and the arguments.
  For a `dg-agent mcp` call it also names the tab title. On a mail site the
  title is masked, so no subject line shows.
  Deny, no answer in 60 seconds, or a closed window runs nothing.
- A site is the scheme and registrable domain, the same key that the pw --ext
  allowlist uses, so one grant covers `outlook.live.com` and `mail.live.com`.
  A grant is not tied to a tab group.
- One mail `area` grant lets the agent list and search mail on that site. It
  does not cover message bodies. The mail-body area asks apart, also when a
  mail grant holds. The popup says what each grant covers.
- On a mailbox tab, only the enabled built-in `dg_` tools for that site run.
  Other tools are refused or left out of `tools`. The signed-in Proton Mail
  tab is the mailbox tab: pw --ext shows it with no address or title and
  refuses `snapshot`, `click`, `fill` and the other page verbs. Outlook is not
  a mailbox tab.
- `tools` asks nothing. It shows the tool list of any page in the agent's
  group, also a page the tab reached by a link or a redirect. The
  `dg-agent mcp` list also asks nothing. It shows only the `dg_` tool names and
  descriptions, not your tab titles or addresses.
- The MCP session is the dg session that `dg-agent mcp` is paired with. A
  `session` grant holds for repeat calls in that dg session and ends when the
  session ends.

## Remember for 30 days

The popup of a `session` or `area` tool has a "Remember for 30 days" checkbox. It is not
ticked by default.

- Without it, the grant ends when the MCP session ends.
- With it, the grant holds for that site and tool, or that site and area, for
  30 days, for every agent session, also after a browser restart. Use on the grant does not extend it.
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

pw --ext fully controls Outlook pages, like any other page: the site approval,
PII masking and the unmask grant apply, and the title hides the account name
unless an unmask grant holds. The Web MCP tools are an extra, cheaper path:
they run on your own signed-in Outlook tab, through the Web MCP bridge, with
the Web MCP approvals above, and return compact JSON in place of page
snapshots. Agents use both. PR #210 lets Web MCP reach any of your tabs, not
only agent tabs.

| Tool | Class | What it does |
|---|---|---|
| `dg_outlook_list` | `area` (mail) | Newest messages of a folder: id, sender address, date, read, flagged. Subject and preview are masked |
| `dg_outlook_search` | `area` (mail) | The same fields for an Outlook search query over the six distinguished mail folders |
| `dg_outlook_read` | `area` (mail-body) | One message with its subject and its body as plain text, body capped at 50,000 characters and shortened with `truncated: true` when the answer would not fit the output limit; the read state does not change |
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
- List and search never show a subject or a preview. Subject and body text
  show only through `dg_outlook_read`, behind the mail-body approval.
- Sender and recipient fields hold addresses only. The extension masks them
  unless an unmask grant holds. Write tools echo only counts and ids.
- A write tool on several ids reports each id apart. When some ids are stale,
  it acts on the others and returns their ids with an `errors` list of
  `{id, error}` entries, where `error` is the Outlook response code only. It
  fails as a whole only when no id worked.
- Each signed-in account of a browser profile has its own service endpoint
  (`/owa/<n>/service.svc`). The tools keep the sign-in headers of each
  endpoint apart and call only the endpoint of the tab's own account (the
  `<n>` in `/mail/<n>/`, `/calendar/<n>/` and the other routes). A call that
  waited in the queue while the tab switched account is not sent.
- An id list holds at most 50 ids, and `limit` is at most 50. At most 4
  calls run at once in a tab.
- A tool that runs before the page has sent its first service call waits up
  to 10 seconds and then fails with "Outlook is still loading; retry.".
- A failed call of an enabled built-in `dg_` tool shows the agent the tool's
  own error, with addresses masked. This lets the agent tell a retry ("Outlook
  is still loading; retry.", "Outlook refused the request (429)") from bad
  input. The rule follows the built-in ownership check, not the mailbox rule.
  On the Proton Mail mailbox tab, any other page error shows a fixed failure
  text.

## Revoke

The toolbar popup has a "Web MCP grants" section. It lists each active session
grant (session, site, tool) and each remembered grant (site, tool, expiry
date), with a Revoke button per grant and a Revoke all button. A mail area
grant shows as "mail (list and search)", and a mail-body area grant shows as
"mail-body (read message bodies)". The Options MCP tab has the same list. Only
the extension's own popup and Options pages can list or revoke grants.

pw --ext Stop, on the banner or in the toolbar popup, ends browser control
only. It does not revoke Web MCP grants, and it does not stop `dg-agent mcp`
calls on your own tabs. Its `pw --ext tools` and `call` stop with the rest of
browser control. The grants stay until the session ends or you revoke them.

See [ADR 0046](adr/0046-webmcp-approvals-apart-from-pw-ext.md),
[ADR 0047](adr/0047-webmcp-area-approval-class.md) and
[ADR 0048](adr/0048-outlook-mail-webmcp-tools.md).
