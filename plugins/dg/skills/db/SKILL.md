---
name: db
description: Query PostgreSQL and Snowflake databases with read-safe defaults and token-efficient output.
---

# Database Queries with db

First run: the block installs the CLI when it is missing. It prints an upgrade hint when the CLI is too old.

```bash
dg db --help >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg" db --help >/dev/null 2>&1 ||
  { { dg --version >/dev/null 2>&1 || "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } && echo "run dg upgrade"; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg` in every later step. If `dg` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg` instead. If the block prints "run dg upgrade", run `dg upgrade`, then run the step again.

If a step fails, run dg doctor credentials db stash.

## Quick start

```bash
dg db connections
dg db test my-pg
dg db query my-pg "SELECT * FROM users LIMIT 10"
```

## Usage

**Usage:** `dg db <setup|query|tables|describe|explain|schema|connections|test> [arguments] [--session ID] [--write] [--limit N] [--format F] [--max-cell N] [--schema S] [--file file.sql]` (see [connections.md](references/connections.md) for the full setup flag list)

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--session ID` | none | Use this dg session for the credential store. | the session of the current directory |
| `--write` | none | Allow DML, DDL, multiple statements, and `SELECT INTO`. | off (read-safe statements only) |
| `--limit N` | none | Limit displayed query rows. | `50` |
| `--format F` | none | Format query rows as `tsv`, `json`, or `markdown`. | `tsv` |
| `--max-cell N` | none | Truncate each displayed cell after N characters. | `200` |
| `--schema S` | none | Select the schema for table and schema introspection. | `public` for PostgreSQL; `PUBLIC` for Snowflake |
| `--file file.sql` | `-f` | Read query SQL from a file instead of an argument. | SQL argument |

An unrecognized flag is rejected with an error. A SQL or table argument that itself starts with `-` (for example a leading `-- comment`) must come after a literal `--`, e.g. `db query my-pg -- "-- comment\nSELECT 1"`.

## Commands

```bash
dg db query <conn> "SQL"
dg db query <conn> -f file.sql
dg db query <conn> "SQL" --write
dg db tables <conn>
dg db describe <conn> <table>
dg db explain <conn> "SQL"
dg db schema <conn>
dg db connections
dg db test <conn>
```

Connections are encrypted credentials named `db/<conn>`. Register them with `dg db setup`; see [connections.md](references/connections.md) for each authentication mode.

## Setup

Run `dg db connections`. If it lists the connection you need, skip this section.

If it lists none, or the human wants a new one, ask with `AskUserQuestion`:

- Engine: `postgresql` or `snowflake`.
- Host, or the local port of an SSH tunnel. The human runs `ssh -L`; setup stores `127.0.0.1`.
- Port, database, and user. Snowflake needs account, and optionally warehouse and role.
- Auth mode: `password`; Snowflake also has `keypair` and `external_browser`.
- Read-only role, if one exists.
- Secret mode: `aws`, `form`, or `command`.

Then run ONE command:

```bash
dg db setup <name> --engine postgresql --host 127.0.0.1 --port 5432 \
  --database <db> --user <user> --secret form
```

Never ask for a password, token, or key in chat. Never accept one there. The secret goes only through one of these modes:

| Mode | Use when | Extra flags |
|---|---|---|
| `--secret form` | Default on a desktop session. Setup opens a local page, or prints its link when it cannot open it. The human types the secret there. The link works once for 120 seconds. | none |
| `--secret command` | The host has only a terminal. | none |
| `--secret aws` | The secret already lives in AWS Secrets Manager. Needs `asm-exec` from the Agent Toolkit for AWS `aws-core` plugin. | `--secret-id`, `--secret-key`, optional `--aws-profile`, `--aws-region` |

`command` mode prints a `dg credentials ... set ...` line. Claude Code `!` mode is not confirmed to give a TTY, so do not print a `!` form. Tell the human to run the printed line in their own terminal. It asks for the secret with a hidden prompt. Then run `dg db test <name>`.

Snowflake `--auth external_browser` has no secret. Omit `--secret`.

Setup writes `readOnly=true` by default. PostgreSQL sessions start read-only, and `--write` is refused on such a connection. Snowflake relies on the role. For a writer and a reader, run setup again under a new name such as `<db>-reader`. Pass `--no-read-only` only for the writer.

Setup reuses the session of the current directory, or runs `dg agent start`. Every db verb accepts `--session`.

## Output

The default is TSV with a `ROWS: shown/total` header. Cells over `--max-cell` are truncated, and output has a hard 64 KB ceiling. See [output-format.md](references/output-format.md).

## Safety

Queries are read-safe by default. `SELECT`, `SHOW`, `DESCRIBE`, non-analyzing `EXPLAIN`, and `SET` pass without flags. DML, DDL, write CTEs, `SELECT INTO`, multiple statements, `EXPLAIN ANALYZE`, `SET ROLE`, and `SET SESSION AUTHORIZATION` require `--write`.

## Snowflake SSO with a cold cache

The login URL goes to stderr, and the connection blocks until login completes. Run it in the background, poll the log, and relay the **last** `https://` line because each retry creates a new SAML request:

```bash
dg db test my-sf > "$(dg stash db sso.log)" 2>&1
```

Never pipe through `head` or `grep`, and do not run it in the foreground when an agent must relay the URL; buffering can make the prompt look hung. A user can instead run `dg db test my-sf` once, themselves, to prime the temporary credential cache.

## References

- [Connection credentials](references/connections.md)
- [Output format details](references/output-format.md)
