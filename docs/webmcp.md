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
| `read` | `dg_` tools that only read, such as `dg_outlook_list` | Runs with no question |
| `session` | `dg_` tools that change little, such as `dg_outlook_move` | Asks once; the Allow holds for that MCP session, site and tool |
| `each` | send, delete, reply, forward, event changes, unknown `dg_` tools, third-party tools, and any tool without a `dg_` name | Asks every time |

- The approval popup names the tool, the site, the agent and the arguments.
  Deny, no answer in 60 seconds, or a closed window runs nothing.
- A site is the scheme and registrable domain, the same key that the pw --ext
  allowlist uses, so one grant covers `outlook.live.com` and `mail.live.com`.
  A grant is not tied to a tab group.
- On a mailbox tab, only the enabled built-in `dg_` tools for that site run.
  Other tools are refused or left out of `tools`.

## Remember for 30 days

The popup of a `session` tool has a "Remember for 30 days" checkbox. It is not
ticked by default.

- Without it, the grant ends when the MCP session ends.
- With it, the grant holds for that site and tool for 30 days, for every agent
  session, also after a browser restart. Use on the grant does not extend it.
- An `each` tool never shows the checkbox and never stores a grant.
- Remembered grants live in the extension's `storage.local`, each one signed
  with the extension's HMAC key from IndexedDB. A record with a bad or missing
  signature, or past its expiry, grants nothing.
- Removing the extension or clearing its data removes them.

## Revoke

The toolbar popup has a "Web MCP grants" section. It lists each active session
grant (session, site, tool) and each remembered grant (site, tool, expiry
date), with a Revoke button per grant and a Revoke all button. Only the
extension's own popup page can list or revoke grants.

pw --ext Stop, on the banner or in the toolbar popup, ends browser control
only. It does not revoke Web MCP grants. After Stop the session's tabs return
to you, so its Web MCP calls have no tab to run in, but its grants stay until
the session ends or you revoke them.

See [ADR 0046](adr/0046-webmcp-approvals-apart-from-pw-ext.md).
