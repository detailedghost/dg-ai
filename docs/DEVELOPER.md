# Developer Guide

## Repository Layout

```text
pkg/
  common/      @dg/common — shared types + pure functions
  extension/   WXT MV3 browser extension (was extension-src/)
  dg-daemon/   loopback HTTP+WS chat daemon — bun build --compile distributable
  dg-agent/    agent-facing CLI for the daemon — bun build --compile distributable
  inbox/       reusable inbox providers/workflows, lazy generators, runtime seams
  channel-review/ Teams review daemon, runners, reactions, and verdict readers
  skills-cli/  CLI framework — bun build --compile distributable
  skills-test/ smoke tests — skills reference the right packages, install logic
plugins/dg/
  skills/      AI instruction layer — SKILL.md + references for each skill
               (the canonical tree; both .claude-plugin/plugin.json and
               plugins/dg/.codex-plugin/plugin.json point here)
    channel-review/ SKILL.md and setup/command references
    google-sms-cleanup/ SKILL.md for Messages for Web cleanup
docs/          Documentation
.github/       CI workflows
```

## Getting Started

```bash
# Clone and install all workspace deps at once
git clone https://github.com/detailedghost/dg-ai
cd dg-ai
bun install        # wires the @dg/* workspace symlinks across every package
```

## Per-Package Commands

### pkg/extension (browser extension)

```bash
cd pkg/extension
bun run dev          # WXT dev server
bun run build        # production build → .output/
bun run lint         # tsc --noEmit
bun test             # unit tests
bun run zip          # build + zip for Chrome
bun run zip:firefox  # build + zip for Firefox
```

### pkg/skills-cli (CLI)

```bash
cd pkg/skills-cli
bun src/index.ts --help          # run locally
bun run lint                     # tsc --noEmit
bun test                         # unit tests
bun run build                    # compile binary to dist/
```

Skills-only install copies `plugins/dg/skills` and does not fetch release
binaries. From the repo root, `mise run install:skills` runs
`bun pkg/skills-cli/src/index.ts install --skills-only`. The file list is
`filesToInstall` in `@dg/common`; the copy is `installSkillTree` in
`@dg/common/node`. See [ADR 0001](adr/0001-skills-only-install.md).

### Wave 2a CLI commands

These commands run from the installed `dg-skills` binary without Bun, the
extension, or dg-daemon. CLI-only installation includes the stash, proxy, and
clipboard skills. `vcs-provider` has no separate skill. Skills-only installation
copies instructions and references; it does not install these runtime tools.

#### Artifact paths and clipboard capture

`dg-skills stash [flags] <tool> [name]` prints one absolute path and creates its
parent (the directory itself when you omit the name). Never construct the
bucket paths yourself.

| Scope | Flag | Path |
| --- | --- | --- |
| Scratch | `--scratch` (default) | `$AI_SCRATCH_DIR/<tool>/<cwd-hash>`; default root `/tmp/ai` |
| State | `-s`, `--state` | `$AI_STATE_DIR/<tool>/<project-hash>`; default root `${XDG_STATE_HOME:-$HOME/.local/state}/ai` |
| Current worktree | `-a`, `--agents` | `<worktree>/.agents/<tool>` |
| Main worktree | `-m`, `--main` | `<main worktree>/.agents/<tool>` |

`-G`/`--global` removes the scratch/state bucket; repository scopes reject it.
`-u`/`--unique` generates a name and treats a supplied name as its suffix.
`-r`/`--root` prints only the root without requiring a tool.
`-C`/`--dir <dir>` resolves paths for another directory. Git supplies worktree
identity; repository scopes require a Git checkout. Usage errors exit 1.

```bash
dg-skills stash --state review handoff.md
dg-skills stash --main review findings.md
dg-skills clipboard-image "$(dg-skills stash -a -u clipboard .png)"
```

`clipboard-image` needs `wslpath` plus `powershell.exe` on WSL, `wl-paste` on
Wayland, or `xclip` on X11. Its explicit destination saves a PNG; `--scratch`
keeps a temporary PNG and prints its path; `-` emits PNG bytes. Without arguments
it saves under `.agents/clipboard`. The clipboard skill chooses its default
unique repository path through stash instead. Neither command needs a legacy
helper on PATH.

Scratch/state tool and bucket directories use mode `0700`; proxy transcripts
use exclusive creation with mode `0600` before any backend starts. On POSIX,
foreign-owned or group/other-writable roots and managed descendants fail closed;
managed descendants also reject symlinks. A configured root may itself be a
symlink only when its ownership, resolved target, and ancestors pass the safety
checks. Choose owned `AI_SCRATCH_DIR` and `AI_STATE_DIR` roots when an existing
root is unsafe; do not change a foreign directory's ownership or permissions.
A scratch or state root, or a managed descendant, with any group or other write
bit (mode `0022` mask) is rejected even when you own it. Only ancestors above
the root may be group- or other-writable, and only with the sticky bit. A
shell `umask` of `0002` or `0000` creates such directories, so create the root
with mode `0700`, or run `chmod go-w` on it.
Windows retains directory/symlink checks but cannot enforce POSIX ownership.

#### VCS provider

Run inside a Git checkout with an origin remote and the matching CLI installed
and authenticated: `gh` for GitHub, `glab` for GitLab. Detection recognizes
`github.com` and `gitlab.com`; set `AI_VCS_GITLAB_HOSTS` to a comma-separated
self-hosted GitLab host list or `AI_VCS_PROVIDER=github|gitlab` to select a
provider explicitly. CLI overrides `GH_BIN` and `GLAB_BIN` select executables.

| Subcommand after `dg-skills vcs-provider` | Result or options |
| --- | --- |
| `detect` | Provider/repository JSON; always exits 0, with nulls and a reason when unresolved |
| `capabilities` | Provider capabilities; fails when no provider resolves |
| `auth` | Exit 0 when authenticated, nonzero otherwise; no success output |
| `list-prs` | JSON array; `--limit N`, `--head <branch>` |
| `list-issues` | Open issues as JSON; `--limit N` |
| `view-issue <number>` | One normalized issue |
| `view-pr <number>` | One normalized pull request or merge request |
| `list-threads <number>` | Unresolved review threads |
| `create-pr` | `--title`, `--base`, `--head`, `--body` required; optional `--draft` |
| `merged-pr-for-branch <branch>` | First matching merged request, or JSON null |

This command ports the provider library into the compiled CLI; channel-review's
verdict readers remain separate. Configure GitLab AI review identities explicitly
with `AI_VCS_GITLAB_REVIEW_BOT`; there is no personal reviewer default.

#### Proxy

`dg-skills proxy <backend> --prompt "<task>"` delegates to one of five external
executables: `codex`, `copilot`, `pi`, `opencode`, or `grok`. The chosen
backend needs its own installation, authentication, and service access. A missing
backend returns installation guidance; the CLI never silently switches backend.
`--list-backends` lists identities without starting one. Use `--prompt-file`
instead of `--prompt` for a saved task, and `--cwd`, `--model`, or `--effort` for
explicit overrides. `--resume <id>` continues a backend session.

`--subagent <name>` reads a persona Markdown file.
`--spec <plan-file-or-directory> --slice <id>` reads the plan's assigned primary
agent. Persona lookup uses `DG_PERSONAS_DIR`, then `DG_AGENTS_DIR`, then the
personal `.claude/agents` directory under the user's home. Resume execution does
not inject a persona again. These helpers ship inside proxy and need no public
spec command.

```bash
dg-skills proxy codex --plan --prompt-file task.md --subagent reviewer
```

`--plan` saves the briefed prompt and prints `{plan, backend, planFile, command}`.
Execute the exact quoted `command` to launch a detached job, then use
`dg-skills bg status <id>` or `list`. `update <id> <context>` queues
context or resumes a completed session; `cancel <id>` stops the owned job.
`run`, `drain`, `kill`, and `prune` are `dg-skills bg` subcommands too. Detached launch needs POSIX `sh`;
native Windows execution still needs validation. Result JSON includes the log path,
exit code, and backend session ID when available. See the
[proxy skill](../plugins/dg/skills/proxy/SKILL.md) for failure and resume handling.
`DG_SKILLS_DIR` relocates the real canonical skill tree for shared resource
lookup; compiled code must not use virtual Bun module paths for external files.

#### Meaningful tests

The real-git suite is `pkg/skills-cli/__tests__/meaningful.spec.ts`. It
preserves the ten legacy history/backup/rollback cases and checks CLI status,
plan schemas, literal paths/messages, attribution and inert imports in disposable
repositories with local bare remotes and isolated durable state.

### pkg/dg-daemon (chat daemon)

```bash
cd pkg/dg-daemon
bun src/index.ts --help   # run locally
bun run lint              # tsc --noEmit
bun test                  # daemon, store, dispatch and asset tests
bun run build             # compile binary to dist/dg-daemon
```

The daemon is loopback-only and capability-gated. Its private record fields
are encrypted at rest: the data key comes from the OS keychain when one is available and from a
file-backed key otherwise, so a machine with no keychain still works. On WSL it
needs **mirrored** networking mode — under NAT the Windows-side browser cannot
reach the loopback port, and the daemon exits with code 3 rather than pretending
to be reachable.

The daemon pins the extension's origin the first time it proves itself with a
valid session token, and refuses every other origin after that. Reloading an
unpacked extension from a new path changes its origin, which would otherwise
lock the daemon out for good. Run `dg-daemon origin show` to see what is
pinned and `dg-daemon origin clear` to forget it, so the next connecting
extension can pin again. `/start` also caps how many sessions can be active
at once (`DG_MAX_SESSIONS`, default 256), so a runaway local caller cannot
grow the session directory or the in-memory registry without limit.

`~/.dg` separates daemon and agent data. `daemon/` holds `daemon.db`, with
encrypted private fields and plaintext operational metadata.
`agents/` holds session files, staged assets, and a second database,
`memory.db`, that keeps its records in plain text **on purpose**: FTS5
cannot index ciphertext, which is why an agent's memory lives in a separate
database rather than another table in `daemon.db`. Nothing in it is a
secret the daemon's key protects — it holds an agent's own notes, readable
by whoever owns the home directory.

`src/jobs/` is the scheduled-job engine: `runner.ts` ticks every 30s and hands
each due job to the same `dispatch/` executor a chat session uses, and
`parse.ts` reads the job's stdout as one JSON feed item per line. Job rows and
feed items live under one reserved session id, `__scheduler__`, because
`agent_messages.sender_session_id` needs a real session row and the record AAD
is keyed by session id. An enabled job keeps the daemon alive: the idle
predicate in `jobs/idle.ts` counts enabled jobs alongside sessions and open
connections.

A job carries either a fixed interval (`interval_ms`) or a `cron` expression
(`cron_expr`), never both — `scheduled_jobs` enforces that with a `CHECK`
constraint. `jobs/cron.ts` wraps `croner` to validate an expression at `job add` time and to compute the next run from a given instant; `recordJobRun`
calls it instead of adding an interval when the job has a `cron_expr`, and a
failed run still advances `next_run_at` so one bad job cannot spin.

### pkg/dg-agent (agent CLI)

```bash
cd pkg/dg-agent
bun src/index.ts --help   # run locally
bun run lint              # tsc --noEmit
bun test                  # CLI, memory store and agent-to-agent tests
bun run build             # compile binary to dist/dg-agent
```

`dg-agent` depends on `dg-daemon` only in its devDependencies. The chat
commands (`recv`, `send`, `progress`, `spawn`, `stage`, `close`, `manifest`)
need a live daemon on the other end of the loopback socket; `memory` does
not — `MemoryStore` opens `agents/memory.db` directly, so every memory verb
works with nothing else running.

`send --to <identity>` queues a message for another agent identity instead of
the human, in a second table (`agent_messages`) rather than a nullable column
on `messages`, so `messages` keeps meaning exactly what it always meant and
`recv` handing an agent only its own inbound rows holds without a filter to
get wrong. `recv` checks the human queue first, then the agent queue; a
sender's own session can never claim its own outbound message back.

The daemon's housekeeping tick prunes `agent_messages` past
`AGENT_MESSAGE_RETENTION_DAYS`, delivered or not, so a message addressed to an
identity that never appears cannot accumulate. It never prunes `messages`:
those rows are the transcript the canvas renders, and a message the human typed
outlives whether an agent ever collected it.

### pkg/common (shared library)

```bash
cd pkg/common
bun run lint   # tsc --noEmit
bun test       # unit tests
```

### pkg/skills-test (smoke tests)

```bash
cd pkg/skills-test
bun run lint   # tsc --noEmit
bun test       # install logic + skill manifests + CLI smoke
```

## CI Overview

| Workflow | Trigger (paths) | Result |
| ------------------- | ------------------------------------------- | --------------------------------------- |
| `ext-blt` | PR: extension, common | required on master |
| `skills-blt` | PR: skills-cli, inbox, channel-review, dg-agent, dg-daemon, extension, common, skills, skills-test, bun.lock | required |
| `dg-daemon-blt` | PR: dg-daemon, common | required |
| `dg-agent-blt` | PR: dg-agent, dg-daemon, common | required |
| `release` | push master, no path filter; manual dispatch | one `vX.Y.Z` release: 18 binaries, 2 extension zips, both bootstraps, `SHA256SUMS` |

The skills-cli tests inside `skills-blt` (the workflow that also lints and tests channel-review) run as four shards, `skills-cli (1)` through `skills-cli (4)`.
Each shard and the job that follows it has a 30 minute backstop.
That job passes only after every shard and the other package checks pass.
`blt-gate` still waits on `skills-blt`, which covers channel-review as well as the shards.

## Branch Protection

PRs to `master` require `ext-blt`, `skills-blt` (including channel-review), `dg-daemon-blt` and
`dg-agent-blt` to pass.

> **Manual step, post-merge.** A repository admin must add the `dg-daemon-blt`
> check to branch protection. Until that is done the workflow runs but cannot
> block a merge, so a broken daemon build would land silently.

## Matched release versions

The extension zip, `dg-skills`, `dg-daemon` and `dg-agent` ship as one matched set.
The `release` workflow stamps one version into every file below and tags the release commit `vX.Y.Z`.
Do not bump a version by hand.

| Artifact | Files the release stamps |
| --------------------- | ----------------------------------------------------------------------------------- |
| `dg-ai-extension` zip | `pkg/extension/package.json` |
| `dg-skills` binary | `pkg/skills-cli/package.json`, the source of the current version |
| `dg-daemon` binary | `pkg/dg-daemon/package.json`, `DG_DAEMON_PACKAGE_VERSION` in `src/server/status.ts` |
| `dg-agent` binary | `pkg/dg-agent/package.json`, `DG_AGENT_PACKAGE_VERSION` in `src/version.ts` |
| plugin manifests | `.claude-plugin/plugin.json`, `plugins/dg/.codex-plugin/plugin.json` |
| lockfile | the workspace versions in `bun.lock` |
| skill tree | the repository itself, tracked in `master` |

`@dg/common` stays at 1.0.0; it is not part of this matched release set.

## Releases

Each push to `master` runs `.github/workflows/release.yml`. `scripts/release-version.ts` holds the logic:

- `detect` reads the commits since the last release and prints `mode`, `version` and `previous_tag`.
  `feat` gives a minor bump, `fix` and `perf` give a patch bump, and `!` or `BREAKING CHANGE:` gives a major bump.
  Other types give no release, and the workflow skips.
- `stamp --version X.Y.Z` writes the version into the files above. Every build job stamps first, and the `release` job stamps the same way.
- `changelog` and `notes` write the entry from the same commits. The release page and `CHANGELOG.md` show the same text.

The job graph is `detect`, then the four BLT workflows, then the builds and the smoke runs, then `release`.
Only `release` has `contents: write`. It does the steps below in this order:

1. Check that `origin/master` is still the commit the run started from. If not, it fails and creates no tag.
   If the tag already exists, check that the run's commit produced it. A run for an older commit that computes the same version stops here.
2. Stamp the version, write the changelog entry, and commit as `dg-release <dante+release@detailedghost.com>`.
3. Push the commit and the tag in one `git push --atomic`.
4. Create the release as a draft with every file, then publish it. It is marked Latest only when its version is the highest `vX.Y.Z`.
5. Move the `latest` tag to the release commit, again only for the highest `vX.Y.Z`. This is the only forced push.
6. For the first version above 1.21.1 only, publish a `skills-vX.Y.Z` bridge release with the `dg-skills` binaries. It is never marked Latest.
   A retry of that version publishes the bridge even after later releases exist. A leftover bridge draft is deleted first.

To recover from a failed run, run **Release** again from `master`. If the tag exists, the job publishes from the tag.
If a draft exists, the job deletes the draft and uploads again. No step deletes a tag.

`dg-skills install` refreshes the extension zip, `dg-skills`, `dg-daemon` and `dg-agent` from one release in one pass, skipping any that is already
current. A platform with no published binary warns and continues rather than failing the whole install.

## Manual post-merge cutover

After each wave merges, refresh the plugin and install the published matched
release (`dg-skills install`, or `dg-skills install --cli-only`). Smoke the
migrated commands from outside the checkout with installed skill resources and
without legacy helpers on PATH. Only then manually update personal shims and
references and remove duplicate local skill copies.

The migration does not edit legacy files, personal settings, permission rules,
or installed plugin caches. Review narrow host command permissions separately;
retain existing approval semantics, including separate approval for `pw code`.
Do not broadly allowlist the binary to bypass those prompts. Later-wave public
commands and their skills remain separate dependencies until their ports land.

Wave 3 adds `worktree`, `spec`, `sdlc`, `assign`, `monolith`, `spring-break`,
and `polish`. Set `DG_PROSE_CHECK_CMD` to run a prose check on PR bodies from
`polish`; leave it unset to skip. After the merge, smoke `scaffold`, `validate`,
and `monolith` from outside the checkout with the installed plugin tree.

Wave 4 adds `jot`, `bg`, `cls`, `stat`, `sniff`, `nope`, `find-work`, and
`doctor`. The compiled commands are `dg-skills jot`, `dg-skills bg`,
`dg-skills sniff`, and `dg-skills doctor`; `cls`, `stat`, `nope`, and
`find-work` are instruction-only. After the merge, smoke `jot`, `bg`, `sniff`,
and `doctor` from outside the checkout with the installed plugin tree.
Run `dg-skills doctor` after an install or upgrade to check every command.

Wave 5 adds `db`, `erd`, `eli5`, `ticket`, and `test-live`. The compiled
commands are `dg-skills db`, `dg-skills erd`, and `dg-skills test-live`;
`eli5` and `ticket` are instruction-only. `test-live` is GitHub only and
has no GitLab port. After the merge, smoke `db`, `erd`, and `test-live`
from outside the checkout with the installed plugin tree.

The legacy `viz`, `review`, `lineage`, and `clockout` skills are retired, not
ported. Delete their local copies at the manual cutover.

## Cross-package integration checklist

Some criteria no single package's tests can observe, because they need a real
browser and a real daemon at the same time. Run these by hand on WSL in
mirrored mode, or through a browser harness:

- [ ] With the daemon running and the extension loaded, a message typed in the
  chat page reaches a blocked `recv`.
- [ ] An agent reply from `send` renders in that session's node.
- [ ] A `$` command published by `manifest` runs from the composer without
  waking the agent.
- [ ] A file passed to `stage` renders in the transcript from a blob URL.
- [ ] Killing the daemon mid-conversation leaves the page in a
  `daemon-not-running` state, and restarting it recovers without a reload.

These are listed rather than faked as `depends_on` edges: an edge only sequences
work, it does not make a criterion observable.

## Inbox integration

@dg/inbox exposes main(argv, runtime), provider types/classes, and public-output
redaction. dg-skills inbox supplies encrypted profile/cache hooks and an
authenticated request-ID/session-bound Proton relay through the CliClient in @dg/common/node.
The extension retains session headers in a Proton-only MAIN observer and executes
fixed operations; browser response metadata goes directly back to CLI JSON.
Graph requests use `Prefer: IdType="ImmutableId"` so moves preserve the IDs used
by subsequent read-state updates. See [Microsoft's immutable ID guidance](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).

Workspaces/config live under DG_HOME/inbox, with explicit overrides. Async page
generators stop requesting pages when consumers return. The --workers option
controls bounded asynchronous file writes, not thread workers; source-relative
worker module URLs are unnecessary in compiled releases. Failed writes drain
and prevent a successful incomplete status index.

Profile/cache schema10 records use the daemon's existing encryption envelope/key.
The raw conversation archive is ignored local context and must remain unpublished.
Run bun test and bun run lint in pkg/inbox, then the inbox-cli and inbox-skill
integration suites. Smoke the compiled dg-skills binary from an unrelated cwd
with fixture datasets. See [provider setup](../plugins/dg/skills/inbox-cleanup/references/providers.md).

## Credential store

dg-daemon keeps secrets in their own SQLite file,
`<dg home>/daemon/credentials.db` (mode 0600, in the 0700 `daemon/` directory).
`CredentialStore` (`pkg/dg-daemon/src/store/credentials-store.ts`) owns it with
its own schema steps. The file has its own data key in its own `crypto_meta`
table. The same key-encryption key as `daemon.db` (OS keychain or key file)
wraps it. A copied `daemon.db` alone never unlocks a credential, and
`daemon.db`'s schema stays unchanged.

The value goes only into the encrypted columns. Its AAD binds the table, the
column and the name, so a ciphertext copied to another name does not decrypt.
`meta_json` holds non-secret metadata in plain text. The store rejects meta
with a key named like `value`, `secret`, `token` or `password`.

Name credentials `<consumer>/<provider>[/<qualifier>]`, for example
`channel-review/datadog` or `channel-review/relay/dev`. The store checks only
the character set (`[a-z0-9][a-z0-9._/-]{0,127}`), so each package picks its
own consumer prefix. `CredentialMeta` types the reserved optional fields
`provider`, `site`, `scopes`, `expiresAt`, `createdBy` and `note`; other keys
take any non-secret JSON.

Only dg-daemon opens `credentials.db`. Callers send the
`cli-credentials-request` frame over the loopback daemon, and three callers
may read:

| Caller | Authenticates with | May do |
| --- | --- | --- |
| A dg session (`dg-skills`, agents) | Session token on `/cli` | `set`, `get`, `list`, `delete`, `grant`, `revoke`, `grant-list` |
| A background service | Service grant token | `get` and `list` under `<prefix>/` |
| The paired extension | Its chat socket handshake | `get` and `list` under `extension/` |

A scoped caller gets the same "not allowed" error for any other operation or
name, so it cannot learn whether a name exists. Only a `get` reply carries a
value. The daemon never logs a value or a token.

```bash
printf %s "$SECRET" | dg-skills credentials set consumer/provider --meta provider=example --meta expiresAt=2030-01-01T00:00:00Z
dg-skills credentials list
dg-skills credentials delete consumer/provider
dg-skills credentials grant consumer
dg-skills credentials revoke consumer
```

`set` reads the value from stdin, or from a hidden prompt on a TTY. `list`
prints names, metadata and grants, and flags entries that expired or expire
within 14 days. No command prints a value or a token.

`grant <prefix>` makes a random 32-byte service token. The daemon keeps only
its SHA-256 in `credential_grants` and writes the token to
`<dg home>/grants/<prefix>.token` (mode 0600, directory 0700). Running `grant`
again rotates the token. `revoke` deletes the grant and the file. The daemon
compares token hashes in constant time and records `last_used_at`.

The extension client is `pkg/extension/lib/background/credentials.ts`
(`getExtensionCredential`, `listExtensionCredentials`). It takes the chat
socket after its handshake. No extension UI uses it yet.

### Using the credential store from another package

`createCredentialClient` in `@dg/common/node` wraps the frame.
`resolveCredential` returns the stored value, else the first non-empty
environment variable you name, and reports its `source`. A package can move
from `.env` to the store one secret at a time. A background service without
a dg session runs `dg-skills credentials grant <consumer>` once, then passes
`grant`:

```ts
import { createCredentialClient, resolveDgPaths } from "@dg/common/node";

const credentials = createCredentialClient({ paths: resolveDgPaths(), grant: { prefix: "consumer" } });
const apiKey = await credentials.resolveCredential("consumer/provider", { env: ["PROVIDER_API_KEY"] });
credentials.close();
```

Leave out `grant` to authenticate with the dg session for the working
directory (or pass `session`). If dg-daemon is not running, the client fails
with `dg-daemon is not running; start it with dg-agent start`.
`resolveCredential` uses an environment variable in that case when one is
set.

## Channel review integration

`@dg/channel-review` supplies the Teams relay provider, local daemon, runner
probes, persistent state, reactions, and GitHub/GitLab verdict readers.
`pkg/skills-cli` registers `channel-review` and depends on the workspace package.
Both plugin hosts discover its skill through `plugins/dg/skills/channel-review/`.
Read [setup](../plugins/dg/skills/channel-review/references/setup.md) and
[commands](../plugins/dg/skills/channel-review/references/commands.md) for the
config contract and error templates.

The daemon runs separately from the loopback chat daemon. It fetches its secret
into memory. Per-environment operational state lives in the existing
`DG_HOME/daemon/daemon.db`, in `channel_review_state`; configuration, PID files,
and logs remain under `DG_HOME/channel-review`. The schema-only opener and
single migration list live in `@dg/common/daemon-db`; `ChatStore` retains
ownership of crypto/key initialization. Both processes can start independently.
The service imports its legacy `state.<env>.json` once in a transaction and
retains the source. Status only reads; malformed state reports an error.
See [ADR 0018](adr/0018-channel-review-state-in-daemon-db.md) for schema,
restart behavior, migration guarantees, and integration with the ADR branch.

Review operational state retains its prior plaintext boundary; the shared opener
does not read keys or credentials. For local inspection of the shared database:

```sql
SELECT env, status, count(*) FROM channel_review_requests GROUP BY env, status;
SELECT * FROM channel_review_current WHERE env = 'dev';
```

Build and deploy **both `dg-daemon` and `dg-skills`** with schema 12 support
before allowing the new service to migrate the shared file. Older daemon
binaries refuse schema 12 on restart. Never run an old JSON writer alongside
the database-backed service. Retained legacy JSON is a recovery source rather
than a live mirror. Pending/running requests become failed on restart with
CR-205; the service does not reconstruct or rerun the queue.

`resolveSecrets` (`pkg/channel-review/src/credentials.ts`) reads the
`channel-review/` entries at daemon start, and again before a relay auth retry,
through the `channel-review` grant. It builds an env-like map for the relay
connect and the sinks: unexpired store records first, then the process
environment. `status` reports each source and flags expired records.
`dg-skills channel-review connect` drives Chrome through `playwright-core`. It
imports the package lazily, so other commands never load it, and the compiled
build (`pkg/skills-cli/build.ts`) marks `chromium-bidi` external because the
CDP flow does not use it. The build also rewrites Playwright's two computed
metadata imports to static imports, embedding `package.json` and `browsers.json`.
Playwright is pinned; when upgrading it, run the compiled connect regression,
which removes the dependency's source before starting the binary.
Every review machine needs a signed-in runner and thrash installed in that
runner's skill roots. `status` reports each runner probe, including CR-206 for
missing thrash after executable and login checks pass.
Grok Build is available through `~agent grok`, `--runner grok`, or
`runner.default`; `~model` passes its model ID unchanged. Its probe uses
`grok models` for the resolved auth source and `grok inspect --json` for an
enabled, invocable `/thrash`. These utilities do not generate model output.
The review runs headlessly with `--always-approve`. `runner.fallback: "grok"`
opts into Grok after a Claude limit.

AI usage-limit detection lives in `@dg/common` as `isAiUsageLimit`. Runners check
bounded tails from both stdout and stderr and return CR-207 for quota exhaustion,
including Claude's exit-zero limit responses. Review jobs retry a limited Claude
run once with `runner.fallback` after a successful probe. Fallback is off by
default: set `"fallback": "codex"` to enable it. The
fallback keeps the remaining timeout, uses its own default model, writes a separate
log, and replies to the original request. Other AI tasks expose the same error and
notify the owner; write tasks are not automatically retried.

The [relay contract](../pkg/channel-review/README.md) lists every relay call.
A relay deploy can drop SSE streams and the relay's replay buffer. The daemon
reconnects and may report a gap; commands posted during the deploy cannot
replay. Test first on dev in a test chat. Emoji capture also needs relay
reaction events and a human reaction on the capture prompt.

Run `bun test` and `bun run lint` in `pkg/skills-test`, including release trigger
and binary distribution contracts. Run `bun run test:all` at the root. Refresh
`bun.lock` with `bun install`, then verify `bun install --frozen-lockfile`.

The live `/dg:channel-review` bootstrap check in Claude Code is human-only and
remains pending. Check that the installed skill runs the compiled binary and
prints status JSON. Exit 0 requires reachable secret, chat, and reactions while
stopped; named errors with remedies also pass the bootstrap check. Record the
exact Claude scratch write rule and WSL restart result during live validation.

### Review attribution

Review tasks pass `origin: "daemon"` explicitly to the runner, including Teams requests
and readiness events. Other direct runner callers default to `manual`. The runner puts
fresh JSON in `THRASH_EXECUTION_CONTEXT`: `origin`, `backend`, optional `model`, and
`modelSource` (`requested`, `configured`, or `default`). These model fields describe the orchestrator,
not the reviewer. Child spawning strips inherited `THRASH_*` variables before applying
this attempt's context. Fallback rebuilds it for the successful backend with no stale
Claude model. Current-job status includes `execution`; local logs identify origin and
orchestrator model evidence. The shared database snapshot retains this current-job metadata.

The thrash helper owns the compiled review contract. It reads the
`THRASH_EXECUTION_CONTEXT` JSON above and needs a helper version that understands
`origin` and `modelSource`; older helpers ignore the variable. The skill's
`references/attribution.md` describes the helper `attribute` command.
Each successful chunk gets its own backend/model evidence. Native worker configuration,
requested aliases, resolved runtime IDs, CLI defaults, and unknown models stay distinct.
A proxy persona does not select a model. Distinct worker backends/models remain in the
compiled artifact and public label; the parent model is not substituted.

Public bodies, previews, tallies, and compile/post JSON show `Automatic (daemon)`,
`Automatic (CI)` (origin `action`, set by a GitHub Actions or GitLab CI runner) or `Manual (CLI)` and reviewer models. No private runtime fields belong in public metadata.
The helper freezes origin in a unique diff plan and does not trust review contents for
attribution. It preserves verdicts, dedupe, partial coverage, gates, and provider fallback.
Ship the helper and the skill instructions together with the runner change; old
helpers do not consume the new context.
