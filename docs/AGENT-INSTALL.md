# Agent install guide — DeeGee (`dg`)

How an AI agent (Claude Code) sets up this repository end-to-end, across **two
components**:

1. **The Claude Code plugin** (`dg`) — provides the `/dg:*` skills.
1. **The `dg-ai-extension` browser extension** — the companion that groups tabs
   and drives in-browser demo tours.

Both are needed for the full feature set. Steps below note what an agent can run
directly vs. what needs a human (browser slash-commands and "Load unpacked").

______________________________________________________________________

## Step 1 — Install the Claude plugin

`/plugin` commands are **Claude Code slash commands the user types** — an agent
cannot invoke them. Relay these two lines and ask the user to run them:

```text
/plugin marketplace add detailedghost/dg-ai
/plugin install dg@detailedghost
```

- First line registers the marketplace (use the GitHub slug `detailedghost/dg-ai`,
  or a local path like `~/code/dg` for a checkout).
- Second line installs the `dg` plugin from it.

After this, `${CLAUDE_PLUGIN_ROOT}` resolves to the installed plugin directory and
the `/dg:*` skills are available.

## Step 2 — Install the CLI + extension (agent-runnable + one manual step)

The skills run a compiled `dg-skills` binary. Bootstrap it once — this downloads
the binary for the current platform into `~/.dg/bin`, **then runs
`dg-skills install`**, which stages the extension and prints the exact **Load
unpacked** path:

```bash
DG="$HOME/.dg/bin/dg-skills"
[ -x "$DG" ] || sh "${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli/bootstrap.sh"
# Windows PowerShell: & "${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli/bootstrap.ps1"
```

- No Bun needed at runtime — the binary is self-contained. Bun is only required
  for the `--local` source build.
- Re-run `"$DG" install` anytime to update both the extension and the CLI. For
  Firefox: `"$DG" install firefox`. Default target is **chrome** (also serves
  Brave/Edge/Vivaldi).
- Add `--local` to **build the extension from source** (requires a repository checkout
  with `pkg/extension/`); otherwise it downloads the CI-built `ext-v*` asset.
- Chromium browsers cannot be silently loaded, so the final step is manual —
  relay the printed steps to the user:
  1. Open `chrome://extensions` (or `edge://extensions`).
  1. Enable **Developer mode**.
  1. Click **Load unpacked** and select the printed path.

Full per-OS detail (WSL → Windows profile paths, native Windows, macOS/Linux):
`pkg/skills/browser/references/install.md`.

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
grouping/tours work by opening a batch (`/dg:browser batch-open …`) or a demo
(`/dg:demo …`) — the extension acts only on URLs it marked, so nothing happens
until it's loaded in that browser profile.

______________________________________________________________________

## What an agent can and cannot automate

| Task | Agent-runnable? |
| --- | --- |
| `/plugin` marketplace add / install | No — user types these |
| `bootstrap.sh` (install CLI + extension) | Yes |
| `dg-skills install` (stage extension) | Yes |
| Load unpacked in the browser | No — manual browser UI |
| `launch` cold-start with extension | Yes (browser fully closed) |
| `batch-open` / `demo` / `rerun` | Yes (extension loaded) |
