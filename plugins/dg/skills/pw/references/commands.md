# Commands

### Core

```bash
dg pw open
dg pw open https://example.com/
dg pw goto https://playwright.dev
dg pw type "search query"
dg pw click e3
dg pw dblclick e7
dg pw fill e5 "user@example.com" --submit
dg pw drag e2 e8
dg pw hover e4
dg pw select e9 "option-value"
dg pw upload ./document.pdf
dg pw check e12
dg pw uncheck e12
dg pw snapshot
dg pw eval "document.title"
dg pw eval "el => el.textContent" e5
dg pw dialog-accept
dg pw dialog-accept "confirmation text"
dg pw dialog-dismiss
dg pw resize 1920 1080
dg pw close
```

`--submit` presses Enter after filling. `--header` repeats. Negative numbers are positionals, not flags.

### Navigation

```bash
dg pw go-back
dg pw go-forward
dg pw reload
```

### Keyboard

```bash
dg pw press Enter
dg pw press ArrowDown
dg pw keydown Shift
dg pw keyup Shift
```

### Mouse

```bash
dg pw mousemove 150 300
dg pw mousedown
dg pw mousedown right
dg pw mouseup
dg pw mouseup right
dg pw mousewheel 0 100
dg pw mousewheel 0 -300
```

### Save as

```bash
dg pw screenshot
dg pw screenshot e5
dg pw screenshot --filename=page.png
dg pw pdf --filename=page.pdf
```

### Tabs

```bash
dg pw tab-list
dg pw tab-new
dg pw tab-new https://example.com/page
dg pw tab-close
dg pw tab-close 2
dg pw tab-select 0
```

### Storage

```bash
dg pw state save <name>
dg pw state-save [file]
dg pw state-load <file>
dg pw state load <name>
dg pw state list
dg pw state delete <name>
dg pw state import <file> [name]
dg pw cookie-list
dg pw cookie-list --domain=example.com
dg pw cookie-get session_id
dg pw cookie-set session_id abc123
dg pw cookie-set session_id abc123 --domain=example.com --httpOnly --secure
dg pw cookie-delete session_id
dg pw cookie-clear
dg pw localstorage-list
dg pw localstorage-get theme
dg pw localstorage-set theme dark
dg pw localstorage-delete theme
dg pw localstorage-clear
dg pw sessionstorage-list
dg pw sessionstorage-get step
dg pw sessionstorage-set step 3
dg pw sessionstorage-delete step
dg pw sessionstorage-clear
```

Prefer `dg pw state save <name>`. Raw `dg pw state-save <file>` leaves a full cookie jar on disk until you remove it.

### Network

```bash
dg pw route "**/*.jpg" --status=404
dg pw route "https://api.example.com/**" --body='{"mock": true}'
dg pw route "**/api/**" --header="X-A: 1" --header="X-B: 2"
dg pw route-list
dg pw unroute "**/*.jpg"
dg pw unroute
```

### DevTools

```bash
dg pw console
dg pw console warning
dg pw network
dg pw network --filter=/api/ --request-body
dg pw-code "async page => await page.context().grantPermissions(['geolocation'])"
dg pw-code --filename=script.js
dg pw tracing-start
dg pw tracing-stop
dg pw video-start video.webm
dg pw video-chapter "Chapter Title" --description="Details" --duration=2000
dg pw video-stop
```

`dg pw-code` is a separate command, not a `dg pw` subcommand. It asks for your approval on every call. See `running-code.md`.

## Raw output

The global `--raw` option strips page status, generated code, and snapshot sections. It returns only the result value. Commands without output return nothing. Run each command alone. Do not pipe or redirect.

```bash
dg pw --raw eval "JSON.stringify([...document.querySelectorAll('a')].map(a => a.href))"
dg pw --raw eval "JSON.stringify(performance.timing)"
dg pw --raw cookie-get session_id
dg pw --raw localstorage-get theme
```

To keep output on disk, use the command's own `--filename=` option, then Read the file with `offset`/`limit`.

```bash
dg pw snapshot --filename=before.yml
dg pw click e5
dg pw snapshot --filename=after.yml
```

## Snapshots

After each command, `dg pw` prints the page state and a snapshot path.

```text
### Page
- Page URL: https://example.com/
- Page Title: Example Domain
### Snapshot
[Snapshot](/tmp/ai/pw/9f1a8ce9/page-2026-02-14T19-22-42-679Z.yml) 1.5 KB, 9 lines
```

Take a snapshot on demand with `dg pw snapshot`. Combine the options as needed.

```bash
dg pw snapshot
dg pw snapshot --filename=after-click.yaml
dg pw snapshot "#main"
dg pw snapshot --depth=3
dg pw snapshot --full
dg pw snapshot e34
```

`--filename=` saves to a named file. `"#main"` snapshots one element. The default depth is 6. `--depth=N` limits it, `--full` removes the limit; follow with a partial snapshot such as `e34`. Refs in frames carry a prefix, for example `f1e1`.

## Targeting elements

Use refs from the snapshot by default. A ref matches `^(?:f\d+)?e\d+$`.

```bash
dg pw snapshot
dg pw click e15
```

CSS selectors and Playwright locators also work.

```bash
dg pw click "#main > button.submit"
dg pw click "getByRole('button', { name: 'Submit' })"
dg pw click "getByTestId('submit-button')"
```

## Inspecting element attributes

The snapshot hides `id`, `class`, `data-*` and other DOM properties. Read them with `eval`.

```bash
dg pw eval "el => el.id" e7
dg pw eval "el => el.className" e7
dg pw eval "el => el.getAttribute('data-testid')" e7
dg pw eval "el => el.getAttribute('aria-label')" e7
dg pw eval "el => getComputedStyle(el).display" e7
```

## Browser sessions

Named sessions, profiles, and cleanup: see [session-management.md](session-management.md).

```bash
dg pw open -s=mysession example.com
dg pw -s=mysession click e6
dg pw -s=mysession close
dg pw -s=mysession delete-data
dg pw list
dg pw close-all
dg pw kill-all
```

`-s=<name>` keeps a persistent profile. `--profile=/path` sets the profile directory (use only when asked). `delete-data` removes the session's user data. `close-all` closes every browser. `kill-all` force-kills all daemons.
`dg pw attach --cdp=http://127.0.0.1:9222` drives a running Chromium. Closing the session leaves that browser running.

## Examples

### Form submission

```bash
dg pw open https://example.com/form
dg pw snapshot
dg pw fill e1 "user@example.com"
dg pw fill e2 "password123"
dg pw click e3
dg pw snapshot
dg pw close
```

### Multi-tab workflow

```bash
dg pw open https://example.com
dg pw tab-new https://example.com/other
dg pw tab-list
dg pw tab-select 0
dg pw snapshot
dg pw close
```

### Debugging with DevTools

```bash
dg pw open https://example.com
dg pw click e4
dg pw fill e7 "test"
dg pw console
dg pw network
dg pw close
```

Or trace the same steps:

```bash
dg pw open https://example.com
dg pw tracing-start
dg pw click e4
dg pw fill e7 "test"
dg pw tracing-stop
dg pw close
```

## Extending

Each command is one folder under `pkg/skills-cli/src/pw/commands/<name>/` in the dg repo with `spec.ts` (flags and help, no Playwright import), `run.ts` (the handler), and a test. Add one line for it in `pkg/skills-cli/src/pw/commands/index.ts`. Nothing else changes. The one exception is `dg pw-code`: its spec and handler live in `pkg/skills-cli/src/pw/code/`, and `pkg/skills-cli/src/pw/code-cli.ts` is its client.

The dropped debugger commands (`pause-at`, `resume`, `step-over`, `show`, `tray`, `attach <name>`) return the same way. Legacy `playwright-cli attach` covers them meanwhile.
