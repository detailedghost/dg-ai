# Detection Reference

## What the CLI already covers

`~/.dg/bin/dg-skills sniff` parses these shapes. Do not re-scan them.

| Type | Sources |
|------|---------|
| `SECRET` | workflow `secrets.X`; terraform `container_secrets`, `aws_secretsmanager_secret`; `.env*` keys matching `TOKEN`/`SECRET`/`PASSWORD`/`PRIVATE_KEY`/`API_KEY`/`CONN_STR`/`CREDENTIAL`/`_DSN` |
| `CONFIG` | `.env*` non-secret keys; terraform `container_environment`; Dockerfile `ENV` |
| `CLOUD_PERM` | terraform `aws_iam_*`; workflow `role-to-assume` |
| `SERVICE` | compose service blocks |
| `NETWORK` | Dockerfile `EXPOSE`; compose `ports:` |
| `TOOLCHAIN` | `mise.toml` `[tools]`, `global.json`, `.nvmrc`, `engines`, `requires-python`, `required_version`, Dockerfile `FROM` |
| `REGISTRY` | `nuget.config`, `.npmrc`, Dockerfile `FROM` host, workflow `registry:` |

Skipped while walking: `node_modules`, `venv`, `__pycache__`, `bin`, `obj`, `dist`, `build`, `target`, `vendor`, and every dot-directory except `.github`. The dot-directory rule matters — `.claude/worktrees/` holds full checkouts of the same repo and would otherwise triple every count.

## The inferred pass — yours

Find env reads the CLI cannot see, and emit them with `proven: false`.

| Language | Pattern |
|----------|---------|
| C# | `Environment.GetEnvironmentVariable("X")`, `Configuration["X"]`, `GetConnectionString("X")` |
| Python | `os.environ["X"]`, `os.getenv("X")`, `Settings` / pydantic field names |
| TypeScript | `process.env.X`, `Bun.env.X`, `import.meta.env.X` |
| Shell | `${X}` / `$X` in entrypoints and `Tiltfile` |

Classify a found key exactly as the CLI would — the same name heuristic — then set the gap:

- Name absent from every `.env*`, terraform block, and Dockerfile `ENV` → `undeclared`.
- Name present in `.env` but not the committed sample → the CLI already flagged it `undocumented`; do not duplicate.

## Judging `unused`

A key declared in `.env.sample` (or terraform) that no source file reads is a dead requirement. Two conditions before flagging:

1. The code scan actually completed. A truncated or capped scan means silence, not a guess.
2. The key is not read dynamically. `os.environ[name]`, `Configuration[key]`, or any lookup through a variable disqualifies the whole file — a dynamic read can consume anything.

## Render detail

Columns, left-aligned, one space between: `⚠` marker (2), `TYPE` (10), `NAME` (24), `PHASE` (13), `SOURCE` (12), `WHERE` (30), `GAP` (12).

- Header: `<repo> · <total> items · ⚠ <gaps> gaps`. Drop the `· ⚠ N gaps` clause entirely when there are none.
- Sort: gapped rows first, then `SECRET → CONFIG → CLOUD_PERM → SERVICE → NETWORK → TOOLCHAIN → REGISTRY`, then name.
- `PHASE` needs the full 13 — `dev|build|run` is the widest value and `dev|bu` is worse than useless.
- **Truncate from the left, with a leading `…`, for anything path-shaped** (a `WHERE`, an image ref, any name containing `/`). The tail is the actionable half: `…/deploy/main.tf:95` stays clickable, `terraform/deploy/main.` does not. Truncate plain names from the right.
- `GAP` carries the kind only. Full detail belongs to `--gaps`.
- Never wrap a row. If the terminal is narrower than the table, drop `SOURCE` before anything else.

## Flag behavior

- `--gaps` — filter to `gaps.length > 0` and print each gap's `detail` under its row. If zero, say so in one line and stop.
- `-o` — after printing, write the same table to `$(~/.dg/bin/dg-skills stash -a sniff <repo>.md)` under a `# <repo> requirements` heading with the date. The stash call creates the directory.

## Empty results

A repo with no recognizable surfaces returns `total: 0`. Say that plainly and name what was looked for — do not invent requirements to fill the table.
