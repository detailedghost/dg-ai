# @dg/skills-cli

Standalone CLI for dg AI skills. One entry point registers all skill commands.

## Usage (from source)

```bash
bun pkg/skills-cli/src/index.ts --help
bun pkg/skills-cli/src/index.ts install
bun pkg/skills-cli/src/index.ts install --skills-only --dest "$HOME/.dg/skills"
bun pkg/skills-cli/src/index.ts demo --edit my-feature.demo.md
bun pkg/skills-cli/src/index.ts prototype ui plan.json
bun pkg/skills-cli/src/index.ts proto --ext scrape https://app.example.test/page
bun pkg/skills-cli/src/index.ts proto --ext plant /tmp/ai/proto/example/plan.json
bun pkg/skills-cli/src/index.ts proto --ext cleanup example
```

Plain `proto` and `prototype` run the local prototype commands (`ui`, `serve`,
`wait`, `confirm`, `status`, `stop`, and the path helpers) and need no
extension. The `proto --ext` workflow requires the companion extension. `scrape` and `plant`
exchange local files through the browser's Downloads directory and block until
the extension responds. Run `plant` and `cleanup` from the target project root;
an approved answer is preserved under `.agents/prototype/<slug>/`.

## Inbox cleanup

The installed `dg-skills inbox` command supports Proton Mail through the
extension and Gmail/Outlook through OAuth. Configure encrypted database profiles
with `inbox profile set`, then use `--account-profile NAME` for workflows.
`--session ID` selects a daemon session; explicit `--data-path` fixture commands
work without a daemon. Paging uses lazy async generators and bounded batch writes.

```sh
dg-skills inbox --help
dg-skills inbox profile --help
dg-skills inbox load folders --account-profile personal --session SESSION_ID
dg-skills inbox probe --folder Inbox --limit 3000 --account-profile personal
```

Review decisions and run `apply --dry-run` before `apply --confirm`. Read
[provider setup](../../plugins/dg/skills/inbox-cleanup/references/providers.md) and
[the workflow](../../plugins/dg/skills/inbox-cleanup/references/workflow.md).

## SMS

`dg-skills ssms <provider> <verb>` reads Google Messages for Web and Signal.
`google` uses the CDP browser harness. `signal` wraps `signal-cli` in daemon
JSON-RPC mode and does not touch Signal Desktop. Sends are `draft`, then
`send --draft ID` after an interactive yes or `--approve`. `--yes` does not send. See [SMS providers](../../docs/ssms.md).

```sh
dg-skills ssms --help
dg-skills ssms google status
dg-skills ssms signal link
```

## Channel review

The installed `dg-skills channel-review` command runs local thrash reviews for
Teams requests through a Teams bot relay. Install thrash separately for each runner. Claude
is the supported default; Codex and Copilot runners are experimental.

```sh
dg-skills channel-review status --env dev
dg-skills channel-review start --env dev
dg-skills channel-review stop --env dev
dg-skills channel-review run --env dev
dg-skills channel-review env dev
dg-skills channel-review emojis show
```

`start` runs in the background; `run` stays in the foreground. `status` prints
JSON with daemon state, runner probes, and preflight when stopped. `env` without
a name prints the saved default, base URL, and AWS profile. `emojis capture`
saves a human's custom reaction on its own prompt; `emojis set` saves a known ID.
Apply saved reaction IDs after stop and start.

Read [setup](../../plugins/dg/skills/channel-review/references/setup.md) and
[commands](../../plugins/dg/skills/channel-review/references/commands.md) for
prerequisites, flags, request tokens, and the exact error catalog.

## Background jobs

`dg-skills bg` identifies a job by its Linux `/proc` start time.
On other platforms it fails closed: `status` reports the job as `unknown`, and
`cancel` returns `no-pid` without signaling any process.

## Demo plans

Demo plans use YAML frontmatter and a required `## Steps` list. They may also
declare `includeSetup: false` and an earlier `## Setup` list for login,
configuration, seeded data, or other preparation:

```markdown
---
title: Prepared demo
startUrl: https://app.example.test
includeSetup: false
---

## Setup

1. **Sign in** — Sign in manually with the demo account. `next`

## Steps

1. **Dashboard** — The tutorial starts here. `next`
```

Excluded setup runs first and user-paced, but is not narrated or recorded.
Change `includeSetup` to `true` to make setup lead the tutorial and video.
Plans persist fill text, so credentials, tokens, and MFA codes must be entered
manually rather than authored as actions.

## Skills-only install

`install --skills-only` copies `plugins/dg/skills` into `--dest` (default
`$DG_SKILLS_DEST`, else `$DG_HOME/skills` or `~/.dg/skills`). Each immediate
child directory that contains `SKILL.md` is included, references and all. The
copy is data: the command does not fetch `dg-skills`, `dg-daemon`, `dg-agent`,
or the extension, and it does not execute skill content. From the repo root,
`mise run install:skills` is the same command. `bootstrap.sh --skills-only`
and `DG_SKILLS_ONLY=1` do that copy on a machine without Bun.

## Build standalone binary

```bash
cd pkg/skills-cli
bun run build       # produces dist/dg-skills (current platform)
```

Pre-built binaries for Linux, macOS, and Windows (x64 and arm64) appear in
[GitHub Releases](https://github.com/detailedghost/dg-ai/releases) as
`skills-vX.X.X`. The release workflow also publishes `SHA256SUMS` (GNU
`sha256sum` lines, `<hash>  <filename>`) beside those binaries. `bootstrap.sh`
and `bootstrap.ps1` verify the download when that asset exists and still
install older releases that do not include it.

## Development commands

```bash
bun run lint        # tsc --noEmit
bun test            # unit tests
```
