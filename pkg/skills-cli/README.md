# @dg/skills-cli

Standalone CLI for dg AI skills. One entry point registers all skill commands.

## Usage (from source)

```bash
bun pkg/skills-cli/src/index.ts --help
bun pkg/skills-cli/src/index.ts browser install
bun pkg/skills-cli/src/index.ts browser demo my-feature.demo.md --video
bun pkg/skills-cli/src/index.ts proto scrape https://app.example.test/page
bun pkg/skills-cli/src/index.ts proto plant /tmp/ai/proto/example/plan.json
bun pkg/skills-cli/src/index.ts proto cleanup example
```

The `proto` workflow requires the companion extension. `scrape` and `plant`
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

## Build standalone binary

```bash
cd pkg/skills-cli
bun run build       # produces dist/dg-skills (current platform)
```

Pre-built binaries for Linux x64, macOS arm64, and Windows x64 appear in
[GitHub Releases](https://github.com/detailedghost/dg-ai/releases) as
`skills-vX.X.X`.

## Development commands

```bash
bun run lint        # tsc --noEmit
bun test            # unit tests
```
