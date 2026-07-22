# Agent install guide — DeeGee (`dg`)

How an AI agent (Claude Code) sets up this repo end-to-end. There are **two
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

## Step 2 — Install the CLI dependencies (agent-runnable)

The `dg-browser` CLI depends on `commander`. Install once:

```bash
cd "${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli" && bun install
```

(In a source checkout, use the repo path instead of `${CLAUDE_PLUGIN_ROOT}`.)

## Step 3 — Install the browser extension (agent-runnable + one manual step)

Run the installer — it stages the extension and prints the exact **Load
unpacked** path:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli/src/index.ts" install
```

- Default target is **chrome** (also serves Brave/Edge/Vivaldi). For Firefox:
  `install firefox`.
- Add `--local` to **build from source** (requires a repo checkout with
  `pkg/extension/`); without it, the installer downloads the CI-built asset from
  the latest GitHub release.
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
DG="${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli/src/index.ts"
bun "$DG" launch --browser brave --group "PRs" <refs...>
```

## Step 4 — Verify

```bash
bun "${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli/src/index.ts" --help
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
| `bun install` (CLI deps) | Yes |
| `browser.ts install` (stage extension) | Yes |
| Load unpacked in the browser | No — manual browser UI |
| `launch` cold-start with extension | Yes (browser fully closed) |
| `batch-open` / `demo` / `rerun` | Yes (extension loaded) |
