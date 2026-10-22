# Browser Session Management

Run several isolated browser sessions at once, with state that persists.

## Named sessions

Use `-s=<name>` to isolate browser contexts.

```bash
~/.dg/bin/dg-skills pw -s=auth open https://app.example.com/login
~/.dg/bin/dg-skills pw -s=public open https://example.com
~/.dg/bin/dg-skills pw -s=auth fill e1 "user@example.com"
~/.dg/bin/dg-skills pw -s=public snapshot
```

Each session has its own cookies, localStorage and sessionStorage, IndexedDB, cache, history, and tabs.

## Persistent profiles

Each session keeps a real browser profile on disk. Cookies and logins survive close, crash, and reboot. Sign in once per session name.

- Linux profile dir: `~/.cache/playwright-cli/profiles/<session>`.
- Windows profile dir: `%LOCALAPPDATA%\playwright-cli\profiles\<session>`.
- Use a stable name per site, for example `-s=github`. One profile runs in one browser at a time.
- Persistent sessions are global by name. Opening one that another directory holds is refused.
- `--profile=/path/to/profile` overrides the profile dir. Use it only when asked.

```bash
~/.dg/bin/dg-skills pw -s=github open https://github.com
~/.dg/bin/dg-skills pw -s=github delete-data
```

`delete-data` closes the session and removes its profile. It refuses paths outside the profiles root.

## Scratch sessions

`--scratch` gives an in-memory profile. No cookies save. The session is bound to the directory it opened in: the same `-s` name from another directory is a separate session, and a command from another directory does not reach it.

```bash
~/.dg/bin/dg-skills pw open --scratch https://example.com
~/.dg/bin/dg-skills pw close
```

## Named states

A state holds cookies, localStorage, and IndexedDB under `~/.local/state/ai/pw/states/<name>.json` (directory 0700, files 0600). Names match `^[a-z0-9][a-z0-9._-]{0,63}$`.

```bash
~/.dg/bin/dg-skills pw state save github
~/.dg/bin/dg-skills pw state list
~/.dg/bin/dg-skills pw state load github
~/.dg/bin/dg-skills pw state delete github
~/.dg/bin/dg-skills pw state import ./exported.json github
```

- `~/.dg/bin/dg-skills pw state list` shows name, cookie count, origin count, top domains, and save time.
- `~/.dg/bin/dg-skills pw state load` restores cookies and localStorage into the current session. IndexedDB restores only into `--scratch` sessions.
- The first `~/.dg/bin/dg-skills pw state` or `--from` call imports old files from `~/.cache/playwright-cli/sessions/*.json` and leaves the originals.
- Never print or commit a state file. It holds live credentials.
- Raw `~/.dg/bin/dg-skills pw state-save <file>` leaves a full cookie jar on disk until you remove it. Use `~/.dg/bin/dg-skills pw state save <name>`.

### Clone a login

```bash
~/.dg/bin/dg-skills pw -s=a state save site
~/.dg/bin/dg-skills pw -s=b open --from=site https://site.example.com
~/.dg/bin/dg-skills pw open --scratch --from=site https://site.example.com
```

The scratch form restores everything, including IndexedDB, and leaves no profile behind.

## Session commands

```bash
~/.dg/bin/dg-skills pw list
~/.dg/bin/dg-skills pw close
~/.dg/bin/dg-skills pw -s=mysession close
~/.dg/bin/dg-skills pw close-all
~/.dg/bin/dg-skills pw kill-all
~/.dg/bin/dg-skills pw -s=mysession delete-data
```

- `~/.dg/bin/dg-skills pw list` shows name, status, cwd, browser, profile (or `<in-memory>`), and pid.
- `~/.dg/bin/dg-skills pw close` stops the default session. With `-s=` it stops a named one. It also closes Windows sessions.
- `~/.dg/bin/dg-skills pw kill-all` force-kills every daemon. Use it for stale processes.

## Default session

Without `-s`, commands use `default`. Set `PLAYWRIGHT_CLI_SESSION=mysession` to change that name.

## Best practices

1. Name sessions for their purpose (`github`, `docs-scrape`), not `s1`.
2. Close browsers when done: `~/.dg/bin/dg-skills pw -s=auth close`, or `~/.dg/bin/dg-skills pw close-all`.
3. For parallel work, open each session in its own Bash call, then snapshot each with `~/.dg/bin/dg-skills pw -s=<name> snapshot`.
