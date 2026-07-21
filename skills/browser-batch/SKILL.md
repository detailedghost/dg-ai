---
name: browser-batch
description: Open a batch of GitHub PRs or URLs in the browser and auto-group the resulting tabs. `install` sets up the companion Chrome/Edge extension (one-time, guided); `open <url…>` opens a batch.
argument-hint: "install | open <url…>"
user-invocable: true
---

# Browser Batch

Use this skill to install the companion browser extension or open a batch of
GitHub PRs/URLs.

Both commands run `bun`. If it's missing, `bun --version` will fail — tell the
user to install Bun from https://bun.sh rather than surfacing a raw error.

## Commands

- `install`: set up the local unpacked Chrome/Edge extension. Run:

  ```bash
  bun "${CLAUDE_PLUGIN_ROOT}/skills/browser-batch/bin/install.ts"
  ```

  Relay its printed Load-unpacked steps to the user. See
  `references/install.md` for full per-OS detail.

- `open <refs...>`: resolve refs and open them in the default browser. Run:

  ```bash
  bun "${CLAUDE_PLUGIN_ROOT}/skills/browser-batch/bin/browser-batch.ts" open <args>
  ```

  Pass through user args after `open`.

Accepted refs: full URL, `owner/repo#num`, alias refs like `work#1517` (aliases
you define in `~/.config/browser-batch/config.json`), and bare numbers with
`--repo owner/repo` or a configured default repo.

Tabs group only in the Chrome profile where the extension is loaded, usually your default profile.
