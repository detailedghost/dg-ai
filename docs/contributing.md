# Contributing

## Which branch is the default?

This repo's default branch is `master`. In this guide, "the default branch" means `master`.

## How do I start a change?

Make a branch from the default branch. Never commit to the default branch directly.

Run `bun install` at the repo root. It links the `@dg/*` workspace packages. See [docs/DEVELOPER.md](DEVELOPER.md) for the commands of each package.

## How do I write commits?

Use Conventional Commits with a scope, like `feat(skills): add the doctor command`.

Use these types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`. Write the scope in lowercase kebab-case. Reuse a scope that exists
in the history, such as `skills`, `skills-cli`, `dg-agent`, `channel-review`, `proto`, or `deps`.

The release workflow makes its own commit, `chore(release): cut X.Y.Z`. Do not write one by hand. See "How does it get to users?".

Bots that commit or submit a review use the address in the [bot-commit-email skill](../plugins/dg/skills/bot-commit-email/SKILL.md).

## What must every pull request (PR) include?

1. The code change.
1. Tests that import the real production code.
1. Updated docs, if anything a user or developer sees has changed.
1. An ADR (Architecture Decision Record) at `docs/adr/NNNN-kebab-title.md` if the PR introduces or changes an architectural decision. It says what we decided
   and why. Use [the template](adr/template.md) and add a link to [the index](adr/toc.md).

Write an ADR when a change adds a wire contract, frame type, store, table, state file, trust boundary, secret path, or a wider gate or allowlist. Routine docs,
bug fixes, flags, and copy changes do not need an ADR.

Decisions live in two places, each for a different reader:

- `docs/adr/` is for people. Write each ADR in plain English for a reader who is new to the project.
- `.agents/decisions/` is for agents. It holds the agent-specific rules and context that follow from a decision. Each file links the matching ADR in `docs/adr/`
  and does not repeat it.

Write `docs/` pages and ADRs in simple English: short sentences, common words, active voice. Write `AGENTS.md` files and everything under `.agents/` dense and
terse: fragments, precise technical terms, no filler.

Do not commit an empty file under `.agents/`. Delete a file when it has no content. `agents-folder.spec.ts` checks this.

## How do I write the PR description?

Use the PR template in [docs/pull_request_template.md](pull_request_template.md). Answer three questions in plain American English:

- **What does this change do?**
- **Why do we need it?**
- **How can someone test it?**

Then link any docs or ADR included with the PR. Pretend the reader is smart but new to the project.

## When can I merge?

When all four are true:

- Required checks are green. Today that means `ext-blt` and `skills-blt`. Once the branch ruleset is updated, those become `blt-gate` and `gitleaks`. `blt-gate`
  runs on every PR, finds the changed packages, and runs only their BLT checks (`skills-blt`, `ext-blt`, `dg-daemon-blt`, `dg-agent-blt`). A docs-only PR passes
  it with no build. The skills-cli suite runs as `skills-cli (1)` through `skills-cli (4)`. The `skills-blt` job waits for every shard, then runs the other
  package checks, so `blt-gate` still waits on the check named `skills-blt`.
- GitHub Copilot reviewed the latest push.
- Every review conversation is resolved.
- One person approved.

`blt-gate` runs `scripts/blt-gate.ts` from the PR's own checkout, so review changes to that script and to
`.github/workflows/blt-gate.yml` with extra care.

## How does it get to users?

- A release ships four things as one matched set: the extension, `dg-skills`, `dg-daemon`, and `dg-agent`. All four `package.json` files and both plugin
  manifests carry the same version. Nobody bumps a version by hand.
- Each push to `master` runs the `Release` workflow. It reads the commits since the last release and picks the next version:
  - `feat` bumps the minor version.
  - `fix` and `perf` bump the patch version.
  - A `!` after the type, or a `BREAKING CHANGE:` line in the commit body, bumps the major version.
  - `docs`, `chore`, `ci`, `test`, `style`, and `refactor` cut no release.
- The repo squashes every PR. The PR title and body become the commit, so the PR title decides the bump. Write it as a Conventional Commit.
- When a release is due, the workflow runs the BLT checks again, builds every binary and the extension, and runs each binary on its own platform.
  Then the `release` job stamps the version into the matched set, writes the `CHANGELOG.md` entry, and pushes one `chore(release): cut X.Y.Z` commit by
  `dg-release` to `master`, together with the tag `vX.Y.Z`.
- The `release` job publishes one GitHub release for that tag. It holds every binary, the extension zips, `bootstrap.sh`, `bootstrap.ps1`, and one `SHA256SUMS`.
  It marks the release Latest and moves the `latest` tag to the release commit, unless a higher `vX.Y.Z` release exists.
- To run the workflow by hand, open Actions, pick **Release**, and choose **Run workflow**. Pick `auto`, or force `patch`, `minor`, or `major`.
  Run it on a release commit to publish again a release whose upload failed.
- The workflow never force-pushes `master` and never deletes a tag. A failed release is fixed by running the workflow again.
- Manual step, once. The workflow pushes to `master` as the GitHub Actions app. The `main protection` ruleset must list that app as a bypass actor.
- The first release under this scheme also publishes a `skills-vX.Y.Z` release. It holds the `dg-skills` binaries only and is never marked Latest.
  It lets `dg-skills` 1.21.1 and older find the new release once.
- Users install a release with the bootstrap script or `dg-skills install`. See [docs/install.md](install.md).

## What if I am stuck?

Ask a person. Do not turn off a check to get past it.

## Code Standards

### Repo-wide rules

- **Language.** Write TypeScript for Bun. Run it with `bun run`. Pin no dependency to a moving tag.

- **Types.** Every package runs `tsc --noEmit` as its `lint` script, in strict mode.

- **Tests.** Put tests in `__tests__/*.spec.ts`, next to the package source. Run them with `bun test`. Import the real module. Do not copy production logic into
  a test. Do not write placeholder assertions.

- **Comments.** Write no inline code comments. Put rationale and trade-offs in the commit message and the PR body.

- **Doc comments.** Keep them to one short line, and only where the name does not say enough.

- **YAGNI.** Build the smallest change that meets the need. Add no unused parameters, extension points, or "just in case" branches.

- **Reuse.** Search the repo, and `@dg/common` first, before you write new code. Hoist a helper to `@dg/common` when a second package needs it.

- **Spelling.** Use American English in code, tests, docs, commits, and PR bodies.

- **Markdown.** Keep prose lines to 160 characters. See `.markdownlint.jsonc`.

- **No local zone.** Public sources must not hold private values. `no-local-zone.spec.ts` scans `plugins/dg/skills`, `pkg/skills-cli/src`, and
  `pkg/channel-review/src`. It fails on:

  - home paths such as `/home/<name>/` and `C:\Users\<name>`
  - `~/scripts/` and local `~/.claude/skills/` paths
  - email addresses and token-shaped strings (`dante@detailedghost.com` and `dante+<bot>@detailedghost.com` are allowed)
  - a retired helper used as a command, such as `stash`, `bg-helper`, or `verify-build`

  To add your own private terms, list them in `.no-local-zone.local` at the repo root. Git ignores that file.

- **Skill Flags table.** A skill whose `**Usage:**` line shows flags needs a `## Flags` table. The table has four columns: Flag, Short, Effect, Default. Every
  flag in Usage must appear in the table. `skill-flags.spec.ts` checks this.

- **Doctor coverage.** Every command that `dg-skills` registers needs doctor checks and an allow-rule check. Every skill that calls `dg-skills` needs this line,
  with the items it uses: `If a step fails, run ~/.dg/bin/dg-skills doctor <items>.` `doctor-coverage.spec.ts` checks this.

- **Secrets.** Do not commit a secret. The `gitleaks` check scans every PR. To scan locally, run `mise run security:scan`.

### pkg/common

- Keep it for shared types and pure functions. The root export (`@dg/common`) holds no Node-only code.
- Put Node-only code under `src/node` and import it as `@dg/common/node`. Put shared database code in `@dg/common/daemon-db`.
- Declare the CLI wire types in `src/cli-wire.ts`. `dg-daemon` and `dg-agent` import them from `@dg/common` and keep no private copy.
  `package-boundaries.spec.ts` checks this.
- A change here runs all four BLT workflows, because every package depends on it.

### pkg/skills-cli

- One entry point, `src/index.ts`, registers every `dg-skills` command.
- Give each command a `doctor.ts` with its checks. The doctor coverage guard fails without one.
- Ship `dg-skills` as a compiled binary (`bun build.ts`). Commands that must work compiled have a `*-compiled.spec.ts` test.
- The `skills-cli` tests build and load the extension. CI sets `DG_VERIFY_NO_SANDBOX=1` for them.

### pkg/skills-test

- Hold the guard tests here. They read repo files with `readRepoFile` and `REPO_ROOT` and fail when the repo drifts.
- The guards cover skill manifests, the Flags table, doctor coverage, the no-local-zone scan, package boundaries, dependency pinning, and the release versions
  and triggers.
- Add a guard here when a rule must hold across packages. Do not repeat a package's own test.

### pkg/extension

- The extension uses WXT and Manifest V3. Run `bun run dev`, `bun run build`, and `bun test`.
- CI runs `bun test --isolate` and `bun run build`. Both must pass.
- Import shared types from `@dg/common`. Do not copy them.
- Send no prototype or demo data off the machine. The extension uses the local Downloads directory only.

### pkg/channel-review

- Keep tests on fakes from `__tests__/support/fakes.ts`. Tests that call a real runner CLI run only when `DG_TEST_CLAUDE_CLI=1` or `DG_TEST_GROK_CLI=1` is set.
  `mise run test:runners` sets them when the binary is on `PATH`.
- Check runner changes with `mise run test:runners:mutate`. It runs Stryker mutation tests.
- Automation opens draft PRs and never merges them. See [ADR 0014](adr/0014-draft-prs.md).
- Pass error reports to a runner as data files. See [ADR 0013](adr/0013-untrusted-reports.md).
- Keep deployment values out of the source. See [ADR 0007](adr/0007-private-configuration.md).

### pkg/inbox

- Run `mise run test:inbox`. Do not point those tests at a live Proton mailbox.
- Check plan and safety changes with `mise run test:inbox:mutate`. It runs Stryker on
  `pkg/inbox/src/features/filter-policy/plan.ts` and `safety.ts`. Keep the score at or above the repo low threshold of 80.
- The declared Proton filters file lives under the dg home, for example
  `~/.dg/inbox/workspaces/protonmail/<workspace>/declared-filters.json`. Do not commit a mailbox snapshot.
  Ship the schema, the loader, `pkg/inbox/examples/declared-filters.example.json`, and the docs.
- `filters sync` is the Proton write path. See [ADR 0022](adr/0022-proton-filter-policy.md) and
  [the filter policy guide](inbox-filter-policy.md).

### pkg/dg-daemon

- The daemon listens on loopback only. It checks origin and capability on its connections. See [ADR 0004](adr/0004-loopback-pairing.md).
- Encrypt secret fields with the wrapped data key. Keep credentials in their own store.
  See [ADR 0005](adr/0005-field-encryption.md) and [ADR 0006](adr/0006-credential-store.md).
- Group tests in `__tests__/` by domain, such as `server/`, `crypto/`, and `dispatch/`.
- Keep `DG_DAEMON_PACKAGE_VERSION` in `src/server/status.ts` equal to the `package.json` version. The release tests check this.
- Build with `bun run build`. It compiles one binary.

### pkg/dg-agent

- Import the wire types from `@dg/common`. Do not declare them here.
- Ship `dg-agent` next to `dg-daemon` in the same directory. Each finds the other there.
- Keep secrets out of the failure log. `log-redact.spec.ts` tests it.
- Build with `bun run build`. It compiles one binary.
- A change in `pkg/dg-agent` or `pkg/dg-daemon` runs the `dg-agent-blt` check.

### plugins/dg/skills

- Give each skill a folder with a `SKILL.md`. Use the cross-host frontmatter that `skill-manifests.spec.ts` checks.
- Call the CLI by its literal path, `~/.dg/bin/dg-skills` or `~/.dg/bin/dg-agent`. Do not resolve it through a shell variable. Do not branch on
  `CLAUDE_PLUGIN_ROOT`. Do not run the TypeScript entry point.
- Name other skills with the `dg:` prefix, such as `/dg:polish`. Name shipped agents as `dg:<agent>`.
- Add the `## Flags` table and the doctor line described above.
- Do not add a retired helper command. Use the matching `dg-skills` command.
- Keep paths, hosts, and names that belong to one person or company out of the skill text.
