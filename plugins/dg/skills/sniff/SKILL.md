---
name: sniff
description: Inventory everything an app needs before it can run — secrets, config, cloud permissions, backing services, ports, toolchain pins, registries — as a dense evidence-cited table with defects floated to the top. Use for "what does this app need", "what permissions does it want", "what do I have to provision", onboarding a repo, or pre-deploy readiness.
---

# /dg:sniff — Requirement Inventory

Answer one question about a repo you own: **what must be granted, provisioned, or installed before this runs?**

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills sniff --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.2/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor sniff stash.

## Usage

**Usage:** `/dg:sniff [path] [--gaps] [-o]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--gaps` | none | Print only the `⚠` rows, each with its full gap detail. | off (full table) |
| `-o` | none | Also write the table to `$(~/.dg/bin/dg-skills stash -a sniff <repo>.md)`. | off (terminal only) |

The CLI takes only the path. The skill applies `--gaps` and `-o` when it renders the table.

## When to use /dg:sniff vs neighbours

| Signal | Skill | Why |
|--------|-------|-----|
| "What does this need to run / what do I provision?" | `/dg:sniff` | Inventory of requirements |
| "How do I actually start it?" | `/run` | Launches the app |
| "How does it fit together?" | erd | Architecture and schema graph |
| "Is this grant too broad / is this safe?" | `/security-review`, `dg:security` agent | Risk judgment |
| "Is this npm package greedy?" | neither — out of scope | Local paths only |

## Reference Files (lazy-load)

| File | When to read |
|------|-------------|
| [references/detection.md](references/detection.md) | Before the code scan — per-language inferred-read patterns, render column spec, flag behavior |

## How it runs

1. **Extract.** Run `~/.dg/bin/dg-skills sniff <path>` (default `.`). It emits JSON: `{repo, total, gaps, counts, requirements[]}`. This is deterministic and needs no reasoning — do not re-derive it by grepping. A missing path or a file exits 1 with a message on stderr.
2. **Infer.** Scan source for env reads the CLI cannot see, and add them as rows with `proven: false`. Patterns per language: [references/detection.md](references/detection.md).
3. **Judge `unused`.** A declared key nothing reads is a dead requirement. If the code scan was truncated, stay silent rather than guess.
4. **Render.** Dense table, gaps first, then by type, then by name.

## Render

```text
shop-api · 9 items · ⚠ 2 gaps

  TYPE       NAME                     PHASE         SOURCE       WHERE                          GAP
⚠ SECRET     SERVICE_API_TOKEN        run           secrets-mgr  deploy/main.tf:95              undocumented
⚠ TOOLCHAIN  dotnet 10.0.100          dev           mise         mise.toml:2                    drifted
  CONFIG     APP_AUTH_DOMAIN          run           tfc-varset   deploy/main.tf:41
  NETWORK    :8080 ingress            run           dockerfile   Dockerfile:52
  REGISTRY   registry.example.test    build         nuget.config nuget.config:4
```

- Seven types, always these: `SECRET`, `CONFIG`, `CLOUD_PERM`, `SERVICE`, `NETWORK`, `TOOLCHAIN`, `REGISTRY`.
- `PHASE` is `dev` / `build` / `run`, joined with `|` when a requirement spans several.
- `~` before the type marks `proven: false` — reached for in code, never declared.
- Append `value` to `name` where it exists (`dotnet 10.0.100`), and cite `file:line` so it stays clickable.

## Hard rules

1. **Never print a value for a `SECRET` or `CONFIG` row.** `.env` files hold live credentials. The CLI emits names, types, and locations only — never read a value into the transcript, and never add one.
2. **Report, do not grade.** State permission breadth as fact (`secretsmanager:* on *`). Never score it, recommend hardening, or call it a risk — that is `/security-review`'s job.
3. **Every `⚠` must be falsifiable from the repo alone.** Four kinds only: `undeclared`, `undocumented`, `unused`, `drifted`. If you cannot point at the two files that disagree, it is not a gap.
4. **Local paths only.** A package name, image, or URL is an error, not a target.
5. **Do not re-grep what the CLI already found.** It is deterministic; trust it and spend the tokens on the inferred pass.
