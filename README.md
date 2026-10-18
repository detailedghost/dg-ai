# 👻 DeeGee

Browser, inbox, and channel review plugin for Codex and Claude Code. DeeGee adds
browser tab groups, guided tours, live-page prototypes, agent chat, inbox cleanup,
channel review, and Google SMS cleanup. The companion browser extension is `dg-ai-extension`.

## Install

macOS / Linux (x64 or arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
```

Windows (x64 or arm64), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.ps1 | iex
```

These install the compiled CLI binaries and stage the extension; no Bun is needed.
Follow the printed **Load unpacked** steps to load the extension.
See [install and update](docs/install.md) for Claude Code and Codex plugins,
standalone skills, updates, and **[CLI-only installation](docs/install.md#cli-only-install)**.
From a checkout, `mise run install:skills` copies instruction files without binaries;
see [skills-only installation](docs/install.md#skills-only-install) for `--skills-only`.
The [agent install guide](docs/AGENT-INSTALL.md) separates automated steps from
browser actions that need a person.

## Skills

Claude Code uses `/dg:<skill>`; Codex uses `$dg:<skill>`.

| Skill | Use | Guide |
| --- | --- | --- |
| `browser` | Open and group tabs; launch a browser | [Browser](docs/browser.md) |
| `demo` | Play and record a guided tour | [Tours and prototypes](docs/demo-and-proto.md) |
| `proto` | Compare designs inside a live page | [Tours and prototypes](docs/demo-and-proto.md) |
| `chat` | Talk to a person or another agent; keep agent memory | [Chat](docs/chat.md) |
| `overwatch` | Track work across parallel chats | [Skill commands](plugins/dg/skills/overwatch/SKILL.md) |
| `inbox-cleanup` | Review and organize Proton Mail, Gmail, or Outlook | [Inbox cleanup](docs/inbox-cleanup.md) |
| `google-sms-cleanup` | Organize Google Messages in the browser | [Skill guide](plugins/dg/skills/google-sms-cleanup/SKILL.md) |
| `channel-review` | Review PRs and MRs posted in Teams | [Channel review](docs/channel-review.md) |

### Workflow skills

Instruction-only skills for day-to-day agent work. Claude Code also accepts the
bare `/<name>`.

| Skill | Use |
| --- | --- |
| `agent-seed` | Set up a project's `.agents/` folder and a minimal `CLAUDE.md` |
| `clipboard-img` | Save the clipboard image as a PNG |
| `grill-me` | Interview the user about a design until every branch is resolved |
| `hook-comment-disable` | Turn off the American-English hook for one session |
| `hunt` | Find the root cause of a bug with parallel evidence gathering |
| `kick`, `pickup`, `prd` | Park a planned spec, resume it, or hand it off |
| `pushup` | Push the branch, open its PR, and open the PR in a tab group |
| `refactor` | Find refactor candidates and discuss the chosen one |
| `rename-session` | Suggest names for the current session |
| `standard-test` | Language-agnostic rules for writing and reviewing tests |
| `teach` | Teach a concept across sessions |
| `wait-what` | Explain the last answer again, more simply |
| `walk` | Go through the open questions one at a time |
| `wayfinder` | Map work too big for one session as decision tickets |
| `what-changed` | Write release notes from tags, PRs, and commits |

## Supported browsers

- Chromium: Chrome, Edge, Brave, Vivaldi, and Opera.
- Firefox 139+; tab grouping is used only where the browser supports it.

## Documentation

- [Scheduled jobs, services, and dashboard](docs/jobs-and-services.md)

- [Architecture decisions](docs/adr/toc.md)

- [Developer guide](docs/DEVELOPER.md)

- [Contributing](docs/contributing.md)

- [Security](SECURITY.md)
