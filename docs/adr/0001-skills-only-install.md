# 0001. Skills-only install is a file copy

## Status

Accepted

## Context

dg-ai already installs in two ways:

- The full bootstrap downloads `dg-skills`, then `dg-skills install` downloads
  `dg-daemon`, `dg-agent`, and the extension.
- `--cli-only` downloads the `dg-skills` binary, writes `~/.dg/cli-only`, and
  skips the extension, the daemon, and the agent. With `DG_INSTALL_CODEX=1` it
  also copies skill directories that do not declare `requires: [extension]`.

The shared instructions live in `plugins/dg/skills` as `SKILL.md` files plus
the references next to them. `google-sms-cleanup` is one of those files. Copying
them does not require a release binary. The Codex opt-in already copies skill
directories, and it does that only after the binary download.

## Decision

A skills-only install copies every immediate child of `plugins/dg/skills` that
contains `SKILL.md`, and every regular file under that directory. The skills
root `README.md` stays in the repository; it is the catalog, not a skill.
Skills that declare `requires: [extension]` are copied too. They are
instructions. `--cli-only` remains the install that ships the `dg-skills`
binary and hides those skills from the Codex copy.

`filesToInstall` in `@dg/common` chooses the relative paths.
`installSkillTree` in `@dg/common/node` writes them. The TypeScript and shell
installers set mode `0644` and refuse symlinks. Skill text is data. The
installer does not spawn it, and it does not call the GitHub releases API.

`dg-skills install --skills-only` and `mise run install:skills` call that code.
`bootstrap.sh --skills-only` and `DG_SKILLS_ONLY=1` perform the same copy for a
machine without Bun, and they return before any release-asset download. When
that shell path has no local tree, the only download is the repository source
archive.

The destination is `$DG_SKILLS_DEST`, otherwise `$DG_HOME/skills`, otherwise
`~/.dg/skills`. The command leaves `~/.dg/bin` and the `cli-only` marker as
they were.

## Consequences

- An agent can install the instruction tree, including `google-sms-cleanup`,
  without fetching binaries.
- `dg-skills install` is still how a machine adds the binaries and the extension.
- Adding or removing a skill file updates the end-to-end expected path list.
- The shell and PowerShell bootstraps repeat the copy loop so a host without
  Bun can install. The end-to-end test installs this repository's skill tree
  through the TypeScript command and through `bootstrap.sh`, and both results
  have to be the same paths.

## Amendment (2026-10-18)

Skills-only now also installs the `dg-skills` CLI from the latest `skills-v*` release, because
the skills call it. It uses the same download and SHA256SUMS check as the default path
(`fetchCliBinary` in the CLI, the shared download block in `bootstrap.sh` and `bootstrap.ps1`)
and installs into `${DG_HOME:-~/.dg}/bin`. It still fetches no `dg-daemon`, `dg-agent` or
extension, never runs `dg-skills install`, and never executes skill content.
