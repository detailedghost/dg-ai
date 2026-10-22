---
name: skill-publish
description: Scaffold a Bun-TypeScript CLI into a stdio MCP server (analyze, manifest, generate), or bundle existing Claude Code skills into the dg plugin's canonical `plugins/dg/skills/` tree (plugin draft/validate/generate). Deterministic logic becomes MCP tools; instructions become MCP prompts.
---

# Skill: skill-publish

Two targets, one CLI: `~/.dg/bin/dg-skills skill-publish`.

1. **MCP server** — wraps a Bun-TS CLI's subcommands as MCP tools, for Cursor, Claude Desktop, Cline or any MCP-capable client. `analyze` → `manifest draft|validate` → `generate` produces a `server.ts` scaffold the author finishes and runs themselves (compiling, zipping or publishing it is outside this skill for now).
2. **Plugin target** — bundles one or more existing Claude Code skills into the dg plugin's own `plugins/dg/skills/` tree, inside a source checkout of this repo. `plugin draft|validate|generate` only ever adds or updates the named skills; it never touches the plugin's manifest, never deletes an unrelated skill, and never writes into an installed plugin cache.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills skill-publish --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor skill-publish.

## Usage

**Usage:** `/dg:skill-publish analyze <cli-path> | manifest draft <cli-path> [--out <dir>] | manifest validate <manifest-path> | generate <manifest-path> [--out-dir <dir>] [--repo-owner <owner>] | plugin draft <name> --skill <slug> [--skill <slug>...] [--out <dir>] | plugin validate <manifest-path> | plugin generate <manifest-path> [--root <path>]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--out <dir>` | none | manifest draft: directory for the drafted manifest JSON. plugin draft: directory for the drafted plugin manifest JSON. | manifest draft: the CLI's own directory. plugin draft: cwd. |
| `--out-dir <dir>` | none | generate: directory for the generated MCP server scaffold. | `<manifest-dir>/<name>-server` |
| `--repo-owner <owner>` | none | generate: bake a GitHub-pinned self-update subcommand into the generated server. | omitted (stub `update`) |
| `--skill <slug>` | none | plugin draft: a skill to add to the manifest; repeat the flag for more than one. | none (at least one required) |
| `--root <path>` | none | plugin generate: the checkout's `plugins/dg` to write into. | discovered by walking up from the cwd |

## MCP server target

| Phase | Command | What happens |
|---|---|---|
| 0 | `~/.dg/bin/dg-skills skill-publish analyze <cli-path>` | Detect Bun-TS vs non-TS; native-addon routing |
| 1 | `~/.dg/bin/dg-skills skill-publish manifest draft\|validate <path>` | Two-zoned JSON manifest; schema validation |
| 2 | `~/.dg/bin/dg-skills skill-publish generate <manifest-path> [--out-dir <dir>] [--repo-owner <owner>]` | Deterministic stdio MCP server codegen |

```sh
# Check if your CLI is publishable
~/.dg/bin/dg-skills skill-publish analyze ./my-tool.ts

# Draft a manifest (then review and edit it)
~/.dg/bin/dg-skills skill-publish manifest draft ./my-tool.ts

# Validate the manifest
~/.dg/bin/dg-skills skill-publish manifest validate my-tool.publish.json

# Generate the MCP server scaffold
~/.dg/bin/dg-skills skill-publish generate my-tool.publish.json
```

Shell scripts and Python CLIs must be ported to Bun-TS first (e.g. with `/dg:refactor`); `analyze` reports the mismatch instead of guessing a packaging strategy.

### Manifest zones

**Portable zone** — appears in the generated server: `name`, `version`, `description`, `recipe`, `tools[]`, `concurrency`, `stdout_size_cap`, `prerequisites`, `min_client_version`.

**Local zone** — stays in the authored manifest, stripped before codegen: `cli_path`, `connection_aliases`, `local_env_vars`, `author_notes`, `local_test_data`.

### Argument mapping

Each tool may set `arg_mapping` to control how MCP args become CLI argv (the tool name is always the first/subcommand arg). Without it, args pass through as `--key value` (flag-style CLIs only).

```json
"arg_mapping": [
  { "positional": "conn" },
  { "positional": "sql" },
  { "flag": "limit", "as": "--limit" },
  { "bool_flag": "write", "as": "--write" }
]
```

Use `positional` for bare args, `flag` for valued flags, `bool_flag` for presence-only flags. A flag-shaped **string** value (e.g. `--write`) is rejected at call time — it would otherwise be parsed as a flag by the wrapped CLI, defeating read-only/safety gates. Each call is bounded by a timeout (default 120 s) and byte-capped stdout, with the child killed on either overflow.

`--repo-owner <owner>` bakes a self-update subcommand into the generated server (HTTPS-only, GitHub-host-pinned, SHA256-verified before the atomic self-swap); omit it for a server that will only ever be distributed as a plain zip, which emits a stub `update` that tells the caller to repackage with an owner.

## Plugin target: bundle skills into the dg plugin

```sh
# Scaffold a manifest (repeat --skill to add more; a bare slug resolves under your home directory's .claude/skills/<slug>)
~/.dg/bin/dg-skills skill-publish plugin draft my-change --skill erd --skill ~/path/to/a/skill

# Validate (schema + each skill resolves to a SKILL.md)
~/.dg/bin/dg-skills skill-publish plugin validate my-change.plugin.json

# Ship: copy each named skill's directory into plugins/dg/skills/<slug>, with a secret-wall + human gate
~/.dg/bin/dg-skills skill-publish plugin generate my-change.plugin.json
```

- Run `generate` from inside a checkout of this repo (or pass `--root <path to its plugins/dg>`); it refuses when it cannot find `plugins/dg/.claude-plugin/plugin.json` above the working directory, and it refuses to write anywhere under an installed plugin cache (`~/.claude/plugins/cache/...`).
- `generate` is **additive**: it copies each resolved skill into `plugins/dg/skills/<slug>/`, replacing only that one skill's directory. It never deletes, moves, or rewrites a skill it was not asked to ship, and it never touches `.claude-plugin/plugin.json` or a marketplace manifest — the release process owns those.
- It refuses a self-move: if a named skill's source directory already resolves inside the destination `plugins/dg/skills/` tree, there is nothing to copy and the command errors instead of overwriting a directory with itself.
- The secret wall runs on every `generate`: real secrets (API-key-shaped strings, `gitleaks` when installed) hard-block; every home-rooted path and prompt-injection-shaped phrase is a warning only, shown at the human gate, never silently blocked.
- `version` is normally omitted from the plugin manifest — Claude Code auto-versions the installed plugin from the git commit SHA.

## CLI reference

```
~/.dg/bin/dg-skills skill-publish analyze <cli-path>
~/.dg/bin/dg-skills skill-publish manifest draft <cli-path> [--out <dir>]
~/.dg/bin/dg-skills skill-publish manifest validate <manifest-path>
~/.dg/bin/dg-skills skill-publish generate <manifest-path> [--out-dir <dir>] [--repo-owner <owner>]
~/.dg/bin/dg-skills skill-publish plugin draft <name> --skill <slug> [--skill <slug>...] [--out <dir>]
~/.dg/bin/dg-skills skill-publish plugin validate <manifest-path>
~/.dg/bin/dg-skills skill-publish plugin generate <manifest-path> [--root <path to plugins/dg>]
```
