# Pw browser skill

`dg-skills pw` drives a browser through `playwright-core`: open a page, click,
fill, snapshot, screenshot, mock requests, record video, and save logins as
named states. `dg-skills pw-code` runs arbitrary Node code against the page. The
skill is `plugins/dg/skills/pw/SKILL.md`.

## Browser

`pw open` picks a system Chrome, then Edge, then a Chromium that
`dg-skills pw install-browser` downloaded. With none, it exits 3. The skill tells
agents to ask first, because the download is about 150 MB.
`dg-skills pw install-browser --remove` deletes it. See
[install](install.md#browser-download-for-pw).

## WSL

On WSL, `pw open` uses Windows Chrome or Edge over CDP when one exists, and
headless Chromium inside WSL otherwise. `--windows` forces the Windows browser.
`--wsl-headed` opens a headed browser through WSLg and is experimental. Agents
never pass it unless the human asks.

## Security

`pw-code` is a separate command so the `pw` allow rule does not cover it. Claude
asks for approval on every call. `dg-skills doctor pw-code` warns when
`Bash(~/.dg/bin/dg-skills pw-code:*)` or the `Bash(~/.dg/bin/dg-skills:*)`
wildcard sits in `~/.claude/settings.json`.

## Check the setup

```sh
dg-skills doctor pw pw-code
```

## Remove the old ~/scripts copy

After one `dg-skills install`, remove the pre-port copy:

1. Run `~/scripts/bin/pw kill-all` to stop old daemons.
2. Delete `~/scripts/bin/pw`, `~/scripts/bin/pw-daemon`, and `~/scripts/bin/pw-code`.
3. Delete `~/scripts/ai/skills/pw/`. Remove the `pw`, `pw-daemon`, and `pw-code`
   entries from `TOOLS` in `~/scripts/ai/build.ts`, then rebuild.
4. Delete `~/.codex/skills/pw` and `~/.config/opencode/skills/pw`.
   `dg-skills install --skills-only --dest <dir>` installs the plugin copy.
5. Replace `Bash(pw:*)` in `~/.claude/settings.json` with
   `Bash(~/.dg/bin/dg-skills pw:*)`. Keep `Bash(playwright-cli *)` only if the
   legacy tool stays.
6. Optional: `~/.cache/playwright-cli/profiles` holds saved logins and stays
   valid. Delete it only to start clean.
