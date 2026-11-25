# Relay protocol

The daemon relays requests from the CLI to the browser extension and carries the answers back. This page is the contract for that wire. The Bun daemon implements it today. The native front door must accept and emit the same frames.

The source of truth is the TypeScript validators in `pkg/common/src` (`chat-format.ts`, `relay-features.ts`, `inbox-format.ts`, `proto-format.ts`, `pw-ext-format.ts`). The shared fixtures in `pkg/common/fixtures/relay` pin the contract. `pkg/common/__tests__/relay-fixtures.spec.ts` runs every fixture through the validators and fails when this page or the fixtures fall behind the code.

## Transports

| Peer | Transport | Frames |
| --- | --- | --- |
| Extension and chat pages | WebSocket `/ws` | Chat frames |
| CLI | WebSocket `/cli` (the CLI sends no browser Origin) | CLI request, cancel and result frames |

Every frame is a JSON object with a string `type`, sent as one WebSocket text message. A frame must not exceed 1,048,576 bytes (`CHAT_MAX_PAYLOAD_BYTES`) once serialized as UTF-8.

## Protocol version

Current protocol version: 1

- Every chat frame carries an integer `protocolVersion`.
- The validator accepts any finite number there. The daemon enforces equality with its own version.
- CLI request and cancel frames may carry `protocolVersion`. When present it must be an integer from 1 to 1.
- There is no range negotiation. A peer on another version cannot talk to the daemon. Both sides must be upgraded together.

### Negotiation

1. The extension opens `/ws` and sends the `connect` frame.
2. The daemon compares `protocolVersion` with its own.
3. On a mismatch the daemon answers with an `error` frame and counts one invalid frame. The message is `protocol version mismatch: daemon expects <daemon>, frame declared <peer>`. The error frame carries no `code`.
4. On a bad session or token the daemon answers with an `error` frame whose `code` is `invalid-session`. A peer that gets `invalid-session` must drop the session.
5. On success the daemon answers with a `session-list` frame.

### `connect` frame

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"connect"` | |
| `sessionId` | string | |
| `token` | string | Session capability |
| `protocolVersion` | number | |
| `extensionVersion` | string, optional | Gates features with a minimum extension version |
| `pwExtVerbs` | string array, optional | At most 64 entries of at most 32 characters. Verbs the extension supports. An extension that omits it gets only the verbs that older extensions already supported. |

The handshake is checked by the daemon only. It is not part of the chat frame validator, so no fixture covers it yet.

## Envelope

Every chat frame has these fields.

| Field | Type | Rule |
| --- | --- | --- |
| `type` | string | One of the ratified frame types |
| `sessionId` | string | Non-empty |
| `protocolVersion` | number | Finite |
| `token` | string | Required on inbound frames, forbidden on outbound frames |

Inbound frames travel from the extension or page to the daemon and carry the session token. The relay inbound types are `inbox-browser-result`, `proto-browser-result`, `proto-browser-progress` and `pw-ext-browser-result`. All other relay frames are outbound.

An unknown `type` fails with `chat frame.type must be one of the ratified discriminants, got <type>`.

## Error frame

An `error` frame is outbound.

| Field | Type | Rule |
| --- | --- | --- |
| `type` | `"error"` | |
| `message` | string | Non-empty |
| `code` | `"invalid-session"`, optional | Any other value is rejected |

## Relay features

Each feature has the same flow.

1. The CLI sends a CLI request frame with a `requestId` of 1 to 128 characters.
2. The daemon checks the request, then sends the matching browser request frame to the one extension peer on the session.
3. The extension may send progress frames, then sends one browser result frame.
4. The daemon sends the CLI a CLI result frame with the same `requestId`.

A browser result has `ok`. When `ok` is true it carries `data` and no `error`. When `ok` is false it carries `error` (a non-empty string of at most 2,048 characters) and no `data`.

The daemon refuses a request, or fails a pending one, with an `ok: false` CLI result. Its fields are `type`, `sessionId`, `requestId`, `ok` and `error`. The messages are the `strings` and `checks` tables in `relay-features.ts`.

### Capacity limits

| Feature | Pending | Per requester | Session request ids |
| --- | --- | --- | --- |
| `inbox` | 128 | 8 | 10,000 |
| `proto` | 32 | 4 | 10,000 |
| `pw-ext` | 16 | 2 | 10,000 |

A `requestId` may be used once per session. A repeat is refused.

### Inbox

Requires extension 1.11.0 or newer.

`cli-inbox-request`: `requestId`, `operation`, optional `timeoutMs` (1 to 120,000), optional `protocolVersion`, plus the fields of the operation. Operations are `profile-get`, `profile-set`, `profile-list`, `cache-get`, `cache-set` and `browser`. Only `browser` goes to the extension. Its `request` object is the browser request body.

`inbox-browser-request`: `requestId` and `request`. The request has an `operation` of `session-status`, `list-folders`, `list-filters`, `list-messages`, `create-folder`, `rename-folder`, `delete-folder`, `create-filter`, `update-filter`, `delete-filter`, `reorder-filters`, `move-messages`, `mark-read` or `unlabel-messages`, plus the fields of that operation. Unsupported fields are rejected.

`inbox-browser-result`: `requestId`, `ok`, and `data` or `error`. `data` may hold `folders`, `filters`, `messages`, `folder`, `filter` and `hasMore`. It must not exceed 786,432 bytes.

`cli-inbox-result`: `sessionId`, `requestId`, and either `ok: true` with `value`, or `ok: false` with `error`.

### Prototype

`cli-proto-request`: `requestId`, `phase` (`scrape` or `plant`), `slug`, `markedUrl` (an http or https URL), optional `timeoutMs` (1 to 900,000), optional `protocolVersion`. The default deadline is 45,000 ms for `scrape` and 900,000 ms for `plant`.

`proto-browser-request`: `requestId`, `phase`, `slug`, `markedUrl`, optional `timeoutMs`.

`proto-browser-progress`: inbound. `requestId` and `status` (non-empty, at most 512 characters).

`proto-browser-result`: `requestId`, `ok`, and one of `data`, `notReady` or `error`. A failed result has exactly one of `error` and `notReady`. `notReady` has `code` (`login-page`, `redirected`, `http-error` or `mount-missing`), `message` and `landedUrl`. `data` is a `style-guide` or a `verdict` payload.

`cli-proto-result`: `sessionId`, `requestId`, and `ok: true` with `data`, or `ok: false` with `notReady` or `error`.

### Browser automation (pw-ext)

Requires dg-ai-extension 1.44.0 or newer. The daemon checks the verb against the `pwExtVerbs` list from the `connect` frame:

- An extension that sent `pwExtVerbs` receives only the verbs in that list. This covers every verb, including the verbs from [ADR 0060](adr/0060-pw-auto-mode-and-ext-verbs-for-the-real-browser.md) such as `eval` and the storage writes.
- An extension that omitted `pwExtVerbs` is refused `count`, `unmask`, `dialog`, `network`, `storage`, `fetch`, `credential`, `press`, `webmcp-tools` and `webmcp-call`. The daemon forwards any other verb, and the extension rejects a verb it does not know.

`cli-pw-ext-request`: `requestId`, `request`, optional `timeoutMs` (1 to 300,000), optional `protocolVersion`. No other field is allowed. The default deadline is 120,000 ms.

`cli-pw-ext-cancel`: `requestId`, optional `protocolVersion`. No other field is allowed.

`pw-ext-browser-request`: `requestId`, `request`, `timeoutMs`. The `request` has a `verb` and only the fields that verb allows. An unknown verb or field is rejected.

`pw-ext-browser-cancel`: outbound. `requestId` only. The daemon sends it when a request times out or the CLI cancels.

`pw-ext-browser-result`: `requestId`, `ok`, and `data` or `error`. `data` has `text` (at most 100,000 characters) and may have `image` (a base64 JPEG or PNG data URL) and `tools`.

`cli-pw-ext-result`: `sessionId`, `requestId`, and `ok: true` with `data`, or `ok: false` with `error`.

## Fixtures

Each file under `pkg/common/fixtures/relay` is language-neutral JSON.

```json
{ "validator": "chat-frame", "frame": { }, "error": "exact validator message" }
```

- `valid/` files hold `validator` and `frame`. The frame must pass.
- `invalid/` files also hold `error`. The frame must fail with exactly that message.
- `validator` is `chat-frame` for frames on `/ws`, `cli-request:<feature>` for a CLI request, or `cli-cancel:<feature>` for a CLI cancel. `<feature>` is `inbox`, `proto` or `pw-ext`.

The native side loads the same files and must reach the same verdict and the same message. Change a frame shape in TypeScript and the fixture test fails until this page and the fixtures change with it.
