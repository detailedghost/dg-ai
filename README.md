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

## Supported browsers

- Chromium: Chrome, Edge, Brave, Vivaldi, and Opera.
- Firefox 139+; tab grouping is used only where the browser supports it.

## Documentation

- [Scheduled jobs, services, and dashboard](docs/jobs-and-services.md)
- [Architecture decisions](docs/adr/toc.md)
- [Developer guide](docs/DEVELOPER.md)
- [Contributing](docs/contributing.md)

- [Security](SECURITY.md)
