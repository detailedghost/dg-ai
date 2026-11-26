# Configuration

dg keeps its settings in one file, `config.toml`, in the dg config folder.
`dg config` reads and changes it. Secrets never go in this file. They
stay in the encrypted credential store, and the file holds only a reference to
them.

## Where the file is

| Platform | Path |
| --- | --- |
| Linux | `~/.config/dg/config.toml`, or `$XDG_CONFIG_HOME/dg/config.toml` when `XDG_CONFIG_HOME` is an absolute path |
| macOS | `~/Library/Application Support/dg/config.toml` |
| Windows | `%APPDATA%\dg\config.toml` |
| Any, with `DG_HOME` set | `$DG_HOME/config/config.toml` |

`dg config path` prints the path for this machine. The path comes from
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
| `pw.mode` | string | `auto` | Which browser `dg pw` drives: `ext`, `local` or `auto`. `ext` drives your real browser through the paired extension. `local` drives a Playwright browser that dg starts. `auto` uses the extension when it is paired and connected and the call fits it, else a local browser. `--ext`, `--local` and `DG_PW_MODE` (`ext` or `local`) win over this key. This key replaced `browser.mode`, which is now an error. `DG_BROWSER` is the browser executable path, not a mode. Verbs such as `route`, `state-save` and `video-start` run local in every mode. See [pw browser mode](pw.md#browser-mode-auto-ext-and-local). |
| `pw.phi_sites` | list of strings | empty | Site keys that hold patient data, such as `["https://ehr.example.org"]`. A site key is a scheme, a registrable domain and any non-default port. On a listed site and its subdomains `dg pw` refuses every verb that returns page data, in `--ext` and local mode. The full verb list for each mode is in [pw](pw.md#real-browser---ext). |
| `front.enabled` | boolean | `true` | Runs the native front door as `dg`. Set `false` to run the Bun dg for every command. `DG_FRONT=0` does the same for one shell. With the front door off, `dg config list` and `dg config doctor` print an error and exit 1, because only the front door runs them. To get them back, unset `DG_FRONT`, set `front.enabled = true`, or run `dg install` if the native binary is missing. |
| `hooks.<id>.<setting>` | string | the hook's default | A hook setting, for example `hooks.spelling.locale = "en-GB"`. See [hooks](hooks.md). |
| `install.cli_only` | boolean | `false` | `true` on an install made with `--cli-only`, which has no extension. |
| `refs.default_repo` | string | none | The repo that a bare PR number means in `dg pw batch-open`. |
| `refs.aliases.<name>` | string | none | A short name for a repo, so `app#12` opens `acme/app` PR 12. |
| `inbox.<group>.<setting>` | any | the inbox default | Inbox settings, with the same names as the old `organizer.config.json`, for example `inbox.classifier.mode`. See [inbox cleanup](inbox-cleanup.md). |
| `ssms.allow_send` | boolean | `false` | Lets ssms send a text after the approval gate. See [ssms](ssms.md). |
| `ssms.google.send_enabled` | boolean | `false` | Turns on Google Messages sends. |
| `plugins.<name>.enabled` | boolean | `true` | Turns a plugin on or off. |
| `plugins.<name>.source` | string | none | Where the plugin comes from. |
| `plugins.<name>.fail_closed` | boolean | `false` | Makes a crash or a timeout of an external hook plugin block the tool call. The block message names the plugin and this key. `false` lets the tool call go on, as before. A plugin that is not approved, or an approval key that dg cannot read because the daemon is down, never blocks: the run prints the reason and exits 1, whatever this key says. |
| `plugins.<name>.allow_remote` | boolean | `false` | Lets a plugin whose manifest says `remote = true` connect to a remote URL. Both must be set. |
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

1. A command-line flag, such as `dg inbox --config <file>`.
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
dg credentials set example-token
dg config set plugins.example.settings.token --credential example-token
```

These fields are secret fields:

- `inbox.gmail.clientSecret` and `inbox.outlook.clientSecret`.
- Any key under `plugins.<name>.settings` whose name ends in `secret`, `token`,
  `password`, `api_key` or `private_key` and holds a string, a table or a list.
  A number, such as `max_tokens = 1000`, is not a secret.
- Any string under `plugins.<name>.settings` that looks like a token: one that
  starts with `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`, `sk-`,
  `xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`, `glpat-`, `AKIA`, `ASIA`, `AIza` or
  `ya29.`, or one of 32 or more letters, digits, `_` and `-` that has a
  lowercase letter, an uppercase letter and a digit.

A plain value in a secret field fails validation, and the error never prints the
value. A `{{resolve:...}}` placeholder is refused in every field. The file never
holds a secret, so you can read it, copy it and share it.

## The dg config command

| Command | What it does |
| --- | --- |
| `dg config path` | Prints the path of `config.toml`. |
| `dg config get <key>` | Prints the value, or the default when the key is unset. An unknown key exits 1. |
| `dg config set <key> <value>` | Changes one key, after it validates the result. |
| `dg config set <key> --credential <name>` | Points a secret field at a credential store entry. |
| `dg config edit` | Opens the file in `$VISUAL` or `$EDITOR`. dg saves the edit only when it validates, and keeps the old file when it does not. |

`config set` rewrites the file and drops its comments. `config edit` keeps your
text as you wrote it. `config set` does not change `ssms.allow_send` or
`ssms.google.send_enabled`; use `config edit` for those.

## Migration from older files

Before this release, dg kept its settings in several files. The first
`dg` command after the upgrade moves them into `config.toml` once:

| Old file | Where its values went | Backup |
| --- | --- | --- |
| `<config>/config.json` | `hooks` goes to `[hooks]`. Other keys stay only in the backup. | `<config>/config.json.pre-toml` |
| `<config>/cli-only` | `install.cli_only = true` | `<config>/cli-only.pre-toml` |
| `~/.config/browser-batch/config.json` | `defaultRepo` goes to `refs.default_repo`; `aliases` goes to `[refs.aliases]` | `~/.config/browser-batch/config.json.pre-toml` |
| `<state>/inbox/config/organizer.config.json` | `[inbox]`, with the same names. `clientSecret` values move to the credential store as `dg-config/inbox-gmail-client-secret` and `dg-config/inbox-outlook-client-secret`; an empty one is dropped. | `<state>/inbox/config/organizer.config.json.pre-toml` |
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
- A secret value moves into the credential store first. When the daemon is not
  running, or the store refuses the write, the move stops and writes nothing.
  Start the daemon with `dg daemon start`, then run `dg doctor` to run the
  move again.
- It records each source and its sha256 under `[meta.migrated]`.
- The old inbox file and its backup still hold the client secret in plain
  text. Delete both once you checked that `dg inbox` works.
- It leaves every old file in place, so a rollback to an older dg reads its old
  files unchanged. dg no longer reads them once `config.toml` exists.
  `dg doctor config` warns when one of them changes after the move, and
  names `dg config edit` as the fix.
- A second run changes nothing.

Until the move runs, dg reads the old files, with secret values left out. If you
delete `config.toml`, the next `dg` command moves the old files again.

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

## Memory and the JIT

On Linux and macOS, every dg command except `dg --version` and `dg hooks run` starts itself once more with the JavaScript
JIT turned off (ADR 0057). That keeps each dg process 2 to 20 MB smaller and adds
about 5 ms to each start. Commands with heavy CPU work, such as `dg adr lint --all`
on a large repo, run slower without the JIT.

- `DG_JIT=1 dg <command>` keeps the JIT for one heavy run.
- A `BUN_JSC_useJIT` value you set yourself is kept as it is.
- `dg jot`, `dg stat`, `dg install` and `dg update` keep the JIT, because they use
  native calls that need it.
- Programs that dg starts, such as browsers, git and Bun scripts, keep their own JIT.
- On Linux, the `long-running-jit` line of `dg doctor` shows whether the daemon and
  the phone listener run without the JIT, and their memory.

## Environment files

The compiled dg ignores a `.env` and a `bunfig.toml` in the working folder.
Set environment variables in your shell or in `config.toml` instead.
