# Install and update DeeGee

**As a Claude Code plugin** (the skills self-bootstrap the CLI on first use):

```text
/plugin marketplace add ~/code/dg
/plugin install dg@detailedghost
/plugin install unslop@detailedghost
```

The `unslop` plugin is optional. It installs the upstream `theclaymethod/unslop` skill, which `/dg:polish` calls
when present.

**Standalone — one command installs the `dg-skills`, `dg-daemon` and `dg-agent` binaries
_and_ the browser extension** (compiled binaries, no Bun needed):

macOS / Linux (x64 or arm64):

<!-- markdownlint-disable MD013 -->

```bash
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.0/pkg/skills-cli/bootstrap.sh | sh
```

Windows (x64 or arm64), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.0/pkg/skills-cli/bootstrap.ps1 | iex
```

<!-- markdownlint-enable MD013 -->

Both install `~/.dg/bin/dg-skills` (`$DG_HOME/bin` when `DG_HOME` is set) (released as `skills-v*`), then run
`dg-skills install`, which also fetches `~/.dg/bin/dg-daemon` (`daemon-v*`) and
`~/.dg/bin/dg-agent` (`agent-v*`), stages the extension and prints the **Load
unpacked** steps. Re-run `dg-skills install` anytime to update all three; each
is skipped when already current, and a platform with no published binary warns
and continues instead of failing the install. (Building the extension from
source with `--local` needs [Bun](https://bun.sh).)

## Pin a version

Install a specific release instead of the newest, by adding `--version <x.y.z>`
(shell) or setting `DG_VERSION` first (PowerShell):

<!-- markdownlint-disable MD013 -->

```bash
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.0/pkg/skills-cli/bootstrap.sh | sh -s -- --version 1.19.0
```

Needs 1.21.0 or newer.

```powershell
$env:DG_VERSION = "1.19.0"
irm https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.0/pkg/skills-cli/bootstrap.ps1 | iex
```

Needs 1.21.0 or newer.

<!-- markdownlint-enable MD013 -->

This also pins the `daemon-v*`, `agent-v*` and `ext-v*` releases that
`dg-skills install` fetches afterward to the same version, and combines with
`--cli-only`/`--agent-only`. An installed binary accepts the same flag:
`dg-skills install --version 1.19.0`. Leaving it unset installs each binary's
newest release, as before.

If the pinned `skills-v`, `daemon-v`, `agent-v` or `ext-v` release does not
exist, the whole install fails and names the missing release. It checks
every pinned release first and changes nothing — no binary and no
extension — so a pin never leaves some parts updated and others not.
Leaving the version unset keeps today's behavior: install the newest of
each, warning and skipping one that can't be reached.

## CLI-only install

Install only the `dg-skills` binary and the skills that run without the browser
extension. This skips the extension, the extension pairing, `dg-daemon` and
`dg-agent`. Run it before using the plugin so its skills find `dg-skills` and do
not start a full install.

<!-- markdownlint-disable MD013 -->

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

Windows, in PowerShell:

```powershell
$env:DG_CLI_ONLY = "1"
irm https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.0/pkg/skills-cli/bootstrap.ps1 | iex
```

<!-- markdownlint-enable MD013 -->

`DG_CLI_ONLY=1` works in place of `--cli-only` for the shell form, and an
installed binary accepts `dg-skills install --cli-only`. Add `DG_INSTALL_CODEX=1`
to copy only the CLI skills into `$CODEX_HOME/skills`.

| Skill | CLI-only |
| --- | --- |
| `stash`, `proxy` | Yes — proxy needs the selected external backend installed and authenticated |
| `clipboard-img` | Yes — needs a native WSL, Wayland, or X11 clipboard tool |
| `channel-review` | Yes |
| `worktree`, `spec`, `sdlc`, `assign`, `monolith`, `spring-break`, `review-loop`, `polish` | Yes — they call other skills and tools that must be available |
| `jot`, `bg`, `cls`, `stat`, `sniff`, `find-work`, `doctor` | Yes — they call other skills and tools that must be available |
| `db`, `erd` | Yes |
| `eli5` | Yes for `-v`/`-p` (stash) or `--erd`; a plain `/dg:eli5 <thing>` needs no CLI |
| `ticket` | Yes — needs a stored `ticket/jira` credential |
| `test-live` | Yes — needs Git and an authenticated `gh` (GitHub only) |
| `nope` | No CLI needed — it calls no CLI and no other skill |
| `google-sms-cleanup` | Yes — instruction-only |
| `inbox-cleanup` | Yes for explicit `--data-path` fixtures; live profiles need `dg-daemon` |
| `browser`, `demo`, `proto`, `chat`, `overwatch` | No — each declares `requires: [extension]` |

`vcs-provider` is also available as a CLI command; it needs Git and authenticated
`gh` (GitHub) or `glab` (GitLab). It has no separate skill. Other workflow skills
without an extension dependency also install; their own tools and referenced
skills still need to be available.

A skill that needs the extension stops with a message that names the fix. To add
the extension later, run `dg-skills install` (or the full bootstrap command
above). That also fetches `dg-daemon` and `dg-agent` and removes the CLI-only
marker at `~/.dg/cli-only`.

## Skills-only install

Copy the skill instruction files plus the `dg-skills` CLI they call. This path writes
`plugins/dg/skills` (each `SKILL.md` plus the reference files next to it,
including `google-sms-cleanup`) into a directory you choose, then installs
`dg-skills` from the latest `skills-v*` release into `${DG_HOME:-~/.dg}/bin`,
verified against that release's `SHA256SUMS`. It does not download `dg-daemon`,
`dg-agent`, or the extension, and it does not run the text inside a skill.

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
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.0/pkg/skills-cli/bootstrap.sh | sh -s -- --skills-only
```

Windows, in PowerShell:

```powershell
$env:DG_SKILLS_ONLY = "1"
irm https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.0/pkg/skills-cli/bootstrap.ps1 | iex
```

<!-- markdownlint-enable MD013 -->

`DG_SKILLS_ONLY=1` works in place of `--skills-only` for the shell form.
`DG_SKILLS_DEST` chooses the directory (default: `$DG_HOME/skills` or
`~/.dg/skills`). Point it at `$CODEX_HOME/skills` when the files should land
where Codex reads skills. The skills root `README.md` is not installed.

## Codex plugin

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
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.0/pkg/skills-cli/bootstrap.sh | DG_INSTALL_CODEX=1 sh
```

PowerShell standalone installation:

```powershell
$env:DG_INSTALL_CODEX = "1"
irm https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.0/pkg/skills-cli/bootstrap.ps1 | iex
```

The standalone path copies the skills to `$CODEX_HOME/skills` (or
`~/.codex/skills`). Start a new Codex thread after either installation method.

## Supported browsers

- **Chromium** — Chrome, Edge, Brave, Vivaldi, Opera (single build)
- **Firefox** 139+

See the [agent install guide](AGENT-INSTALL.md) for pairing, local builds, and
the steps that need a person. Read the [browser guide](browser.md) for the
extension’s URL markers and browser-specific behavior.
