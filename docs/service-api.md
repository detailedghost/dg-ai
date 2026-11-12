# Service API v1 (provisional)

A service that the daemon runs can read its own credentials over HTTP. The
service needs no dg code: it needs `fetch`, environment variables and one file
read. Version 1 is provisional. The shape can change before it is final.

## Set up a grant

Run the steps in this order.

1. `dg-agent start`. The credential commands use the `/cli` socket, and the
   socket needs a dg session. `dg-daemon start` gives no session.
2. `dg-skills credentials set <prefix>/<name>` for each credential.
3. `dg-skills credentials grant <prefix>`. This writes the token file.

Declare the service with `"grant": "<prefix>"`. The daemon refuses to start the
service when the token file is missing.

A new `dg-skills credentials grant <prefix>` replaces the token. The old token
gives 401. Restart the service, or read the token file again.

## Environment

The daemon sets these keys for each service. They win over `envFile` and
`passEnv`.

| Key | Value |
| --- | --- |
| `DG_SERVICE_API` | `1` |
| `DG_SERVICE_LABEL` | The service label. It is information, not a proof of identity. |
| `DG_DAEMON_URL` | `http://127.0.0.1:<port>` |
| `DG_CREDENTIAL_GRANT_PREFIX` | The grant prefix. Set only when the service has `grant`. |
| `DG_CREDENTIAL_GRANT_FILE` | The absolute path of the token file. Set only when the service has `grant`. |

The environment holds no token. Read the file.

A later transport arrives as a new environment key. It does not change v1.

## Route

`POST <DG_DAEMON_URL>/service-api/v1/credentials`

Headers:

- `X-Dg-Grant-Prefix`: the prefix
- `X-Dg-Grant-Token`: the token, read from the file and trimmed
- `Content-Type: application/json`

Do not send `X-Dg-Session-Id` or an `Origin` header.

Request bodies:

- `{"operation":"list"}`
- `{"operation":"get","name":"<prefix>/<rest>"}`

Responses:

- `list`: `{"ok":true,"value":[{"name","meta","updatedAt"}]}`. Only names below
  `<prefix>/` appear. An entry has no `value`.
- `get`: `{"ok":true,"value":{"value","meta","updatedAt"}}`, or
  `{"ok":true,"value":null}` when the name is absent.
- Error: `{"ok":false,"error":"<reason>"}`

## Status codes

| Status | Meaning | Body |
| --- | --- | --- |
| 200 | Success | JSON |
| 400 | A browser `Origin` header | Plain text |
| 400 | A bad body, a bad key, or an invalid name | JSON |
| 400 | A `Host` header that is not the loopback authority | Plain text |
| 401 | No grant, an unknown prefix, an incorrect token, or a session id header | JSON |
| 403 | A name outside `<prefix>/`, or an operation other than `get` and `list` | JSON |
| 404 | A method other than POST, or another path | Plain text, with the same hardening headers |
| 413 | A body above 64 KiB | JSON |
| 415 | A content type other than `application/json` | Plain text |
| 500 | The credential store failed | JSON |

Do not call `res.json()` on a plain text body.

A 400 for an unsupported body key names the key only for the known frame
fields (`type`, `requestId`, `protocolVersion`, `name`, `value`, `meta`,
`prefix`, `grant`). Any other key shows as `other`. The route never echoes a
part of the request.

## Example

```js
import { readFileSync } from "node:fs";

const token = readFileSync(process.env.DG_CREDENTIAL_GRANT_FILE, "utf8").trim();
const res = await fetch(`${process.env.DG_DAEMON_URL}/service-api/v1/credentials`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Dg-Grant-Prefix": process.env.DG_CREDENTIAL_GRANT_PREFIX,
    "X-Dg-Grant-Token": token,
  },
  body: JSON.stringify({ operation: "get", name: "bot/api-key" }),
});
if (!res.ok) throw new Error(await res.text());
const body = await res.json();
const value = body.value?.value;
if (value === undefined) throw new Error("credential not found");
```

## Limits

A grant limits the route to one prefix. It is not a sandbox. A process of the
same OS user can read each token file.
