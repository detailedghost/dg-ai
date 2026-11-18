---
feature: "Opt-in hooks area"
feature_snake_case: opt_in_hooks
date: "2026-10-29"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "hooks-manifest-runner"
    agents:
      primary: dg:js
      qa: [dg:qa-code, dg:qa-perf]
    depends_on: []
    files: ["pkg/skills-cli/src/hooks/manifest.ts","pkg/skills-cli/src/hooks/types.ts","pkg/skills-cli/src/hooks/run.ts","pkg/skills-cli/src/hooks/io.ts","pkg/skills-cli/src/hooks/config.ts","pkg/skills-cli/src/hooks/defs/**","pkg/skills-cli/src/hooks/adapters/**","pkg/skills-cli/src/hooks/data/**","pkg/skills-cli/src/commands/hooks.ts","pkg/skills-cli/src/index.ts","pkg/common/src/node/dg-config.ts","pkg/common/src/node/index.ts","pkg/common/__tests__/dg-config.spec.ts","pkg/skills-cli/__tests__/hooks/**"]
  - id: 2
    name: "hooks-settings-writers"
    agents:
      primary: dg:js
      qa: [dg:qa-code, dg:security]
    depends_on: [1]
    files: ["pkg/skills-cli/src/hooks/settings/**","pkg/skills-cli/src/hooks/cli.ts","pkg/skills-cli/src/commands/hooks.ts","pkg/skills-cli/__tests__/hooks-settings/**"]
  - id: 3
    name: "hooks-skill-docs-adr"
    agents:
      primary: dg:lore
      qa: [dg:qa-code]
    depends_on: [2]
    files: ["plugins/dg/skills/hooks/**","plugins/dg/skills/hook-comment-disable/SKILL.md","plugins/dg/skills/README.md","pkg/skills-cli/src/hooks/doctor.ts","pkg/skills-cli/src/doctor/registry.ts","pkg/skills-test/__tests__/hooks-skill.spec.ts","docs/hooks.md","docs/adr/0026-opt-in-hooks.md","docs/adr/toc.md","README.md"]
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# Opt-in hooks area

## Purpose
Give dg its own hooks area: a manifest of structured hook definitions, each a TypeScript module run on the pinned runtime as its own lazy chunk, all off by default. `dg-skills hooks list|status|enable <id>|disable <id>` writes and removes entries in each tool's own settings (Claude Code, Codex, OpenCode) and never installs an always-on dispatcher. Hook settings such as the spelling locale live in dg's config.json.

## Scope
### Included
- Manifest and types; hooks: spelling (en-US default or en-GB), format, pr-prose, pr-confirm, spec-plan-lint, daily-prune; internal Codex apply_patch adapter
- `dg-skills hooks run <id>` fast path that skips commander; per-hook latency budget test
- Settings writers for Claude (~/.claude/settings.json), Codex (~/.codex/hooks.json), OpenCode (generated plugin file + opencode.json plugin list) with a command marker so dg edits only its own entries
- hooks skill, retargeted hook-comment-disable skill, docs, ADR 0026
### Excluded
- ai-attention, nodeterm and the personal Codex command-rewrite hook (stay local or are being removed)
- Other spelling locales than en-US and en-GB (file later)
- Any hooks.json inside the plugin directory

### Slice 1 — hooks-manifest-runner

#### Engineering
- [ ] types.ts: HookEvent = 'PreToolUse' | 'PostToolUse' | 'SessionStart'; HookRuntime = 'claude' | 'codex' | 'opencode'; HookDefinition { id, summary, event, matcher?, runtimes, settings?: Record<string, {values: string[], default: string}>, load: () => Promise<{ default: HookHandler }> }; HookInput { tool_name, tool_input, tool_response?, cwd, session_id }; HookResult { exitCode, stdout?, stderr?, additionalContext? }
- [ ] manifest.ts: HOOKS array with the six definitions; `load` is a dynamic import so each hook is its own chunk
- [ ] run.ts: runHook(id, stdin, env) parses the JSON once, applies the Codex apply_patch adapter when tool_name is apply_patch, calls the handler, writes stdout/stderr and exits with the handler code
- [ ] main.ts fast path: argv[0]==='hooks' && argv[1]==='run' imports ./hooks/run before commander
- [ ] defs/spelling.ts: ports american-english-hook.sh; word pairs in data/spelling-pairs.txt; locale from config hooks.spelling.locale (en-US default); en-GB reads the table in the other direction; bypass marker <scratch>/hooks/comment-disabled.<session>
- [ ] defs/format.ts: ports format-hook.sh formatter chain with skip-not-pass and once-per-session additionalContext
- [ ] defs/pr-prose.ts: ports pr-prose-hook.sh plus both awk scripts (body extraction and PR-shaped heuristics); Vale stays an optional extra: when `vale` is absent the hook prints one install hint and the built-in heuristics still run
- [ ] defs/pr-confirm.ts: permissionDecision ask before `gh pr create` or `glab mr create` only
- [ ] defs/spec-plan-lint.ts: when the edited path matches .agents/spec/*/plan.md run selfCommand(['spec','validate',file]) and lint-waves; exit 2 on failure
- [ ] defs/daily-prune.ts: ports daily-prune.ts (scratch/state TTL, worktree prune through selfCommand(['worktree','prune']), .agents ignored files) running once a day in the background from SessionStart; SKIP keeps pw/states, pw/sessions, pw/sock, pw/log
- [ ] dg-config.ts: readDgConfig()/writeDgConfig(patch) on <configDir>/config.json with atomic rename
- [ ] hook-latency.spec.ts: for each hook, run [bun, dg.js, dg-skills, hooks, run, <id>] with a non-matching input 7 times; median under 40 ms times DG_BUDGET_SCALE

#### Testing Criteria
##### Contracts
- [ ] Contract: runHook('spelling') exits 2 and lists `colour -> color` for an Edit new_string containing colour under en-US; under en-GB the same input passes and `color` is flagged
- [ ] Contract: runHook('pr-confirm') prints the ask decision JSON for `gh pr create …` and prints nothing for `gh pr view`
- [ ] Contract: runHook('spec-plan-lint') is a no-op for a file outside .agents/spec and exits 2 with the validate output for a plan.md that fails validate
- [ ] Contract: runHook('format') with no formatter installed exits 0 and emits additionalContext once per session
- [ ] Contract: the apply_patch adapter turns one Codex patch with two files into two Edit-shaped inputs
- [ ] pr-prose tests ported from pr-prose.test.ts (heredoc body, --body-file, bullets before prose, 40-word sentence, template leftovers, terse exemption)
- [ ] daily-prune tests ported from daily-prune.test.ts
- [ ] hook-latency.spec.ts under budget for all six hooks

#### Acceptance Criteria
- [ ] Given the bundle, when `echo '{"tool_name":"Read"}' | dg-skills hooks run spelling` runs, then it exits 0 in under 40 ms median
- [ ] Given config hooks.spelling.locale = en-GB, when a file with `color` is written, then the hook blocks with `color -> colour`

### Slice 2 — hooks-settings-writers

#### Engineering
- [ ] settings/marker.ts: ownedCommand(id) = `<launcher> hooks run <id>`; isOwned(command) matches /(^|[\/\\ ])dg-skills(\.cmd)? hooks run [a-z-]+$/; dg never touches a hook object whose command does not match
- [ ] settings/claude.ts and settings/codex.ts: readSettings -> add or remove the owned hook object under hooks[event] in a group keyed by matcher; create the group when absent; delete a group only when it ends empty; write with 2-space JSON through a temp file and rename; re-read before write and retry up to 3 times when the file changed since the first read (optimistic lock); refuse with exit 1 when the file is not valid JSON
- [ ] settings/opencode.ts: generates <opencode config>/plugins/dg-hooks.js (header line `generated by dg-skills hooks; do not edit`) mapping PreToolUse/PostToolUse to tool.execute.before/after that spawn the owned command with Claude-shaped JSON on stdin; adds or removes `dg-hooks` in opencode.json `plugin`; SessionStart hooks are skipped for opencode
- [ ] cli.ts: `hooks list` (id, summary, runtimes), `hooks status [--json]` (per runtime: enabled ids, settings file path, config values), `hooks enable <id> [--runtime r]... [--set key=value]`, `hooks disable <id|--all> [--runtime r]`, `hooks set <id> <key> <value>`; default runtimes are the ones whose settings dir exists
- [ ] disable --all is the uninstall path: removes every owned entry in every runtime, removes dg-hooks.js and the opencode plugin entry, leaves config.json
- [ ] Every write prints `<runtime>: enabled <id> (takes effect in new sessions)`

#### Testing Criteria
##### Contracts
- [ ] Contract: enable spelling on a settings.json with existing user hooks adds exactly one object under PostToolUse with matcher Edit|Write|MultiEdit and leaves every other byte of meaning intact (deep-equal of all non-dg entries)
- [ ] Contract: disable spelling removes only the owned object and removes the group when it is empty
- [ ] Contract: enable twice is idempotent (one object)
- [ ] Contract: a settings.json changed between read and write is re-read and the write still contains the concurrent change
- [ ] Contract: invalid JSON in settings.json aborts with exit 1 and no write
- [ ] Contract: opencode enable writes dg-hooks.js with the enabled ids and adds `dg-hooks` once to opencode.json plugin
- [ ] Contract: `hooks set spelling locale fr` fails listing en-US, en-GB
- [ ] Contract: disable --all leaves no command matching the owned marker in any runtime file

#### Acceptance Criteria
- [ ] Given a fresh ~/.claude/settings.json, when `dg-skills hooks enable spelling pr-confirm` runs, then `hooks status` lists both under claude and a new Claude session runs them
- [ ] Given Codex and OpenCode present, when `hooks enable format` runs, then ~/.codex/hooks.json and the opencode plugin both carry it

### Slice 3 — hooks-skill-docs-adr

#### Engineering
- [ ] plugins/dg/skills/hooks/SKILL.md (<= 60 lines): what each hook does in one line, enable/disable/status commands, the ask-first rule before enabling anything, link to docs/hooks.md
- [ ] hook-comment-disable/SKILL.md retargeted to the spelling hook and `dg-skills hooks`; marker path unchanged
- [ ] hooks/doctor.ts: hooksChecks = [skillFilesCheck(['hooks']), settings readable per runtime, stale owned entries (command path no longer resolves), allowRuleCheck('hooks')]
- [ ] docs/hooks.md: manifest table, per-runtime file paths, marker rule, concurrency rule, uninstall, latency budget
- [ ] ADR 0026 opt-in hooks that write tool settings; toc entry

#### Testing Criteria
##### Contracts
- [ ] Contract: hooks-skill.spec.ts asserts SKILL.md lists every manifest id and tells the agent to ask before enable
- [ ] doctor-coverage.spec.ts passes for hooks
- [ ] markdownlint and vale pass

#### Acceptance Criteria
- [ ] Given /dg:hooks, when the user asks what is on, then the agent runs `dg-skills hooks status` and reports per runtime

## Slice Summaries

## Agent Notes

- (slice 3, orchestrator) Build to the literal forms in pkg/skills-test/__tests__/hooks-skill.spec.ts: each manifest id in backticks in SKILL.md and docs/hooks.md, the line 'If a step fails, run ~/.dg/bin/dg-skills doctor hooks.', an ask-first sentence (ask before enabling), a link to docs/hooks.md, and hook-comment-disable updated to drop american-english-hook.sh and name spelling and dg-skills hooks with its marker command unchanged.
- (slice 3, orchestrator) Add hooks/doctor.ts with hooksChecks (skill files, allow rule, and per-runtime settings readability) and register it in the doctor registry so doctor-coverage passes. Run markdownlint and vale on the new docs when installed; skip with a note when not.

- (slice 2, orchestrator) Slice 2 is committed. opencode: dg-hooks.js is a standalone file in <opencode config dir>/plugins/, which opencode loads by itself. Nothing is added to the opencode.json plugin array, because a bare `dg-hooks` name resolves to an unclaimed npm package (supply-chain risk). Every enable and disable removes a legacy bare `dg-hooks` entry and keeps other entries. This replaces any spec text that adds `dg-hooks` to plugin.
- (slice 2, orchestrator) The OWNED marker in marker.ts is fully anchored and replaces the regex shown in Code Structure: BIN = dg-skills(?:\.cmd|\.exe)?, `^(?:"[^"]*[\\/]BIN"|'[^']*[\\/]BIN'|(?:[^\s;&|`$<>()"']*[\\/])?BIN) hooks run ([a-z][a-z-]*)---
feature: "Opt-in hooks area"
feature_snake_case: opt_in_hooks
date: "2026-10-29"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "hooks-manifest-runner"
    agents:
      primary: dg:js
      qa: [dg:qa-code, dg:qa-perf]
    depends_on: []
    files: ["pkg/skills-cli/src/hooks/manifest.ts","pkg/skills-cli/src/hooks/types.ts","pkg/skills-cli/src/hooks/run.ts","pkg/skills-cli/src/hooks/io.ts","pkg/skills-cli/src/hooks/config.ts","pkg/skills-cli/src/hooks/defs/**","pkg/skills-cli/src/hooks/adapters/**","pkg/skills-cli/src/hooks/data/**","pkg/skills-cli/src/commands/hooks.ts","pkg/skills-cli/src/index.ts","pkg/common/src/node/dg-config.ts","pkg/common/src/node/index.ts","pkg/common/__tests__/dg-config.spec.ts","pkg/skills-cli/__tests__/hooks/**"]
  - id: 2
    name: "hooks-settings-writers"
    agents:
      primary: dg:js
      qa: [dg:qa-code, dg:security]
    depends_on: [1]
    files: ["pkg/skills-cli/src/hooks/settings/**","pkg/skills-cli/src/hooks/cli.ts","pkg/skills-cli/src/commands/hooks.ts","pkg/skills-cli/__tests__/hooks-settings/**"]
  - id: 3
    name: "hooks-skill-docs-adr"
    agents:
      primary: dg:lore
      qa: [dg:qa-code]
    depends_on: [2]
    files: ["plugins/dg/skills/hooks/**","plugins/dg/skills/hook-comment-disable/SKILL.md","plugins/dg/skills/README.md","pkg/skills-cli/src/hooks/doctor.ts","pkg/skills-cli/src/doctor/registry.ts","pkg/skills-test/__tests__/hooks-skill.spec.ts","docs/hooks.md","docs/adr/0026-opt-in-hooks.md","docs/adr/toc.md","README.md"]
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# Opt-in hooks area

## Purpose
Give dg its own hooks area: a manifest of structured hook definitions, each a TypeScript module run on the pinned runtime as its own lazy chunk, all off by default. `dg-skills hooks list|status|enable <id>|disable <id>` writes and removes entries in each tool's own settings (Claude Code, Codex, OpenCode) and never installs an always-on dispatcher. Hook settings such as the spelling locale live in dg's config.json.

## Scope
### Included
- Manifest and types; hooks: spelling (en-US default or en-GB), format, pr-prose, pr-confirm, spec-plan-lint, daily-prune; internal Codex apply_patch adapter
- `dg-skills hooks run <id>` fast path that skips commander; per-hook latency budget test
- Settings writers for Claude (~/.claude/settings.json), Codex (~/.codex/hooks.json), OpenCode (generated plugin file + opencode.json plugin list) with a command marker so dg edits only its own entries
- hooks skill, retargeted hook-comment-disable skill, docs, ADR 0026
### Excluded
- ai-attention, nodeterm and the personal Codex command-rewrite hook (stay local or are being removed)
- Other spelling locales than en-US and en-GB (file later)
- Any hooks.json inside the plugin directory

### Slice 1 — hooks-manifest-runner

#### Engineering
- [ ] types.ts: HookEvent = 'PreToolUse' | 'PostToolUse' | 'SessionStart'; HookRuntime = 'claude' | 'codex' | 'opencode'; HookDefinition { id, summary, event, matcher?, runtimes, settings?: Record<string, {values: string[], default: string}>, load: () => Promise<{ default: HookHandler }> }; HookInput { tool_name, tool_input, tool_response?, cwd, session_id }; HookResult { exitCode, stdout?, stderr?, additionalContext? }
- [ ] manifest.ts: HOOKS array with the six definitions; `load` is a dynamic import so each hook is its own chunk
- [ ] run.ts: runHook(id, stdin, env) parses the JSON once, applies the Codex apply_patch adapter when tool_name is apply_patch, calls the handler, writes stdout/stderr and exits with the handler code
- [ ] main.ts fast path: argv[0]==='hooks' && argv[1]==='run' imports ./hooks/run before commander
- [ ] defs/spelling.ts: ports american-english-hook.sh; word pairs in data/spelling-pairs.txt; locale from config hooks.spelling.locale (en-US default); en-GB reads the table in the other direction; bypass marker <scratch>/hooks/comment-disabled.<session>
- [ ] defs/format.ts: ports format-hook.sh formatter chain with skip-not-pass and once-per-session additionalContext
- [ ] defs/pr-prose.ts: ports pr-prose-hook.sh plus both awk scripts (body extraction and PR-shaped heuristics); Vale stays an optional extra: when `vale` is absent the hook prints one install hint and the built-in heuristics still run
- [ ] defs/pr-confirm.ts: permissionDecision ask before `gh pr create` or `glab mr create` only
- [ ] defs/spec-plan-lint.ts: when the edited path matches .agents/spec/*/plan.md run selfCommand(['spec','validate',file]) and lint-waves; exit 2 on failure
- [ ] defs/daily-prune.ts: ports daily-prune.ts (scratch/state TTL, worktree prune through selfCommand(['worktree','prune']), .agents ignored files) running once a day in the background from SessionStart; SKIP keeps pw/states, pw/sessions, pw/sock, pw/log
- [ ] dg-config.ts: readDgConfig()/writeDgConfig(patch) on <configDir>/config.json with atomic rename
- [ ] hook-latency.spec.ts: for each hook, run [bun, dg.js, dg-skills, hooks, run, <id>] with a non-matching input 7 times; median under 40 ms times DG_BUDGET_SCALE

#### Testing Criteria
##### Contracts
- [ ] Contract: runHook('spelling') exits 2 and lists `colour -> color` for an Edit new_string containing colour under en-US; under en-GB the same input passes and `color` is flagged
- [ ] Contract: runHook('pr-confirm') prints the ask decision JSON for `gh pr create …` and prints nothing for `gh pr view`
- [ ] Contract: runHook('spec-plan-lint') is a no-op for a file outside .agents/spec and exits 2 with the validate output for a plan.md that fails validate
- [ ] Contract: runHook('format') with no formatter installed exits 0 and emits additionalContext once per session
- [ ] Contract: the apply_patch adapter turns one Codex patch with two files into two Edit-shaped inputs
- [ ] pr-prose tests ported from pr-prose.test.ts (heredoc body, --body-file, bullets before prose, 40-word sentence, template leftovers, terse exemption)
- [ ] daily-prune tests ported from daily-prune.test.ts
- [ ] hook-latency.spec.ts under budget for all six hooks

#### Acceptance Criteria
- [ ] Given the bundle, when `echo '{"tool_name":"Read"}' | dg-skills hooks run spelling` runs, then it exits 0 in under 40 ms median
- [ ] Given config hooks.spelling.locale = en-GB, when a file with `color` is written, then the hook blocks with `color -> colour`

### Slice 2 — hooks-settings-writers

#### Engineering
- [ ] settings/marker.ts: ownedCommand(id) = `<launcher> hooks run <id>`; isOwned(command) matches /(^|[\/\\ ])dg-skills(\.cmd)? hooks run [a-z-]+$/; dg never touches a hook object whose command does not match
- [ ] settings/claude.ts and settings/codex.ts: readSettings -> add or remove the owned hook object under hooks[event] in a group keyed by matcher; create the group when absent; delete a group only when it ends empty; write with 2-space JSON through a temp file and rename; re-read before write and retry up to 3 times when the file changed since the first read (optimistic lock); refuse with exit 1 when the file is not valid JSON
- [ ] settings/opencode.ts: generates <opencode config>/plugins/dg-hooks.js (header line `generated by dg-skills hooks; do not edit`) mapping PreToolUse/PostToolUse to tool.execute.before/after that spawn the owned command with Claude-shaped JSON on stdin; adds or removes `dg-hooks` in opencode.json `plugin`; SessionStart hooks are skipped for opencode
- [ ] cli.ts: `hooks list` (id, summary, runtimes), `hooks status [--json]` (per runtime: enabled ids, settings file path, config values), `hooks enable <id> [--runtime r]... [--set key=value]`, `hooks disable <id|--all> [--runtime r]`, `hooks set <id> <key> <value>`; default runtimes are the ones whose settings dir exists
- [ ] disable --all is the uninstall path: removes every owned entry in every runtime, removes dg-hooks.js and the opencode plugin entry, leaves config.json
- [ ] Every write prints `<runtime>: enabled <id> (takes effect in new sessions)`

#### Testing Criteria
##### Contracts
- [ ] Contract: enable spelling on a settings.json with existing user hooks adds exactly one object under PostToolUse with matcher Edit|Write|MultiEdit and leaves every other byte of meaning intact (deep-equal of all non-dg entries)
- [ ] Contract: disable spelling removes only the owned object and removes the group when it is empty
- [ ] Contract: enable twice is idempotent (one object)
- [ ] Contract: a settings.json changed between read and write is re-read and the write still contains the concurrent change
- [ ] Contract: invalid JSON in settings.json aborts with exit 1 and no write
- [ ] Contract: opencode enable writes dg-hooks.js with the enabled ids and adds `dg-hooks` once to opencode.json plugin
- [ ] Contract: `hooks set spelling locale fr` fails listing en-US, en-GB
- [ ] Contract: disable --all leaves no command matching the owned marker in any runtime file

#### Acceptance Criteria
- [ ] Given a fresh ~/.claude/settings.json, when `dg-skills hooks enable spelling pr-confirm` runs, then `hooks status` lists both under claude and a new Claude session runs them
- [ ] Given Codex and OpenCode present, when `hooks enable format` runs, then ~/.codex/hooks.json and the opencode plugin both carry it

### Slice 3 — hooks-skill-docs-adr

#### Engineering
- [ ] plugins/dg/skills/hooks/SKILL.md (<= 60 lines): what each hook does in one line, enable/disable/status commands, the ask-first rule before enabling anything, link to docs/hooks.md
- [ ] hook-comment-disable/SKILL.md retargeted to the spelling hook and `dg-skills hooks`; marker path unchanged
- [ ] hooks/doctor.ts: hooksChecks = [skillFilesCheck(['hooks']), settings readable per runtime, stale owned entries (command path no longer resolves), allowRuleCheck('hooks')]
- [ ] docs/hooks.md: manifest table, per-runtime file paths, marker rule, concurrency rule, uninstall, latency budget
- [ ] ADR 0026 opt-in hooks that write tool settings; toc entry

#### Testing Criteria
##### Contracts
- [ ] Contract: hooks-skill.spec.ts asserts SKILL.md lists every manifest id and tells the agent to ask before enable
- [ ] doctor-coverage.spec.ts passes for hooks
- [ ] markdownlint and vale pass

#### Acceptance Criteria
- [ ] Given /dg:hooks, when the user asks what is on, then the agent runs `dg-skills hooks status` and reports per runtime

## Slice Summaries

. ownedCommand quotes a launcher with white space and throws on characters outside [\w.:/\\ @+~-]. Compound commands are not owned.
- (slice 2, orchestrator) opencode honors XDG_CONFIG_HOME only when absolute; JSONC and opencode.jsonc are unsupported and exit 1 naming the file; a UTF-8 BOM is stripped for all JSON settings files. A launcher must be absolute; a relative DG_HOME exits 2.
- (slice 2, orchestrator) Settings writes follow a symlink to its target, keep the existing mode (new files 0600), and a no-op change writes nothing. Malformed entries on unrelated events stay untouched; a non-array value on the event being enabled exits 1. Multi-runtime enable validates all files first; on a later write failure it lists changed runtimes on stderr, writes no --set values and exits 1. `hooks status --json` adds an optional per-runtime `error` field and exits 1 when any runtime errored.

- (slice 2, orchestrator) Seams as the Red tests assume: hooks/cli main(argv, io) gains io.home and io.launcher; ownedCommand(launcher, id); settings/json-file.ts exports async updateJsonFile(file, mutate, seams?: { afterRead }). enable takes several ids and a repeatable --runtime flag.
- (slice 2, orchestrator) `hooks status --json` prints { runtimes: { <runtime>: { enabled: string[], settingsFile: string } } }.
- (slice 2, orchestrator) Codex ~/.codex/hooks.json uses the same { hooks: { Event: [{ matcher?, hooks: [{ type, command }] }] } } shape as Claude settings.json (checked against a real file).
- (slice 2, orchestrator) `hooks set <id> <key> <bad>` exits 2 and prints the allowed values on stderr, with no config write. `enable --set key=value` writes config.json for the id being enabled.
- (slice 2, orchestrator) When the optimistic lock fails 3 times, the command exits 1 with `<file> kept changing; try again` on stderr and writes nothing. Add one test.
- (slice 2, orchestrator) When opencode loses its last enabled id on any disable, delete dg-hooks.js and remove `dg-hooks` from plugin, keeping other plugin entries.
- (slice 2, orchestrator) A live Claude session check stays out of the automated tests; status listing and file contents cover it.

- (slice 1, orchestrator) Correction decisions: DAILY_PRUNE_CODE_ROOT is opt-in, with no ~/code default for .agents pruning. spec-plan-lint exits 2 on any non-zero status, including 127. The Vale hint goes out as additionalContext once per session. The SKIP list skips only hooks/daily-prune.stamp, so old hook markers get reaped. No config lock. spawnCapture gets a 30 s timeout and a 1 MiB cap per stream. The command matcher covers sudo, env, command, exec, and bash -c or sh -c wrappers.

- (slice 1, orchestrator) runHook(id, stdin, env, seams?) returns Promise<number>. seams is optional with real defaults: { run(argv, {cwd}) -> Promise<{status, stdout, stderr}>, which(bin) -> string|undefined, spawnDetached(argv), stdout(text), stderr(text) }. The registerRawCommand action calls process.exit with the result.
- (slice 1, orchestrator) Config is <stateDir>/config.json shaped { hooks: { spelling: { locale } } }. stateDir comes from resolveDgPaths with the env passed to runHook (DG_HOME or ~/.dg). Scratch and state come from AI_SCRATCH_DIR and AI_STATE_DIR in that same env.
- (slice 1, orchestrator) spelling on Write scans tool_input.content in full; on Edit it scans new_string. It does not need git.
- (slice 1, orchestrator) spec-plan-lint runs both `dg-skills spec validate <file>` and `dg-skills spec lint-waves <file>` through the run seam, always both. Any non-zero status exits 2 and relays the captured stdout and stderr.
- (slice 1, orchestrator) defs/daily-prune.ts keeps the legacy exports listed by the Red tests; PruneOptions gains the run seam and pruneWorktrees becomes async. The stamp is <AI_STATE_DIR>/hooks/daily-prune.stamp, and SessionStart calls spawnDetached at most once per day. Keep both calls: selfCommand(["worktree","prune"]) with cwd at the main repo, and selfCommand(["worktree","remove", branch]) per merged clean branch.
- (slice 1, orchestrator) The shipped SKIP list is hooks, adhoc, bg/*.pid, pw/states, pw/sessions, pw/sock and pw/log only. The personal entries (subagents-current.json, ghattach-chromium, test-live/state, skill-cleanup/backups, hook-comment-disabled.*) are dropped from the public plugin.
- (slice 1, orchestrator) pr-prose prints the Vale install hint at most once per hook run, on stderr, only when which("vale") is undefined; heuristics always run.
- (slice 1, orchestrator) adapters/codex-apply-patch.ts exports applyPatchInputs(event: HookInput): HookInput[] with the Edit-shaped result described by the Red tests.
- (slice 1, orchestrator) hook-latency.spec.ts and the 40 ms budget move to PR E; leave that checkbox open.
- (slice 1, orchestrator) The Green stage adds tests for dg-config.ts (read, write with atomic rename, unknown keys kept) and for the commands/hooks.ts registration (hooks run <id> reaches runHook). The real formatter chain stays untested; only the injected which seam is used.

- (build base, orchestrator) The user moved the install work (E, F, B, D) to the end of the chain. PR C builds now from origin/master (v1.27.0) on feat/opt_in_hooks, independent of B and D; the `Chain position` section is superseded. E, F, B and D rebase onto it later. No change to commands/install.ts in this PR.
- (build base, orchestrator) master has no pkg/skills-cli/src/main.ts and no main(argv). Register `hooks` in pkg/skills-cli/src/index.ts through registerRawCommand (pkg/skills-cli/src/utils/legacy-command.ts) in a new commands/hooks.ts, whose run does `(await import("../hooks/cli")).main(argv)` so the hooks modules load only when `hooks` runs (this stands in for registerLazyRaw). `hooks run <id>` is a subcommand of that same raw command; the pre-commander fast path is deferred to E, which adds main.ts and rebases it in.
- (build base, orchestrator) pkg/launcher does not exist on master, and the compiled master binary starts in about 260-390 ms because index.ts imports every command statically. hook-latency.spec.ts and the 40 ms budget are deferred to E (it adds pkg/launcher and the fast path). In this PR, test handlers in-process through runHook with injected stdin and env; do not add a wall-clock budget test.
- (build base, orchestrator) exitAfterDrain does not exist on master. runHook writes stdout and stderr and returns the exit code; the registerRawCommand action calls process.exit(code), the master convention. Hook output stays small (findings capped at 8).
- (build base, orchestrator) selfCommand is master pkg/common/src/node/self-command.ts, exported from @dg/common/node. spec-plan-lint and daily-prune call it as the spec says; tests inject the command runner instead of spawning the binary.
- (build base, orchestrator) dg config before F: dg-config.ts reads and writes join(resolveDgPaths().stateDir, "config.json") (DG_HOME or ~/.dg) from pkg/common/src/node/paths.ts. Do not use DgPaths.configPath; that is the daemon config at <stateDir>/daemon/config.json. F moves the file later.
- (build base, orchestrator) Launcher for owned commands before E and F: the installed binary <stateDir>/bin/dg-skills (dg-skills.exe on Windows), passed into the settings writers as a parameter so tests use a fixture path. The owned-marker regex also accepts `dg-skills.exe` next to `dg-skills` and `dg-skills.cmd`, so entries written now still match after the E shim change.
- (build base, orchestrator) ADR: master ends at 0024; keep this ADR as 0026 because E reserves 0025.
- (security, orchestrator) An EDR alert (T1068) fired on this machine. Tests never overwrite a running executable, never put new stub programs on PATH, and never run PowerShell security queries. Settings writes use a temp file plus atomic rename. Prefer injected seams (runner, env, home dir, launcher path) over real tool binaries; the format hook tests inject the formatter lookup instead of installing fake formatters.

## Issues Remediation
## Decisions

- [DECIDED] Every shipped hook is TypeScript run on the pinned runtime as its own lazy chunk; a per-hook latency budget test targets under 40 ms.
- [DECIDED] Ship: spelling (from american-english-hook.sh and american-english.txt, locale `en-US` default or `en-GB`, same pair table read either direction), format, pr-prose, pr-confirm (asks only before a PR or MR is created), spec-plan-lint, daily-prune. Other locales are out of scope.
- [DECIDED] Not shipped: ai-attention (stays in ~/scripts), nodeterm hooks, the personal Codex command-rewrite hook (the user is removing that tool). `codex-apply-patch-inputs` is an internal adapter inside the edit hooks, not a hook.
- [DECIDED] Off by default. `dg-skills hooks list|status|enable <id>|disable <id>` writes and removes entries in each tool's own settings: Claude `~/.claude/settings.json`, Codex `~/.codex/hooks.json`, OpenCode `~/.config/opencode/opencode.json` plus a generated plugin file. No always-on dispatcher. The plugin never ships `hooks/hooks.json`: Claude Code runs those for every session while the plugin is on and has no per-hook toggle.
- [DECIDED] Hook settings live in dg's `config.json` (`configPath` from PR F; `~/.dg/config.json` before F).
- Why the user's settings file and not the plugin: three runtimes, one source of truth per tool, and the enabled state is visible where the user already looks (`/hooks` in Claude Code).
- Alternatives compared: (1) a separate `dg-hooks` plugin in the marketplace: always on once installed, Claude only, no per-hook choice; (2) one dispatcher command on every event that reads an enabled list: pays a process start on every tool call even with nothing on; (3) chosen: a manifest plus per-tool settings writers, cost only for hooks the user turned on.
- [DECIDED] dg finds its own entries by the command string `<launcher> hooks run <id>`. Claude Code validates settings, so no custom JSON key is added.
- [DECIDED] `hooks run` is a fast path in the skills `main()` that skips commander.

## Code Structure

```text
pkg/skills-cli/src/hooks/
  types.ts                     HookEvent, HookRuntime, HookDefinition, HookInput, HookResult, HookHandler
  manifest.ts                  HOOKS: the six definitions with lazy `load`
  run.ts                       runHook(id, stdin, env): parse once, adapt apply_patch, call handler, emit
  io.ts                        readStdinJson(), emitAdditionalContext(), ask()
  config.ts                    hookSetting(id, key): config.json lookup with manifest defaults
  defs/spelling.ts             pair table either direction, token split, diff-based scan, bypass marker
  defs/format.ts               formatter chain, skip-not-pass, once-per-session additionalContext
  defs/pr-prose.ts             body extraction (heredoc, --body, --body-file), Vale optional, PR-shape heuristics
  defs/pr-confirm.ts           permissionDecision ask before a PR or MR is created
  defs/spec-plan-lint.ts       guard on .agents/spec/*/plan.md, then spec validate and lint-waves via selfCommand
  defs/daily-prune.ts          TTL prune of scratch and state, worktree prune via selfCommand, .agents ignored files
  adapters/codex-apply-patch.ts  one apply_patch event -> Edit-shaped inputs per file
  data/spelling-pairs.txt      british american pairs (from american-english.txt)
  data/markdownlint.default.json
  settings/marker.ts           ownedCommand(id), ownedId(command)
  settings/json-file.ts        read, modify, atomic write with optimistic retry
  settings/claude.ts           hooks[event][] groups by matcher in ~/.claude/settings.json
  settings/codex.ts            same shape in ~/.codex/hooks.json
  settings/opencode.ts         generated plugins/dg-hooks.js plus the opencode.json plugin list
  cli.ts                       list, status, enable, disable, set
  doctor.ts                    hooksChecks
pkg/skills-cli/src/commands/hooks.ts        registerLazyRaw "hooks"
pkg/skills-cli/src/main.ts                  fast path for `hooks run`
pkg/common/src/node/dg-config.ts            readDgConfig, writeDgConfig (atomic)
pkg/skills-cli/__tests__/hooks/**           per-hook unit tests, ported pr-prose and daily-prune suites
pkg/skills-cli/__tests__/hooks-settings/**  writer tests on fixture settings files
pkg/launcher/__tests__/hook-latency.spec.ts budget test through the shim on the no-match path
plugins/dg/skills/hooks/SKILL.md            about 50 lines
plugins/dg/skills/hook-comment-disable/SKILL.md  retargeted to the spelling hook
docs/hooks.md, docs/adr/0026-opt-in-hooks.md
```

## Code sample: manifest, one hook, enable, and the run path

`pkg/skills-cli/src/hooks/types.ts`:

```ts
export type HookEvent = "PreToolUse" | "PostToolUse" | "SessionStart";
export type HookRuntime = "claude" | "codex" | "opencode";

export interface HookInput {
 tool_name?: string;
 tool_input?: Record<string, unknown>;
 tool_response?: Record<string, unknown>;
 cwd?: string;
 session_id?: string;
}

export interface HookResult {
 exitCode: number;
 stdout?: string;
 stderr?: string;
}

export type HookHandler = (input: HookInput, ctx: HookContext) => Promise<HookResult>;

export interface HookDefinition {
 id: string;
 summary: string;
 event: HookEvent;
 matcher?: string;
 runtimes: HookRuntime[];
 settings?: Record<string, { values: readonly string[]; default: string }>;
 load(): Promise<{ default: HookHandler }>;
}
```

`pkg/skills-cli/src/hooks/manifest.ts` (one entry in full, the rest on one line each):

```ts
export const HOOKS: readonly HookDefinition[] = [
 {
  id: "spelling",
  summary: "Reject spellings from the other English locale in text written by Edit or Write",
  event: "PostToolUse",
  matcher: "Edit|Write|MultiEdit",
  runtimes: ["claude", "codex", "opencode"],
  settings: { locale: { values: ["en-US", "en-GB"], default: "en-US" } },
  load: () => import("./defs/spelling"),
 },
 { id: "format", summary: "Format the edited file with the formatter installed for its type", event: "PostToolUse", matcher: "Edit|Write|MultiEdit", runtimes: ["claude", "codex", "opencode"], load: () => import("./defs/format") },
 { id: "pr-prose", summary: "Block a PR or MR body that does not read as plain English", event: "PreToolUse", matcher: "Bash", runtimes: ["claude", "codex", "opencode"], load: () => import("./defs/pr-prose") },
 { id: "pr-confirm", summary: "Ask before a PR or MR is created", event: "PreToolUse", matcher: "Bash", runtimes: ["claude", "codex"], load: () => import("./defs/pr-confirm") },
 { id: "spec-plan-lint", summary: "Validate a spec plan.md after it is written", event: "PostToolUse", matcher: "Edit|Write|MultiEdit", runtimes: ["claude", "codex", "opencode"], load: () => import("./defs/spec-plan-lint") },
 { id: "daily-prune", summary: "Once a day, remove scratch and state past TTL and merged clean worktrees", event: "SessionStart", runtimes: ["claude", "codex"], load: () => import("./defs/daily-prune") },
];
```

`pkg/skills-cli/src/hooks/defs/spelling.ts` (core of the port):

```ts
import pairs from "../data/spelling-pairs.txt" with { type: "text" };

type Table = Map<string, string>;

export function tableFor(locale: "en-US" | "en-GB"): Table {
 const table: Table = new Map();
 for (const line of pairs.split("\n")) {
  const [british, american] = line.trim().split(/\s+/);
  if (!british || !american) continue;
  if (locale === "en-US") table.set(british, american);
  else table.set(american, british);
 }
 return table;
}

export function tokens(text: string): string[] {
 return text.split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map((t) => t.toLowerCase());
}

export function findings(newText: string, table: Table, max: number): string[] {
 const out: string[] = [];
 for (const [i, line] of newText.split("\n").entries()) {
  for (const token of tokens(line)) {
   const fix = table.get(token);
   if (fix) out.push(`${i + 1}: ${token} -> ${fix}`);
   if (out.length >= max) return out;
  }
 }
 return out;
}

const handler: HookHandler = async (input, ctx) => {
 if (!["Edit", "Write", "MultiEdit"].includes(input.tool_name ?? "")) return { exitCode: 0 };
 if (ctx.bypassed("comment-disabled")) return { exitCode: 0 };
 const newText = newlyWrittenText(input, ctx);
 if (!newText) return { exitCode: 0 };
 const locale = ctx.setting("spelling", "locale") as "en-US" | "en-GB";
 const found = findings(newText, tableFor(locale), ctx.number("HOOK_SPELLING_MAX_FINDINGS", 8));
 if (found.length === 0) return { exitCode: 0 };
 return { exitCode: 2, stderr: `spelling (${locale}): use the ${locale} form\n${found.join("\n")}` };
};

export default handler;
```

`pkg/skills-cli/src/main.ts` fast path, before commander (valid only because PR E makes `./commands` and `commander` dynamic imports in `main.ts`; a hoisted static import would make this path pay a full start):

```ts
if (argv[0] === "hooks" && argv[1] === "run" && argv[2]) {
 const { runHook } = await import("./hooks/run");
 return runHook(argv[2], process.stdin, process.env);
}
```

`pkg/skills-cli/src/hooks/settings/marker.ts`:

```ts
export const ownedCommand = (launcher: string, id: string): string => `${launcher} hooks run ${id}`;

const OWNED = /(?:^|[\\/ ])dg-skills(?:\.cmd)? hooks run ([a-z][a-z-]*)$/;

export function ownedId(command: string): string | undefined {
 return OWNED.exec(command.trim())?.[1];
}
```

`pkg/skills-cli/src/hooks/settings/claude.ts` (Codex reuses it on `~/.codex/hooks.json`):

```ts
type HookEntry = { type: "command"; command: string; statusMessage?: string };
type HookGroup = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Partial<Record<HookEvent, HookGroup[]>>; [key: string]: unknown };

export function withHook(settings: Settings, def: HookDefinition, launcher: string): Settings {
 const groups = settings.hooks?.[def.event] ?? [];
 if (groups.some((g) => g.hooks.some((h) => ownedId(h.command) === def.id))) return settings;
 const entry: HookEntry = { type: "command", command: ownedCommand(launcher, def.id) };
 const owned = groups.find((g) => (g.matcher ?? "") === (def.matcher ?? "") && g.hooks.some((h) => ownedId(h.command)));
 const next = owned
  ? groups.map((g) => (g === owned ? { ...g, hooks: [...g.hooks, entry] } : g))
  : [...groups, { ...(def.matcher ? { matcher: def.matcher } : {}), hooks: [entry] }];
 return { ...settings, hooks: { ...settings.hooks, [def.event]: next } };
}

export function withoutHook(settings: Settings, id: string): Settings {
 const hooks = { ...settings.hooks };
 for (const event of Object.keys(hooks) as HookEvent[]) {
  const groups = (hooks[event] ?? [])
   .map((g) => ({ ...g, hooks: g.hooks.filter((h) => ownedId(h.command) !== id) }))
   .filter((g) => g.hooks.length > 0);
  if (groups.length > 0) hooks[event] = groups;
  else delete hooks[event];
 }
 return { ...settings, hooks };
}
```

dg only touches hook objects whose command matches `ownedId`; a group is removed only when it ends empty; every other byte of meaning in the file is preserved (the test deep-compares all non-owned entries before and after).

`pkg/skills-cli/src/hooks/settings/json-file.ts`, the concurrent-edit rule:

```ts
export async function updateJsonFile<T>(path: string, change: (current: T) => T, attempts = 3): Promise<void> {
 for (let attempt = 1; attempt <= attempts; attempt++) {
  const before = readFileSync(path, "utf8");
  const next = `${JSON.stringify(change(JSON.parse(before) as T), null, 2)}\n`;
  if (readFileSync(path, "utf8") !== before) continue;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, path);
  return;
 }
 throw new Error(`${path} changed while dg-skills was editing it; run the command again`);
}
```

Invalid JSON throws before any write (exit 1, naming the file). Enable and disable print `<runtime>: enabled <id> (takes effect in new sessions)` because Claude Code reads hooks at session start.

Generated OpenCode plugin `~/.config/opencode/plugins/dg-hooks.js` (machine-written; its one header comment marks it as generated):

```js
const HOOKS = [{ id: "spelling", lifecycle: "after", tools: ["Edit", "Write"] }];
const LAUNCHER = "/home/u/.local/bin/dg-skills";
export default async ({ $, directory }) => {
 const run = (lifecycle) => async (input) => {
  for (const hook of HOOKS) {
   if (hook.lifecycle !== lifecycle || !hook.tools.includes(input.tool_name)) continue;
   const payload = JSON.stringify({ tool_name: input.tool_name, tool_input: input.tool_input, cwd: directory });
   const result = await $({ "timeout-ms": 10000 })`echo ${payload} | ${LAUNCHER} hooks run ${hook.id}`.nothrow();
   if (result.exitCode === 2) throw new Error(result.stderr.toString());
  }
 };
 return { "tool.execute.before": run("before"), "tool.execute.after": run("after") };
};
```

## Uninstall

`dg-skills hooks disable --all` removes every owned entry in every runtime, deletes `dg-hooks.js`, removes `dg-hooks` from the opencode plugin list and leaves `config.json` in place. Run it before removing dg. doctor warns about owned entries whose launcher path no longer exists.

## SKILL.md draft: plugins/dg/skills/hooks/SKILL.md

```markdown
---
name: hooks
description: List, enable and disable dg's optional hooks (spelling, format, pr-prose, pr-confirm, spec-plan-lint, daily-prune) in Claude Code, Codex and OpenCode settings. Everything is off until the user turns it on.
---

<generated first-run block, probe `hooks`>

If a step fails, run dg-skills doctor hooks.

| Hook | Event | Does |
| --- | --- | --- |
| spelling | PostToolUse Edit/Write | rejects the other locale's spellings (`en-US` default; `dg-skills hooks set spelling locale en-GB`) |
| format | PostToolUse Edit/Write | formats with the installed formatter; says when none is present |
| pr-prose | PreToolUse Bash | blocks a PR or MR body that does not read as plain English |
| pr-confirm | PreToolUse Bash | asks before a PR or MR is created |
| spec-plan-lint | PostToolUse Edit/Write | validates `.agents/spec/*/plan.md` |
| daily-prune | SessionStart | once a day removes scratch, state and merged worktrees past TTL |

Commands: `dg-skills hooks list`, `dg-skills hooks status`, `dg-skills hooks enable <id>... [--runtime claude|codex|opencode]`, `dg-skills hooks disable <id>|--all`, `dg-skills hooks set <id> <key> <value>`.

Rules: ask the user before you enable or disable anything (it edits their settings files). Changes apply to new sessions. Details in docs/hooks.md.
```

## Size, speed and token impact

Size: about 60 KB minified across six hook chunks plus 3 KB of data; nothing loads until a hook is on and fires. Speed: today's `sh + jq` hooks cost 9-31 ms measured; the TS path through the shim is bun 7 ms + dg.js + hook chunk, target under 40 ms median on the no-match path, enforced by `hook-latency.spec.ts` (`DG_BUDGET_SCALE` for CI). Tokens: SKILL.md about 50 lines; hook output is one line per finding, capped at 8.

## Risks and early signals

- 40 ms is tight through a shim; the fast path in `main()` avoids commander, and the budget test is the gate. Signal: the first latency run.
- The pr-prose port replaces two awk scripts and a 20 KB test suite; port the tests first.
- Settings rewrites: a tool that writes its settings at the same moment wins or loses by the optimistic retry; the error names the file and asks for a rerun.

## ADR draft: docs/adr/0026-opt-in-hooks.md

Status: Proposed. Context: hooks run on every tool call in three runtimes; plugin `hooks/hooks.json` is always on and has no per-hook toggle; shell hooks depended on a private `~/scripts` tree. Decision: dg ships a manifest of TypeScript hooks as lazy chunks and a `hooks` command that writes owned entries (`<launcher> hooks run <id>`) into each tool's own settings, off by default; settings live in dg's config.json. Consequences: good — per-hook choice, one implementation for three runtimes, zero cost when nothing is on; bad — edits to user settings files (optimistic locking, atomic writes), effect in the next session only; neutral — the plugin never ships `hooks/hooks.json`. Alternatives: a separate hooks plugin; an always-on dispatcher.

## Ratified decisions

- [DECIDED] The 40 ms latency budget is a hard failure locally; CI runs at 3x through `DG_BUDGET_SCALE`.
- [DECIDED] pr-prose keeps Vale as an optional extra (install hint when absent); the built-in heuristics always run.

## Chain position

Layer 5 on `chore/recommended-plugins` (which sits on the prune branch): all three touch `commands/install.ts`. Branch `feat/opt-in-hooks`. Independent of A apart from one registration row.
