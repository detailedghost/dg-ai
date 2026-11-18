# Local mode by default, --ext opt-in for the dg-ai-extension across every dg skill — Initial Notes

## Purpose
Every dg skill runs without the dg-ai-extension unless the caller passes --ext, the way /dg:proto already works. batch-open opens plain tabs in the default browser and adds the tab-group marker only with --ext; launch is an --ext-only verb; rerun and demo take the same flag (demo's local player lands in the next bundle); the CLI-only guard trips only when --ext is present; the browser skill, every batch-open caller (pushup, deps-upgrade, sdlc finish, spec execute) and inbox-cleanup's Proton path follow the same convention. A repo test fails when any SKILL.md declares requires: [extension] or runs require-extension outside an --ext path; chat, demo and overwatch stay on a named allowlist until bundles 015 and 016 remove them.

## Scope
### Included
- ext-flag helper and a flag-aware CLI-only guard in pkg/skills-cli
- batch-open: plain tabs by default, tab-group marker only with --ext; launch is --ext-only; demo and rerun accept --ext and keep today's default with a one-line notice until 015
- doctor: extension checks for batch-open, launch, rerun, demo and require-extension become --ext-only (info, not fail, on a CLI-only install)
- browser skill rewritten without requires: [extension], with a Flags table whose --ext row matches proto's format
- pushup, deps-upgrade, sdlc finish step 8f and spec execute step 6 call batch-open without a marker unless the human passed --ext
- inbox-cleanup: Proton needs --ext; Gmail and Outlook are local; the skill and providers.md say so
- Repo test ext-opt-in.spec.ts: no requires: [extension]; require-extension only on a line that also names --ext; chat, demo and overwatch on a PENDING_LOCAL_MODE allowlist
- docs: install.md skills table, AGENT-INSTALL.md, browser.md, skills README; ADR 0028
### Excluded
- The demo local player (bundle 015_demo_local_player)
- Local chat and overwatch pages served by dg-daemon (bundle 016_local_chat_overwatch_pages)
- A local Proton Mail path for inbox-cleanup (see Open questions)
- Removing the extension, its install command or the daemon pairing flow
- Changing the _tab_group, _demo or _proto marker formats
