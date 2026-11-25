# Browser mode

`dg pw` runs each call in the human's real browser (`ext`) or in a Playwright browser that dg starts (`local`). The default is `auto`.

## Order of choice

First match wins:

1. A local-only verb runs local.
2. `--local` runs local. `--ext` runs ext. `--ext` with a local-only verb exits 2 with `pw <verb> runs only in local mode`.
3. `DG_BROWSER=ext` or `DG_BROWSER=local`. `DG_BROWSER=auto` forces nothing. Any other value stops the call with `DG_BROWSER must be ext, local or auto`. To name a browser binary, set `DG_VERIFY_BROWSER`.
4. `browser.mode` in `config.toml`: `ext`, `local` or `auto` (default).
5. `auto`: ext when the extension is paired and connected and the call fits it, else local with no error.

A call fits the extension when its verb has an ext verb, it has no options and no session, and the positional count matches. `type --submit` is the one option that fits. The pw name maps to the ext name: `goto` to `open`, `tab-list` to `tabs`, `tab-new` to `new`, `tab-close` to `close`.

`pw select`, `close`, `tab-select`, `upload` and `tab-close <index>` stay local in auto mode: their pw meaning (option, browser session, tab index, local path) differs from the ext verb of the same name. Use the ext verb with `--ext`, for example `dg pw --ext select <tabId>`.

## Local-only verbs

| Verb | Why it stays local |
|---|---|
| `route`, `unroute`, `route-list` | Request mocking uses Playwright interception. The extension cannot intercept or fulfill requests of the real profile |
| `network-state-set` | Offline and throttle emulation set a Playwright context state |
| `state-save`, `state-load` | They write or read a full cookie jar and storage in a plain file, which would copy the sign-ins of the real profile |
| `delete-data` | It wipes cookies and storage of a profile, which the extension never does in the real profile |
| `cookie-set`, `cookie-delete`, `cookie-clear` | Cookie writes in the real profile are refused; local cookies belong to a throwaway profile |
| `video-start`, `video-stop`, `video-chapter` | Recording uses the Playwright context recorder |
| `tracing-start`, `tracing-stop` | Tracing uses the Playwright tracer |
| `pdf` | It uses `page.pdf()` of Playwright |
| `install-browser` | It downloads Playwright's Chromium |
| `kill-all` | It stops local pw daemons and sessions |
| `attach` | It connects to a browser over CDP, a local engine |

Firefox, WebKit, headless runs and CI need local mode too. CI and recorded fixtures use `--local`.
