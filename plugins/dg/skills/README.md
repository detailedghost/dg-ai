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
| `verify/` | Review a finished change round by round and record a verdict per round |
| `chat/` | Live browser chat through dg-agent and dg-daemon |
| `inbox-cleanup/` | Review Proton Mail, Gmail, or Outlook cleanup with redacted feedback |
| `channel-review/` | Local thrash reviews for Teams PR and MR requests through a bot relay |
| `google-sms-cleanup/` | Review Messages for Web without deletion or unapproved sends |
| `agent-seed/` | Set up `.agents/`, a lean `AGENTS.md`, `CLAUDE.md` as `@AGENTS.md`, and the `docs/` rule files |
| `clipboard-img/` | Capture a clipboard PNG through the compiled clipboard-image command |
| `grill-me/` | Resolve a design through a structured interview |
| `hook-comment-disable/` | Disable the American-English hook for one session with explicit approval |
| `hunt/` | Gather evidence and diagnose a codebase bug |
| `jobs/` | List and control the dg-daemon and channel-review daemons |
| `kick/` | Plan and park a deferred spec bundle |
| `overwatch/` | Track parallel sessions on the live Overwatch board |
| `phone/` | Private encrypted chat with one or more other agents over Nostr |
| `phone-friend/` | Renamed to phone; this hidden alias is kept for two minor releases |
| `pickup/` | Resume a parked spec bundle |
| `prd/` | Prepare a spec bundle for handoff |
| `proxy/` | Delegate to codex, copilot, pi, opencode, or grok |
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
| `worktree/` | Create, list, remove, and prune git worktrees for agent workflows |
| `spec/` | Plan or execute a durable feature spec bundle |
| `sdlc/` | Run a feature brief through slice waves to a draft PR |
| `assign/` | Pick the best-fit engineering agent for work or spec slices |
| `monolith/` | Consolidate a codebase's vocabulary into `.agents/monolith.md` |
| `spring-break/` | Consolidate `.agents/school/` into topic clusters and trim the agent context files |
| `review-loop/` | Loop an antagonistic review over a branch and address findings |
| `polish/` | Clean up a diff for quality, then apply the fixes |
| `jot/` | Save a short note or a session handoff (`dg-skills jot`) |
| `bg/` | Run a task in the background and track the jobs (`dg-skills bg`) |
| `cls/` | Close out a git worktree and return to the main repo |
| `stat/` | Show this session's in-flight work, status, and ETA in one table |
| `sniff/` | Inventory what an app needs before it can run (`dg-skills sniff`) |
| `nope/` | Reset to the correct file-search defaults and record a feedback note |
| `find-work/` | Find actionable work and run each item in a parallel worktree |
| `doctor/` | Check what the dg skills need and walk through fixes (`dg-skills doctor`) |
| `bot-commit-email/` | Git commit and review email for every bot (`dante+<botname>@detailedghost.com`) |
| `db/` | Query PostgreSQL and Snowflake with read-safe defaults (`dg-skills db`) |
| `eli5/` | Explain a concept, file, error, or codebase as if the reader is five |
| `erd/` | Generate an architecture map or any Mermaid diagram as Markdown or HTML |
| `test-live/` | Deploy the current branch, wait for it to go live, then drop the temp commits (`dg-skills test-live`) |
| `ticket/` | File a Jira ticket from the registered project, assignee, sprint, and issue types |

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
  jobs/
  kick/
  overwatch/
  phone/
  phone-friend/
  pickup/
  prd/
  proto/
  verify/
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
  worktree/
  spec/
  sdlc/
  assign/
  monolith/
  spring-break/
  review-loop/
  polish/
  jot/
  bg/
  cls/
  stat/
  sniff/
  nope/
  find-work/
  doctor/
  bot-commit-email/
  db/
  eli5/
  erd/
  test-live/
  ticket/
```

Each folder contains `SKILL.md` and may include `references/`, scripts, or other
supporting assets. Cross-skill references are relative to this tree. The CLI
implementation lives in [`pkg/skills-cli/`](../../../pkg/skills-cli/README.md).
`DG_SKILLS_DIR` can select a relocated real skill tree for CLI resource lookup.

## Runtime requirements

The extension, dg-skills, dg-daemon, dg-agent, and both plugin manifests share
version **1.21.1**. `chat/` invokes dg-agent (`agent-v*`), which launches the
adjacent dg-daemon (`daemon-v*`). Most compiled helpers run through dg-skills
(`skills-v*`). User terminal commands can use `dg-skills`; skill instructions
check the installed binary once and call the literal `~/.dg/bin/dg-skills` path.

`dg-skills install --cli-only` skips the extension, pairing, dg-daemon, dg-agent,
and skills marked `requires: [extension]`: browser, chat, demo, overwatch, and
proto. It includes stash, proxy, clipboard-img, and other skills without that
requirement. Live inbox profiles still need dg-daemon; Google SMS cleanup needs
Messages for Web through the host's browser tools. `jobs` also needs the full
install, since it drives `dg-daemon` directly though it has no extension
dependency. Instructions that refer to later-wave skills still need those
skills separately until their ports ship.

Stash supports scratch, state, current-worktree, and main-worktree scopes.
Clipboard capture needs WSL's `wslpath` and `powershell.exe`, Wayland's `wl-paste`,
or X11's `xclip`. Proxy needs the selected backend installed and authenticated;
its packaged persona and background helpers work without public spec/bg commands.
Set `DG_PERSONAS_DIR` or `DG_AGENTS_DIR` for persona files; otherwise proxy uses the
personas packaged in `agents/`. Detached launch needs
POSIX `sh`. The provider helper needs Git and authenticated `gh` or `glab`;
`vcs-provider` is a CLI command, not a separate skill. See the
[command reference](../../../docs/DEVELOPER.md#wave-2a-cli-commands) for its full
inventory and configuration.

Maintainers follow the [post-merge cutover](../../../docs/DEVELOPER.md#manual-post-merge-cutover) steps after each wave.
