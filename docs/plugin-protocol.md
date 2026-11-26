# Plugin protocol v1

One contract for every plugin transport. Bun and C# read the same manifest, the same `[plugins.<name>]` section and the
same fixtures in `pkg/common/fixtures/plugins`. See [ADR 0059](adr/0059-dg-plugins-are-built-in-or-external-with-one-transport-contract.md).

The reference code is `pkg/common/src/plugins/` (`manifest.ts`, `contract.ts`, `config.ts`). The C# side (`native/src/Dg.Core/Plugins`)
and the Bun IPC transport must match the fixtures byte for byte.

## Binary frame

Every message on IPC, TCP and UDP is one frame: a fixed 12-byte header and a payload. All integers are **big-endian**
(network order) and unsigned.

| Offset | Width | Field | Meaning |
| --- | --- | --- | --- |
| 0 | 1 byte (u8) | version | Protocol version. Always `1`. |
| 1 | 1 byte (u8) | encoding | `0` = UTF-8 JSON, `1` = MessagePack. |
| 2 | 2 bytes (u16) | flags | Bit 0 (`0x0001`) response. Bit 1 (`0x0002`) error. Bit 2 (`0x0004`) event, no reply expected. Bits 3 to 15 are reserved and must be zero. |
| 4 | 4 bytes (u32) | request id | Chosen by the sender of a request. A response repeats it. Events use `0`. |
| 8 | 4 bytes (u32) | length | Payload size in bytes. |
| 12 | `length` bytes | payload | One message in the frame's encoding. |

Rules:

- Write the header and payload in one buffer with one write, and set `TCP_NODELAY`. Two writes cost about 41 ms (Nagle and delayed ACK).
- The payload limit is 1,048,576 bytes (1 MiB). A UDP frame, header included, is at most 1,200 bytes.
- A reader that sees a bad version, an unknown encoding, a reserved flag bit or a length over the limit closes the connection.
- A decoder that is given a whole buffer rejects a buffer that is shorter or longer than `12 + length`.
- HTTP does not use frames. The body is the payload, the URL path is the route, and `Content-Type` is `application/json` or `application/msgpack`.

### Decode errors

The stable code is the word after `frame` in the error text: `dg plugin: frame <code>: ...`.

| Code | Cause |
| --- | --- |
| `short-header` | Fewer than 12 bytes. |
| `bad-version` | Version is not 1. |
| `bad-encoding` | Encoding is not 0 or 1. |
| `reserved-flags` | A bit outside `0x0007` is set. |
| `oversize` | Length is over 1 MiB. Checked before the payload is read. |
| `truncated-payload` | Fewer payload bytes than `length`. |
| `trailing-bytes` | More bytes than `12 + length`. |

### Worked example

The payload `{}` as a request with id 2, JSON, no flags:

```
01        version 1
00        encoding json
00 00     flags none
00 00 00 02   request id 2
00 00 00 02   length 2
7b 7d     "{}"
```

Hex: `0100000000000002000000027b7d`.

### Fixtures

`pkg/common/fixtures/plugins/frames/frames.json` holds `valid` and `invalid` frames as lowercase hex.

- A valid entry has `version`, `encoding`, `flags`, `requestId`, `hex` and either `payloadText` (JSON) or `payloadHex`.
  A decoder must return those fields. An encoder given them must produce `hex` exactly.
- An invalid entry has `hex` and the expected `error` code.

## Messages

The payload of a request frame is `{ "route": "<route>", "body": { ... } }`. The payload of a response frame is the
route's response body. A response with the error flag holds `{ "code": "<string>", "message": "<string>" }`.
On HTTP the route is the URL path and the request body is the payload's `body`.

`hello` is always JSON and is the first request on a connection. It negotiates the encoding. After the response, both
sides use the chosen encoding.

| Route | Request body | Response body |
| --- | --- | --- |
| `/v1/hello` | `protocol` (1), `encodings` (list, must hold `json`), `capabilities` (list), `token` (optional) | `protocol` (1), `encoding` (`json` or `msgpack`), `capabilities` (list) |
| `/v1/hook/decide` | `event`, `tool` (optional), `input` (optional object) | `decision` (`allow`, `deny`, `ask`), `reason` (optional) |
| `/v1/job/run` | `job`, `args` (optional list of strings) | `runId` |
| `/v1/job/status` | `runId` | `state` (`queued`, `running`, `succeeded`, `failed`), `exitCode` (optional integer) |
| `/v1/skill/describe` | none (`{}`) | `name`, `description`, `files` (list) |
| `/v1/health` | none (`{}`) | `status` (`ok`, `degraded`), `version` |

Message fixtures are in `fixtures/plugins/messages`. Each file holds `route`, `direction` and `body`. Files under
`invalid` also hold `expect.key` and `expect.includes`: the error names that key and contains that text.

### Timeouts and budgets

| Route | Timeout |
| --- | --- |
| `/v1/hello`, `/v1/health` | 1 s |
| `/v1/hook/decide`, `/v1/job/status`, `/v1/skill/describe` | 2 s |
| `/v1/job/run` | 10 s |

Latency budget for `/v1/hook/decide` at p99, warm connection: IPC 1 ms, TCP 2 ms, HTTP 5 ms.
dg keeps one warm connection per plugin and never starts a process per call.

## Authentication

- **IPC**: file permissions. A Unix socket is mode `0600`. A named pipe has a user-only ACL.
- **HTTP and TCP**: a per-plugin token from the credential store, under the credential name `plugin-<name>-token`.
  HTTP sends `Authorization: Bearer <token>`. TCP sends the token in the `hello` request, and the plugin closes the
  connection if it is wrong. The TOML holds only a credential reference, never the token. Tokens never appear in URLs or logs.
- **Remote**: a manifest with `remote = true` and the `http` transport with an `https` endpoint. dg connects only if
  `config.toml` also has `[plugins.<name>] allow_remote = true`. A downloaded manifest cannot opt itself in.
  Non-loopback hosts are refused without `remote = true`. TCP and UDP are local only.

### TCP loopback trade-off

On TCP, any local process can listen on the port first and receive the token that dg sends in the `hello`
request. An authenticated plugin must use IPC, where file permissions guard the socket. Use TCP only for
plugins that hold no secret.

## plugin.toml

```toml
name = "secret-scan"          # lowercase letters, digits, hyphens
version = "0.3.1"             # semantic version
kind = "hook"                 # hook | job | skill
transport = "ipc"             # ipc (default) | http | tcp | udp
endpoint = "secret-scan.sock" # required for http, tcp, udp
remote = false                # true only for an https endpoint
source = "https://github.com/example/dg-secret-scan"
commit = "0123456789abcdef0123456789abcdef01234567"  # or sha256 = "<64 hex>"

[entry]
command = "dg-secret-scan"    # or builtin = "<id>", exactly one
args = ["--serve"]

[capabilities]
network = false
fs_read = ["."]
fs_write = []
exec = ["git"]

[permissions]
credentials = ["plugin-secret-scan-token"]
env = ["HOME"]
```

- A skill, and any plugin with a `source`, must carry a `sha256` or a `commit` pin. Set only one.
- A built-in plugin has no endpoint and is never remote.
- Every error reads `dg plugin: <file>:<line>: <message>. Next: <step>.` The line is the key's line, or 1 when the key is missing.
- Invalid manifest fixtures list the expected line, key and text in `fixtures/plugins/manifests/invalid/expected.json`.

## config.toml

`[plugins.<name>]` holds `enabled`, `source`, `settings` and `allow_remote`. A plugin with no section is disabled.
Secrets in `settings` are credential references `{ credential = "<name>" }` only.

## Permissions

dg enforces what it can for an external plugin: the exec allowlist, the working directory, the environment, timeouts,
and no credential access unless declared. It cannot enforce the network or file access of an external process. `dg plugin verify`
lists both groups (`permissionReport`). OS sandboxing is a later bundle.

## Skills and trust

An imported skill is pinned by commit or sha256 and is untrusted until the user approves it. Any change needs approval again.
Helper commands run only after approval. Plugin and skill text is never an instruction to the agent.
