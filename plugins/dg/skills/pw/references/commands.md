# Commands

### Core

```bash
~/.dg/bin/dg-skills pw open
~/.dg/bin/dg-skills pw open https://example.com/
~/.dg/bin/dg-skills pw goto https://playwright.dev
~/.dg/bin/dg-skills pw type "search query"
~/.dg/bin/dg-skills pw click e3
~/.dg/bin/dg-skills pw dblclick e7
~/.dg/bin/dg-skills pw fill e5 "user@example.com" --submit
~/.dg/bin/dg-skills pw drag e2 e8
~/.dg/bin/dg-skills pw hover e4
~/.dg/bin/dg-skills pw select e9 "option-value"
~/.dg/bin/dg-skills pw upload ./document.pdf
~/.dg/bin/dg-skills pw check e12
~/.dg/bin/dg-skills pw uncheck e12
~/.dg/bin/dg-skills pw snapshot
~/.dg/bin/dg-skills pw eval "document.title"
~/.dg/bin/dg-skills pw eval "el => el.textContent" e5
~/.dg/bin/dg-skills pw dialog-accept
~/.dg/bin/dg-skills pw dialog-accept "confirmation text"
~/.dg/bin/dg-skills pw dialog-dismiss
~/.dg/bin/dg-skills pw resize 1920 1080
~/.dg/bin/dg-skills pw close
```

`--submit` presses Enter after filling. `--header` repeats. Negative numbers are positionals, not flags.

### Navigation

```bash
~/.dg/bin/dg-skills pw go-back
~/.dg/bin/dg-skills pw go-forward
~/.dg/bin/dg-skills pw reload
```

### Keyboard

```bash
~/.dg/bin/dg-skills pw press Enter
~/.dg/bin/dg-skills pw press ArrowDown
~/.dg/bin/dg-skills pw keydown Shift
~/.dg/bin/dg-skills pw keyup Shift
```

### Mouse

```bash
~/.dg/bin/dg-skills pw mousemove 150 300
~/.dg/bin/dg-skills pw mousedown
~/.dg/bin/dg-skills pw mousedown right
~/.dg/bin/dg-skills pw mouseup
~/.dg/bin/dg-skills pw mouseup right
~/.dg/bin/dg-skills pw mousewheel 0 100
~/.dg/bin/dg-skills pw mousewheel 0 -300
```

### Save as

```bash
~/.dg/bin/dg-skills pw screenshot
~/.dg/bin/dg-skills pw screenshot e5
~/.dg/bin/dg-skills pw screenshot --filename=page.png
~/.dg/bin/dg-skills pw pdf --filename=page.pdf
```

### Tabs

```bash
~/.dg/bin/dg-skills pw tab-list
~/.dg/bin/dg-skills pw tab-new
~/.dg/bin/dg-skills pw tab-new https://example.com/page
~/.dg/bin/dg-skills pw tab-close
~/.dg/bin/dg-skills pw tab-close 2
~/.dg/bin/dg-skills pw tab-select 0
```

### Storage

```bash
~/.dg/bin/dg-skills pw state save <name>
~/.dg/bin/dg-skills pw state-save [file]
~/.dg/bin/dg-skills pw state-load <file>
~/.dg/bin/dg-skills pw state load <name>
~/.dg/bin/dg-skills pw state list
~/.dg/bin/dg-skills pw state delete <name>
~/.dg/bin/dg-skills pw state import <file> [name]
~/.dg/bin/dg-skills pw cookie-list
~/.dg/bin/dg-skills pw cookie-list --domain=example.com
~/.dg/bin/dg-skills pw cookie-get session_id
~/.dg/bin/dg-skills pw cookie-set session_id abc123
~/.dg/bin/dg-skills pw cookie-set session_id abc123 --domain=example.com --httpOnly --secure
~/.dg/bin/dg-skills pw cookie-delete session_id
~/.dg/bin/dg-skills pw cookie-clear
~/.dg/bin/dg-skills pw localstorage-list
~/.dg/bin/dg-skills pw localstorage-get theme
~/.dg/bin/dg-skills pw localstorage-set theme dark
~/.dg/bin/dg-skills pw localstorage-delete theme
~/.dg/bin/dg-skills pw localstorage-clear
~/.dg/bin/dg-skills pw sessionstorage-list
~/.dg/bin/dg-skills pw sessionstorage-get step
~/.dg/bin/dg-skills pw sessionstorage-set step 3
~/.dg/bin/dg-skills pw sessionstorage-delete step
~/.dg/bin/dg-skills pw sessionstorage-clear
```

Prefer `~/.dg/bin/dg-skills pw state save <name>`. Raw `~/.dg/bin/dg-skills pw state-save <file>` leaves a full cookie jar on disk until you remove it.

### Network

```bash
~/.dg/bin/dg-skills pw route "**/*.jpg" --status=404
~/.dg/bin/dg-skills pw route "https://api.example.com/**" --body='{"mock": true}'
~/.dg/bin/dg-skills pw route "**/api/**" --header="X-A: 1" --header="X-B: 2"
~/.dg/bin/dg-skills pw route-list
~/.dg/bin/dg-skills pw unroute "**/*.jpg"
~/.dg/bin/dg-skills pw unroute
```

### DevTools

```bash
~/.dg/bin/dg-skills pw console
~/.dg/bin/dg-skills pw console warning
~/.dg/bin/dg-skills pw network
~/.dg/bin/dg-skills pw network --filter=/api/ --request-body
~/.dg/bin/dg-skills pw-code "async page => await page.context().grantPermissions(['geolocation'])"
~/.dg/bin/dg-skills pw-code --filename=script.js
~/.dg/bin/dg-skills pw tracing-start
~/.dg/bin/dg-skills pw tracing-stop
~/.dg/bin/dg-skills pw video-start video.webm
~/.dg/bin/dg-skills pw video-chapter "Chapter Title" --description="Details" --duration=2000
~/.dg/bin/dg-skills pw video-stop
```

`pw-code` is a separate command, not a `pw` subcommand. It asks for your approval on every call. See `running-code.md`.

## Raw output

The global `--raw` option strips page status, generated code, and snapshot sections. It returns only the result value. Commands without output return nothing. Run each command alone. Do not pipe or redirect.

```bash
~/.dg/bin/dg-skills pw --raw eval "JSON.stringify([...document.querySelectorAll('a')].map(a => a.href))"
~/.dg/bin/dg-skills pw --raw eval "JSON.stringify(performance.timing)"
~/.dg/bin/dg-skills pw --raw cookie-get session_id
~/.dg/bin/dg-skills pw --raw localstorage-get theme
```

To keep output on disk, use the command's own `--filename=` option, then Read the file with `offset`/`limit`.

```bash
~/.dg/bin/dg-skills pw snapshot --filename=before.yml
~/.dg/bin/dg-skills pw click e5
~/.dg/bin/dg-skills pw snapshot --filename=after.yml
```

## Snapshots

After each command, `pw` prints the page state and a snapshot path.

```
### Page
- Page URL: https://example.com/
- Page Title: Example Domain
### Snapshot
[Snapshot](/tmp/ai/pw/9f1a8ce9/page-2026-02-14T19-22-42-679Z.yml) 1.5 KB, 9 lines
```

Take a snapshot on demand with `~/.dg/bin/dg-skills pw snapshot`. Combine the options as needed.

```bash
~/.dg/bin/dg-skills pw snapshot
~/.dg/bin/dg-skills pw snapshot --filename=after-click.yaml
~/.dg/bin/dg-skills pw snapshot "#main"
~/.dg/bin/dg-skills pw snapshot --depth=3
~/.dg/bin/dg-skills pw snapshot --full
~/.dg/bin/dg-skills pw snapshot e34
```

`--filename=` saves to a named file. `"#main"` snapshots one element. The default depth is 6. `--depth=N` limits it, `--full` removes the limit; follow with a partial snapshot such as `e34`. Refs in frames carry a prefix, for example `f1e1`.

## Targeting elements

Use refs from the snapshot by default. A ref matches `^(?:f\d+)?e\d+$`.

```bash
~/.dg/bin/dg-skills pw snapshot
~/.dg/bin/dg-skills pw click e15
```

CSS selectors and Playwright locators also work.

```bash
~/.dg/bin/dg-skills pw click "#main > button.submit"
~/.dg/bin/dg-skills pw click "getByRole('button', { name: 'Submit' })"
~/.dg/bin/dg-skills pw click "getByTestId('submit-button')"
```

## Inspecting element attributes

The snapshot hides `id`, `class`, `data-*` and other DOM properties. Read them with `eval`.

```bash
~/.dg/bin/dg-skills pw eval "el => el.id" e7
~/.dg/bin/dg-skills pw eval "el => el.className" e7
~/.dg/bin/dg-skills pw eval "el => el.getAttribute('data-testid')" e7
~/.dg/bin/dg-skills pw eval "el => el.getAttribute('aria-label')" e7
~/.dg/bin/dg-skills pw eval "el => getComputedStyle(el).display" e7
```

## Browser sessions

Named sessions, profiles, and cleanup: see [session-management.md](session-management.md).

```bash
~/.dg/bin/dg-skills pw open -s=mysession example.com
~/.dg/bin/dg-skills pw -s=mysession click e6
~/.dg/bin/dg-skills pw -s=mysession close
~/.dg/bin/dg-skills pw -s=mysession delete-data
~/.dg/bin/dg-skills pw list
~/.dg/bin/dg-skills pw close-all
~/.dg/bin/dg-skills pw kill-all
```

`-s=<name>` keeps a persistent profile. `--profile=/path` sets the profile directory (use only when asked). `delete-data` removes the session's user data. `close-all` closes every browser. `kill-all` force-kills all daemons.
`~/.dg/bin/dg-skills pw attach --cdp=http://127.0.0.1:9222` drives a running Chromium. Closing the session leaves that browser running.

## Examples

### Form submission

```bash
~/.dg/bin/dg-skills pw open https://example.com/form
~/.dg/bin/dg-skills pw snapshot
~/.dg/bin/dg-skills pw fill e1 "user@example.com"
~/.dg/bin/dg-skills pw fill e2 "password123"
~/.dg/bin/dg-skills pw click e3
~/.dg/bin/dg-skills pw snapshot
~/.dg/bin/dg-skills pw close
```

### Multi-tab workflow

```bash
~/.dg/bin/dg-skills pw open https://example.com
~/.dg/bin/dg-skills pw tab-new https://example.com/other
~/.dg/bin/dg-skills pw tab-list
~/.dg/bin/dg-skills pw tab-select 0
~/.dg/bin/dg-skills pw snapshot
~/.dg/bin/dg-skills pw close
```

### Debugging with DevTools

```bash
~/.dg/bin/dg-skills pw open https://example.com
~/.dg/bin/dg-skills pw click e4
~/.dg/bin/dg-skills pw fill e7 "test"
~/.dg/bin/dg-skills pw console
~/.dg/bin/dg-skills pw network
~/.dg/bin/dg-skills pw close
```

Or trace the same steps:

```bash
~/.dg/bin/dg-skills pw open https://example.com
~/.dg/bin/dg-skills pw tracing-start
~/.dg/bin/dg-skills pw click e4
~/.dg/bin/dg-skills pw fill e7 "test"
~/.dg/bin/dg-skills pw tracing-stop
~/.dg/bin/dg-skills pw close
```

## Extending

Each command is one folder under `pkg/skills-cli/src/pw/commands/<name>/` with `spec.ts` (flags and help, no Playwright import) and `run.ts` (the handler); its test lives at `pkg/skills-cli/__tests__/pw/commands/<name>.spec.ts`. Add one line for it in `pkg/skills-cli/src/pw/commands/index.ts`. Nothing else changes. The one exception is `pw-code`: its spec and handler live in `pkg/skills-cli/src/pw/code/`, `pkg/skills-cli/src/pw/code-cli.ts` is its client, and `pkg/skills-cli/src/commands/pw-code.ts` registers it as its own top-level command, separate from `pw`.

The dropped debugger commands (`pause-at`, `resume`, `step-over`, `show`, `tray`, `attach <name>`) return the same way. Legacy `playwright-cli attach` covers them meanwhile.
