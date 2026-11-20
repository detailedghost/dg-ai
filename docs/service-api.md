# Service API v1 (provisional)

A service that the daemon runs can read its own credentials over HTTP. The
service needs no dg code: it needs `fetch`, environment variables and one file
read. Version 1 is provisional. A breaking change arrives as a new environment key or a v2 route. The v1 keys and route are not changed in place.

## Set up a grant

List the credentials of the job in its `credentials` key, then run `dg job enable <name>`.
It stores each credential, writes the token file and starts the job. See
[Credentials: enable and setup](jobs-and-services.md#credentials-enable-and-setup).
The key names keep the word `SERVICE`, such as `DG_SERVICE_API`, although the noun is now job.

dg sets the `grant` of a job that lists credentials. The daemon refuses to start the
job when the token file is missing.

`dg job setup <name> --rotate-token` makes a new token. The old token gives 401.
Restart the job, or read the token file again.

## Environment

The daemon sets these keys for each service. They win over `envFile` and
`passEnv`.

| Key | Value |
| --- | --- |
| `DG_SERVICE_API` | `1` |
| `DG_SERVICE_LABEL` | The service label. It is information, not a proof of identity. |
| `DG_DAEMON_URL` | `http://127.0.0.1:<port>` |
| `DG_SERVICE_STATE_DIR` | The absolute path of `<state>/jobs/<label>/`. The daemon makes the folder (mode 0700 on POSIX) before the service starts, and `service rm` does not remove it. |
| `DG_HOME` | The dg home of the daemon. The daemon injects this key only when it has one. |
| `DG_CREDENTIAL_GRANT_PREFIX` | The grant prefix. Set only when the service has `grant`. |
| `DG_CREDENTIAL_GRANT_FILE` | The absolute path of the token file. Set only when the service has `grant`. |

The environment holds no token. Read the file.

The daemon gives its own `DG_HOME` to each service when it has one, so a
`dg-skills` or `dg-agent` call of the service uses the same dg home. The state
folder is yours to keep files in: the daemon does not read it.

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
- `{"operation":"refresh","name":"<prefix>/<rest>","job":"<job name>"}`

Responses:

- `list`: `{"ok":true,"value":[{"name","meta","updatedAt"}]}`. Only names below
  `<prefix>/` appear. An entry has no `value`.
- `get`: `{"ok":true,"value":{"value","meta","updatedAt"}}`, or
  `{"ok":true,"value":null}` when the name is absent.
- `refresh`: `{"ok":true,"value":{"name","updatedAt"}}`. The answer holds no
  credential value. Send `get` to read the new value.
- Error: `{"ok":false,"error":"<reason>"}`

## Refresh a credential

`refresh` makes the daemon fetch one credential again from the source that the
record holds, and store the new value under the same name. For a repository job
the owner read that source at the consent of `dg job add` or `dg job update`. Two
cases have no such review: a local folder with a `dg` block asks nothing, and
`--yes` gives the consent with no person present. A job uses it when its upstream refuses a stored credential, for
example with HTTP 401. The body keys `operation`, `name` and `job` are
necessary. Each other key gets the 400 answer for an unsupported key. The
request cannot give a secret id, a region, a key, a profile or an argv.

- `name` is `<prefix>/<rest>` and must be a credential that the job lists.
- `job` is the name of a job whose `grant` is the prefix of the request. The job
  reads its own name from `DG_SERVICE_LABEL`. The grant proves the prefix and
  not the job: each holder of the grant can name any job of that prefix, and
  jobs that share a prefix trust each other. This is an accepted risk; see
  [ADR 0052](adr/0052-job-sources-and-credentials.md).
- The credential needs a recorded `source`, and a person must have run
  `dg job setup <job>` once. Without both, the answer is 409. When
  `dg job update` changes the `source` of a credential that a job lists, it
  removes the job from the "setup done" mark and prints
  `next: dg job setup <job>`, so the answer is 409 until a person runs setup
  again.
- The fetch uses the environment of the job that the request names (`envFile`,
  `passEnv` and the allowlist), not the environment of the caller. It runs
  `aws` from the `PATH` of that environment, in the state folder of the job.
- The daemon starts one fetch at most for one credential name in 60 s. A
  request inside that time, or during a fetch, gets 429 with `retryAfter` in
  seconds. A failed fetch counts. The limit is in the memory of the daemon.
- A refresh does not change the grant token and does not restart a job. A job
  that binds the credential to an environment variable gets the new value at its
  next start.
- Each 502 answer ends with `— run dg job setup <job> --refresh`. Run that
  command as the next step: it fetches the value again with the shell of the
  owner and shows the cause.

Example after an upstream answers 401:

```js
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const call = async (body) => {
  const res = await fetch(`${process.env.DG_DAEMON_URL}/service-api/v1/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Dg-Grant-Prefix": process.env.DG_CREDENTIAL_GRANT_PREFIX,
      "X-Dg-Grant-Token": readFileSync(process.env.DG_CREDENTIAL_GRANT_FILE, "utf8").trim(),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const refresh = () =>
  call({ operation: "refresh", name: "bot/api-key", job: process.env.DG_SERVICE_LABEL });
const retryWith = (value) => console.log("retry the upstream call with the new value", value.length);

let refreshed = await refresh();
if (refreshed.status === 429) {
  await sleep(refreshed.body.retryAfter * 1000);
  refreshed = await refresh();
}
if (refreshed.status !== 200) {
  throw new Error(`refresh failed: ${refreshed.status} ${refreshed.body.error ?? ""}`);
}
const { body } = await call({ operation: "get", name: "bot/api-key" });
retryWith(body.value.value);
```

## Status codes

| Status | Meaning | Body |
| --- | --- | --- |
| 200 | Success | JSON |
| 400 | A browser `Origin` header | Plain text |
| 400 | A bad body, a bad key, or an invalid name | JSON |
| 400 | A `Host` header that is not the loopback authority | Plain text |
| 401 | No grant, an unknown prefix, an incorrect token, or a session id header | JSON |
| 403 | A name outside `<prefix>/`, an operation other than `get`, `list` and `refresh`, or a `job` that is not a job of this grant | JSON |
| 409 | `refresh`: the credential has no recorded source, or no person ran `dg job setup <job>` | JSON |
| 429 | `refresh`: one fetch at most for one credential in 60 s; the body has `retryAfter` | JSON |
| 404 | A method other than POST, or another path | Plain text, with the same hardening headers |
| 413 | A body above 64 KiB | JSON |
| 415 | A content type other than `application/json` | Plain text |
| 500 | The credential store failed | JSON |
| 502 | `refresh`: the fetch failed; the text ends with `— run dg job setup <job> --refresh` | JSON |

Do not call `res.json()` on a plain text body.

A 400 for an unsupported body key names the key only for the known frame
fields (`type`, `requestId`, `protocolVersion`, `name`, `value`, `meta`,
`prefix`, `grant`, `job`). Any other key shows as `other`. The route never echoes a
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
