# Connection Credentials

Each connection is one encrypted credential named `db/<conn>`. Its secret value is read from stdin or a hidden prompt; non-secret connection fields are repeated as `--meta key=value`.

The credential store requires a non-empty value. Snowflake `external_browser` has no password, so store the literal placeholder `external_browser`. The db command recognizes that authentication mode and never passes the placeholder to Snowflake or logs it.

## PostgreSQL password

```bash
~/.dg/bin/dg-skills credentials set db/my-pg \
  --meta engine=postgresql \
  --meta host=localhost \
  --meta port=5432 \
  --meta database=mydb \
  --meta user=readonly
```

## Snowflake external browser (SSO)

```bash
printf '%s\n' external_browser | ~/.dg/bin/dg-skills credentials set db/my-sf \
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

`clientStoreTemporaryCredential=true` caches the ID token so later non-interactive callers can skip the browser. Prime it once with `~/.dg/bin/dg-skills db test my-sf`.

`browserActionTimeout` is measured in milliseconds and defaults to 120000 in the Snowflake SDK. Lower it for automated callers or raise it for slower SSO and MFA.

## Snowflake key pair

The credential value is the private-key passphrase. Only the key's path is stored as metadata; the key contents never enter the credential store.

```bash
~/.dg/bin/dg-skills credentials set db/my-sf-key \
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
~/.dg/bin/dg-skills credentials set db/my-sf-password \
  --meta engine=snowflake \
  --meta account=ACCT-ID \
  --meta user=analyst \
  --meta database=MY_DB \
  --meta schema=PUBLIC \
  --meta warehouse=COMPUTE_WH
```

There is no `connections.json` fallback and no `${VAR}` interpolation. Update a connection by setting the same credential name again.
