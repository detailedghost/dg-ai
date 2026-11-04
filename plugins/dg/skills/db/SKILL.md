---
name: db
description: Query PostgreSQL and Snowflake databases with read-safe defaults and token-efficient output.
---

# Database Queries with db

First run: install or refresh the CLI when it is missing or too old.

```bash
dg-skills db --help >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg-skills" db --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg-skills` in every later step. If `dg-skills` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg-skills` instead.

If a step fails, run dg-skills doctor credentials db stash.

## Quick start

```bash
dg-skills db connections
dg-skills db test my-pg
dg-skills db query my-pg "SELECT * FROM users LIMIT 10"
```

## Usage

**Usage:** `dg-skills db <query|tables|describe|explain|schema|connections|test> [arguments] [--write] [--limit N] [--format F] [--max-cell N] [--schema S] [--file file.sql]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--write` | none | Allow DML, DDL, multiple statements, and `SELECT INTO`. | off (read-safe statements only) |
| `--limit N` | none | Limit displayed query rows. | `50` |
| `--format F` | none | Format query rows as `tsv`, `json`, or `markdown`. | `tsv` |
| `--max-cell N` | none | Truncate each displayed cell after N characters. | `200` |
| `--schema S` | none | Select the schema for table and schema introspection. | `public` for PostgreSQL; `PUBLIC` for Snowflake |
| `--file file.sql` | `-f` | Read query SQL from a file instead of an argument. | SQL argument |

An unrecognized flag is rejected with an error. A SQL or table argument that itself starts with `-` (for example a leading `-- comment`) must come after a literal `--`, e.g. `db query my-pg -- "-- comment\nSELECT 1"`.

## Commands

```bash
dg-skills db query <conn> "SQL"
dg-skills db query <conn> -f file.sql
dg-skills db query <conn> "SQL" --write
dg-skills db tables <conn>
dg-skills db describe <conn> <table>
dg-skills db explain <conn> "SQL"
dg-skills db schema <conn>
dg-skills db connections
dg-skills db test <conn>
```

Connections are encrypted credentials named `db/<conn>`. Register them with `dg-skills credentials set`; see [connections.md](references/connections.md) for each authentication mode.

## Output

The default is TSV with a `ROWS: shown/total` header. Cells over `--max-cell` are truncated, and output has a hard 64 KB ceiling. See [output-format.md](references/output-format.md).

## Safety

Queries are read-safe by default. `SELECT`, `SHOW`, `DESCRIBE`, non-analyzing `EXPLAIN`, and `SET` pass without flags. DML, DDL, write CTEs, `SELECT INTO`, multiple statements, `EXPLAIN ANALYZE`, `SET ROLE`, and `SET SESSION AUTHORIZATION` require `--write`.

## Snowflake SSO with a cold cache

The login URL goes to stderr, and the connection blocks until login completes. Run it in the background, poll the log, and relay the **last** `https://` line because each retry creates a new SAML request:

```bash
dg-skills db test my-sf > "$(dg-skills stash db sso.log)" 2>&1
```

Never pipe through `head` or `grep`, and do not run it in the foreground when an agent must relay the URL; buffering can make the prompt look hung. A user can instead run `dg-skills db test my-sf` once, themselves, to prime the temporary credential cache.

## References

- [Connection credentials](references/connections.md)
- [Output format details](references/output-format.md)
