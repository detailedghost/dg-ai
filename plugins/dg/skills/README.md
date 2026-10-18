# DeeGee skills

This canonical skill tree serves the Codex and Claude Code plugins.
`mise run install:skills` (or `dg-skills install --skills-only`) copies every
folder containing `SKILL.md` plus its supporting files, without installing
binaries. The skills-root README itself is not installed.

| Skill | Description |
| --- | --- |
| `browser/` | Tab batch-open, tour launch, and extension installation |
| `demo/` | Guided browser demos with optional setup and video recording |
| `proto/` | Compare app-native UI approaches on a live page |
| `chat/` | Live browser chat through dg-agent and dg-daemon |
| `inbox-cleanup/` | Review Proton Mail, Gmail, or Outlook cleanup with redacted feedback |
| `channel-review/` | Local thrash reviews for Teams PR and MR requests through a bot relay |
| `google-sms-cleanup/` | Review Messages for Web without deletion or unapproved sends |
| `agent-seed/` | Set up `.agents/`, `AGENTS.md`, and a minimal `CLAUDE.md` |
| `clipboard-img/` | Capture a clipboard PNG through the compiled clipboard-image command |
| `grill-me/` | Resolve a design through a structured interview |
| `hook-comment-disable/` | Disable the American-English hook for one session with explicit approval |
| `hunt/` | Gather evidence and diagnose a codebase bug |
| `kick/` | Plan and park a deferred spec bundle |
| `overwatch/` | Track parallel sessions on the live Overwatch board |
| `pickup/` | Resume a parked spec bundle |
| `prd/` | Prepare a spec bundle for handoff |
| `proxy/` | Delegate to codex, copilot, pi, opencode, cortex, or grok |
| `pushup/` | Push a branch, open its PR, and group the PR in the browser |
| `refactor/` | Find architectural improvements and discuss a chosen approach |
| `rename-session/` | Suggest or apply a session name |
| `standard-test/` | Apply portable rules for meaningful tests |
| `stash/` | Resolve scratch, state, current-worktree, or main-worktree artifact paths |
| `teach/` | Teach a workspace concept across sessions |
| `wait-what/` | Explain the last message again in project vocabulary |
| `walk/` | Resolve open questions one at a time |
| `wayfinder/` | Map large work into decision tickets |
| `what-changed/` | Draft release notes from tags, requests, and commits |

## Structure

```text
skills/
  agent-seed/
  browser/
  channel-review/
  chat/
  clipboard-img/
  demo/
  google-sms-cleanup/
  grill-me/
  hook-comment-disable/
  hunt/
  inbox-cleanup/
  kick/
  overwatch/
  pickup/
  prd/
  proto/
  proxy/
  pushup/
  refactor/
  rename-session/
  standard-test/
  stash/
  teach/
  wait-what/
  walk/
  wayfinder/
  what-changed/
```

Each folder contains `SKILL.md` and may include `references/`, scripts, or other
supporting assets. Cross-skill references are relative to this tree. The CLI
implementation lives in [`pkg/skills-cli/`](../../../pkg/skills-cli/README.md).
`DG_SKILLS_DIR` can select a relocated real skill tree for CLI resource lookup.

## Runtime requirements

The extension, dg-skills, dg-daemon, dg-agent, and both plugin manifests share
version **1.15.0**. `chat/` invokes dg-agent (`agent-v*`), which launches the
adjacent dg-daemon (`daemon-v*`). Most compiled helpers run through dg-skills
(`skills-v*`). User terminal commands can use `dg-skills`; skill instructions
resolve the installed binary and invoke the quoted `"$DG"` path.

`dg-skills install --cli-only` skips the extension, pairing, dg-daemon, dg-agent,
and skills marked `requires: [extension]`: browser, chat, demo, overwatch, and
proto. It includes stash, proxy, clipboard-img, and other skills without that
requirement. Live inbox profiles still need dg-daemon; Google SMS cleanup needs
Messages for Web through the host's browser tools. Instructions that refer to
later-wave skills still need those skills separately until their ports ship.

Stash supports scratch, state, current-worktree, and main-worktree scopes.
Clipboard capture needs WSL's `wslpath` and `powershell.exe`, Wayland's `wl-paste`,
or X11's `xclip`. Proxy needs the selected backend installed and authenticated;
its packaged persona and background helpers work without public spec/bg commands.
Set `DG_PERSONAS_DIR` or `DG_AGENTS_DIR` for persona files; detached launch needs
POSIX `sh`. The provider helper needs Git and authenticated `gh` or `glab`;
`vcs-provider` is a CLI command, not a separate skill. See the
[command reference](../../../docs/DEVELOPER.md#wave-2a-cli-commands) for its full
inventory and configuration.

After a wave merges, refresh the plugin, install the release, and verify the
commands before manually updating personal shims/references and removing
replaced local skills. Legacy files, personal settings, permission rules, and
plugin caches stay untouched by this migration. Preserve host approval prompts
and the separate approval for `pw code`; review narrow permission rules manually.
