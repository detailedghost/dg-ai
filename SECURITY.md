# Security Policy

DeeGee (`dg`) is a set of personal Claude Code and Codex utilities. Security
fixes land on `master` and ship in the next release tag of the affected
artifact. Install the latest tag to receive them.

## Supported versions

Each binary and the extension publish their own tag. Channel-review ships
inside the `dg-skills` binary (`skills-v*`); it has no release tag of its own.
The skill tree and the install scripts install from the latest `skills-v*`
release tag. Fixes still land on `master` first.

| Artifact | Tag | Supported release |
| --- | --- | --- |
| `dg-skills` (inbox and channel-review included) | `skills-v*` | Latest tag |
| `dg-daemon` | `daemon-v*` | Latest tag |
| `dg-agent` | `agent-v*` | Latest tag |
| `dg-ai-extension` zip | `ext-v*` | Latest tag |
| Skill tree (`plugins/dg/skills`) | `skills-v*` | Latest tag |
| `pkg/skills-cli/bootstrap.sh` and `bootstrap.ps1` | `skills-v*` | Latest tag |

`dg-skills install` refreshes the extension zip, `dg-skills`, `dg-daemon`, and
`dg-agent`, and skips an artifact that is already current. Re-run it, or the
bootstrap script from the latest `skills-v*` tag, after a security release. The extension update
is the unpacked zip from the `ext-v*` release.

Installed binary versions are recorded in `~/.dg/bin/.dg-skills.version`,
`~/.dg/bin/.dg-daemon.version`, and `~/.dg/bin/.dg-agent.version`. The
extension version is the `version` field of the loaded extension manifest.

## Reporting a vulnerability

Use GitHub private vulnerability reporting. Open a draft security advisory on
[detailedghost/dg-ai](https://github.com/detailedghost/dg-ai/security/advisories/new).

Include:

- The artifact and version (a version file, the extension manifest, or the
  release tag).
- What a successful attack can reach.
- Steps to reproduce, or a proof of concept with every secret redacted.
- Which component is affected: the extension, a daemon, the credential store,
  channel-review, or an install script.

Keep the full report on that private advisory. If the advisory form is
unavailable, contact the repository owner on GitHub and ask them to open one
before sending details.

## Response timeline

- Acknowledgement within 3 days.
- An initial severity assessment within 7 days.
- A status update at least every 7 days while the report stays open.
- An accepted report is fixed on `master`, then published as a new release tag
  for each affected artifact. The advisory is published after that release is
  available. `dg-skills install` picks up the new binaries and extension zip.
- A report that is out of scope, or that is not a vulnerability, gets a short
  explanation.

Wait until the fix is released, or 90 days after the report, before discussing
it in public.

## Scope

Report vulnerabilities in these parts of this repository:

- **Extension.** The WXT extension in `pkg/extension` (`dg-ai-extension`), for
  Chromium browsers and Firefox 139+. It groups tabs, runs demos and
  prototypes, and talks to `dg-daemon` on loopback after the extension origin
  is pinned.
- **Daemons and command-line tools.** `dg-daemon` (loopback HTTP and
  WebSocket, encrypted `daemon.db`, scheduled jobs, and supervised services),
  `dg-agent`, and the `dg-skills` binary built from `pkg/skills-cli`.
- **Credential store.** The encrypted `credentials.db`, grant tokens, and the
  `dg-skills credentials` commands.
- **Channel-review daemon.** The local daemon in `pkg/channel-review` that
  `dg-skills channel-review` runs. It watches a Teams bot relay and keeps state
  under `<DG_HOME>/channel-review`.
- **Install scripts.** `pkg/skills-cli/bootstrap.sh`,
  `pkg/skills-cli/bootstrap.ps1`, and the GitHub release downloads performed by
  `dg-skills install`.

A dependency vulnerability is in scope when a shipped artifact includes it.

The Teams relay you run, the thrash skill, and other projects' tools (`claude`,
`codex`, `copilot`, `gh`, `glab`, `aws`) are maintained elsewhere. Send those
reports to the project that ships them.

## Secrets and environment files

Git ignores `.env`. `DG_HOME` defaults to `~/.dg`. Keep live values in a
local `.env` file, or in the credential store. `.env.example` lists variable
names with empty values.

`dg-skills credentials set` reads the secret from stdin or a hidden prompt and
stores it in `<DG_HOME>/daemon/credentials.db` (file mode `0600`, directory
mode `0700`). The value is encrypted. The data key is wrapped by the OS
keychain, or by `<DG_HOME>/daemon/key` when no keychain is available. The key
file must be mode `0600` or the daemon refuses to read it. `credentials list`
prints names, metadata, and grants, and omits the secret. Metadata is
plaintext. The store rejects a metadata key named `value`, `secret`, `token`,
or `password`.

`dg-skills credentials grant` writes a token to
`<DG_HOME>/grants/<prefix>.token` (mode `0600`, directory mode `0700`). The
daemon stores only the SHA-256 hash of that token.

A supervised service may set `envFile` in `<DG_HOME>/daemon/config.json`. The
path is absolute. On macOS and Linux the daemon refuses a file other
users can read and tells you to run `chmod 600` on it. The child receives
`PATH`, `HOME`, `LANG`, `TZ`, and the `KEY=VALUE` lines from that file. A
scheduled job receives only `PATH`, `HOME`, `LANG`, and `TZ`.

`<DG_HOME>/agents/memory.db` is plaintext so full-text search can index it.
Keep secrets out of agent memory. Demo and prototype fill text is stored as
plaintext. Type passwords, tokens, and MFA codes by hand.

Channel-review reads its relay secret from `CHANNEL_REVIEW_RELAY_SECRET_<ENV>`
when that variable is set, and otherwise loads it from AWS Secrets Manager
into memory. Keep that value out of `config.json`, logs, and chat. Inbox
profiles and caches use the daemon's encrypted store.

Name the variable or credential in a report, issue, pull request, or
transcript, and redact the value. Leave `.env`, `credentials.db`, `daemon.db`,
`daemon/key`, and grant token files out of git.
