# Connection Credentials

Each connection is one encrypted credential named `db/<conn>`. Use `dg-skills db setup` first. It writes the credential and its meta keys, then runs `dg-skills db test`. The raw `credentials set` recipes below stay for manual use.

## Setup

```bash
dg-skills db setup my-pg --engine postgresql --host 127.0.0.1 --port 5432 \
  --database mydb --user readonly --secret form
dg-skills db setup my-sf --engine snowflake --account ACCT-ID --user me \
  --auth keypair --private-key-path ~/.snowflake/rsa_key.p8 --secret command
dg-skills db setup my-aws --engine postgresql --host 127.0.0.1 --port 5432 \
  --database mydb --user readonly --secret aws \
  --secret-id prod/db --secret-key password --aws-region us-east-1
```

Flags: `--engine`, `--host`, `--port`, `--database`, `--schema`, `--user`, `--account`, `--warehouse`, `--role`, `--auth`, `--private-key-path`, `--read-only`, `--no-read-only`, `--secret`, `--secret-id`, `--secret-key`, `--aws-profile`, `--aws-region`, `--session`.

PostgreSQL supports only `--auth password`. Snowflake `--auth external_browser` needs no `--secret`.

## Meta keys

| Key | Meaning |
|---|---|
| `readOnly` | `true` by default. PostgreSQL sessions start read-only, and `--write` is refused. Snowflake relies on the role. |
| `secretSource` | `aws-sm` when the secret lives in AWS Secrets Manager. Absent otherwise. |
| `secretId` | Secrets Manager secret name or ARN. |
| `secretKey` | JSON key inside the secret that holds the value. |
| `awsProfile` | Optional. Passed to `asm-exec` as `AWS_PROFILE`. |
| `awsRegion` | Optional. Passed to `asm-exec` as `AWS_REGION`. |

An `aws-sm` connection stores the placeholder `aws-sm` as its value. Each db verb re-runs under `asm-exec`, which resolves the real secret at run time.

## Raw credentials recipes

The credential store requires a non-empty value. Snowflake `external_browser` has no password, so store the literal placeholder `external_browser`. The db command recognizes that authentication mode and never passes the placeholder to Snowflake or logs it.

## PostgreSQL password

```bash
dg-skills credentials set db/my-pg \
  --meta engine=postgresql \
  --meta host=localhost \
  --meta port=5432 \
  --meta database=mydb \
  --meta user=readonly
```

## Snowflake external browser (SSO)

```bash
printf '%s\n' external_browser | dg-skills credentials set db/my-sf \
  --meta engine=snowflake \
  --meta account=ACCT-ID \
  --meta user=user@example.test \
  --meta authenticator=external_browser \
  --meta role=DEVELOPER \
  --meta database=MY_DB \
  --meta schema=RAW \
  --meta warehouse=COMPUTE_WH \
  --meta clientStoreTemporaryCredential=true \
  --meta browserActionTimeout=300000
```

The IdP login URL is always printed to **stderr** before the browser is launched, so SSO still works with no DISPLAY, no TTY, or a browser that fails to open. stdout stays clean for TSV and JSON parsing. Under WSL the URL is handed to the Windows host (`wslview`, then `explorer.exe`, then `powershell.exe`).

Auto-launch is best-effort. With no `wslview` on PATH it falls to `explorer.exe`, which can fail silently with the long SAML URLs some identity providers issue. The printed URL is always the fallback.

Each connect retry mints a **new** `SAMLRequest`; only the last printed URL is valid.

`clientStoreTemporaryCredential=true` caches the ID token so later non-interactive callers can skip the browser. Prime it once with `dg-skills db test my-sf`.

`browserActionTimeout` is measured in milliseconds and defaults to 120000 in the Snowflake SDK. Lower it for automated callers or raise it for slower SSO and MFA.

## Snowflake key pair

The credential value is the private-key passphrase. Only the key's path is stored as metadata; the key contents never enter the credential store.

```bash
dg-skills credentials set db/my-sf-key \
  --meta engine=snowflake \
  --meta account=ACCT-ID \
  --meta user=svc_account \
  --meta authenticator=snowflake_jwt \
  --meta privateKeyPath=~/.snowflake/rsa_key.p8 \
  --meta role=SVC_ROLE \
  --meta database=MY_DB \
  --meta schema=PUBLIC \
  --meta warehouse=COMPUTE_WH
```

The key file must have mode 600 or 400. `~` at the beginning of `privateKeyPath` expands to the current home directory.

## Snowflake password

```bash
dg-skills credentials set db/my-sf-password \
  --meta engine=snowflake \
  --meta account=ACCT-ID \
  --meta user=analyst \
  --meta database=MY_DB \
  --meta schema=PUBLIC \
  --meta warehouse=COMPUTE_WH
```

There is no `connections.json` fallback and no `${VAR}` interpolation. Update a connection by setting the same credential name again.
