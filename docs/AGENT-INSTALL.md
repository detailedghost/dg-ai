# Agent install guide — DeeGee (`dg`)

How an AI agent (Codex or Claude Code) sets up this repository end-to-end,
across **two components**:

1. **The DeeGee plugin** (`dg`) — provides browser, demo, prototype, chat, inbox cleanup, channel review, and Google SMS cleanup skills.
1. **The `dg-ai-extension` browser extension** — the companion that groups tabs
   and drives in-browser demo tours.

Both are needed for the full feature set. Steps below note what an agent can run
directly vs. what needs a human (browser slash-commands and "Load unpacked").

## Codex plugin installation

Register this repository's Codex marketplace and install DeeGee:

```bash
codex plugin marketplace add detailedghost/dg-ai
codex plugin add dg@detailedghost
```

Start a new Codex thread so it discovers the plugin's skills. On first use, a
skill downloads the `dg-skills` CLI if needed. Run the browser skill's `install`
command to stage the companion extension and print the browser's manual
**Load unpacked** steps.

### Standalone Codex skill installation

Codex can load the same skills without the Claude plugin. The bootstrap scripts
keep this opt-in because they write to Codex's local skill directory:

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | DG_INSTALL_CODEX=1 sh
```

On Windows PowerShell:

```powershell
$env:DG_INSTALL_CODEX = "1"
irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
```

These alternative commands install the CLI, stage the browser extension, and copy the
shared browser, demo, proto, chat, inbox-cleanup, channel-review, and google-sms-cleanup skills into `$CODEX_HOME/skills` (default
`~/.codex/skills`). Start a new Codex thread after installation.

## CLI-only install

Use this when the user wants the CLI skills without the browser extension, the
extension pairing, `dg-daemon` or `dg-agent`. It installs `dg-skills` and writes
the marker `~/.dg/cli-only`. Run it before the plugin skills, so their
bootstrap gate sees `dg-skills` and skips the full install.

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

On Windows PowerShell:

```powershell
$env:DG_CLI_ONLY = "1"
irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
```

`DG_CLI_ONLY=1` also works for the shell form, and `dg-skills install --cli-only`
does the same from an installed `dg-skills`. Combined with `DG_INSTALL_CODEX=1`, only
the skills that do not declare `requires: [extension]` reach `$CODEX_HOME/skills`.

- CLI-only skills: `channel-review`, `google-sms-cleanup` (`dg-skills ssms`;
  it drives Messages for Web and can wrap `signal-cli`), `inbox-cleanup` with explicit
  `--data-path` fixtures, `proto` and `demo`, whose default local modes need no
  extension. Only `proto --ext` and `demo --ext` need the dg-ai-extension.
- Extension use: no SKILL.md declares `requires: [extension]`. Every skill runs
  locally by default, and `--ext` opts in to the extension. Only `browser`
  `launch` always needs it. `chat` and
  `overwatch` open a page that `dg-daemon` serves on loopback, which needs
  `dg-agent` and `dg-daemon` but no extension. A CLI-only install has both,
  because one bundle holds all three programs. `browser` runs locally by
  default: `dg-skills batch-open` opens plain tabs and needs the extension only
  with `--ext`. `launch` is `--ext`-only. In a CLI-only install,
  `batch-open --ext`, `launch`, `demo --ext`, `rerun --ext`, `proto --ext`,
  `chat --ext` and `overwatch --ext` stop with: the command needs the
  dg-ai-extension, and `dg-skills install` adds it.
- The extension stays required for every `--ext` command. Each one starts with
  the gate `--ext only: dg-skills require-extension <skill> || exit 1`.
  `chat --ext` and `overwatch --ext` open the same local page as without
  `--ext`. The extension then pairs with each new session on its own. See
  [Pair the browser with an agent session](#pair-the-browser-with-an-agent-session).
- To add the extension later, run `dg-skills install`. It installs the extension
  and removes the marker. Then follow Step 2 below
  for the manual **Load unpacked** step.
- The extension folder is in the dg data root, for example
  `~/.local/share/dg/dg-ai-extension-chrome` on Linux and
  `%LOCALAPPDATA%\dg\dg-ai-extension-chrome` on Windows and WSL. Releases
  before the per-OS layout used `~/.dg`. The move happens on the first start
  of any dg program, not only on install. When the extension folder moves,
  install prints one line. The human must then do one manual step: open
  `chrome://extensions`, remove the old `dg-ai-extension` entry, and load
  unpacked from the new folder. An agent cannot do this step.

## Agent-only install

Use this for a non-Claude agent (for example a Grok Bot) that only needs the
`phone` skill. It installs `dg-agent`, plus `dg-skills` (which fetches
it), and writes the same `~/.dg/cli-only` marker as the CLI-only install.
It never fetches `dg-daemon` or the extension, and never installs personas,
which only the Claude-side CLI uses.

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --agent-only
```

On Windows PowerShell:

```powershell
$env:DG_AGENT_ONLY = "1"
irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
```

`DG_AGENT_ONLY=1` also works for the shell form, and `dg-skills install --agent-only`
does the same from an installed `dg-skills`. It accepts neither `--cli-only` nor
`--skills-only` at the same time. After this, `dg-agent phone
accept <card>` works; see [docs/phone.md](phone.md).

## Skills-only install

Use this when the user wants the skill instruction files without the extension. The installer copies each directory under `plugins/dg/skills` that
contains a `SKILL.md` — the instruction file and its references, including
`google-sms-cleanup` — and does not execute that text. The checkout
commands below do not download the runtime, the bundle or the extension. The
`DG_SKILLS_ONLY=1` bootstrap also installs the runtime and the bundle, so the
skills can run `dg-skills`; set `DG_SKILLS_NO_CLI=1` with it to copy the files only.

From a checkout of this repository:

```bash
mise run install:skills
```

The same copy from source:

```bash
bun pkg/skills-cli/src/index.ts install --skills-only --dest "${DG_SKILLS_DEST:-$HOME/.dg/skills}"
```

`dg-skills install --skills-only` is the flag on an already installed `dg-skills`.
Pass `--repo <checkout>` so it can read `plugins/dg/skills`. `--dest` overrides
the default directory, which is `$DG_SKILLS_DEST`, otherwise `$DG_HOME/skills`,
otherwise `~/.dg/skills`.

Without a checkout:

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --skills-only
```

On Windows PowerShell:

```powershell
$env:DG_SKILLS_ONLY = "1"
irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
```

`DG_SKILLS_ONLY=1` is the shell equivalent of `--skills-only`. This is separate
from `--cli-only`, which writes `~/.dg/cli-only`. Every skills-only path also
installs the `dg-skills` CLI from the latest `vX.Y.Z` release into
the launcher folder ([install layout](install.md#where-dg-keeps-its-files)), checked against the release's `SHA256SUMS`, because the
skills run it. It fetches no `dg-daemon`, `dg-agent` or extension, leaves the
`cli-only` marker untouched, and never executes skill content. Set
`DG_SKILLS_NO_CLI=1` with the bootstraps for an offline copy that skips the CLI.

## Pin a version

Use this when the user wants a specific release instead of the newest, for
example to match a pinned CI job or roll back after a bad upgrade. Add
`--version <x.y.z>` (shell) or set `DG_VERSION` first (PowerShell); it combines
with `--cli-only`/`--agent-only` and carries through to `dg-skills install`, so
`dg-daemon`, `dg-agent` and the extension install from that same release too.

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --version X.Y.Z
```

On Windows PowerShell:

```powershell
$env:DG_VERSION = "X.Y.Z"
irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
```

`dg-skills install --version X.Y.Z` is the flag on an already installed
`dg-skills`. Leaving it unset installs the newest release.

Replace `X.Y.Z` with a `vX.Y.Z` release that lists `dg-lib-X.Y.Z.tar.gz` and
`runtime.json`. If that release does not exist or lacks one of its parts, the
whole install fails and names it, before it touches the runtime, the bundle or
the extension. A release from before the bundle fails the same way and prints
that release's own bootstrap command.
Leaving the version unset keeps today's behavior: install the newest of
each, warning and skipping one that can't be reached.

______________________________________________________________________

## Step 1 — Install the Claude plugin

Current Claude Code releases expose plugin management through the CLI, so an
authorized agent can install or refresh DeeGee directly:

```bash
claude plugin marketplace add detailedghost/dg-ai
claude plugin install dg@detailedghost
```

To refresh an existing install, run:

```bash
claude plugin update dg@detailedghost
```

- The first line registers the marketplace. Use the GitHub slug
  `detailedghost/dg-ai`, or a local checkout path such as `~/code/dg`.
- The second line installs the `dg` plugin; `update` refreshes an existing copy.
- Restart an existing Claude Code session after installing or updating so it
  discovers the refreshed skills.

### Update a marketplace pinned to a release tag

A marketplace pinned to a tag, such as `vX.Y.Z` or the older `skills-vX.Y.Z`, does not move when a
new release ships. `claude plugin update dg@detailedghost` then reports the old
version as the latest. The pin lives in two files, and they must match:

- `~/.claude/settings.json`: `extraKnownMarketplaces.detailedghost.source.ref`
- `~/.claude/plugins/known_marketplaces.json`: the `ref` of the `detailedghost`
  entry

Set both to the new release tag, then run
`claude plugin update dg@detailedghost`. When only one file changes, Claude
Code hides the marketplace until both refs match. An unpinned marketplace
follows `master` and needs no change.

After this, `${CLAUDE_PLUGIN_ROOT}` resolves to the installed plugin directory and
the `/dg:*` skills are available.

## Step 2 — Install the CLI + extension (agent-runnable + one manual step)

The skills run `dg-skills`, `dg-agent` and `dg-daemon` from one bundle on a
pinned Bun runtime. Bootstrap once — this installs the runtime, the bundle and the three launchers in
the per-OS folders ([install layout](install.md#where-dg-keeps-its-files)), **then runs `dg-skills install`**,
which stages the extension and prints the exact **Load unpacked** path:

```bash
if ! command -v dg-skills >/dev/null 2>&1 && [ ! -x "${DG_HOME:-$HOME/.local}/bin/dg-skills" ]; then
  PLUGIN_ROOT="${DG_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
  LOCAL_BOOTSTRAP="${PLUGIN_ROOT}/pkg/skills-cli/bootstrap.sh"
  if [ -n "$PLUGIN_ROOT" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
  fi
fi
```

On Windows PowerShell:

```powershell
irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
```

Claude Code sets `CLAUDE_PLUGIN_ROOT`. Other agent runtimes can set
`DG_PLUGIN_ROOT` to the same checkout. When neither variable points at the
bundled script, the snippet downloads `bootstrap.sh` from the repository.

- No Bun of your own is needed — the installer brings a pinned Bun and never uses
  one on PATH. Bun is only required for the `--local` source build.
- Re-run `dg-skills install` anytime to update the extension, the runtime
  and the bundle together; each part is skipped when already current. For Firefox:
  `dg-skills install firefox`. Default target is **chrome** (also serves
  Brave/Edge/Vivaldi).
- The chat skill runs `dg-agent`, and `dg-agent start` starts
  `dg-daemon` from the same bundle and runtime. Its own bootstrap gate tests for `dg-agent`, not `dg-skills` — a
  machine that already used `browser`, `demo` or `proto` has `dg-skills`
  already, so gating on that would skip the download the gate exists for.
- On **WSL**, the daemon needs **mirrored** networking mode. Under NAT the
  Windows-side browser cannot reach the loopback port; `dg-daemon` exits with
  code 3 rather than pretending to be reachable.
- The state root holds two independent trees. On Linux it is
  `~/.local/state/dg`; `resolveDgPaths` gives the other OSes. `daemon/` holds
  the encrypted `daemon.db` behind the chat commands. `agents/` holds session
  files and the plain-text `memory.db` behind `dg-agent memory`. An agent can also send
  another agent identity a message with `dg-agent send --to <identity>`
  instead of the human. Neither needs the daemon running: `memory` opens
  `agents/memory.db` directly.
- Add `--local` to **build the extension from source** (requires a repository checkout
  with `pkg/extension/`); otherwise it downloads the CI-built extension zip from the release.
- Chromium browsers cannot be silently loaded, so the final step is manual —
  relay the printed steps to the user:
  1. Open `chrome://extensions` (or `edge://extensions`).
  1. Enable **Developer mode**.
  1. Click **Load unpacked** and select the printed path.

Full per-OS detail (WSL → Windows profile paths, native Windows, macOS/Linux):
`plugins/dg/skills/browser/references/install.md`.

### Alternative: cold-start with the extension pre-loaded

For Chromium browsers other than Chrome stable (Brave/Edge/Vivaldi), skip the
manual `chrome://extensions` step entirely — the browser must be fully closed
first:

```bash
dg-skills launch --ext --browser brave --group "PRs" <refs...>
```

## Step 3 — Verify

```bash
dg-skills --help
```

Should list `install`, `batch-open`, `launch`, `demo`, `rerun`, and `channel-review`. Then confirm
grouping/tours work with the browser or demo skill. For the chat harness:

```bash
dg-agent --help
dg-daemon status
```

If a bare name does not answer, call `${DG_HOME:-$HOME/.local}/bin/<name>` instead.

`dg-agent --help` should list `start`, `recv`, `send`, `progress`,
`spawn`, `stage`, `close`, `manifest` and `memory`. `status` is a `dg-daemon` command,
not a `dg-agent` one. `dg-daemon status` reports that no daemon is running
yet, though `memory` works regardless. It opens `agents/memory.db` in the
state root (`~/.local/state/dg/agents/memory.db` on Linux)
directly rather than asking the daemon. Claude Code uses the
`/dg:*` namespace; Codex uses `$dg:*`. The extension acts only on URLs it marked,
so nothing happens until it is loaded in that browser profile.

______________________________________________________________________

### Shell completion

The install also writes bash, zsh and fish completion files for the three
programs to the per-user shell folders. It does not edit a shell startup file.
`dg-skills doctor completion` reports their state. zsh needs one `fpath` line
in `~/.zshrc`; the installer prints it, and an agent must not add it without
the human's yes. See [Shell completion](install.md#shell-completion).

## What an agent can and cannot automate

| Task | Agent-runnable? |
| ------------------------------------------------------------------ | ---------------------------- |
| `claude plugin marketplace add` / `install` / `update` | Yes, with user authorization |
| `bootstrap.sh` (install CLI + extension) | Yes |
| `dg-skills install` (stage extension + refresh the runtime and the bundle) | Yes |
| `dg-agent start` (register a chat session; the extension pairs on its own) | Yes |
| `dg-agent start --open` (open the chat page) | Yes (default browser; on WSL only with `DG_OPEN_WINDOWS=1`) |
| Read a human's chat reply (`dg-agent recv --block`) | Yes — it waits for them |
| `chat --ext` / `overwatch --ext` (open the local page; the extension is required) | Yes, once the human has loaded the extension |
| `dg-agent spawn -- <command>` (run a command in a new session, with `DG_SESSION_ID` set) | Yes |
| Click Unpair, or click Trust this daemon after a daemon home reset | No, the human does it in the popup |
| Switch WSL to mirrored networking mode | No — manual host config |
| Add `dg-daemon-blt` and `dg-agent-blt` to branch protection | No — repo admin |
| Load unpacked in the browser (the only routine human step) | No — manual browser UI |
| `launch` cold-start with extension (`--ext` only) | Yes (browser fully closed) |
| `batch-open --ext` / `demo --ext` / `rerun --ext` | Yes (extension loaded) |
| `demo` / `rerun` without `--ext` | Yes (local browser; it records an MP4 with no start screen, and `ffmpeg` is needed for MP4 output) |
| `batch-open` without `--ext` | No (plain tabs) |

## Google SMS cleanup

The shared google-sms-cleanup skill runs `dg-skills ssms`. `ssms google` drives
Messages for Web through the CDP browser harness. `ssms signal` wraps
`signal-cli` and does not open Signal Desktop. The defaults never delete a
conversation or message, never send without explicit per-message approval, and
list ambiguous threads instead of acting. A draft send needs `--yes` and is
refused from a hook. The CLI does not install `signal-cli`. Messages for Web
cannot star, rename, or file conversations; give the user the phone steps for
those. See [SMS providers](ssms.md).

## Inbox cleanup

The shared inbox-cleanup skill runs the dg-skills inbox command. Update
dg-skills, dg-agent, dg-daemon, and the extension together with dg-skills install.
Start a dg session before configuring encrypted inbox profiles. Proton also
requires one connected extension and a signed-in Proton mail tab. A headless
agent cannot rely on `dg-agent start --open`. Run `dg-agent start
--print-session-id` to print the session id. The extension pairs with the
session on its own. If the command prints that no extension is connected,
run `dg-skills install` and ask the human to load the extension. Reload the
Proton Mail tab. Pass the session id as `--session` on inbox commands. Run
`dg-skills inbox bootstrap-url --session <id>` for a chat URL with a one-time
code. That URL works once, within 60 seconds. Gmail and
Outlook need a registered OAuth client and the provider's delegated permissions.
Explicit --data-path fixtures work without those services. Read
[provider setup](../plugins/dg/skills/inbox-cleanup/references/providers.md) and
[cleanup workflow](../plugins/dg/skills/inbox-cleanup/references/workflow.md).

## Channel review

The shared channel-review skill runs the `dg-skills channel-review`
command. It needs no browser extension. Install thrash separately for each
runner on every machine; dg does not ship it. Claude is the supported default.
Read [setup](../plugins/dg/skills/channel-review/references/setup.md) and
[commands](../plugins/dg/skills/channel-review/references/commands.md) before
changing config.

| Task | Who runs it |
| --- | --- |
| `aws sso login --profile <profile>` | Human: complete AWS SSO sign-in for the profile in `envs.<name>.awsProfile`. |
| Add the bot (`envs.<name>.botName`, such as Review Bot) to each review chat | Human: select the bot from the org catalog. |
| Register the bot and run the relay | Human: follow [relay setup](../plugins/dg/skills/channel-review/references/relay-setup.md). |
| React during `emojis capture` | Human: add the custom reaction to the capture prompt. An agent may start capture. |
| Approve the fun-pool GIF list | Human: review the list before each release. |
| `status`, `env`, `start`, `stop`, `run` | Agent: run the requested operation and report its output. |
| `emojis show`, `emojis set` | Agent: inspect slots or save the supplied custom ID. |
| Invoke `/dg:channel-review` in Claude Code for the live bootstrap check | Human: verify the installed skill runs status through the installed `dg-skills`. |

Start with `status --env dev` in a test chat. If the service mailbox is
absent from the chat, set `chat.id` from the Teams **Copy link** URL. Status
reports runner probes and, while stopped, secret, chat, and reaction preflight.
The live bootstrap check passes with exit 0 when those services are reachable,
or with a JSON failure report that names the problem and remedy. This guide
does not record a completed live check.

______________________________________________________________________

## Pair the browser with an agent session

Pairing needs no code and no human step. The extension keeps a link socket to
its daemon and adopts every new session that the daemon pushes. Load the
extension once with **Load unpacked**. That is the only routine human step.

An agent pairs a session in one step:

1. Run `dg-agent start`.
1. Read the line on stderr. `Paired <identity> (<id8>) with the browser extension.` means the extension adopted the session. `No browser extension is connected. Install it with: dg-skills install` means none is loaded. Run `dg-skills install` and ask the human to load the extension.

`dg-agent start` prints nothing on stdout. `--print-session-id` prints the session id. `--json` prints `{sessionId, port, extensionLinked}`. `--open` opens the chat page through a one-time code and prints no URL. `dg-agent overwatch open` also uses a one-time code. A code works once, within 60 seconds.

To run a command inside a new session, use `dg-agent spawn -- <command...>`. It runs the command with `DG_SESSION_ID` set and exits with the exit code of that command. The CLI picks its session from `--session`, then `DG_SESSION_ID`, then the one session for the current directory.

The pill reads Connected only while the agent's CLI holds the session socket open. Commands such as `dg-agent recv` open that socket. Right after `dg-agent start`, the pill reads Idle.

The daemon pins the extension origin on first contact. The extension pins the daemon id on first contact and refuses a port that reports another id. After a daemon home reset, the popup shows "The daemon changed" with **Trust this daemon**. The human clicks it once to pin the new daemon. This step is rare.

Pairings are kept in the extension's local storage until you click Unpair or the daemon expires the session. They survive a browser restart. The local storage is per browser profile. A second profile adopts each session on its own.

**Trust trade-off.** The daemon trusts any process that the same user runs on this machine, and it does so silently. A local program can fake an `Origin` header. The daemon id pin stops a process on a free port. It does not stop a proxy that copies the live daemon. See [ADR 0039](adr/0039-zero-touch-pairing.md).

### Checking and unpairing paired sessions

The popup lists each paired agent with its identity, a short session id and a pill:

- **Connected:** the daemon confirmed the session and the agent's CLI is active.
- **Working:** the agent has a browser request in flight. The row lists each run with its age.
- **Idle:** the session is paired, but no agent CLI is active.

Each agent row has these controls:

- **Unpair** removes that session's saved pairing and closes its connection. The agent session keeps running. Other pairings stay connected. The extension does not adopt that session again until it closes.
- **Menu**, the per-agent menu, holds **Open chat** and **Add this tab**. **Open chat** opens the daemon `/chat` page for that session. **Add this tab** hands the current tab to that agent.

Under each agent, the popup lists its tab group with the group color. The popup scrolls inside a fixed height when the list grows long.

**Add this tab** refuses a tab in a private window and a browser page. It also refuses a tab that another agent owns while that agent has pending runs.

The popup menu in the header holds **Settings** and **Record demo**. The Options page opens from **Settings**.

For local extension changes, run `dg-skills install --local --repo <checkout>`.
This rebuilds and replaces the installed extension even when its version is unchanged.
Reload DeeGee in `brave://extensions` and refresh any connected application tabs.

______________________________________________________________________

## Upgrading from a release without the pairing popup

Older releases paired through pages inside the extension. The first release with the pairing popup removes those pages. Follow these steps in order:

1. Run `dg-skills install`. It updates the daemon before the extension.
1. Restart the daemon. Run `dg-daemon restart`. It stops the running daemon, ends each session, and starts the new daemon.
1. Reload the extension in `chrome://extensions`, then open the popup.
1. In each agent session, run `dg-agent start`. The extension adopts the session.
1. Run `dg-skills pw --ext open <url>`, or click **Add this tab** in the popup, so the agent has a tab.

Restart the daemon right after the upgrade. A channel-review run can apply schema 13 while an old daemon still runs. The old daemon's `saveSession` then fails until you restart it.

### What the upgrade removed

| Removed | Replacement |
| --- | --- |
| The extension side panel | The daemon `/chat` page. Run `dg-agent start --open`, or click **Open chat** in the popup. |
| The extension dashboard page | `dg-daemon job list` and `dg-daemon job run <label>` manage jobs. A job with `--notify` sends new feed items to an agent as messages. |
| The extension overwatch page | The daemon `/board` page. Run `dg-agent overwatch open`. |
| `dg-agent attach` | `dg-agent start`. The extension adopts the session. |
| `dg-agent start --fresh` and `dg-agent start -s <id>` | `dg-agent start` registers the session and the extension adopts it. |
| `GET /start` | The `/chat` page. |
| `POST /sessions` and `GET /sessions` | `dg-agent start` registers sessions. |
| `/attach { intent: "create" }` | `/attach { intent: "attach" }`, which the `/chat` switcher sends with a page bearer. |
| `POST /pair`, and the offer and claim routes that replaced it | None. The extension adopts each session that the daemon pushes. |
| The `pair` command of `dg-agent` and `dg-daemon`, and the popup code, QR and paste form | None. Run `dg-agent start`. |
| `DG_SESSION_TOKEN` | None. Pass `-s <id>` to name a session. The CLI asks the daemon for that session's token. |
| `DG_UNCLAIMED_TTL_MS` | None. No session waits for an agent. |
| The waiting presence | None. A session has a CLI, or it is idle or gone. |

### What else changed

The toolbar button opens the popup, not the Options page. Record demo moved to the popup menu. Alt+Shift+D still starts a recording on the page.

The Options page is slim. The Pairing page, the navigation and the theme toggle are gone. The page ignores a stored theme value and follows the browser theme. Privacy and Kudos are folded sections at the bottom.

`dg-agent start --ext` requires the extension and behaves like `dg-agent start`. `--open` opens the daemon `/chat` page through a one-time code. `dg-agent overwatch open --ext` opens `/board`. Neither opens a page inside the extension.

The daemon trusts any process of the same user on this machine, without a prompt. Origin headers can be faked by local programs. The daemon id pin stops a process on a free port, not a proxy that copies the live daemon.

The `/chat` header reads `Talking to <identity> · <id8> · <presence>`. The switcher lists every connected agent. The connection pill says Connected only after the daemon confirms the session. An open socket alone does not count.

Pairings persist. After a session starts, the extension reconnects on its own until you click **Unpair** or the daemon expires the session.

`dg-skills pw --ext` acts on the agent's own tab group, not the active tab. A new agent has no tab, so a verb that needs a tab says "This agent has no tab yet." Run `dg-skills pw --ext open <url>` or `dg-skills pw --ext new <url>`. Or click **Add this tab** in the popup. Manage the group with `dg-skills pw --ext tabs`, `dg-skills pw --ext select <tabId>` and `dg-skills pw --ext close [tabId]`. Add `--tab <id>` to any verb to target one tab once. `current` no longer lists tabs. Use `tabs`.

**Clear disconnected** left with the side panel. `dg-daemon sessions clear` still closes sessions that have no CLI.

### Mixed versions

- **Old extension, new daemon.** An extension older than the floor posts to routes that now return 404, so it cannot pair. The daemon refuses `dg-skills pw --ext` with the update text. The refusal text reads: "pw --ext requires dg-ai-extension 1.44.0 or newer; update the extension, reload it, and reconnect this session."
- **New extension, old daemon.** An old daemon does not push sessions, so the extension adopts none. Update the daemon first.
- **Mixed binaries.** Update dg-agent, dg-daemon and the extension together. An old `dg-agent start` fails on `GET /sessions?waiting=1`. A new extension rejects a `session-list` that carries `waiting` until the old daemon reaps it.

### Roll back the database

Schema 13 is forward-only. An older daemon stops on the new database with this error:

```text
database schema user_version 13 is newer than this binary's supported version 12 — refusing to open a database written by a newer build
```

Before it runs step 13, the daemon writes `pre-migration-v13-<ts>-<rand>.db` into the daemon folder that holds `daemon.db`, `<state>/daemon`. The [install guide](install.md#where-dg-keeps-its-files) lists `<state>` for each OS. To roll back:

1. Stop every process that holds the database. That means the daemon and any channel-review process. Run `dg-daemon stop` for the daemon. Stop channel-review with `dg-skills channel-review stop --env dev` or `--env prod`.
1. Delete `daemon.db-wal` and `daemon.db-shm` from the daemon folder. The daemon runs SQLite in WAL mode, and a leftover journal from the schema-13 database corrupts the restored file.
1. Install the older release.
1. Restore that snapshot as `daemon.db`.
1. Start the daemon.

You lose the sessions that you made after the upgrade.

Rows with `awaiting_agent = 1` at upgrade become ordinary sessions with no CLI. The idle TTL reaps them. You can also clear them with `dg-daemon sessions clear`.

The release process generates CHANGELOG.md. Do not edit it by hand.
