# 👻 DeeGee

Browser, inbox, channel review, and agent workflow plugin for Codex and Claude Code.
DeeGee adds stash, proxy, browser tab groups, guided tours, live-page prototypes,
agent chat, inbox cleanup, channel review, and Google SMS cleanup. The companion
browser extension is `dg-ai-extension`.

## Install

macOS / Linux (x64 or arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.17.0/pkg/skills-cli/bootstrap.sh | sh
```

Windows (x64 or arm64), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.17.0/pkg/skills-cli/bootstrap.ps1 | iex
```

These install the compiled CLI binaries and stage the extension; no Bun is needed.
The extension, all three binaries, and both plugin manifests share release
version **1.17.0**.
Follow the printed **Load unpacked** steps to load the extension.
See [install and update](docs/install.md) for Claude Code and Codex plugins,
standalone skills, updates, and **[CLI-only installation](docs/install.md#cli-only-install)**.
From a checkout, `mise run install:skills` copies instruction files without binaries;
see [skills-only installation](docs/install.md#skills-only-install) for `--skills-only`.
The [agent install guide](docs/AGENT-INSTALL.md) separates automated steps from
browser actions that need a person.

Claude Code users can also install the optional `unslop` skill that `/dg:polish` calls when present:
`/plugin install unslop@detailedghost`.

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

The [canonical index](plugins/dg/skills/README.md) lists every installed skill.
Claude Code also accepts the bare `/<name>`.

| Skill | Use |
| --- | --- |
| `agent-seed` | Set up a project's `.agents/` folder and a minimal `CLAUDE.md` |
| `assign` | Pick the best-fit agent for a piece of work or for each spec slice |
| `bg` | Run a task in the background; `dg-skills bg` tracks the jobs |
| `clipboard-img` | Save the clipboard image as a PNG |
| `cls` | Close out a git worktree and return to the main repo |
| `doctor` | Check what the dg skills need and walk through the fixes; `dg-skills doctor` |
| `find-work` | Find actionable work, run each item in a parallel worktree, and open PRs in batch |
| `grill-me` | Interview the user about a design until every branch is resolved |
| `hook-comment-disable` | Turn off the American-English hook for one session |
| `hunt` | Find the root cause of a bug with parallel evidence gathering |
| `jot` | Save a short note or a session handoff; `dg-skills jot` |
| `kick`, `pickup`, `prd` | Park a planned spec, resume it, or hand it off |
| `monolith` | Consolidate a codebase's domain vocabulary into `.agents/monolith.md` |
| `nope` | Reset to the correct file-search defaults and record a feedback note |
| `polish` | Clean up a diff for reuse, simplification, and hygiene, then apply the fixes |
| `proxy` | Delegate to one of five external CLI agents with persona and background support |
| `pushup` | Push the branch, open its PR, and open the PR in a tab group |
| `refactor` | Find refactor candidates and discuss the chosen one |
| `rename-session` | Suggest names for the current session |
| `review-loop` | Loop Copilot or a local backend over a branch and address the findings |
| `sdlc` | Run a feature brief through worktree, slice waves, review, and a draft PR |
| `sniff` | Inventory what an app needs to run, with cited evidence; `dg-skills sniff` |
| `spec` | Plan a durable feature spec or execute one |
| `spring-break` | Consolidate `.agents/school/` into topic clusters |
| `standard-test` | Language-agnostic rules for writing and reviewing tests |
| `stash` | Resolve scratch, state, or repository artifact paths |
| `stat` | Show this session's in-flight work, status, and ETA in one table |
| `teach` | Teach a concept across sessions |
| `wait-what` | Explain the last answer again, more simply |
| `walk` | Go through the open questions one at a time |
| `wayfinder` | Map work too big for one session as decision tickets |
| `what-changed` | Write release notes from tags, PRs, and commits |
| `worktree` | Create, list, remove, and prune git worktrees |

### Stash, providers, and proxy

Use the installed CLI from a terminal:

```bash
dg-skills stash -u review findings.md
dg-skills stash -a review findings.md
dg-skills vcs-provider detect
dg-skills vcs-provider list-prs --limit 10
dg-skills proxy --list-backends
dg-skills proxy codex --prompt "Review the current changes"
```

`stash` prints an absolute path and creates its parent. Its default scratch scope
separates working directories; `--state` shares a project bucket across worktrees,
`--agents` uses the current worktree's `.agents`, and `--main` uses the main
worktree's `.agents`. `--global` removes scratch/state bucketing, `--unique` names
a fresh artifact, `--root` prints the root, and `--dir` selects another directory.
The [developer guide](docs/DEVELOPER.md#wave-2a-cli-commands) lists flags, roots,
and all ten `vcs-provider` verbs for GitHub and GitLab.

`proxy` supports **codex**, **copilot**, **pi**, **opencode**, and
**grok**. Install and authenticate the chosen backend separately. It accepts
`--prompt-file`, `--resume`, and persona selection through `--subagent` or an
explicit `--spec <plan> --slice <id>`. Set `DG_PERSONAS_DIR` (or `DG_AGENTS_DIR`)
for persona files. `--plan` prints a quoted detached launch command; run that
command, then inspect it with `dg-skills bg status <id>` or `list`.
The `spec` and `bg` commands are public and `proxy` uses them directly, so
it needs no legacy helper. Detached launch needs a POSIX `sh`.
Job identity comes from the Linux `/proc` start time. Elsewhere the helper fails closed: `status` shows `unknown` and `cancel` signals nothing.
Read the [proxy skill](plugins/dg/skills/proxy/SKILL.md) for result and resume rules.

`dg-skills clipboard-image <dest.png>` captures through WSL (`wslpath` and
`powershell.exe`), Wayland (`wl-paste`), or X11 (`xclip`); `-` writes PNG bytes to
stdout. The clipboard skill resolves its default destination through stash.

Maintainers follow the [post-merge cutover](docs/DEVELOPER.md#manual-post-merge-cutover) steps after each wave.

## Supported browsers

- Chromium: Chrome, Edge, Brave, Vivaldi, and Opera.
- Firefox 139+; tab grouping is used only where the browser supports it.

## Documentation

- [Scheduled jobs, services, and dashboard](docs/jobs-and-services.md)

- [Architecture decisions](docs/adr/toc.md)

- [Developer guide](docs/DEVELOPER.md)

- [Contributing](docs/contributing.md)
- [Security](SECURITY.md)
