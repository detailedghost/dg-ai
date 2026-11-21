# Configuration

dg keeps its settings in one file, `config.toml`, in the dg config folder.
`dg-skills config` reads and changes it. Secrets never go in this file. They
stay in the encrypted credential store, and the file holds only a reference to
them.

## Where the file is

| Platform | Path |
| --- | --- |
| Linux | `~/.config/dg/config.toml`, or `$XDG_CONFIG_HOME/dg/config.toml` when `XDG_CONFIG_HOME` is an absolute path |
| macOS | `~/Library/Application Support/dg/config.toml` |
| Windows | `%APPDATA%\dg\config.toml` |
| Any, with `DG_HOME` set | `$DG_HOME/config/config.toml` |

`dg-skills config path` prints the path for this machine. The path comes from
`resolveDgPaths().configTomlPath`, the same source as every other dg path
(ADR 0025).

Set `DG_HOME` to a temporary folder to keep a test or a trial run away from your
real settings. With `DG_HOME` set, dg never reads `~/.config/dg`. Set
`DG_PATH_FENCE` as well to make dg stop with an error when any dg path, the
config folder included, falls outside the fence. The test runner sets both.

## Sections

Every key below is optional. A missing file, or a missing key, gives the
default.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `hooks.<id>.<setting>` | string | the hook's default | A hook setting, for example `hooks.spelling.locale = "en-GB"`. See [hooks](hooks.md). |
| `install.cli_only` | boolean | `false` | `true` on an install made with `--cli-only`, which has no extension. |
| `refs.default_repo` | string | none | The repo that a bare PR number means in `dg-skills pw batch-open`. |
| `refs.aliases.<name>` | string | none | A short name for a repo, so `app#12` opens `acme/app` PR 12. |
| `inbox.<group>.<setting>` | any | the inbox default | Inbox settings, with the same names as the old `organizer.config.json`, for example `inbox.classifier.mode`. See [inbox cleanup](inbox-cleanup.md). |
| `ssms.allow_send` | boolean | `false` | Lets ssms send a text after the approval gate. See [ssms](ssms.md). |
| `ssms.google.send_enabled` | boolean | `false` | Turns on Google Messages sends. |
| `plugins.<name>.enabled` | boolean | `true` | Turns a plugin on or off. |
| `plugins.<name>.source` | string | none | Where the plugin comes from. |
| `plugins.<name>.settings` | table | empty | The plugin's own settings. |
| `meta.migrated` | table | empty | Written by dg: each old config file that moved into this file, with its sha256. Do not edit it. |

An example:

```toml
[hooks.spelling]
locale = "en-GB"

[refs]
default_repo = "acme/app"

[refs.aliases]
app = "acme/app"

[inbox.classifier]
mode = "rules-only"

[plugins.example]
enabled = true
source = "github:acme/example"

[plugins.example.settings]
depth = 3
token = { credential = "example-token" }
```

An unknown section or key, or a value of the wrong type, stops the command with
the file, the line, the key, and the next step:

```text
dg config: /home/me/.config/dg/config.toml:5: install.cli_only must be a boolean, got "yes". Next: run dg config edit, or dg config set install.cli_only <value>.
```

## Precedence

A setting comes from the first of these that sets it:

1. A command-line flag, such as `dg-skills inbox --config <file>`.
2. An environment variable, such as `CLASSIFIER_MODE` for `inbox.classifier.mode`.
3. `config.toml`.
4. The built-in default.

## Secret references

A secret field holds only a reference to an entry in the credential store:

```toml
token = { credential = "example-token" }
```

Store the value first, then point the field at it:

```sh
dg-skills credentials set example-token
dg-skills config set plugins.example.settings.token --credential example-token
```

These fields are secret fields:

- `inbox.gmail.clientSecret` and `inbox.outlook.clientSecret`.
- Any key under `plugins.<name>.settings` whose name has `secret`, `token`,
  `password`, `api_key` or `private_key` in it.
- Any string under `plugins.<name>.settings` that looks like a token, such as a
  `ghp_` or `sk-` value or a long random string.

A plain value in a secret field fails validation, and the error never prints the
value. A `{{resolve:...}}` placeholder is refused in every field. The file never
holds a secret, so you can read it, copy it and share it.

## The dg config command

| Command | What it does |
| --- | --- |
| `dg-skills config path` | Prints the path of `config.toml`. |
| `dg-skills config get <key>` | Prints the value, or the default when the key is unset. An unknown key exits 1. |
| `dg-skills config set <key> <value>` | Changes one key, after it validates the result. |
| `dg-skills config set <key> --credential <name>` | Points a secret field at a credential store entry. |
| `dg-skills config edit` | Opens the file in `$VISUAL` or `$EDITOR`. dg saves the edit only when it validates, and keeps the old file when it does not. |

`config set` rewrites the file and drops its comments. `config edit` keeps your
text as you wrote it. `config set` does not change `ssms.allow_send` or
`ssms.google.send_enabled`; use `config edit` for those.

## Migration from older files

Before this release, dg kept its settings in several files. The first
`dg-skills` command after the upgrade moves them into `config.toml` once:

| Old file | Where its values went | Backup |
| --- | --- | --- |
| `<config>/config.json` | `hooks` goes to `[hooks]`. Other keys stay only in the backup. | `<config>/config.json.pre-toml` |
| `<config>/cli-only` | `install.cli_only = true` | `<config>/cli-only.pre-toml` |
| `~/.config/browser-batch/config.json` | `defaultRepo` goes to `refs.default_repo`; `aliases` goes to `[refs.aliases]` | `~/.config/browser-batch/config.json.pre-toml` |
| `<state>/inbox/config/organizer.config.json` | `[inbox]`, with the same names. `clientSecret` values move to the credential store as `dg-config/inbox-gmail-client-secret` and `dg-config/inbox-outlook-client-secret`. | `<state>/inbox/config/organizer.config.json.pre-toml` |
| `<config>/ssms/config.yaml` | `[ssms]`, with the same names | `<config>/ssms/config.yaml.pre-toml` |

`<config>` is the dg config folder above. `<state>` is the dg state folder:
`~/.local/state/dg` on Linux, `~/Library/Application Support/dg/state` on macOS,
`%LOCALAPPDATA%\dg\state` on Windows, or `$DG_HOME/state`. The inbox file moves
from `$EMAIL_ORGANIZER_HOME` instead when that is set.

How the move works:

- It runs under the install lock and checks every source first. A broken file
  stops it, names the file, and changes nothing.
- It copies each source to `<file>.pre-toml` with mode 0600 and compares the
  copy before it writes `config.toml`. An existing `.pre-toml` that differs
  stops the move, so an older backup is never overwritten.
- A secret value moves into the credential store first. When dg-daemon is not
  running, or the store refuses the write, the move stops and writes nothing.
  Start the daemon with `dg-daemon start`, then run `dg-skills doctor` to run the
  move again.
- It records each source and its sha256 under `[meta.migrated]`.
- It leaves every old file in place, so a rollback to an older dg reads its old
  files unchanged. dg no longer reads them once `config.toml` exists.
  `dg-skills doctor config` warns when one of them changes after the move, and
  names `dg config edit` as the fix.
- A second run changes nothing.

Until the move runs, dg reads the old files, with secret values left out. If you
delete `config.toml`, the next `dg-skills` command moves the old files again.

## What stays out

These keep their own files, outside `config.toml`:

- The daemon jobs table, `<state>/daemon/config.json`, and the job sources,
  `<data>/jobs/sources.json`. The daemon owns and locks them (ADR 0049).
- The exec allowlist, `<config>/exec-allowlist`. It stays a separate 0600 file
  that only you edit.
- Channel review config, `<config>/channel-review/config.json`.
- Inbox route profiles, mappings and security files in the inbox config folder.

ssms reads `[ssms]` only from the `config.toml` in the dg config folder under the
account's passwd home. `HOME`, `DG_HOME` and `XDG_CONFIG_HOME` do not choose
that file, the same rule that held for `ssms/config.yaml` (ADR 0024).
