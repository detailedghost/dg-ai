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
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.2/pkg/skills-cli/bootstrap.sh | DG_INSTALL_CODEX=1 sh
```

On Windows PowerShell:

```powershell
$env:DG_INSTALL_CODEX = "1"
irm https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.2/pkg/skills-cli/bootstrap.ps1 | iex
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
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.2/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

On Windows PowerShell:

```powershell
$env:DG_CLI_ONLY = "1"
irm https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.2/pkg/skills-cli/bootstrap.ps1 | iex
```

`DG_CLI_ONLY=1` also works for the shell form, and `dg-skills install --cli-only`
does the same from an installed binary. Combined with `DG_INSTALL_CODEX=1`, only
the skills that do not declare `requires: [extension]` reach `$CODEX_HOME/skills`.

- CLI-only skills: `channel-review`, `google-sms-cleanup` (instruction-only;
  it drives Messages for Web), `inbox-cleanup` with explicit
  `--data-path` fixtures, and `proto`, whose default local mode needs no
  extension. Only `proto --ext` needs the dg-ai-extension.
- Extension skills: `browser`, `demo`, `chat` and `overwatch`. Each
  declares `requires: [extension]` in its SKILL.md. In a CLI-only install,
  `dg-skills batch-open`, `launch`, `demo`, `rerun` and `proto --ext`, and the
  `dg-skills require-extension <skill>` check at the top of `chat` and
  `overwatch`, stop with: the command needs the dg-ai-extension, and
  `dg-skills install` adds it.
- To add the extension later, run `~/.dg/bin/dg-skills install`. It installs the extension,
  `dg-daemon` and `dg-agent`, and removes the marker. Then follow Step 2 below
  for the manual **Load unpacked** step.

## Skills-only install

Use this when the user wants the skill instruction files and none of the
binaries. The installer copies each directory under `plugins/dg/skills` that
contains a `SKILL.md` — the instruction file and its references, including
`google-sms-cleanup` — and does not execute that text. It does not download
`dg-skills`, `dg-daemon`, `dg-agent`, or the extension.

From a checkout of this repository:

```bash
mise run install:skills
```

The same copy from source:

```bash
bun pkg/skills-cli/src/index.ts install --skills-only --dest "${DG_SKILLS_DEST:-$HOME/.dg/skills}"
```

`dg-skills install --skills-only` is the flag on an already installed binary.
Pass `--repo <checkout>` so it can read `plugins/dg/skills`. `--dest` overrides
the default directory, which is `$DG_SKILLS_DEST`, otherwise `$DG_HOME/skills`,
otherwise `~/.dg/skills`.

Without a checkout:

```bash
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.2/pkg/skills-cli/bootstrap.sh | sh -s -- --skills-only
```

On Windows PowerShell:

```powershell
$env:DG_SKILLS_ONLY = "1"
irm https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.2/pkg/skills-cli/bootstrap.ps1 | iex
```

`DG_SKILLS_ONLY=1` is the shell equivalent of `--skills-only`. This is separate
from `--cli-only`, which writes `~/.dg/cli-only`. Every skills-only path also
installs the `dg-skills` CLI from the latest `skills-v*` release into
`${DG_HOME:-~/.dg}/bin`, checked against the release's `SHA256SUMS`, because the
skills run it. It fetches no `dg-daemon`, `dg-agent` or extension, leaves the
`cli-only` marker untouched, and never executes skill content. Set
`DG_SKILLS_NO_CLI=1` with the bootstraps for an offline copy that skips the CLI.

______________________________________________________________________

## Step 1 — Install the Claude plugin

Current Claude Code releases expose plugin management through the CLI, so an
authorized agent can install or refresh DeeGee directly:

```bash
claude plugin marketplace add detailedghost/dg-ai
claude plugin install dg@detailedghost
# Refresh an existing install:
claude plugin update dg@detailedghost
```

- The first line registers the marketplace. Use the GitHub slug
  `detailedghost/dg-ai`, or a local checkout path such as `~/code/dg`.
- The second line installs the `dg` plugin; `update` refreshes an existing copy.
- Restart an existing Claude Code session after installing or updating so it
  discovers the refreshed skills.

After this, `${CLAUDE_PLUGIN_ROOT}` resolves to the installed plugin directory and
the `/dg:*` skills are available.

## Step 2 — Install the CLI + extension (agent-runnable + one manual step)

The skills run compiled binaries. Bootstrap once — this downloads `dg-skills`
for the current platform into `~/.dg/bin` (`$DG_HOME/bin` when `DG_HOME` is set), **then runs `dg-skills install`**,
which fetches `dg-daemon` and `dg-agent` too, stages the extension, and prints the exact **Load
unpacked** path:

```bash
if [ ! -x ~/.dg/bin/dg-skills ]; then
  PLUGIN_ROOT="${DG_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
  LOCAL_BOOTSTRAP="${PLUGIN_ROOT}/pkg/skills-cli/bootstrap.sh"
  if [ -n "$PLUGIN_ROOT" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.2/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
# Windows PowerShell:
# irm https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.2/pkg/skills-cli/bootstrap.ps1 | iex
```

Claude Code sets `CLAUDE_PLUGIN_ROOT`. Other agent runtimes can set
`DG_PLUGIN_ROOT` to the same checkout. When neither variable points at the
bundled script, the snippet downloads `bootstrap.sh` from the repository.

- No Bun needed at runtime — the binary is self-contained. Bun is only required
  for the `--local` source build.
- Re-run `~/.dg/bin/dg-skills install` anytime to update the extension, `dg-skills` and
  `dg-daemon` and `dg-agent` together; each is skipped when already current. For Firefox:
  `~/.dg/bin/dg-skills install firefox`. Default target is **chrome** (also serves
  Brave/Edge/Vivaldi).
- The chat skill runs `~/.dg/bin/dg-agent`, released separately under
  `agent-v*`, and `dg-agent start` launches `~/.dg/bin/dg-daemon` (released under
  `daemon-v*`) by resolving it as a sibling, so both must live in the same
  directory. Its own bootstrap gate tests for `dg-agent`, not `dg-skills` — a
  machine that already used `browser`, `demo` or `proto` has `dg-skills`
  already, so gating on that would skip the download the gate exists for.
- On **WSL**, the daemon needs **mirrored** networking mode. Under NAT the
  Windows-side browser cannot reach the loopback port; `dg-daemon` exits with
  code 3 rather than pretending to be reachable.
- `~/.dg` holds two independent trees: `daemon/`, with the encrypted
  `daemon.db` behind the chat commands, and `agents/`, with session files and
  the plain-text `memory.db` behind `dg-agent memory`. An agent can also send
  another agent identity a message with `dg-agent send --to <identity>`
  instead of the human. Neither needs the daemon running: `memory` opens
  `agents/memory.db` directly.
- Add `--local` to **build the extension from source** (requires a repository checkout
  with `pkg/extension/`); otherwise it downloads the CI-built `ext-v*` asset.
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
~/.dg/bin/dg-skills launch --browser brave --group "PRs" <refs...>
```

## Step 3 — Verify

```bash
~/.dg/bin/dg-skills --help
```

Should list `install`, `batch-open`, `launch`, `demo`, `rerun`, and `channel-review`. Then confirm
grouping/tours work with the browser or demo skill. For the chat harness:

```bash
"${DG_HOME:-$HOME/.dg}/bin/dg-agent" --help
"${DG_HOME:-$HOME/.dg}/bin/dg-daemon" status
```

`dg-agent --help` should list `start`, `recv`, `send`, `progress`, `spawn`,
`stage`, `close`, `manifest` and `memory` — `status` is a `dg-daemon` command,
not a `dg-agent` one. `dg-daemon status` reports that no daemon is running
yet, though `memory` works regardless — it opens `~/.dg/agents/memory.db`
directly rather than asking the daemon. Claude Code uses the
`/dg:*` namespace; Codex uses `$dg:*`. The extension acts only on URLs it marked,
so nothing happens until it is loaded in that browser profile.

______________________________________________________________________

## What an agent can and cannot automate

| Task | Agent-runnable? |
| ------------------------------------------------------------------ | ---------------------------- |
| `claude plugin marketplace add` / `install` / `update` | Yes, with user authorization |
| `bootstrap.sh` (install CLI + extension) | Yes |
| `dg-skills install` (stage extension + refresh all three binaries) | Yes |
| `dg-agent start` (register a chat session) | Yes |
| `dg-agent start --open` (open the chat page) | Yes (default browser) |
| Read a human's chat reply (`dg-agent recv --block`) | Yes — it waits for them |
| Switch WSL to mirrored networking mode | No — manual host config |
| Add `dg-daemon-blt` and `dg-agent-blt` to branch protection | No — repo admin |
| Load unpacked in the browser | No — manual browser UI |
| `launch` cold-start with extension | Yes (browser fully closed) |
| `batch-open` / `demo` / `rerun` | Yes (extension loaded) |

## Google SMS cleanup

The shared google-sms-cleanup skill is instruction-only. It does not call
`dg-skills`, `dg-agent`, or the extension. Open Messages for Web in the browser.
The defaults never delete a conversation or message, never send without
explicit per-message approval, and list ambiguous threads instead of acting.
Messages for Web cannot star, rename, or file conversations; give the user the
phone steps for those.

## Inbox cleanup

The shared inbox-cleanup skill runs the compiled dg-skills inbox command. Update
dg-skills, dg-agent, dg-daemon, and the extension together with dg-skills install.
Start a dg session before configuring encrypted inbox profiles; Proton also
requires one connected extension and a signed-in Proton mail tab. A headless
agent cannot rely on `dg-agent start --open`. The command prints
`http://127.0.0.1:<port>/start#_chat=<base64url>`, whose fragment is base64url
JSON of the session id and token. Open that URL in the browser where the
extension is loaded, then reload the Proton Mail tab. `dg-agent start
--print-session-id` or `--json` prints the session id without decoding the
fragment; pass it as `--session` on inbox commands. Gmail and
Outlook need a registered OAuth client and the provider's delegated permissions.
Explicit --data-path fixtures work without those services. Read
[provider setup](../plugins/dg/skills/inbox-cleanup/references/providers.md) and
[cleanup workflow](../plugins/dg/skills/inbox-cleanup/references/workflow.md).

## Channel review

The shared channel-review skill runs the compiled `dg-skills channel-review`
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
| Invoke `/dg:channel-review` in Claude Code for the live bootstrap check | Human: verify the installed skill runs status through the compiled binary. |

Start with `status --env dev` in a test chat. If the service mailbox is
absent from the chat, set `chat.id` from the Teams **Copy link** URL. Status
reports runner probes and, while stopped, secret, chat, and reaction preflight.
The live bootstrap check passes with exit 0 when those services are reachable,
or with a JSON failure report that names the problem and remedy. This guide
does not record a completed live check.

### Checking and disconnecting paired sessions

DeeGee's Pairing panel stays visible in Chat, Overwatch, and extension options.
A successful code submission initially says **Code accepted**. **Paired — connection
confirmed** appears only after the daemon authenticates a session; an open socket
alone does not count as paired. If confirmation takes longer than ten seconds,
the panel reports the missing confirmation and allows another attempt.

The current session has a **Current** label and a distinct accent-colored shadow.
In Chat, selecting a connected session updates that highlight.
The panel lists sessions captured by this extension, with each session's connection
status and a **Disconnect** button. Disconnect removes that session's saved browser
credentials and closes its connection without ending the agent session. The daemon confirms each disconnect before the
extension reports success. Other
captured sessions keep their existing connection without interruption. **Pair another session** adds a session
without replacing existing ones. Tokens remain in browser session storage and are
never displayed by the pairing panel.

For local extension changes, run `dg-skills install --local --repo <checkout>`.
This rebuilds and replaces the installed extension even when its version is unchanged.
Reload DeeGee in `brave://extensions` and refresh any connected application tabs.

Selective session disconnect requires dg-daemon 1.11.2 or newer. Update both the
daemon and extension before using the Disconnect controls.
