---
feature: "Guided database connection setup"
feature_snake_case: db_setup
date: "2026-11-20"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "session-hint-doctor"
    depends_on: []
    files: ["pkg/common/src/node/session-tokens.ts","pkg/common/__tests__/session-tokens.spec.ts","pkg/skills-cli/src/doctor/checks.ts","pkg/skills-cli/src/credentials/doctor.ts","pkg/skills-cli/src/db/doctor.ts","pkg/skills-cli/__tests__/doctor-hints.spec.ts","pkg/skills-cli/__tests__/doctor-session.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 2
    name: "update-launcher-layout"
    depends_on: []
    files: ["pkg/skills-cli/src/update/run.ts","pkg/skills-cli/src/install/cli.ts","pkg/skills-cli/src/install/doctor.ts","pkg/skills-cli/__tests__/update.spec.ts","pkg/skills-cli/__tests__/install-bundle.spec.ts","pkg/skills-cli/__tests__/doctor-dg-launcher.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-devops]
  - id: 3
    name: "db-setup-core"
    depends_on: [1]
    files: ["pkg/skills-cli/src/db/setup.ts","pkg/skills-cli/src/db/session.ts","pkg/skills-cli/src/db/index.ts","pkg/skills-cli/src/db/credentials.ts","pkg/skills-cli/src/db/engines/postgresql.ts","pkg/skills-cli/__tests__/db-setup.spec.ts","pkg/skills-cli/__tests__/db-command.spec.ts","pkg/skills-cli/__tests__/db-credentials.spec.ts","pkg/skills-cli/__tests__/db-engines.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code, dg:security]
  - id: 4
    name: "db-aws-secret-ref"
    depends_on: [3]
    files: ["pkg/skills-cli/src/db/aws-secret.ts","pkg/skills-cli/src/db/credentials.ts","pkg/skills-cli/src/db/index.ts","pkg/skills-cli/__tests__/db-aws-secret.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:security]
  - id: 5
    name: "db-secret-form"
    depends_on: [3]
    files: ["pkg/common/src/cli-wire.ts","pkg/common/src/credentials-format.ts","pkg/common/src/node/credentials-client.ts","pkg/common/__tests__/credentials-client.spec.ts","pkg/dg-daemon/src/server/page-codes.ts","pkg/dg-daemon/src/server/secret-intake.ts","pkg/dg-daemon/src/server/credentials.ts","pkg/dg-daemon/src/server/http.ts","pkg/dg-daemon/src/server/pages.ts","pkg/dg-daemon/__tests__/server/secret-intake.spec.ts","pkg/dg-daemon/__tests__/server/page-codes.spec.ts","pkg/pages/build.ts","pkg/pages/src/secret/**","pkg/pages/__tests__/secret-page.spec.ts","pkg/skills-cli/src/db/setup-form.ts","pkg/skills-cli/src/db/setup.ts","pkg/skills-cli/__tests__/db-setup-form.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      effort: xhigh
      qa: [dg:security, dg:qa-code]
  - id: 6
    name: "db-skill-setup-flow"
    depends_on: [3,4,5]
    files: ["plugins/dg/skills/db/**","plugins/dg/skills/doctor/**","pkg/skills-test/__tests__/db-skill-setup.spec.ts"]
    agents:
      primary: dg:lore
      confidence: high
      qa: [dg:reviewer]
---

# Guided database connection setup

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

### Slice 1 — session-hint-doctor

#### Engineering
- [ ] selectSoleSession: on 0 matches the message says run dg-agent start in this directory; on 2 or more it lists them and says pass --session <id> or set DG_SESSION_ID
- [ ] storedCredentialNames: a session-resolution DgCliError maps to fix DAEMON_START (dg-agent start); a protocol mismatch keeps dg-skills install; other errors keep their message with no install hint
- [ ] New sessionCheck: ok when exactly one live session matches the cwd, warn with fix dg-agent start on 0, warn with --session on 2+; add it to credentialsChecks and dbChecks

#### Testing Criteria
##### Contracts
- [ ] Contract: selectSoleSession([] , cwd) throws a DgCliError whose message contains 'dg-agent start'
- [ ] Contract: selectSoleSession with two cwd matches throws a message that contains '--session' and both session ids
- [ ] Contract: credential-store check with no resolvable session returns warn with fix 'dg-agent start', never 'dg-skills install'
- [ ] Contract: credential-store check on a protocol mismatch returns fix containing 'install'
- [ ] Contract: sessionCheck returns ok/warn/warn for 1/0/2 cwd matches

#### Acceptance Criteria
- [ ] Given a live daemon and no session for the cwd, when dg-skills doctor credentials db runs, then it prints Fix: dg-agent start
- [ ] bun test passes in pkg/common and pkg/skills-cli

### Slice 2 — update-launcher-layout

#### Engineering
- [ ] Root cause: update imports ../install/cli from the running (old) bundle, so writeShims uses the old PROGRAMS list; releases before v5.13.0 have no dg in it
- [ ] Add a hidden dg-skills install launchers step that runs finishLauncherLayout for the current release
- [ ] After the install step succeeds, update spawns the freshly written dg-skills launcher (programCommand) with that step, so the new release's code writes the launchers; a failure is a failed step with fix dg-skills install
- [ ] install doctor: a missing dg launcher in binDir is a warn with fix dg-skills install

#### Testing Criteria
##### Contracts
- [ ] Contract: updateDeps gains finishLayout(version); run calls it once after a successful install and not after a failed one
- [ ] Contract: default finishLayout spawns the bin-dir dg-skills launcher with the hidden launchers step, not the in-process import
- [ ] Contract: a non-zero exit from finishLayout reports the install step as failed with detail naming dg-skills install
- [ ] Contract: install doctor warns when binDir has dg-skills but no dg launcher

#### Acceptance Criteria
- [ ] Given a bin dir with no dg launcher, when dg-skills update installs a release, then the dg launcher exists afterward without running dg-skills install
- [ ] bun test passes in pkg/skills-cli

### Slice 3 — db-setup-core

#### Engineering
- [ ] db/session.ts ensureCwdSession(): explicit --session or DG_SESSION_ID wins; else match live sessions for the cwd without throwing; 0 matches spawns dg-agent start --print-session-id (programCommand); 2+ fails with the list and --session
- [ ] DbCredentialClient factory takes the session id; every db verb accepts --session
- [ ] dg-skills db setup <name> flags: --engine, --host, --port, --database, --schema, --user, --account, --warehouse, --role, --auth password|keypair|external_browser, --private-key-path, --read-only/--no-read-only (default read-only), --secret aws|form|command, --secret-id, --secret-key, --session; validates required fields per engine before touching the store
- [ ] Secret mode command: print one line for the human's own terminal: dg-skills credentials --session <id> set db/<name> --meta ... (hidden prompt), then the next command dg-skills db test <name>; exit 0
- [ ] Secret mode aws: store meta secretSource=aws-sm, secretId, secretKey and a non-secret placeholder value; never read the secret
- [ ] external_browser keeps its placeholder; keypair stores privateKeyPath only
- [ ] readOnly meta: setup writes readOnly=true unless --no-read-only; connectionFromRecord parses it; absent means false so existing connections are unchanged
- [ ] PostgreSQL: readOnly connections pass options -c default_transaction_read_only=on; any verb with --write on a readOnly connection is refused before connect
- [ ] After the secret is stored setup runs the same test path as db test, then prints exactly one next command (dg-skills db tables <name> on success, the fix on failure)
- [ ] Setup output and errors never include a secret value; meta is printed key=value

#### Testing Criteria
##### Contracts
- [ ] Contract: ensureCwdSession returns the sole cwd match without spawning
- [ ] Contract: ensureCwdSession with 0 matches spawns dg-agent start --print-session-id once and returns its trimmed stdout
- [ ] Contract: ensureCwdSession with 2 matches throws naming --session; DG_SESSION_ID overrides matching
- [ ] Contract: setup --secret command prints a single credentials set line holding every --meta pair, --session <id>, readOnly=true, and no value
- [ ] Contract: setup --secret aws stores meta {secretSource: 'aws-sm', secretId, secretKey} and calls client.set with the placeholder, never a secret
- [ ] Contract: setup rejects a postgresql run with no database or user before calling client.set
- [ ] Contract: connectionFromRecord maps readOnly 'true' to true and absent to false
- [ ] Contract: pgConnect for a readOnly connection passes options containing default_transaction_read_only=on
- [ ] Contract: db query --write on a readOnly connection exits 1 with a read-only message and never connects
- [ ] Contract: setup prints exactly one 'Next:' line

#### Acceptance Criteria
- [ ] Given a cwd with no session, when the agent runs dg-skills db setup pg1 --engine postgresql ... --secret command, then a session is registered and the printed command stores db/pg1 when the human runs it
- [ ] Given a stored readOnly postgres connection, when db query runs an UPDATE with --write, then it is refused
- [ ] bun test passes in pkg/skills-cli

### Slice 4 — db-aws-secret-ref

#### Engineering
- [ ] First verify asm-exec's real CLI contract (load the aws-secrets-manager skill); record it in Agent Notes before coding
- [ ] db/aws-secret.ts is the only module that knows asm-exec: build the placeholder {{resolve:secretsmanager:<id>:SecretString:<key>}} and the asm-exec argv
- [ ] A db verb on a secretSource=aws-sm connection re-runs itself under asm-exec with env DG_DB_SECRET set to the placeholder and DG_DB_ASM_CHILD=1; the child reads DG_DB_SECRET as the secret and never logs it
- [ ] asm-exec missing from PATH: exit 1 with an install hint; never fall back to aws secretsmanager get-secret-value or the SDK
- [ ] Optional meta awsProfile and awsRegion pass through as AWS_PROFILE and AWS_REGION

#### Testing Criteria
##### Contracts
- [ ] Contract: placeholder('db/prod', 'password') === '{{resolve:secretsmanager:db/prod:SecretString:password}}'
- [ ] Contract: an aws-sm connection in the parent spawns asm-exec once with DG_DB_SECRET set to the placeholder, not a value
- [ ] Contract: in the child (DG_DB_ASM_CHILD=1) connectionFromRecord uses DG_DB_SECRET as password
- [ ] Contract: no code path in pkg/skills-cli/src references get-secret-value, batch-get-secret-value or GetSecretValueCommand
- [ ] Contract: asm-exec missing gives exit 1 and a message naming asm-exec

#### Acceptance Criteria
- [ ] Given a db/<name> with secretSource=aws-sm and asm-exec on PATH, when db test runs, then it connects and the secret never appears in stdout, stderr or the credential store
- [ ] bun test passes in pkg/skills-cli

### Slice 5 — db-secret-form

#### Engineering
- [ ] createPageCodes becomes generic over its payload; chat keeps sessionId, a second instance holds {name, meta} intents with a 120 s TTL and single use
- [ ] New session-authed credentials operation intake {name, meta}: validates name and meta, mints a code, returns {url, expiresAt}; url is http://127.0.0.1:<port>/secret#code=<code>
- [ ] Daemon serves /secret and /secret.js with the same CSP and headers as /chat; the page shows the credential name and one password field
- [ ] POST /secret-intake {code, value}: host guard, local-page origin check, attach limiter, redeem the code, store.set(name, value, meta), reply 204; a used or expired code replies 404; the value is passed to noteSecret and never logged
- [ ] The page never receives a session token or meta; it gets only the name to display through a code-scoped GET
- [ ] setup --secret form calls intake, opens the url with tryOpen (prints it when opening fails), waits until the credential's updatedAt changes or the code expires, then continues to db test

#### Testing Criteria
##### Contracts
- [ ] Contract: intake codes redeem once; a second redeem and a redeem after 120 s return undefined
- [ ] Contract: POST /secret-intake with a valid code stores the value under the intent's name and meta and returns 204
- [ ] Contract: POST /secret-intake from a non-local origin, a non-loopback Host, or with a bad code is refused and stores nothing
- [ ] Contract: the intake reply and the /secret page carry no session token
- [ ] Contract: daemon logs during a submit do not contain the submitted value
- [ ] Contract: setup --secret form on code expiry exits 1 and prints the setup command again

#### Acceptance Criteria
- [ ] Given dg-daemon is running, when the agent runs setup --secret form and the human types the password in the opened page, then db/<name> is stored, db test runs, and the value never appears in agent output
- [ ] bun test passes in pkg/common, pkg/dg-daemon, pkg/pages and pkg/skills-cli

### Slice 6 — db-skill-setup-flow

#### Engineering
- [ ] SKILL.md gains a Setup section: run dg-skills db connections; on none, ask the human (AskUserQuestion) for engine, host or tunnel port, port, database, user, auth mode, read-only role and secret mode, then run one dg-skills db setup command
- [ ] Secret mode guidance: never ask for or accept a secret in chat; form is the default in a desktop session, command for a terminal-only host, aws when the secret is in AWS Secrets Manager
- [ ] Command mode tells the human to run the printed line in their own terminal; Claude Code ! mode has no hidden TTY prompt
- [ ] Reader connection later: run setup again under a new name such as <db>-reader
- [ ] connections.md documents setup first and keeps the raw credentials set recipes; documents readOnly, secretSource, secretId, secretKey
- [ ] If a step fails line points at dg-skills doctor credentials db

#### Testing Criteria
##### Contracts
- [ ] Contract: SKILL.md contains dg-skills db setup and the three secret modes
- [ ] Contract: SKILL.md tells the agent never to ask for a password in chat
- [ ] Contract: connections.md lists the readOnly, secretSource, secretId and secretKey meta keys

#### Acceptance Criteria
- [ ] bun test passes in pkg/skills-test

## Slice Summaries

## Agent Notes
(plan) Doctor bug source: doctor/checks.ts storedCredentialNames maps every client error to fix dg-skills install. No-session error source: common/src/node/session-tokens.ts selectSoleSession. db verbs have no --session flag today even though the error tells the user to pass one; DG_SESSION_ID already works.
(plan) Launcher bug source: update/run.ts defaultUpdateDeps.install imports ../install/cli from the running bundle. v5.12.1 shims.ts has PROGRAMS = PROGRAM_NAMES (no dg); dg joined in 41447a28 (first tag v5.13.0). Updates that start from this release on are fixed; older starts need doctor plus dg-skills install.
(plan) dg-agent start always registers a new session; sessions stay active for the 24 h reattach grace (session/liveness.ts), so ensureCwdSession must reuse a match before it spawns, or the cwd gets 2 matches and every later call fails.
(plan) The chat code exchange (http.ts handleChatCodeExchange) returns the session token to the page, so the secret form must not reuse it.
(plan) asm-exec and the aws-secrets-manager skill are not on this machine, and infra-conventions.md has no Secrets Manager pattern to reuse. Slice 4 starts by confirming the asm-exec CLI contract.
(plan) Claude Code ! mode gives no TTY, so readCredentialValue would read empty piped stdin; command mode tells the human to use their own terminal.

## Issues Remediation

## Code Structure

Structure decisions from pass 1.5. Each names the alternative it beat.

- **CLI shape** [DECIDED] dg-skills db setup is flag-driven and never prompts; the /dg:db skill does the walk-through with AskUserQuestion and runs one command. Beat: a TTY wizard (hangs under an agent, no stdin). Applies to: 3, 5, 6.
- **Session resolution** [DECIDED] common/session-tokens.ts owns cwd matching and its messages (slice 1); db/session.ts ensureCwdSession reuses it and spawns dg-agent start --print-session-id through programCommand on 0 matches. Beat: moving registerSession out of dg-agent (larger change, one caller). Applies to: 1, 3.
- **Connection metadata** [DECIDED] New meta keys readOnly, secretSource (aws-sm), secretId, secretKey, awsProfile, awsRegion live on the existing db/<name> credential; the stored value is a non-secret placeholder for aws-sm, as external_browser already does. Absent readOnly means false. Beat: a new store or connections.json. Applies to: 3, 4, 6.
- **asm-exec boundary** [DECIDED] db/aws-secret.ts is the only module that names asm-exec or the resolve placeholder; the db process re-runs itself under asm-exec and reads DG_DB_SECRET. Beat: in-process SDK GetSecretValue (breaks the never-call-get-secret-value rule). Applies to: 3, 4. [OPEN — roundtable] asm-exec is not installed on this machine and its CLI contract is unverified; slice 4 verifies it first.
- **One-time form** [DECIDED] dg-daemon serves /secret like /chat (same CSP, host guard, origin check, limiter). createPageCodes becomes generic; a second instance holds {name, meta} intents, 120 s, single use. The page sends only {code, value}; it never gets a session token or meta. A new session-authed credentials operation intake on the existing CLI wire creates the intent. Beat: reusing the chat code exchange (hands the page a session token); the extension (not always installed). Applies to: 3, 5.
- **Read-only** [DECIDED] PostgreSQL readOnly connections set default_transaction_read_only=on through the pg options string; any --write on a readOnly connection is refused before connect; classifySql stays the SQL guard. Snowflake relies on the human-named role. Applies to: 3, 6.
- **Launcher fix** [DECIDED] update spawns the new bin-dir dg-skills launcher with a hidden install launchers step after installBundleOnly, so the new release's PROGRAMS list writes the launchers. Beat: self-heal on every dg-skills start. Applies to: 2.
