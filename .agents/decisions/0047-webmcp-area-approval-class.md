---
covers: ["pkg/common/src/webmcp-format.ts", "pkg/extension/lib/background/webmcp-approval.ts", "pkg/extension/lib/features/webmcp-grants.ts"]
---

[ADR 0047](../../docs/adr/0047-webmcp-area-approval-class.md)

- Map each area-class tool to its area in `WEBMCP_TOOL_AREAS`. Use area `mail` for `dg_outlook_list` and `dg_outlook_search`, and `mail-body` for `dg_outlook_read`.
- Store an area grant under the synthetic tool key `area:<area>` in the same `{site, tool}` record. Never add an `area` field to the grant record.
- Keep the session store, the signed 30-day remembered store and the revoke messages unchanged for area grants.
- Ask every time for an area-class tool with no known area.
- Never let a `mail` grant cover reading a message body. Require its own `mail-body` grant.
- Say in the approval prompt what the area covers. Name the area in the popup and Options revoke lists.
- Keep the `read` class for a tool that reads nothing private.
