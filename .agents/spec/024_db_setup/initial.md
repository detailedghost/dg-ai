# Guided database connection setup — Initial Notes

## Purpose
Give an agentic session one guided way to connect to a database: /dg:db setup, backed by dg-skills db setup. One run reuses or registers the dg-agent session for the cwd, records a read-only-by-default connection, stores the secret without it ever entering chat or agent context (AWS Secrets Manager reference, a one-time local form, or a printed command the human runs), runs db test and prints the one next command. It also fixes the wrong doctor hint for the no-session case and the missing dg launcher after dg-skills update.

## Scope
### Included
- dg-skills db setup <name> with flags for engine (postgresql, snowflake), host or tunnel local port, port, database, schema, user, auth mode, role, read-only, and secret mode
- Session reuse or registration for the cwd (spawns dg-agent start when none matches)
- --session on every dg-skills db verb; the no-session error names dg-agent start
- Doctor credential-store and db checks give dg-agent start as the fix when no session resolves
- Secret mode aws: store only secret id and JSON key; resolve at connect time through asm-exec with a {{resolve:secretsmanager:<id>:SecretString:<key>}} placeholder; never call get-secret-value
- Secret mode form: dg-daemon serves a one-time 127.0.0.1 page; the value goes straight into the encrypted credential store
- Secret mode command: print a ready dg-skills credentials set command for the human to run in their own terminal
- readOnly connection metadata, default true for setup; PostgreSQL sessions start read-only, --write is refused on a read-only connection
- dg-skills update runs the new release's launcher layout, so the dg launcher exists after one update
- /dg:db skill setup flow and connections.md: the agent asks the human for non-secret fields, then runs one command; a reader connection is a second setup run under a new name
### Excluded
- dg-managed SSH tunnels (setup records 127.0.0.1 plus the human's tunnel port)
- An interactive TTY wizard in dg-skills (the skill does the walk-through)
- Building Velora DB reader logins
- Engines other than postgresql and snowflake
- Retroactive fix for updates started from releases before this one (doctor flags the missing launcher; dg-skills install repairs it)
- Extension-hosted secret form
