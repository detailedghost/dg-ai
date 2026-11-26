# Install and update DeeGee

**As a Claude Code plugin** (the skills self-bootstrap the CLI on first use):

```text
/plugin marketplace add ~/code/dg
/plugin install dg@detailedghost
/plugin install unslop@detailedghost
```

The `unslop` plugin is optional. It installs the upstream `theclaymethod/unslop` skill, which `/dg:polish` calls
when present. To install every recommended plugin at its pinned commit, see
[Recommended plugins](#recommended-plugins).

**Standalone — one command installs `dg` _and_ the browser extension.** `dg` is
a small native front door plus one compiled program with every command, so you need no Bun of your own:

macOS / Linux (x64 or arm64):

<!-- markdownlint-disable MD013 -->

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

Windows (x64 or arm64), in PowerShell:

```powershell
irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
```

<!-- markdownlint-enable MD013 -->

Both download `dg` for your platform into the dg data folder (compressed, then unpacked), check
it against the release's `SHA256SUMS`, and link it into the launcher folder (see
[Where dg keeps its files](#where-dg-keeps-its-files)). Then they run `dg install`.
That stages the extension and prints the **Load unpacked** steps. Re-run
`dg install` anytime to update. A part that is already current is
skipped. (Building the extension from source with `--local` needs
[Bun](https://bun.sh).)

`dg` is the only command. Every command runs as `dg <command>`: `dg pw`, `dg phone`,
`dg job`, `dg doctor`. Run `dg --help` for the list. Two groups share verbs, so
these verbs keep a group name:

- Daemon lifecycle verbs run as `dg daemon <verb>`: `serve`, `status`, `start`,
  `stop`, `restart`, `sessions` and `origin`.
- Agent session verbs run as `dg agent <verb>`: `start`, `send`, `recv`,
  `progress`, `spawn`, `stage`, `close` and `manifest`.

A bare `dg start` exits 1 and names `dg agent start` and `dg daemon start`.
`dg skills <command>`, `dg agent <command>` and `dg daemon <command>` also work as
full paths. `dg upgrade` is an alias of `dg update`, and `dg extension` is an alias
of `dg install`.

The three older program names are removed. Install writes no file with those
names. See [Upgrade from 6.3](#upgrade-from-63).

When a `dg` file in the launcher
folder is not the dg program, install keeps the file and prints
`dg: kept <path>; it is not a dg launcher. Remove it or rename it, then run dg install again`.
The check `dg-launcher` in `dg doctor` warns about the same file, and
about a missing `dg` launcher. dg writes no `dg` file into the legacy
`~/.dg/bin` folder.

## Where dg keeps its files

dg follows the conventions of each OS. Install puts the `dg` launcher in a
user-writable folder and the rest under four roots, one for each role.

<!-- markdownlint-disable MD013 -->

| Role | Linux | macOS | Windows | `DG_HOME` set |
| --- | --- | --- | --- | --- |
| Launcher: `dg` | `~/.local/bin` | `~/.local/bin` | `%LOCALAPPDATA%\dg\bin` | `$DG_HOME/bin` |
| Config: `config.json`, the CLI-only marker, channel-review config | `$XDG_CONFIG_HOME/dg` (`~/.config/dg`) | `~/Library/Application Support/dg` | `%APPDATA%\dg` | `$DG_HOME/config` |
| Data: the program in `bin/`, skills, personas, browsers, job sources | `$XDG_DATA_HOME/dg` (`~/.local/share/dg`) | `~/Library/Application Support/dg` | `%LOCALAPPDATA%\dg` | `$DG_HOME/data` |
| State: daemon, phone, grants, agent sessions and memory, job state | `$XDG_STATE_HOME/dg` (`~/.local/state/dg`) | `~/Library/Application Support/dg/state` | `%LOCALAPPDATA%\dg\state` | `$DG_HOME/state` |
| Cache: prototypes, demos | `$XDG_CACHE_HOME/dg` (`~/.cache/dg`) | `~/Library/Caches/dg` | `%LOCALAPPDATA%\dg\cache` | `$DG_HOME/cache` |
| Logs | `<state>/log` | `~/Library/Logs/dg` | `%LOCALAPPDATA%\dg\log` | `$DG_HOME/log` |

<!-- markdownlint-enable MD013 -->

Job sources are in `<data>/jobs`, and job state is in `<state>/jobs`.

For example, the phone state is in `~/.local/state/dg/phone` on Linux and in
`~/Library/Application Support/dg/state/phone` on macOS.

When the launcher folder is not on `PATH`, `bootstrap.sh` and
`dg install` print the line to add. `bootstrap.ps1` adds
`%LOCALAPPDATA%\dg\bin` to the user `PATH` once and says so. Skills call
`dg` by name and fall back to `${DG_HOME:-$HOME/.local}/bin/dg`,
the launcher path, also in the step right after the bootstrap.

### DG_HOME

Set `DG_HOME` to keep everything under one folder, for example for a test or a
second install. Each role then gets its own subfolder: `$DG_HOME/bin`,
`$DG_HOME/config`, `$DG_HOME/data`, `$DG_HOME/state`, `$DG_HOME/cache` and
`$DG_HOME/log`. An empty `DG_HOME` counts as unset.

### Move from ~/.dg

Releases before this layout kept everything in `~/.dg` (or flat in `DG_HOME`).
Any start of `dg` moves what is left, before
the command runs. When nothing is left, the check is one folder listing.
[ADR 0036](adr/0036-one-layout-module.md) records the design.

Three terms have one meaning here:

- A target is unused when it holds no rows and no files.
- dg keeps an old copy when it leaves that copy in place and does not remove it.
- An entry is blocked when dg cannot move it now. dg keeps the old copy, and
  the program that writes that state refuses to open it and prints the line
  that says why.

The move follows these rules:

1. Each folder and file moves to its new root. dg copies it, checks that the
   copy has the same files and bytes, and only then removes the old copy.
   When the check fails, dg keeps the old copy and names it.
2. dg never writes over a target that holds data. It keeps the old copy, keeps
   the target, and says so. `dg doctor install` then names both copies.
3. When the target exists and is unused, dg sets it aside as
   `<name>.empty-<ts>`, then moves the old copy in. `dg clean` removes
   the set-aside copy only when it is unused, and keeps a copy that holds
   files. See [Clean up](#clean-up).
4. When an old folder is still in use after the copy, for example the program
   file that runs install on Windows, dg leaves it. The next start of any dg
   program removes it and prints one line.
5. When a process that writes a folder is still running, dg blocks that entry.
   Only the daemon's own start and `dg install` stop an old daemon.
   On Linux and macOS they send SIGTERM. When the old daemon is hung and does
   not answer its health check, they first confirm the pid is the dg daemon
   that wrote the pid file, then send SIGTERM and, if it stays, SIGKILL; a pid
   that another program reused gets no signal, and a pid dg cannot identify
   blocks the move. On Windows dg never stops it: it
   prints the service line, and you stop the dg daemon, then run
   `dg install` again.
6. The phone state moves on any `dg phone` command and on
   `dg install`. See [phone](phone.md#where-the-phone-state-lives).
7. On Linux and macOS, the daemon moves its key in the OS keychain to an
   account named after the new state root. The move runs only when the daemon
   starts to serve, not at the first open. It copies the key, reads it back,
   compares it, and only then deletes the old entry. On macOS, dg passes the
   key to the keychain tool on stdin, so it never appears in the process
   arguments. If any step fails, dg keeps both entries, reads the old account
   when the new one is empty, and prints one warning that names the key,
   never its value. The move is one-way. See the
   [keychain warnings](#keychain-warnings).
8. The staged extension folder moves to the data root. The browser remembers
   the old folder, so install prints one line: open `chrome://extensions`
   once, remove the old `dg-ai-extension` entry, and load unpacked from the
   new folder. Later installs update that folder in place.
9. `ssms` state moves to the state root. Its fixed `config.yaml` moves to
   the config folder under the passwd home, and only `dg install`
   moves it. See [ssms](ssms.md).
10. dg leaves files it does not know in `~/.dg`.
11. A symlinked `~/.dg` keeps its link. dg moves the contents and never
    removes or renames the link.
12. With `DG_HOME` set, the role folders under it stay in place and dg
    moves only the old files next to them.
13. The `daemon` folder follows rule 2 with one more case. When the old
    folder holds data and `<state>/daemon` is a real folder with no data,
    dg sets `<state>/daemon` aside and moves the old copy in. When both hold
    data, dg blocks the entry and stops the start of the daemon. See
    [Two daemon folders hold data](#two-daemon-folders-hold-data).

Earlier releases kept small notice launchers for the three older program names
in `~/.dg/bin`. The upgrade removes them, and `dg clean` removes them earlier. See
[Upgrade from 6.3](#upgrade-from-63).

Claude Code allow rules for a launcher path in `~/.dg/bin` stop matching.
`dg doctor` warns and names the new rule, `Bash(dg <sub>:*)`.

Stale skill copies outside the dg install, for example `~/.agents/skills`, can still call `~/.dg/bin` and need a reinstall from their own source.

#### When does it move

| Command | What moves |
| --- | --- |
| `--help`, `-h` anywhere before a `--`, `--version` | Nothing. |
| `dg hooks run`, `dg phone listen`, `dg daemon status` | Nothing. These commands skip the move. |
| `dg install` | Everything. It stops an old daemon and an old phone listener, moves `runtime/` and `lib/`, then rewrites the launcher and restarts the listener, also when the install fails. |
| `dg doctor` | What it can, before it reports. The `layout` check then lists what is left. |
| `dg clean` | What it can, then it removes the leftovers. |
| `dg spec`, `dg memory` and other commands | The daemon, memory, grants and config. They leave `runtime/`, `lib/`, `phone/` and the ssms config until install (or, for `phone/`, a `dg phone` command) runs. |
| `dg phone <verb>` | The phone folder, then the phone-friend lines. |
| `dg agent start` | The same as other `dg agent` commands. It starts the daemon, and the daemon's own start moves the daemon folder. |

The keychain key moves only when the daemon serves. The daemon folder can move
days before the key does.

#### Layout lines

Every line goes to stderr. `<from>` is the old path and `<to>` is the new one.
dg prints each line once for each process.

<!-- markdownlint-disable MD013 -->

| Line | Cause | Fix |
| --- | --- | --- |
| `dg: kept <from>; a process that writes it is running. Stop it, then run dg install again` | A live writer holds the entry. dg blocked it. | Stop the process, then run `dg install`. |
| `dg: kept <from>; stop the dg daemon, then run dg install again` | On Windows, dg never stops the daemon. | Stop the dg daemon, then run `dg install`. |
| `dg: <from> has not moved to <to>; run dg install` | A program tried to open an entry that has not moved. This command lacks a step the move needs, such as the phone check or the ssms config folder. | Run `dg install`, or for the phone any `dg phone` command. |
| `dg: copied <from> to <to>; it is in use, so the next dg start removes it` | The copy is complete, but dg could not remove the old copy. The removal is scheduled. | Nothing. The next dg start removes it. |
| `dg: removed <from>; its copy at <to> was complete` | A scheduled removal finished on a later start. | Nothing. |
| `dg: kept <from>; its copy at <to> no longer holds every file` | A scheduled removal found the copy incomplete. | Compare the two folders before you remove either. |
| `dg: two daemon folders hold data: <from> and <to>. dg does not choose one and does not merge them. Move the folder that you do not want to a different name, then run the command again` | The old daemon folder and `<state>/daemon` both hold data. dg blocked the entry. | See [Two daemon folders hold data](#two-daemon-folders-hold-data). |
| `dg: set aside <dest> as <aside>; dg copied no file from it, and dg clean keeps it` | The old daemon folder held data, and the target held files but no data. dg renamed the target and moved the old copy in. | Compare the set-aside copy with the new folder, then remove it by hand. `dg clean` keeps it. |
| `dg: set aside unused <to> as <to>.empty-<ts>; dg clean removes it` | The target was unused, so dg renamed it and moved the old copy in. | Run `dg clean` when you want the set-aside copy gone. |
| `dg: kept <from>; <to> already exists and holds data. dg doctor reports both copies` | Both copies hold data. | Run `dg doctor install`, compare the copies, then remove one. |
| `dg: kept <from>; <to> already exists` | A target existed when the copy began. | Run `dg doctor install`, then compare the copies. |
| `dg: kept <from>; the copy failed its check: <problem>` | The copy did not pass the check, for example the phone key check. dg removed the copy. | Fix the problem named, then run `dg install`. |
| `dg: kept <from>; moving it to <to> failed: <reason>` | The copy or its byte check failed. dg removed the copy. | Fix the reason, then run `dg install`. |
| `dg: kept <from>; setting aside <to> failed: <reason>` | dg could not rename the unused target. | Fix the reason, then run `dg install`. |
| `dg: phone-friend lines wait for conversion; run dg phone status` | `dg phone listen` found old phone-friend lines that no command has converted. It exits 1. | Run `dg phone status`. |

<!-- markdownlint-enable MD013 -->

#### Two daemon folders hold data

When the old daemon folder and `<state>/daemon` both hold data, two daemon
folders with data stop the start of the daemon. The message names the two
folders. dg does not choose one, and dg merges nothing.

`dg daemon serve` exits 78 for this block, and the systemd unit does not start
it again. The `dg job` verbs that write the config exit 78 too.

To fix it, move `<state>/daemon` to a different name when the legacy folder
holds the sessions, then start again. When `<state>/daemon` holds the sessions,
move the legacy folder instead. Compare the two first.

#### Layout check in doctor

`dg doctor install` runs a check with the id `layout`. The check only
reads. It writes nothing.

When every file is in its per-OS folder, the check reports `ok`:
`every dg file is in its per-OS folder`. Otherwise it reports `warn` with one
line for each entry that is left:

| Warn line | Meaning | Who acts |
| --- | --- | --- |
| `<from> has not moved to <to>; run dg install` | dg has not moved the entry. | `dg install` fixes it. |
| `dg: kept <from>; a process that writes it is running. Stop it, then run dg install again` | A live writer blocks the entry. | Stop the process, then `dg install` fixes it. |
| `<from> is copied and waits for removal` | The copy is complete. The old copy waits for removal. | `dg install` or any dg start removes it. |
| `<from> is copied but the copy is incomplete; dg keeps it` | The copy lacks files. dg keeps the old copy. | A human decides. Check both folders first. |
| `<from> and <to> both hold data; compare them, then remove the one you do not need` | A split: both copies hold data. | A human decides. Compare, then remove one. |

The fix line of the warn is `dg install`. On Windows with a live
daemon, it is the service line instead.

#### Keychain warnings

Each line starts with `dg: keychain secret chat-store-kek`. None holds the key.

<!-- markdownlint-disable MD013 -->

| Line, after the prefix | Meaning |
| --- | --- |
| `could not be read from the old account; dg leaves both accounts as they are` | dg cannot read the old entry. It changes nothing. |
| `could not be written to the new account; dg keeps the old entry and reads it from the old account` | The new account refused the key. |
| `did not read back the same from the new account; dg keeps the old entry and reads it from the old account` | The read-back differs from the copy. |
| `differs between the old and the new account; dg reads the new account. If the daemon refuses the key, delete the entry <account> and start the daemon again` | The accounts hold different keys. |
| `moved to the new account, but the old entry could not be deleted; dg reads the new account, and a copy stays in the old one` | The copy succeeded. The old entry stays. |

<!-- markdownlint-enable MD013 -->

### Clean up

`dg clean` removes what the move left behind. It moves what it can
first, then removes these paths:

- Each unused `<name>.empty-<ts>` copy that a move set aside, such as
  `phone.empty-<ts>`. A pending removal that is complete also finishes.
- The `~/.dg/bin` folder, only when every name in it is a dg launcher.
- `~/.dg`, only when it is empty.

It prints one line for each removed path, and a final count:

```text
dg: removed <path>
dg: removed 2 path(s)
```

When it removes `~/.dg/bin`, it also prints one notice that names each removed
launcher and says that the launcher folder holds `dg`.

The `~/.dg/bin/<name>` paths stop working now, not at the removal release.
Claude Code allow rules for a path in `~/.dg/bin` stop matching. `dg doctor`
names the new rule. A later install does not bring `~/.dg/bin` back.

`dg clean` leaves these paths in place:

- `dg-ai-*` folders. Install removes them.
- A set-aside copy that holds data. It prints
  `dg: kept <path>; it holds data`.
- A `bin` folder that holds other files, or launchers with no replacement in the new launcher folder. It prints
  `dg: kept <path>; it holds files that are not dg launchers with a replacement: <names>`.
- A pending copy that is still in use.

When a removal fails, it prints
`dg: kept <path>; removing it failed: <reason>`, continues, and exits 1.

It refuses to run while a folder has not moved or an old writer is running. It
prints the fix lines from [Layout lines](#layout-lines), then
`dg: cleaned nothing; fix the lines above, then run dg clean again`,
and exits 1. When nothing is left, it prints `dg: nothing to clean`. It is
safe to run again.

## Install layout

One release is two programs. The front door is a small native program (about
4.7 MB) that runs at `dg`. The Bun program, which holds every command, runs at
`dg-core`. Install keeps each version it downloads, so a rollback needs no
download. On Linux the data folder is `~/.local/share/dg`:

```text
<data>/
  bin/<version>/dg        the front door (dg.exe on Windows)
  bin/<version>/dg-core   the Bun program (dg-core.exe on Windows)
  bin/current -> <version>  symlink, or a directory junction on Windows
  companions/<name>-<version>/  pw and db, downloaded on first use
```

`<bin>/dg` is the launcher, with `<bin>` the launcher folder from the
[layout table](#where-dg-keeps-its-files). On Linux and macOS it is a symlink to
`<data>/bin/current/dg`. On Windows it is a hard link,
`%LOCALAPPDATA%\dg\bin\dg.exe`, to the file in `<data>\bin\<version>`, so each
update links it again. Windows also gets a `dg-core.exe` link beside it. Install
writes no other launcher and no `.cmd` file. It replaces `current` by creating a
new link and renaming it over the old one, so a running program keeps working
during an update. The version that the install replaces stays in `bin/` for
rollback.

The Bun program embeds its own runtime. The installer never uses a `bun` on your
`PATH`.

### What the front door runs

The front door is on by default. It runs these commands itself, with no Bun
start-up:

- `dg --version`
- `dg hooks run <id>` for the built-in hook ids
- `dg completion` words, when there are two or more words
- `dg config get`, `set`, `list` and `doctor`
- `dg plugin list`, `verify`, `enable` and `disable`, until a record claims approval
  (the front door cannot check the approval MAC, so it hands those records to `dg-core`)

Every other command runs `dg-core` with the same arguments. This includes a
single-word completion, an unknown hook id, `dg plugin add`, `remove` and
`update`, and every command not in the list above. `dg-core` prints its own output.

### Turn the front door off

Set `DG_FRONT=0` for one shell, or set `front.enabled = false` in `config.toml`
for good. With either setting, the front door hands every command to `dg-core`.
The [config table](config.md) lists the key.

With the front door off, `dg config list` and `dg config doctor` print an
error and exit 1. Only the front door runs them.

To go back to a Bun-only install, run `DG_FRONT=0 dg install`. It moves
`dg-core` back to `dg` and leaves no front door. To turn the front door on again
for an installed version, run `dg install` without the setting.

### When the front door is missing or fails

Install checks the front door before it keeps it. When the release has no
front door asset for your platform, the checksum does not match, or the file
fails its `--version` probe, install prints one line,
`dg: the front door was not installed (<reason>); dg runs the Bun program only`,
and keeps the Bun program at `dg`. The install still succeeds.

### Downloads

Every download is checked before anything changes. `SHA256SUMS` lists the raw
asset names, and install compares the sha256 of the unpacked file. Install also
runs the new program with `--version` before it moves `current`. A failed check
prints `checksum mismatch` or the self-check error and leaves the old install
as it was.

The release ships each program in three forms: raw, `.zst` (zstd -19) and `.gz`.
Install picks `.zst`, then `.gz`, then the raw file, and unpacks it. Both
bootstrap scripts pick `.gz` and unpack it with `gzip`. They fall back to the
raw file when `gzip` is missing.

An update from an installed version downloads a delta. The release carries a
zstd patch from the previous release for each program. Install applies the
patch to the installed program with `zstd --patch-from` and checks the raw
sha256. When `zstd` is not on `PATH`, or the patch is missing or fails its
check, install prints one line and downloads the full `.zst` instead.

The `pw` (browser) and `db` (database) libraries are not in the program. They
ship as `dg-pw-<version>.tar.zst` and `dg-db-<version>.tar.zst`. The first
command that needs one downloads it, checks its sha256 against `SHA256SUMS`,
and unpacks it into `<data>/companions/<name>-<version>`. A failed download
prints a retry line and a manual `curl` command. dg writes no unverified bytes.

The release has one Bun program asset for each platform: `dg-linux-x64`,
`dg-linux-x64-baseline`, `dg-linux-arm64`, `dg-darwin-x64`, `dg-darwin-arm64`,
`dg-windows-x64.exe`, `dg-windows-x64-baseline.exe` and `dg-windows-arm64.exe`.
The front doors are `dg-front-<rid>` for `linux-x64`, `linux-arm64`, `osx-x64`,
`osx-arm64`, `win-x64` and `win-arm64`, with `.exe` on Windows. On x64 without
AVX2, install picks the `-baseline` Bun asset and the shared x64 front door.

## Shell completion

Every install and update writes tab completion for `dg` in bash, zsh and fish.
That includes a CLI-only, agent-only or skills-only install. The installer does
not edit a shell startup file.

| Shell | File | Loaded by |
| ----- | ---- | --------- |
| bash | `~/.local/share/bash-completion/completions/dg` | bash-completion, on first use |
| zsh | `~/.local/share/zsh/site-functions/_dg` | `compinit`, when the folder is on `fpath` |
| fish | `~/.config/fish/completions/dg.fish` | fish, on first use |

`XDG_DATA_HOME` replaces `~/.local/share` and `XDG_CONFIG_HOME` replaces
`~/.config`. With `DG_HOME` set, the files go to `$DG_HOME/share/...` and
`$DG_HOME/config/fish/...` instead, so a test install does not touch your
shell. Windows gets no completion files.

zsh reads that folder only when it is on `fpath` before `compinit` runs. When
zsh is installed and `FPATH` does not hold the folder, the installer prints
one line. Add it to `~/.zshrc` above `compinit`:

```zsh
fpath=(~/.local/share/zsh/site-functions $fpath)
```

The scripts call the program back for each word
(`dg __complete <words>`), so new commands complete as soon as an
update installs them. To write, refresh or remove the files by hand:

```bash
dg skills completion --install
dg skills completion --uninstall
```

To load a script for the current shell only, without files, run
`source <(dg completion bash)` (or `zsh`), or
`dg completion fish | source` in fish. `dg completion <shell>` prints the
script for every `dg` command.
`dg doctor completion` reports missing or old files and names the fix.

## Upgrade from 6.3

Release 6.3 and earlier shipped four programs, `dg-skills`, `dg-agent`,
`dg-daemon` and `dg`, as launchers over one bundle and one Bun runtime. This
release ships one compiled program, `dg`, and removes the other three names.
Only this section and the [Roll back](#roll-back) steps that follow deal with the old names and releases.

On a 6.3 install, run `dg upgrade`. The command `dg-skills update` does the
same. 6.4 updates the same way, so each step below that names 6.3 also holds
for 6.4.

```bash
dg upgrade
```

On 6.0.0 to 6.1.1, the old `update` installs only the new bundle. It does
not run the new bundle's `install launchers` step, so the old launchers stay.
The next `dg` or `dg-skills` command finishes the layout before it runs, and
prints `dg: finishing the upgrade: installing the compiled dg and removing the old launchers`.
A second `dg upgrade` does the same. Hook runs, `completion`, help flags and
the `dg-agent` and `dg-daemon` launchers do not download the program. They print
`dg: the upgrade is not finished; run dg upgrade once more to install the compiled dg`.

| Installed release | Runs needed |
| --- | --- |
| 6.2.0 to 6.4.0 | One `dg upgrade` |
| 6.0.0 to 6.1.1 | One `dg upgrade`, then any `dg` command or a second `dg upgrade` |

Then restart the daemon, so a running daemon picks up the new program:

```bash
dg daemon restart
```

The update steps, in order:

1. The 6.3 `update` downloads the new bundle tarball, `dg-lib-<v>.tar.gz`, and
   `runtime.json`, checks both against `SHA256SUMS`, and runs the new bundle's
   self-check. The release keeps both assets for two minor releases, only for
   this step.
1. It runs the hidden step `install launchers` of the new bundle. A 6.0.0 to 6.1.1
   `update` skips this step, and the next command runs it. That step
   installs the compiled `dg` of the new version at `<data>/bin/<version>/dg`,
   links `<data>/bin/current`, and links `<bin>/dg`.
1. The same step rewrites the argv that dg stored: the login unit of the daemon
   (`dg autostart`) and the phone listener unit. It also rewrites each
   `dg-skills hooks run` line in agent settings and git hooks to `dg hooks run`.
1. It removes the old launchers `dg-skills`, `dg-agent` and `dg-daemon` from the
   launcher folder, and the notice launchers in `~/.dg/bin`.
1. On Windows, the old `.cmd` files are in use during the update. The next
   `dg install`, `dg update` or daemon start removes them.
1. The daemon rewrites job argv that names `lib/current/dg.js` or an old program
   name, once, at its next start. It keeps a copy of the old file as
   `config.json.pre-compiled` in the daemon folder, with mode 0600.

Each rewrite is safe to run again. When a file with an old name is not a dg
launcher, install keeps it and prints
`dg: kept <path>; it is not a dg launcher. dg no longer uses that name`.

A stale 6.3 shim still runs, through the bundle bridge. It prints one line,
then runs the command:

```text
dg: the dg-skills command is removed; run dg <args>
```

A compiled `dg` started under an old name prints the same line and exits 1. Fix
the script or the job that names the old program. Each old command is now
`dg <command>`:

| Old form | New form |
| --- | --- |
| `dg-skills <command>` | `dg <command>` |
| `dg-agent phone`, `overwatch`, `memory`, `mcp` | `dg phone`, `dg overwatch`, `dg memory`, `dg mcp` |
| `dg-agent start`, `send`, `recv`, `progress`, `spawn`, `stage`, `close`, `manifest` | `dg agent <verb>` |
| `dg-daemon job`, `autostart`, `service` | `dg job`, `dg autostart`, `dg service` |
| `dg-daemon serve`, `status`, `start`, `stop`, `restart`, `sessions`, `origin` | `dg daemon <verb>` |

Releases from before the bundle shipped three separate compiled binaries. A
compiled `dg-skills install` from one of those old releases cannot find the new assets, so update once by
re-running bootstrap:

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

On Windows, re-run the `bootstrap.ps1` command above.

## Roll back

`dg install --version <previous version>` points `<data>/bin/current` at that
version. While `<data>/bin/<previous version>` exists, nothing is downloaded. To
roll back by hand (Linux path shown), replace the link:

```bash
ln -sfn <previous version> ~/.local/share/dg/bin/current
```

Restart the daemon after a rollback with `dg daemon restart`.

To roll back to the last release before the compiled program, run the 6.4.0
bootstrap. Its skills come back with it:

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/download/v6.4.0/bootstrap.sh | sh
```

Then reinstall the daemon login unit with `dg-daemon autostart install` and add
again each job that names `dg`. Those two commands use the old names, because
the 6.4 install has no other.

A version from before the compiled program needs that release's own bootstrap
script, as the error message says.

### Roll back to a release that uses ~/.dg

No command copies the data back. A release from before the per-OS layout reads
`~/.dg`, so you copy each folder back by hand.

1. Stop every writer.
   - Daemon: run `dg daemon stop`. An older release has no `stop`
     command: send SIGTERM to the pid in `<state>/daemon/daemon.pid` (Linux
     and macOS).
   - Phone: run `dg phone close`.
   - Channel review: run `dg channel-review stop --env <env>`.
   - ssms: `dg ssms` has no stop command. Let a running `dg ssms`
     command end.
2. Copy each folder back to its `~/.dg` name with a copy that keeps
   attributes. On Linux and macOS, use `cp -a <from> <to>`. On Windows, use
   `robocopy <from> <to> /E /COPY:DAT` for a folder. The table lists the Linux
   paths. `resolveDgPaths` in `pkg/common/src/node/dg-paths.ts` gives the other
   OSes. `memory.db`, `memory.db-wal` and `memory.db-shm` move together. Create
   `~/.dg` with mode 0700 when it does not exist.
3. Run the bootstrap of that release right away. Every later start on
   the new release logs kept lines until you remove the copies.

| Entry | Per-OS path on Linux | Copy it to |
| --- | --- | --- |
| runtime | `~/.local/share/dg/runtime` | `~/.dg/runtime` |
| lib | `~/.local/share/dg/lib` | `~/.dg/lib` |
| skills | `~/.local/share/dg/skills` | `~/.dg/skills` |
| browsers | `~/.local/share/dg/browsers` | `~/.dg/browsers` |
| demo-narration | `~/.local/share/dg/demo-narration` | `~/.dg/demo-narration` |
| sessions | `~/.local/state/dg/agents/sessions` | `~/.dg/agents/sessions` |
| assets | `~/.local/state/dg/agents/assets` | `~/.dg/agents/assets` |
| memory | `~/.local/state/dg/agents/memory.db`, `memory.db-wal`, `memory.db-shm` | `~/.dg/agents/` |
| personas | `~/.local/share/dg/agents` | `~/.dg/agents` |
| daemon-logs | `~/.local/state/dg/log` | `~/.dg/daemon/logs` |
| daemon | `~/.local/state/dg/daemon` | `~/.dg/daemon` |
| grants | `~/.local/state/dg/grants` | `~/.dg/grants` |
| phone | `~/.local/state/dg/phone` | `~/.dg/phone` |
| phone-friend | `~/.local/state/dg/phone-friend` | `~/.dg/phone-friend` |
| inbox | `~/.local/state/dg/inbox` | `~/.dg/inbox` |
| browser-profiles | `~/.local/state/dg/browser-profiles` | `~/.dg/browser-profiles` |
| demo-profile | `~/.local/state/dg/demo-profile` | `~/.dg/demo-profile` |
| channel-review-config | `~/.config/dg/channel-review/config.json` | `~/.dg/channel-review/config.json` |
| channel-review | `~/.local/state/dg/channel-review` | `~/.dg/channel-review` |
| ssms-config | `ssms/config.yaml` in the config folder under the passwd home | `~/.dg/ssms/config.yaml` |
| ssms | `~/.local/state/dg/ssms` | `~/.dg/ssms` |
| proto | `~/.cache/dg/proto` | `~/.dg/proto` |
| demos | `~/.cache/dg/demos` | `~/.dg/demos` |
| config | `~/.config/dg/config.json` | `~/.dg/config.json` |
| cli-only | `~/.config/dg/cli-only` | `~/.dg/cli-only` |

Copy a parent folder before the folder inside it: `daemon` before
`daemon-logs`, `agents` (personas) before `sessions`, `assets` and `memory`, and
`channel-review` before its `config.json`. The `bin` entry is a marker, not a
copy. The older release writes its own launchers to `~/.dg/bin`.

After a rollback, the old release owns `~/.dg`. Before you upgrade again,
remove the per-OS copies you no longer want. Otherwise dg keeps both, and
`dg doctor install` reports a split.

The keychain move is one-way. A daemon from before the per-OS layout (#136)
cannot read the key. The encrypted credentials in `daemon.db` do not decrypt.
Pair again and add the credentials again.

## Bump the Bun runtime

Maintainers change the pinned Bun with one command from a checkout:

```bash
bun scripts/bump-runtime.ts 1.4.2
```

It reads Bun's `SHASUMS256.txt` for that tag and rewrites
`pkg/launcher/runtime.json`, the `bun` pin in `.mise/config.toml` and every
`setup-bun` version in the workflows. `dependency-pinning.spec.ts` fails when
they disagree. The next release builds the compiled programs with the new Bun,
and ships the new `runtime.json` for the 6.3 bridge.

## Update everything

One command brings every dg part to the newest release:

```bash
dg update --check   # print installed and newest versions; change nothing
dg update           # update, then run doctor
```

`update` runs these steps in order. A failed step does not stop the rest, and
the command exits 1 when any step failed:

1. The `dg` program, the launcher link, and the staged
   dg-ai-extension, pinned to the newest release. A CLI-only install stays
   CLI-only, the staged browser extension is refreshed (with both Chrome and
   Firefox staged, Chrome is refreshed and the step names the command for
   Firefox), and an install with no
   staged extension (such as a skills-only install) gets only the program.
   The step fails
   when the installed version is not the newest afterward.
2. The Claude plugin: `claude plugin marketplace update detailedghost`, then
   `claude plugin update dg@detailedghost` (or `install` when it is missing).
   Skipped when `claude` is not on `PATH`.
3. The Codex plugin, when the Codex config (`$CODEX_HOME`, default
   `~/.codex`) enables `dg@detailedghost`:
   `codex plugin marketplace upgrade detailedghost`, then
   `codex plugin add dg@detailedghost`. A marketplace that points at a local
   folder is replaced with `detailedghost/dg-ai` first.
4. `dg doctor`, as one summary line. It is information only. Doctor
   also reports things `update` does not own, such as a stopped daemon, so it
   does not change the exit code.

Skills copied into `$CODEX_HOME/skills` by a `--codex` bootstrap
are not refreshed by `update`. When Codex has no dg plugin but has that
folder, `update` and `--check` print the bootstrap command that refreshes it.

The Claude step updates the user scope. A project or local install that is
still behind gets a warning line with the command to run in that project.

`update` always goes to the newest release, because the plugins follow their
marketplace. To install one exact release, use `dg install --version
<x.y.z>`. Restart Claude Code and Codex
sessions afterward, and reload the extension. The `/dg:update` skill runs
`--check`, asks, and then runs the update.

## Update the Claude Code plugin

Pin the marketplace once to the `latest` tag. Do not pin `master`. Set the
same ref in both files:

- `~/.claude/settings.json`: `extraKnownMarketplaces.detailedghost.source.ref`
- `~/.claude/plugins/known_marketplaces.json`: the `detailedghost` source `ref`

Then each release arrives with two commands:

```bash
claude plugin marketplace update detailedghost
claude plugin update dg@detailedghost
```

## Pin a version

Install a specific release instead of the newest, by adding `--version <x.y.z>`
(shell) or `-Version <x.y.z>` (PowerShell):

<!-- markdownlint-disable MD013 -->

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --version X.Y.Z
```

```powershell
& ([scriptblock]::Create((irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1))) -Version X.Y.Z
```

<!-- markdownlint-enable MD013 -->

This pins the program and the extension to that `vX.Y.Z`
release, and combines with `--cli-only`/`--agent-only`. An installed
An installed `dg` accepts the same flag: `dg install --version X.Y.Z`.
Leaving it unset installs the newest release.

If the pinned release does not exist, the whole install fails and names it. It
checks every part first and changes nothing, so a pin never leaves some parts
updated and others not. A pin to a release from before the compiled program fails the
same way and prints that release's own bootstrap command.

## Plugin cache

Claude Code keeps every dg plugin version under
`~/.claude/plugins/cache/<marketplace>/dg/<version>/` and removes orphaned ones
about 14 days after it marks them. `dg install` reclaims that space now,
in every mode except `--skills-only` and `--local`, which is a dev build that
never touches release binaries. It prints one line, for example
`plugin cache: removed 1.20.0, 1.21.0 (58 MB); kept 1.24.0 (active)`.

Install keeps a version when any of these is true:

- `installed_plugins.json` names it.
- A session read it in the last 24 hours (the `.in_use` folder changed).
- An `.in_use` entry names a live process.
- It has no `.orphaned_at` marker. Install never deletes a version in an unknown
  state, and prints `kept <version> (unknown state)`.

Install skips the step and prints a reason when `installed_plugins.json` is
unreadable. It never follows a symlink and never touches other plugins or the
marketplace clones. Pass `--keep-cache` to leave the cache alone.

`dg doctor install` reports stale versions and how much space they use.

When `DG_HOME` is set to something other than `~/.dg`, install prints
`note: DG_HOME=<path>; installing there` to stderr before it changes anything,
and `dg doctor` warns.

## Recommended plugins

Recommended plugins are third-party skills that dg pins but does not
maintain. No dg skill requires them. Every entry in
`.claude-plugin/marketplace.json` except `dg` is one:

- `unslop` removes AI writing patterns from prose. `/dg:polish` calls it when
  present.
- `mattpocock-skills` ships many skills, including `/teach` and `/wait-what`.

Each entry is pinned to a full commit sha. Installs fetch that commit, not the
branch head.

### Install

```bash
dg install --with-recommended
```

The flag is off by default. It works with the default install, `--cli-only` and
`--skills-only`. With `--agent-only`, the command exits 1 before it changes
anything.

With the default install or `--cli-only`, `dg` runs the `claude` CLI to
install each plugin. It first refreshes the `detailedghost` marketplace once.
Claude Code installs the commit that its own `detailedghost` marketplace clone
pins, and that clone follows `master`. `dg` checks the
installed sha against that marketplace pin. When the marketplace pin differs
from the pin in this `dg`, it prints a `note:` line that names both.
When the clone cannot be read, it checks against its own pin. When an installed
sha differs from the expected pin, it uninstalls and installs again. Only
user-scope installs count.

`mattpocock-skills` adds many skill descriptions to every Claude Code session.
That raises the system prompt, so the flag stays opt-in.

### Codex and OpenCode

Use `--skills-only` with `--dest`. A skills-only install copies the dg skills
from a dg-ai checkout, so pass `--repo` with its path, or run the command
inside the checkout:

```bash
dg install --skills-only --repo ~/code/dg-ai --dest ~/.config/opencode/skills --with-recommended
```

`dg` fetches each pinned commit with git. It copies only the regular
tracked files of the declared skill folders that hold a `SKILL.md`. `unslop`
installs as `<dest>/unslop/`. A symlink in the source stops the plugin.

A flat destination skips any skill whose name matches a dg skill. Today those
are `grill-me` and `wayfinder`. Each skip prints a line. The dg copies win
because `/dg:spec` and `/dg:grill-me` link to `/dg:wayfinder`, and wayfinder
runs `dg:grill-me`. In Claude Code, namespaces keep them apart:
`/dg:grill-me` and `/mattpocock-skills:grill-me`.

### Offline behavior

With no network, no `claude` binary, an unknown sha or a sha mismatch, the
plugin prints one warning, `⚠ <plugin> skipped: <reason>`. It installs nothing
for that plugin. If a failure happens while the skills move into place, the
warning reads `⚠ <plugin> failed: <reason>` instead. The dg skills still
install and the command continues.

With the `claude` CLI, `dg` checks the user-scope sha after each install.
If it differs from the pin, `dg` uninstalls the plugin and prints
`⚠ <plugin> removed: installed <sha>, expected <pin>`. If that uninstall fails,
the line reads `⚠ <plugin> skipped: installed <sha>, expected <pin>; uninstall
failed: <reason>`. If the sha cannot be read, the line reads `⚠ <plugin>
installed, but its commit could not be verified`, and the plugin stays.

When the same command also moves `dg` to another version, the running
binary still holds the old pins. It then installs no recommended plugin and
prints `⚠ recommended plugins skipped: dg is now v<version>. Run the
same dg install command again to install them at its pins.`

### Bump a pin

Maintainers move a pin from a checkout:

```bash
bun scripts/bump-plugin-pin.ts unslop
bun scripts/bump-plugin-pin.ts mattpocock-skills --ref main
```

The script reads the ref with `git ls-remote`, rewrites the sha in
`.claude-plugin/marketplace.json` and prints `<name>: <old> -> <new>`. It exits
1 for an unknown name or bad ref, 2 for a missing file and 3 when the repo is
unreachable. Claude Code does not act on a sha change alone, so the next
`dg install --with-recommended` uninstalls and installs the plugin
again.

### Retired and private copies

dg no longer ships `/dg:teach` and `/dg:wait-what`. `/teach` and `/wait-what`
now come from `--with-recommended` as `mattpocock-skills`. A skills install
removes an old `teach` or `wait-what` folder from the destination only when its
`SKILL.md` matches the last dg copy.

If you copied `unslop` by hand, delete the private copies. They shadow the
pinned plugin and never update:

- `~/.claude/skills/unslop`
- `~/.agents/skills/unslop`
- `~/.config/opencode/skills/unslop`

Then reinstall the pinned plugin for your agent.

Claude Code:

```bash
dg install --with-recommended
```

Codex and OpenCode need a dg-ai checkout, as above. Replace `~/code/dg-ai`
with its path.

Codex:

```bash
dg install --skills-only --repo ~/code/dg-ai --dest ~/.codex/skills --with-recommended
dg install --skills-only --repo ~/code/dg-ai --dest ~/.agents/skills --with-recommended
```

OpenCode:

```bash
dg install --skills-only --repo ~/code/dg-ai --dest ~/.config/opencode/skills --with-recommended
```

dg marks each recommended skill folder with a `.dg-recommended` file. It
replaces only folders that have this file. If a folder with the same name is
already there without the file, dg leaves it alone and prints
`skipped <name> (a copy dg did not install is already there)`. Delete that
folder, then run the command again.

## Manage dg plugins

`dg plugin` manages external dg plugins. A plugin is untrusted until you approve
it. dg does not load its text or run it before then. The contract is in
[plugin-protocol.md](plugin-protocol.md).

An agent must never pass `--approve`. Approval is a human step: the person reads
the plugin source, then runs the command.

```bash
dg plugin add <git url or path> [--pin <sha256|commit>] [--name <name>]
dg plugin verify <name> --approve   # human only: review <data>/plugins/<name>/src first
dg plugin list [--json]
dg plugin enable <name>
dg plugin disable <name>
dg plugin update <name> [--pin <sha256|commit>]
dg plugin remove <name>
```

`add` copies the source and marks it `unapproved`. `verify` checks the copy
against its recorded hash. With `--approve`, it records that hash as approved
and signs the record. The signing key is the credential `dg/plugin-approval-key`
in the dg daemon credential store. `--approve` creates it on first use, so the
daemon must run (`dg agent start`).

A plugin counts as approved only when the signature verifies and the files still
match. A record with no signature, or a bad one, is unapproved. This includes
records that older dg wrote. If the daemon is not running or the key is missing,
no plugin is approved. Start the daemon, or run `verify <name> --approve` again.

`update` fetches the new source. When the source or its pin changed, the plugin
turns off until you run `verify --approve` again. The front door runs `list` and
`verify` itself while no record claims approval. It hands any approval check and
every `--approve` to `dg-core`, because the front door has no credential store
client. `add`, `remove`, `enable`, `disable` and `update` run in `dg-core`.

The plugin host caches file sizes, times and inodes in `stat-cache.json` inside
the plugin folder. It signs the cache with the same key. It hashes the files
again when any entry changes, when the signature fails, and once a day.

## CLI-only install

Install the program and the skills that run without the browser
extension. This skips the extension and its pairing. Run it before using the
plugin so its skills find `dg` and do not start a full install.

<!-- markdownlint-disable MD013 -->

macOS / Linux:

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Windows, in PowerShell:

```powershell
& ([scriptblock]::Create((irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1))) -CliOnly
```

<!-- markdownlint-enable MD013 -->

An installed `dg` accepts `dg install --cli-only`. Add `--codex`
(`-Codex` in PowerShell) to copy only the CLI skills into `$CODEX_HOME/skills`.

| Skill | CLI-only |
| --- | --- |
| `stash`, `proxy` | Yes — proxy needs the selected external backend installed and authenticated |
| `clipboard-img` | Yes — needs a native WSL, Wayland, or X11 clipboard tool |
| `channel-review` | Yes |
| `worktree`, `spec`, `sdlc`, `assign`, `monolith`, `spring-break`, `review-loop`, `polish` | Yes — they call other skills and tools that must be available |
| `land` | Yes — needs Git, an authenticated `gh` (GitHub only), and the selected review backend |
| `jot`, `bg`, `cls`, `stat`, `sniff`, `find-work`, `doctor` | Yes — they call other skills and tools that must be available |
| `db`, `erd` | Yes |
| `pw` | Yes — needs Bun 1.4.0 or later and Chrome, Edge, or a Chromium from `install-browser`; `pw launch` and `pw batch-open --ext` need the extension |
| `adr` | Yes — `dg adr`; `ask` mode needs a repo that ran `dg adr init` |
| `eli5` | Yes for `-v`/`-p` (stash) or `--erd`; a plain `/dg:eli5 <thing>` needs no CLI |
| `ticket` | Yes — needs a stored `ticket/jira` credential |
| `test-live` | Yes — needs Git and an authenticated `gh` (GitHub only) |
| `nope` | No CLI needed — it calls no CLI and no other skill |
| `google-sms-cleanup` | Yes — `dg ssms`; live Google needs a CDP browser, live Signal needs `signal-cli` |
| `inbox-cleanup` | Yes for explicit `--data-path` fixtures; live profiles need the dg daemon |
| `proto`, `demo` | No — local by default; `--ext` needs the extension |
| `chat`, `overwatch` | No — needs the dg daemon, which serves the local page on loopback; `--ext` also needs the extension |

On WSL, the default `demo` uses the Windows browser. The CLI controls it through a
remote-debugging port on 127.0.0.1, and the port stays open while the run is live. To
not open that port, use `demo --video --browser chromium` for a headless recording inside WSL.
`--video` alone still uses the Windows browser when one is present.
Any local process can attach to that port during the run. See
[ADR 0029](adr/0029-local-demo-player-wsl-debug-port.md).

`vcs-provider` is also available as a CLI command; it needs Git and authenticated
`gh` (GitHub) or `glab` (GitLab). It has no separate skill. Other workflow skills
without an extension dependency also install; their own tools and referenced
skills still need to be available.

Every skill runs locally by default; only `pw launch` always needs the
extension. A skill run with `--ext` stops with a message that names the fix
when the extension is missing. To add the extension later, run
`dg install` (or the full bootstrap command above). That removes the
CLI-only marker in the dg config folder.

## Skills-only install

Copy the skill instruction files plus the `dg` program they call. This path writes
`plugins/dg/skills` (each `SKILL.md` plus the reference files next to it,
including `google-sms-cleanup`) into a directory you choose. Bootstrap copies
the files before any download. It then installs the `dg` program from
the latest `vX.Y.Z` release, checked against that release's `SHA256SUMS`, and
stops. It does not download the extension, and it does not run the text inside
a skill.

From a checkout:

```bash
mise run install:skills
```

Or, with Bun:

```bash
bun pkg/skills-cli/src/index.ts install --skills-only
```

An installed `dg` accepts the same flag. Pass `--repo <checkout>`
when it is not running inside this repository.

<!-- markdownlint-disable MD013 -->

macOS / Linux, without a local checkout:

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --skills-only
```

Windows, in PowerShell:

```powershell
& ([scriptblock]::Create((irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1))) -SkillsOnly
```

<!-- markdownlint-enable MD013 -->

`--dest <dir>` (`-Dest <dir>`) chooses the directory (default: `skills/` in the dg
data folder). Point it at `$CODEX_HOME/skills` when the files should land
where Codex reads skills. Add `--no-cli` (`-NoCli`) for an offline copy that
downloads nothing. The skills root `README.md` is not installed.

## Chat-only install

Download only the chat-safe chat skills, ready to upload to Claude chat. This
installs no program, no launcher and no extension, and runs nothing
it downloads. See [chat install](chat-install.md) for what the skills do and how to
upload them.

<!-- markdownlint-disable MD013 -->

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --chat-only
```

```powershell
& ([scriptblock]::Create((irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1))) -ChatOnly
```

<!-- markdownlint-enable MD013 -->

## Install flags

Every bootstrap mode is a flag. PowerShell takes the same flags as switches when
the script runs as a script block, as in the commands above.

| `bootstrap.sh` | `bootstrap.ps1` | Effect |
| --- | --- | --- |
| `--cli-only` | `-CliOnly` | Skip the browser extension |
| `--agent-only` | `-AgentOnly` | Install for a non-Claude agent that only needs phone |
| `--skills-only` | `-SkillsOnly` | Copy the skill files, then the `dg` program |
| `--no-cli` | `-NoCli` | With `--skills-only`: copy the files only, download nothing |
| `--chat-only` | `-ChatOnly` | Download only the chat skills for Claude chat |
| `--dest <dir>` | `-Dest <dir>` | Where `--skills-only` or `--chat-only` writes |
| `--codex` | `-Codex` | Also copy the skills into `$CODEX_HOME/skills` |
| `--version <x.y.z>` | `-Version <x.y.z>` | Install that release instead of the newest |

Older scripts may still set `DG_CLI_ONLY`, `DG_AGENT_ONLY`, `DG_SKILLS_ONLY`,
`DG_SKILLS_NO_CLI`, `DG_SKILLS_DEST`, `DG_INSTALL_CODEX` or `DG_VERSION`. They keep
working, and a flag always wins. `--chat-only` has no environment variable.

## Codex plugin

Install from this repository's Codex marketplace:

```bash
codex plugin marketplace add detailedghost/dg-ai
codex plugin add dg@detailedghost
```

Start a new Codex thread after installation. The shared skills bootstrap the CLI
on first use.

To install the same skills directly into `$CODEX_HOME/skills` without the Codex
plugin, opt in while bootstrapping:

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --codex
```

PowerShell standalone installation:

```powershell
& ([scriptblock]::Create((irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1))) -Codex
```

The standalone path copies the skills to `$CODEX_HOME/skills` (or
`~/.codex/skills`). Start a new Codex thread after either installation method.

## Supported browsers

- **Chromium** — Chrome, Edge, Brave, Vivaldi, Opera (single build)
- **Firefox** 139+

See the [agent install guide](AGENT-INSTALL.md) for pairing, local builds, and
the steps that need a person. Read the [browser guide](browser.md) for the
extension’s URL markers and browser-specific behavior.

## Browser download for pw

`dg pw` uses a system Chrome or Edge first. With neither, it exits 3 and
names `dg pw install-browser`. Run that command only when you agree to a
download of about 150 MB. It stores Chromium under `browsers/` in the dg data
folder and records it in `chromium.json`.

`dg doctor pw` reports the result on one line, such as
`browser: chrome (system)`. To remove the download, run
`dg pw install-browser --remove`. It deletes the `browsers/` directory
and nothing else.
