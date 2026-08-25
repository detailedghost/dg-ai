# Agent install guide — DeeGee (`dg`)

How an AI agent (Codex or Claude Code) sets up this repository end-to-end,
across **two components**:

1. **The DeeGee plugin** (`dg`) — provides browser, demo, and prototype skills.
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
DG_INSTALL_CODEX=1 \
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
```

On Windows PowerShell:

```powershell
$env:DG_INSTALL_CODEX = "1"
irm https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.ps1 | iex
```

These alternative commands install the CLI, stage the browser extension, and copy the
`browser`, `demo`, and `proto` skills into `$CODEX_HOME/skills` (default
`~/.codex/skills`). Start a new Codex thread after installation.

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
for the current platform into `~/.dg/bin`, **then runs `dg-skills install`**,
which fetches `dg-daemon` and `dg-agent` too, stages the extension, and prints the exact **Load
unpacked** path:

```bash
DG="$HOME/.dg/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
# Windows PowerShell:
# irm https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.ps1 | iex
```

- No Bun needed at runtime — the binary is self-contained. Bun is only required
  for the `--local` source build.
- Re-run `"$DG" install` anytime to update the extension, `dg-skills` and
  `dg-daemon` and `dg-agent` together; each is skipped when already current. For Firefox:
  `"$DG" install firefox`. Default target is **chrome** (also serves
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
"$DG" launch --browser brave --group "PRs" <refs...>
```

## Step 3 — Verify

```bash
"$DG" --help
```

Should list `install`, `batch-open`, `launch`, `demo`, and `rerun`. Then confirm
grouping/tours work with the browser or demo skill. For the chat harness:

```bash
"$HOME/.dg/bin/dg-agent" --help
"$HOME/.dg/bin/dg-daemon" status
```

Should list `start`, `status`, `recv`, `send`, `progress`, `spawn`, `stage`,
`close`, `manifest` and `memory`; `status` reports that no daemon is running
yet, though `memory` works regardless — it opens `~/.dg/agents/memory.db`
directly rather than asking the daemon. Claude Code uses the
`/dg:*` namespace; Codex uses `$dg:*`. The extension acts only on URLs it marked,
so nothing happens until it is loaded in that browser profile.

______________________________________________________________________

## What an agent can and cannot automate

| Task | Agent-runnable? |
| --- | --- |
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
