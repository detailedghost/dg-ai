# Ecosystem Detection

Resolve `DG` with the [skill bootstrap](../SKILL.md#runtime-and-skill-paths) in every fresh shell.

`"$DG" deps-upgrade` auto-detects the project ecosystem by checking for these marker files in the order below. First match wins. Pass `--ecosystem <name>` to override (useful in mixed-ecosystem monorepos).

| Marker | Ecosystem | Installer | Audit | `bump-dep` edits | Lock staged |
|---|---|---|---|---|---|
| `bun.lockb` / `bun.lock` | `bun` | `bun install` | `bun audit --json` | `package.json` | `bun.lock*` |
| `pnpm-lock.yaml` | `pnpm` | `pnpm install` | `pnpm audit --json` | `package.json` | `pnpm-lock.yaml` |
| `yarn.lock` | `yarn` | `yarn install` | `yarn npm audit --json` | `package.json` | `yarn.lock` |
| `package-lock.json` | `npm` | `npm install` | `npm audit --json` | `package.json` | `package-lock.json` |
| `go.mod` | `go` | `go mod tidy` | `govulncheck -json ./...` | `go.mod` (via `go get <pkg>@v<new>`) | `go.sum` |
| `Cargo.toml` | `rust` | `cargo build --locked` | `cargo audit --json` | `Cargo.toml` + `cargo update -p <pkg> --precise <new>` | `Cargo.lock` |
| `*.csproj` / `*.sln` | `dotnet` | `dotnet restore` | `dotnet list package --vulnerable --format json` | each `*.csproj` referencing the package (via `dotnet add package`) | *(no lock file)* |
| `Gemfile` | `ruby` | `bundle install` | `bundle-audit check --format json` | `Gemfile` + `bundle update --conservative <pkg>` | `Gemfile.lock` |
| `pyproject.toml` / `requirements.txt` | `python` | `uv sync` / `poetry install` / `pip install -r …` | `pip-audit --format json` | `pyproject.toml` or `requirements.txt` | `poetry.lock` / `uv.lock` (if present) |

The helper prints the detected ecosystem to stderr before running any subcommand that branches on it (`audit`, `install`, `bump-dep`). Watch for that line when diagnosing a misdetection — override with `--ecosystem <name>` if wrong.

For monorepos with multiple ecosystems at the root: the helper currently assumes a single ecosystem per invocation. Run the skill once per ecosystem subtree (cd into it) if needed.
