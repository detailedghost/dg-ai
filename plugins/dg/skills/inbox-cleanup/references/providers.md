# Provider setup

Run commands through the compiled DG path established by the skill. Start a
daemon session with the installed companion binary:

```sh
"${DG_HOME:-$HOME/.dg}/bin/dg-agent" start --open
```

Keep the returned session ID and pass --session ID when your command's working
directory differs from the registered session, or when several sessions exist.
Gmail and Outlook use the daemon for encrypted configuration and OAuth storage;
Proton also needs exactly one extension connected to that session. Install or
update all companion binaries with dg-skills install when protocol versions differ.
Proton inbox operations require extension version 1.11.0 or newer.

## Profiles

Profile names select accounts with --account-profile NAME in workflow commands.
The separate --profile NAME workflow flag chooses a saved routing policy.

```sh
"$DG" inbox profile set personal --provider gmail --client-id YOUR_DESKTOP_CLIENT_ID \
  --auth-mode browser --session SESSION_ID
"$DG" inbox profile get personal --session SESSION_ID
"$DG" inbox profile list --session SESSION_ID
```

Use --json JSON or --file PATH for a complete validated profile. Useful settings
include clientId, authMode, redirectUri, scopes, pageSize, and environment-variable
references clientSecretEnv/accessTokenEnv/refreshTokenEnv. Outlook also supports
tenantId, authority, and loginHint. Inline token/secret fields are refused. Profile
get/list output is model-readable JSON; account addresses are redacted. OAuth
cache data has no public CLI command and never belongs in a config file or memory.

State defaults to ${DG_HOME:-~/.dg}/inbox/config and
${DG_HOME:-~/.dg}/inbox/workspaces/PROVIDER/PROFILE. --config and --dir override
local policy/artifact paths. Authentication material remains in the encrypted
daemon database. Explicit --data-path fixture commands bypass live services.

## Proton Mail

Sign in to HTTPS mail.proton.me or mail.protonmail.com, then reload the tab after
installing the extension so its MAIN observer sees real fetch/XHR API headers.
Use a modern browser with MAIN scripting support (Firefox 128+; the plugin's
broader Firefox features may require a newer version).

```sh
"$DG" inbox profile set proton --provider protonmail --account-hint 0 \
  --session SESSION_ID
```

accountHint is the /u/ account index, such as 0 or 1, for Proton. It is an email
login hint for Gmail/Outlook. An optional --tab-id fixes a particular mail tab.
Several matching mail tabs require an explicit selection; several extension
peers on the same session require disconnecting all but one peer. A selected
account is checked again inside the page before execution.

The extension runs named fixed JavaScript operations. It retains observed
x-pm-uid/appversion/locale headers only in page memory, uses same-origin fetch
with cookies included, and returns bounded metadata through the daemon to stdout.
No raw message body, cookies, headers, arbitrary script source, or arbitrary
endpoint URL is returned to the model. Expired sessions give sign-in/reload
guidance. Folder-scoped message responses must include valid label IDs matching
the selected folder; otherwise the operation fails before returning messages.
Full Sieve policy is retained privately for reviewed consolidation.

## Gmail

Register a Google desktop OAuth client and enable the Gmail API. Browser login
uses a loopback callback, state validation, PKCE, and offline refresh tokens.
Default redirect: http://127.0.0.1:0/oauth2/callback. Default scopes cover Gmail
read-only, modify, and settings.basic operations; custom scopes must cover the
operations you use. Consumer/test Google apps may require test-user enrollment
or provider approval for sensitive/restricted scopes.

Use --client-secret-env ENV_NAME when your client configuration needs a secret.
Set that environment variable outside the CLI. For an externally supplied token,
use --auth-mode env --access-token-env ENV_NAME. Expired encrypted cached tokens
are refreshed automatically. A revoked cached refresh token is removed from
encrypted storage; browser mode starts a new login. Temporary refresh failures
and externally supplied credentials are preserved. Generic desktop clients do
not support Google's TV/device-code flow; choose browser login for this integration.

Set GOOGLE_BROWSER_OPEN_COMMAND or gmail.openBrowserCommand in your local
--config file to select a browser command. Commands are split into executable
arguments at whitespace, without shell expansion. Gmail always prints a login
URL to stderr with the account hint removed, so you can continue if the opener
does not show a browser. It keeps waiting for the loopback callback. Open the
URL in a browser that can reach that local callback.

Gmail scans one ID page at a time, fetches metadata with bounded concurrency,
and applies labels/read-state changes in batches. A move adds the destination
label and the reviewed workflow removes its original source label.

See Google's [native application OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app)
and [message listing API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list).

## Outlook

Register a Microsoft Entra application, choose its supported account types, and
configure delegated Graph mail permissions. A public-client desktop app can use
browser or device-code login; a confidential client uses a registered loopback
redirect and a secret referenced through --client-secret-env.

```sh
"$DG" inbox profile set work --provider outlook --client-id YOUR_CLIENT_ID \
  --tenant-id organizations --auth-mode device-code --session SESSION_ID
```

Choose organizations, consumers, common, or your explicit tenant ID. Authority
must be https://login.microsoftonline.com; redirects must use local HTTP
loopback. Default scopes are Mail.Read/User.Read, Mail.ReadWrite, and
MailboxSettings.Read. Broader administrative permission is not inferred.

MSAL reuses and refreshes encrypted cached tokens before interactive login.
Silent mode refuses missing cached accounts; account/profile configuration binds
the cache. Environment access tokens are supported through accessTokenEnv.
Graph nextLink paging remains on its trusted origin/path and refuses cycles.
Live Outlook batches preserve message IDs across moves, so reviewed read-state
changes still target the same messages.

Live Graph supports inventory, moves, read state, and folder relocation. Outlook
folder-tree/label/filter/route policy planning and apply commands currently use
an explicit loaded JSON dataset; they do not silently translate those policies
into live Graph writes. File-backed Outlook message move/read methods remain
read-only. Proton Sieve consolidation is Proton-specific.

See Microsoft's [MSAL caching documentation](https://learn.microsoft.com/en-us/entra/msal/javascript/node/caching)
and [token acquisition documentation](https://learn.microsoft.com/en-us/entra/msal/javascript/node/acquire-token-requests).

## Paging

Live providers skip overlapping message IDs and count unique messages toward
the requested limit. Pages stay fixed in size and are fetched only as needed.
Repeated cursors, a nonempty continuing page with no new IDs, or three
consecutive empty continuing pages stop the scan with a paging error.

## Verification

Automated tests use synthetic datasets and authenticated local relay fixtures.
Real-account OAuth consent, extension permissions, and live mailbox mutations
still require validation in the user's chosen provider/browser environment.
