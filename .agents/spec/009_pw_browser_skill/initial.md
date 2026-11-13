# pw browser skill in the plugin — Initial Notes

## Purpose
Port the pw browser CLI (Bun daemon per session on playwright-core) into the dg plugin as `dg-skills pw` and `dg-skills pw-code`, with the skill at plugins/dg/skills/pw. It ships to every plugin user as a lazy chunk that costs nothing until called, uses the system Chrome or Edge first, offers `dg-skills pw install-browser` when none exists, and inside WSL drives the Windows-side browser by default, opening a headed browser inside WSL only with an explicit flag.

## Scope
### Included
- Port of ~/scripts/ai/skills/pw src (core, commands, code, daemon, cli) and its 93 test files into pkg/skills-cli/src/pw and __tests__/pw
- Registration as lazy commands `pw` and `pw-code`; daemon runs as `dg-skills pw __daemon <spec>` from the same bundle
- Storage through the shared scratch-paths helpers (same paths as today: <scratch>/pw/{sessions,sock,log,<cwd-hash>}, <state>/pw/states)
- install-browser command that downloads Chromium under the dg data dir; doctor item reporting browser status
- WSL rule: Windows mode by default (Windows Chrome, then Edge, over CDP), then headless Chromium inside WSL, then the install-browser message; `--wsl-headed` is the explicit opt-in for a headed browser inside WSL
- SKILL.md plus references, doctor items for pw and pw-code, docs, removal list for the local ~/scripts copy
### Excluded
- New browser features beyond the current pw command set
- Firefox or WebKit downloads through install-browser (Chromium only)
- Windows-native or macOS session liveness beyond pid checks (Linux and WSL are the tested hosts)
