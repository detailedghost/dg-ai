# Outlook Web MCP spike (spec 018, slice 2)

Date: 2026-11-13. Hosts: `outlook.live.com` (consumer) and `outlook.cloud.microsoft`
(business; `outlook.office.com` redirects there). Tool: `dg-skills pw --ext` on two
signed-in tabs. The spike did not change mail, folders, contacts or events.

## Evidence legend

- **observed**: seen in this spike with `pw --ext` `current`, `snapshot`, `count` or `tools`.
- **inferred**: public knowledge of OWA. This spike did not see it.
- **unknown**: not seen and not known.

`pw --ext` has no eval, no network view and no header access. An anonymous header
fetch of the hosts was refused in this environment. Thus every service-call detail
in this file is **inferred**. Where this file picks the service path, the reason is
that the DOM path fails the slice 4 tool contract. The service path was not seen.

## Pick table

The ten tools of slice 4 (`WEBMCP_TOOL_CLASSES` in `pkg/common/src/webmcp-format.ts`).

| Command | Pick | Evidence | Risk |
|---|---|---|---|
| `dg_outlook_list` | service | observed: the list is virtualized. Only a small part of the folder's rows render, and rows render only when the tab is in front. The DOM cannot give `limit` up to 50 from a background tab. | inferred action shape (`FindConversation` or `FindItem`) |
| `dg_outlook_search` | service | observed: search is `#topSearchInput`, and its results use the same virtualized list. Same limit problem as list. | inferred endpoint; search can use a separate search API |
| `dg_outlook_read` | service | observed: DOM read needs a route change to `/mail/<folder>/id/<route-id>`. That selects the item, and with default settings it can mark an unread item read. | inferred `GetItem` shape; body is HTML and must go to plain text |
| `dg_outlook_mark_read` | service | observed: ribbon has no "Mark as read" button. Consumer rows have hover buttons "Mark as read"; business rows show none when idle. Labels differ per host. | inferred `UpdateItem` IsRead field |
| `dg_outlook_flag` | service | observed: ribbon "Flag / Unflag" acts on the selection only. Row hover labels are "Flag this message" and "Unflag this message". DOM needs a selection of each id first. | inferred `UpdateItem` Flag field |
| `dg_outlook_move` | service | observed: "Move to" opens a folder picker. The DOM resolves folders by `data-folder-name`, an English display name, and Favorites duplicates folder items. | inferred `MoveItem` with folder ids |
| `dg_outlook_archive` | service | observed: ribbon "Archive" acts on the selection only. | inferred `MoveItem` to distinguished folder `archive` |
| `dg_outlook_delete` | service | observed: ribbon "Delete" acts on the selection. Consumer also renders one hover "Delete" per row. | inferred `DeleteItem` with `MoveToDeletedItems` |
| `dg_outlook_draft` | service | unknown: the compose form was not opened. | inferred `CreateItem` with `SaveOnly` |
| `dg_outlook_reply` | service | observed: reading pane has `menuitem` Reply, Reply all, Forward on both hosts. The compose form was not opened. | inferred `CreateItem` with `ReplyToItem` or `ReplyAllToItem`; this sends mail |

## Shared observations (both hosts)

- observed: both hosts run the same app shell. Ribbon, folder tree, list and reading
  pane have the same roles and labels, with small host differences (below).
- observed: `pw --ext tools` lists zero WebMCP tools on both hosts. The slice 4 rule
  "register only when the page has no own tools" holds today.
- observed: message rows are `div[role="option"][data-convid][aria-posinset]` in
  `[role="listbox"]` inside `[aria-label="Message list"]`. `data-convid` holds a
  conversation id. The element `id` is a 28-character token and is not an item id.
  The route id in `/mail/<folder>/id/<route-id>` is a longer URL-encoded base64 id.
- observed: `pw --ext count` printed these ids without redaction. The slice 4 test
  "an OWA item id round-trips through redactText unchanged" agrees with this.
  These ids link to a real mailbox. Spike notes, logs and test fixtures must use
  made-up ids, never real ones.
- observed: the accessible name of an unread row starts with "Unread" on consumer.
  On business no row name had that prefix while the folder had unread items. Read
  state from the DOM is not reliable on business.
- observed: reading pane selectors, the same on both hosts:
  `[role="document"][aria-label="Message body"]`, `[id^="UniqueMessageBody"]`,
  `[id$="_SUBJECT"]`, `[aria-label^="From:"]`, `[aria-label^="To:"]`,
  `[data-testid="SentReceivedSavedTime"]`. No attachment list was on the item seen.
- observed: no `[role="dialog"]` and no `[role="menu"]` while idle. The delete
  confirmation behavior was not seen.
- observed: no `meta[http-equiv="Content-Security-Policy"]` on either host;
  `script[nonce]` is present, so a header CSP is likely (unknown). A `bootFlights`
  meta names a trusted-types flight. That is a feature flag, not proof of
  `require-trusted-types-for`. Trusted Types enforcement and `connect-src`: unknown.
  Slice 4 must use Trusted-Types-safe DOM APIs in any case.
- observed: preconnect links go to a `cdn.office.net` host and to
  `login.microsoftonline.com` on both hosts, also on consumer. Inferred: both hosts
  get tokens through MSAL.

## Host differences

| Area | Consumer (`outlook.live.com`) | Business (`outlook.cloud.microsoft`) |
|---|---|---|
| Mail route | `/mail/0/<folder>` | `/mail/<folder>` |
| Calendar route | `/calendar/0/view/workweek` | `/calendar/view/workweek` |
| People route | `/people/0/` | `/people/` |
| Ribbon reply | "Reply" plus "Expand to see more respond options" | "Reply", "Reply all", "Forward" buttons |
| Row hover buttons | "Delete", "Mark as read", "Flag this message" on every row | "Flag this message" only while idle |
| Extra frames | one ad `iframe` | none |
| Inferred service base | `/owa/0/service.svc` | `/owa/service.svc` |

## Folders

- observed: folder items are `[role="treeitem"][data-folder-name="<name>"]`. The
  names seen are lowercase English: `inbox`, `drafts`, `sent items`,
  `deleted items`, `junk email`, `archive`. Favorites repeat some of them, so a
  selector can match 2 items. No `data-folder-id` attribute is present.
- observed: the routes `/mail/inbox`, `/mail/sentitems`, `/mail/0/inbox` and
  `/mail/0/archive` open those folders on their host.
- Pick: service. Use distinguished folder ids `inbox`, `archive`, `deleteditems`,
  `junkemail`, `drafts`, `sentitems` (inferred). They do not change with the UI
  language. A custom folder needs `FindFolder` and its folder id (inferred).
- Primary mailbox scope: inferred that a distinguished folder id with no `Mailbox`
  element acts on the signed-in primary mailbox. Shared mailboxes: unknown; none
  were open.

## Auth and headers (all inferred)

- Requests are `POST <base>?action=<Action>&app=Mail` with JSON body
  `{ "__type": "<Action>JsonRequest:#Exchange", "Header": {...}, "Body": {...} }`.
- Headers the page sends: `Action`, `X-OWA-CANARY`, `Authorization: Bearer <token>`
  on MSAL builds, `X-AnchorMailbox`, `X-OWA-SessionId`, `X-Req-Source: Mail`,
  `Content-Type: application/json; charset=utf-8`.
- How the plugin gets them: a MAIN-world `fetch` and `XMLHttpRequest` observer at
  `document_start`, like `pkg/extension/lib/features/inbox-proton-observer.ts`.
  Unlike the Proton headers, `Authorization` and `X-OWA-CANARY` are secrets: a live
  access token and a CSRF canary. Rules for slice 4:
  - Copy headers only from same-origin `service.svc` requests (the Proton
    `trusted(url)` check).
  - Keep the copy in the MAIN-world closure only. Never send it to the isolated
    world, the background or an MCP response. Make the service call in the same realm.
  - Drop the copy when `X-AnchorMailbox` changes (account switch).
  - Never put a header value in error text, logs or storage.
- Token life: unknown. MSAL access tokens usually live about 1 hour (inferred). The
  observer takes the newest value from each page request, so a token refresh by the
  page refreshes the copy.
- Rate limits: unknown. Slice 4 keeps at most 4 calls in flight per tab and maps
  401, 440 and 429 to `Outlook refused the request (<status>)`.

## Full inventory (scope change 2026-11-13)

Picks for the extended scope. "DOM seen" names what the spike saw.

### Mail

| Command | Pick | DOM seen | Inferred service action |
|---|---|---|---|
| list | service | virtualized list | `FindConversation` / `FindItem` |
| search | service | `#topSearchInput` | search query API or `FindItem` with `QueryString` |
| read body | service | reading pane selectors | `GetItem` with `Body` |
| attachments metadata | service | none (no attachment seen) | `GetItem` with `Attachments` |
| mark read / unread | service | consumer hover buttons | `UpdateItem` `IsRead` |
| flag | service | ribbon and hover buttons | `UpdateItem` `Flag` |
| move | service | "Move to" picker | `MoveItem` |
| archive | service | ribbon "Archive" | `MoveItem` to `archive` |
| delete | service | ribbon "Delete" | `DeleteItem` `MoveToDeletedItems` |
| junk | service | ribbon "Report junk" | `MarkAsJunk` |
| categories | service | ribbon "Categorize" (business) | `UpdateItem` `Categories` |
| draft | service | unknown | `CreateItem` `SaveOnly` |
| reply / reply-all / forward | service | pane menu items | `CreateItem` with `ReplyToItem`, `ReplyAllToItem`, `ForwardItem` |
| send | service | unknown | `SendItem` or `CreateItem` `SendAndSaveCopy` |

### Folders

| Command | Pick | DOM seen | Inferred service action |
|---|---|---|---|
| list | service | folder tree with `data-folder-name` | `FindFolder` |
| create | service | none | `CreateFolder` |
| rename | service | none | `UpdateFolder` `DisplayName` |
| delete | service | none | `DeleteFolder` |

### Contacts and people

| Command | Pick | DOM seen | Inferred service action |
|---|---|---|---|
| list | service | consumer: `[role="grid"]` rows; business: empty state | `FindPeople` |
| search | service | search box | `FindPeople` with `QueryString` |
| read | service | not opened | `GetPersona` |
| create | service | ribbon "New contact" | `CreateItem` `Contact` |
| update | service | ribbon "Edit" | `UpdateItem` |
| delete | service | ribbon "Delete" | `DeleteItem` |

### Calendar

| Command | Pick | DOM seen | Inferred service action |
|---|---|---|---|
| list events | service | `[data-calitemid]` event buttons in the work-week view | `GetCalendarView` or `FindItem` with `CalendarView` |
| read event | service | no peek card opened on click | `GetCalendarEvent` / `GetItem` |
| create | service | ribbon "New event" | `CreateItem` `CalendarItem` |
| update | service | none | `UpdateItem` |
| delete | service | none | `DeleteItem` / `CancelCalendarItem` |
| respond (accept, tentative, decline) | service | none (no meeting request seen) | `CreateItem` with `AcceptItem`, `TentativelyAcceptItem`, `DeclineItem` |
| free/busy | service | none | `GetUserAvailability` |

## Proposed tools and approval classes

Classes: `read` (no ask), `area` (ask once per dg session, origin and area, then not
again in that session), `session` (ask once per session, origin and tool, as R-3),
`each` (ask on every call). `area` is new and needs an amendment to R-3.

| Tool | Area | Class |
|---|---|---|
| `dg_outlook_list` | mail | read |
| `dg_outlook_search` | mail | read |
| `dg_outlook_read` | mail | area |
| `dg_outlook_attachments` | mail | area |
| `dg_outlook_mark_read` | mail | session |
| `dg_outlook_flag` | mail | session |
| `dg_outlook_categorize` | mail | session |
| `dg_outlook_move` | mail | session |
| `dg_outlook_archive` | mail | session |
| `dg_outlook_junk` | mail | session |
| `dg_outlook_draft` | mail | session |
| `dg_outlook_delete` | mail | each |
| `dg_outlook_reply` | mail | each |
| `dg_outlook_reply_all` | mail | each |
| `dg_outlook_forward` | mail | each |
| `dg_outlook_send` | mail | each |
| `dg_outlook_folder_list` | mail | read |
| `dg_outlook_folder_create` | mail | session |
| `dg_outlook_folder_rename` | mail | session |
| `dg_outlook_folder_delete` | mail | each |
| `dg_outlook_contact_list` | contacts | area |
| `dg_outlook_contact_search` | contacts | area |
| `dg_outlook_contact_read` | contacts | area |
| `dg_outlook_contact_create` | contacts | session |
| `dg_outlook_contact_update` | contacts | session |
| `dg_outlook_contact_delete` | contacts | each |
| `dg_outlook_event_list` | calendar | area |
| `dg_outlook_event_read` | calendar | area |
| `dg_outlook_freebusy` | calendar | area |
| `dg_outlook_event_create` | calendar | each |
| `dg_outlook_event_update` | calendar | each |
| `dg_outlook_event_delete` | calendar | each |
| `dg_outlook_event_respond` | calendar | each |

Event create, update, delete and respond are `each` because they can send mail to
attendees. Open point: list and search return subjects and previews. This table
keeps them `read`; the alternative is `area` for mail too. The security review
recommends `area`, so that no agent reads subjects and previews without one ask.

## Origins

`outlook.cloud.microsoft` is a third origin. Slice 4 must add it in three places:

1. `BUILT_IN_SCRIPTS[outlook].matches` in `pkg/common/src/webmcp-format.ts`. Today
   `approvalClassOf` and `mailboxToolAllowed` give class `each` to, or refuse, every
   `dg_outlook_` tool on the business tab, because `patternCoversOrigin` does not
   cover this origin.
2. `mailbox()` in `pkg/extension/lib/background/tab-guards.ts`, with
   `outlook.office.com` and `outlook.live.com`.
3. The slice 4 tests for `mailbox()` and for the content script matches.

## Risks

- Every service shape is inferred. Slice 4 must confirm the action names, header
  names and body keys on a live tab before release.
- DOM selectors use English aria labels and English `data-folder-name` values. A
  non-English UI breaks label selectors. Use roles and data attributes, not labels.
- Class names are generated and change per build; this file names none.
- The message list is virtualized and renders only in a front tab.
- No write was done. Each write path is unproven on both hosts.

## Open items for the human

- Service shapes: capture action names, header names and JSON keys (values removed)
  from DevTools Network on one tab, or let slice 4's observer log names only. If the
  observer logs, a test must prove that no header or body value reaches the log, and
  the logging goes before release.
- Approval class `area` and the R-3 amendment; whether list and search are `area`.
- A throwaway message, contact and event for write proof.
