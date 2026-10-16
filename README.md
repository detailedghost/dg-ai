# 👻 DeeGee

Browser, inbox, and channel review plugin for Codex and Claude Code. Skills: **browser**, **demo**,
**live-page prototype**, **chat**, **inbox cleanup**, **channel review**, and **Google SMS cleanup**.
The companion extension is `dg-ai-extension`.

## 📦 Install

**As a Claude Code plugin** (the skills self-bootstrap the CLI on first use):

```text
/plugin marketplace add ~/code/dg
/plugin install dg@detailedghost
```

**Standalone — one command installs the `dg-skills`, `dg-daemon` and `dg-agent` binaries
_and_ the browser extension** (compiled binaries, no Bun needed):

macOS / Linux (x64 or arm64):

<!-- markdownlint-disable MD013 -->

```bash
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
```

Windows (x64 or arm64), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.ps1 | iex
```

<!-- markdownlint-enable MD013 -->

Both install `~/.dg/bin/dg-skills` (released as `skills-v*`), then run
`dg-skills install`, which also fetches `~/.dg/bin/dg-daemon` (`daemon-v*`) and
`~/.dg/bin/dg-agent` (`agent-v*`), stages the extension and prints the **Load
unpacked** steps. Re-run `dg-skills install` anytime to update all three; each
is skipped when already current, and a platform with no published binary warns
and continues instead of failing the install. (Building the extension from
source with `--local` needs [Bun](https://bun.sh).)

### CLI-only install

Install only the `dg-skills` binary and the skills that run without the browser
extension. This skips the extension, the extension pairing, `dg-daemon` and
`dg-agent`. Run it before using the plugin so its skills find `dg-skills` and do
not start a full install.

<!-- markdownlint-disable MD013 -->

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

Windows, in PowerShell:

```powershell
$env:DG_CLI_ONLY = "1"
irm https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.ps1 | iex
```

<!-- markdownlint-enable MD013 -->

`DG_CLI_ONLY=1` works in place of `--cli-only` for the shell form, and an
installed binary accepts `dg-skills install --cli-only`. Add `DG_INSTALL_CODEX=1`
to copy only the CLI skills into `$CODEX_HOME/skills`.

| Skill | CLI-only |
| --- | --- |
| `channel-review` | Yes |
| `google-sms-cleanup` | Yes — instruction-only; it drives Messages for Web and does not declare `requires: [extension]` |
| `inbox-cleanup` | Yes for explicit `--data-path` fixtures; live profiles need `dg-daemon` |
| `browser`, `demo`, `proto`, `chat`, `overwatch` | No — each declares `requires: [extension]` |

A skill that needs the extension stops with a message that names the fix. To add
the extension later, run `dg-skills install` (or the full bootstrap command
above). That also fetches `dg-daemon` and `dg-agent` and removes the CLI-only
marker at `~/.dg/cli-only`.

### Skills-only install

Copy the skill instruction files and nothing else. This path writes
`plugins/dg/skills` (each `SKILL.md` plus the reference files next to it,
including `google-sms-cleanup`) into a directory you choose. It does not
download `dg-skills`, `dg-daemon`, `dg-agent`, or the extension, and it does
not run the text inside a skill.

From a checkout:

```bash
mise run install:skills
```

Or, with Bun:

```bash
bun pkg/skills-cli/src/index.ts install --skills-only --dest "$HOME/.dg/skills"
```

An installed `dg-skills` binary accepts the same flag. Pass `--repo <checkout>`
when the binary is not running inside this repository.

<!-- markdownlint-disable MD013 -->

macOS / Linux, without a local checkout:

```bash
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh -s -- --skills-only
```

Windows, in PowerShell:

```powershell
$env:DG_SKILLS_ONLY = "1"
irm https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.ps1 | iex
```

<!-- markdownlint-enable MD013 -->

`DG_SKILLS_ONLY=1` works in place of `--skills-only` for the shell form.
`DG_SKILLS_DEST` chooses the directory (default: `$DG_HOME/skills` or
`~/.dg/skills`). Point it at `$CODEX_HOME/skills` when the files should land
where Codex reads skills. The skills root `README.md` is not installed.

### Codex plugin

Install from this repository's Codex marketplace:

```bash
codex plugin marketplace add detailedghost/dg-ai
codex plugin add dg@detailedghost
```

Start a new Codex thread after installation. The shared skills bootstrap the CLI
on first use.

To install the same skills directly into `$CODEX_HOME/skills` without the Codex
plugin, opt in while bootstrapping:

```bash
DG_INSTALL_CODEX=1 curl -fsSL \
  https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
```

PowerShell standalone installation:

```powershell
$env:DG_INSTALL_CODEX = "1"
irm https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.ps1 | iex
```

The standalone path copies the skills to `$CODEX_HOME/skills` (or
`~/.codex/skills`). Start a new Codex thread after either installation method.

### 🌐 Supported browsers

- **Chromium** — Chrome, Edge, Brave, Vivaldi, Opera (single build)
- **Firefox** 139+

## 🚀 Usage

Claude Code invokes these as `/dg:*`; Codex invokes them as `$dg:*`.

One-time guided setup of the companion browser extension:

```text
Claude Code: /dg:browser install
Codex:      $dg:browser install
```

Open a batch of PRs/URLs in your **default** browser, grouped into a named group:

```text
Claude Code: /dg:browser batch-open --group "Reviews" work#1517 work#1518
Codex:      $dg:browser batch-open --group "Reviews" work#1517 work#1518
```

Or cold-start a **Chromium** browser (Brave/Edge/Vivaldi) with the extension
pre-loaded — no manual load step (`--list` shows what's installed):

```text
Claude Code: /dg:browser launch --browser brave-beta --group "PRs" work#1517 work#1518
Codex:      $dg:browser launch --browser brave-beta --group "PRs" work#1517 work#1518
```

Hold a **live chat with the agent in a browser tab** while it works — it can
ask you questions, show you staged files, and run commands you publish without
waking itself up:

```text
Claude Code: /dg:chat
Codex:      $dg:chat
```

The `dg-daemon` daemon hosts every session on loopback only, each gated by a
capability token, with messages and staged assets encrypted at rest. On WSL it
needs **mirrored** networking mode, since NAT cannot reach the loopback port
from the Windows-side browser.

An agent can also address another agent directly — `dg-agent send --to <identity>`
queues a message for that identity instead of the human, and the recipient's
`recv` names both sides in `from` and `to`. Each agent keeps its own long-term
memory in a separate, plain-text, full-text-searchable `~/.dg/agents/memory.db`,
which four `dg-agent memory` verbs (`write`, `search`, `read`, `forget`) read and
write with no daemon running at all.

Have the daemon **poll something on a schedule** — a Jira board, a Sentry issue
feed, a Datadog monitor — and collect what comes back:

```sh
dg-daemon job add --label jira-sprint --every 15m --cwd ~/work \
  --notify reviewer -- jira issue list --plain --jsonlines
```

Give the job a fixed cadence with `--every` (`30s`, `15m`, `2h`), or a real
`cron` expression with `--cron` — exactly one of the two is required:

```sh
dg-daemon job add --label weekday-standup --cron "0 9 * * 1-5" --cwd ~/work \
  -- bun run ./check-standup.ts
```

The command prints one JSON object per line — `id` and `title` required, `meta`
and `url` optional — and each line becomes a feed item. The daemon dedupes on
`id`, so a second run of the same query adds nothing. `--notify <identity>`
queues one agent message when a run brings in something new. `job list`, `job run`, `job enable`, `job disable` and `job rm` manage them from there.

A job inherits no secrets: the daemon passes only `PATH`, `HOME`, `LANG` and
`TZ` to the child, so the command must authenticate through its own config
under `HOME` (`~/.sentryclirc`, `~/.config/jira`, and so on). While any job is
enabled the daemon stays up, ignoring its idle timeout.

Have the daemon **keep a long-running script alive** — a bot, a watcher —
by declaring it under `services` in `~/.dg/daemon/config.json`:

```json
{
	"services": {
		"teams-bot": {
			"argv": ["bun", "run", "bot.ts"],
			"cwd": "/home/me/bots/teams",
			"envFile": "/home/me/.config/teams-bot.env",
			"autostart": true
		}
	}
}
```

Only a script declared there can start, and `argv` runs with no shell. `cwd`
and `envFile` must be absolute paths. The child gets `PATH`, `HOME`, `LANG` and
`TZ`, plus the `KEY=VALUE` lines of `envFile`, which must not be readable by
other users. Then drive it against the live daemon:

```sh
dg-daemon service start teams-bot
dg-daemon service status
dg-daemon service stop teams-bot
```

A crash restarts the script after 1s, doubling to a 60s cap; a clean exit does
not restart it. Output streams to `~/.dg/daemon/logs/service-<label>.log`. One
instance runs per label, guarded by `~/.dg/daemon/services/<label>.pid`. Stop
signals the whole process group. A running service keeps the daemon from its
idle exit. Nothing starts the daemon at login yet, so `autostart` only applies
once the daemon is running.

The extension's **dashboard page** shows what has come in — jobs and their next
run on the left, the feed on the right — and hands any item to an agent. Jobs
are added by CLI for now; a page for that is the next step.

Play a **live guided tour** of a feature in your real browser — the extension
spotlights each element and injects explanatory text boxes, step by step:

```text
Claude Code: /dg:demo 1517
Codex:      $dg:demo 1517
```

You review the compiled tour script before it plays. Optional screenshots/video
land in your Downloads folder.

Tours can include a setup phase for login, configuration, or seeded data. Setup
is excluded from the tutorial and recording by default, but can be explicitly
included as the opening steps.

Explore app-native UI approaches directly inside a live page, then export the
one you approve:

```text
Claude Code: /dg:proto
Codex:      $dg:proto
```

The workflow asks for a page and design question, samples the page's visual
styles, presents the proposed comparison, and plants the approved set in the
browser. Run the browser skill's `install` command first to load the companion
extension. For authenticated or private pages, review the privacy warning
before allowing the style scrape. The CLI writes approved answers under
`.agents/prototype/<slug>/` and removes temporary Downloads and scratch files
after export.

### Inbox cleanup

Review Proton Mail, Gmail, or Outlook with /dg:inbox-cleanup in Claude Code or
$dg:inbox-cleanup in Codex. The compiled dg-skills inbox CLI prepares redacted
samples, supports bounded generator paging, and requires review/dry-run before
confirmed mailbox changes. Proton uses extension JavaScript in a signed-in mail
tab; Gmail/Outlook use OAuth and profiles in dg-ai's encrypted database.

Read [provider setup](plugins/dg/skills/inbox-cleanup/references/providers.md) and
[the workflow](plugins/dg/skills/inbox-cleanup/references/workflow.md). Live-account
authentication and mutations need validation in your provider/browser setup.

### Credential store

`dg-skills credentials set|list|delete` keeps secrets encrypted in
dg-daemon's `credentials.db`. `set` reads the value from stdin or a hidden
prompt, and no command prints it. `grant|revoke` manage read-only service
tokens. Start a session with `dg-agent start` first. See the
[developer guide](docs/DEVELOPER.md#credential-store).

### Channel review

Run /dg:channel-review in Claude Code or $dg:channel-review in Codex to inspect
or manage a local daemon that reviews GitHub PRs and GitLab MRs posted in Teams.
Mention the bot with the owner token, `$review`, and a PR link. Claude runs the thrash skill;
Codex and Copilot runners are experimental. Install thrash separately on every
machine that runs reviews.

It needs a Teams bot relay that streams each chat's messages over Server-Sent
Events; see the [relay contract](pkg/channel-review/README.md) and
[relay setup](plugins/dg/skills/channel-review/references/relay-setup.md). Start
on dev in a test chat. A human signs in to AWS SSO and adds the bot to the chat. Run `dg-skills channel-review status --env dev` before
`dg-skills channel-review start --env dev`. Read
[setup](plugins/dg/skills/channel-review/references/setup.md) and
[commands](plugins/dg/skills/channel-review/references/commands.md) for production
rollout, custom emojis, request tokens, and recovery.

### Google SMS cleanup

Sort, archive, and spam-block a Google Messages inbox with
`/dg:google-sms-cleanup` in Claude Code or `$dg:google-sms-cleanup` in Codex.
The skill drives Messages for Web in the browser. It never deletes a
conversation or message, never sends without explicit per-message approval, and
lists ambiguous threads instead of acting on them. Messages for Web has no
starring, renaming, labels, or folders; those stay on the phone. The skill is
instruction-only and does not call `dg-skills`.

### 🔗 Ref formats

- Full URL
- `owner/repo#num`
- `alias#num` (aliases defined in `~/.config/browser-batch/config.json`)
- bare `num` with `--repo`

## 🧩 Extension

The companion `dg-ai-extension` does the grouping browser-side, built with
[WXT](https://wxt.dev) from `pkg/extension/` and targeting Chrome, Edge, Brave,
Vivaldi, and Firefox 139+ (grouping is feature-detected, skipped where absent).

Grouping is **opt-in per batch**: `batch-open`/`launch` append a
`#_tab_group=<name>` marker to each URL, the extension groups those tabs into
`<name>` and strips the marker. Tabs you open by hand are never grouped. Group
color is set in the extension's Options (default blue); the name comes from
`--group` (default `PRs`). `demo` uses a `#_demo=` marker, while `proto` uses a
compressed `#_proto=` marker for its local CLI/extension handoff.

## 📚 References

- [Developer Guide](docs/DEVELOPER.md)
- [Agent Install Guide](docs/AGENT-INSTALL.md)
- [Contributing](docs/contributing.md)
- [Security](SECURITY.md)
