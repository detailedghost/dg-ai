---
covers: ["pkg/extension/lib/features/webmcp-outlook/**", "pkg/extension/lib/features/request-header-tap.ts", "pkg/extension/entrypoints/webmcp-outlook-main.content.ts"]
---

[ADR 0048](../../docs/adr/0048-outlook-mail-webmcp-tools.md)

- Implement Outlook mail tools with OWA service calls. Never use DOM automation.
- Keep OWA session headers of same-origin `service.svc` requests in the page closure, one copy per endpoint path (`/owa/<n>/service.svc`). Drop only that endpoint's copy on an anchor change.
- Post each call to the endpoint of the tab's own account, from the `<n>` of the page route, or `/owa/service.svc` with no index. Send only the headers held for that endpoint.
- Run at most 4 calls in flight per tab. Never send a queued call whose signal aborted or whose tab or endpoint switched to another account.
- Fail a call only when no response message succeeded.
- Never ask Outlook for the subject or preview in list and search. Return id, sender address, date, read and flag state.
- Search with one `FindItem` over the six distinguished folders and a case-insensitive `Subject` substring restriction. Never use a `QueryString`.
- Show a failed search folder as a code-only error.
- Return the subject and plain-text body only from read. Shorten it so the serialized answer, measured after the address mask, stays under the output cap as valid JSON.
- Return the ids that worked and a code-only error per failed id from a write tool on several ids.
- Pass the error of an enabled built-in tool to the agent through `maskRaw`, following `mailboxToolAllowed`, not `mailbox()`.
- Never make tool code depend on the tab group of the tab.
- Keep the built-in off by default.
