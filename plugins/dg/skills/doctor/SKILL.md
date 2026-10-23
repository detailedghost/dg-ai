---
name: doctor
description: Check that the dg skills have what they need and walk through the fixes. Runs the read-only doctor report for every item or for the items you name, explains each failure in plain words, and runs a Fix command only after you agree. Use when a dg skill fails, after an update, or when you ask to check the setup.
---

# Skill: doctor

One report, one item at a time. The CLI checks tools, versions, credentials by name, the daemon and the allow rules. It only reads and reports: it never edits settings, never fixes anything, never decrypts a credential and never starts the daemon or a browser.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills doctor --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

## Usage

**Usage:** `/dg:doctor [<item>...] [--json]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--json` | none | Print the report as JSON. The skill always asks for it so it can read the result. | off (text) |

## Items

An item is a command name of the CLI, such as `jot`, `bg`, `sniff`, `worktree`, `spec`, `proxy`, `thrash`, `channel-review`, `demo`, `proto`, `launch`, `batch-open`, `credentials` or `install`. Without items the report covers every item. An unknown item exits 2 and prints the item list. The `shared` item always runs first: the CLI version against the dg plugin, the plugin itself, and the scratch and state roots.

## Run

No items given:

```bash
~/.dg/bin/dg-skills doctor --json
```

Items given, for example `jot` and `bg`:

```bash
~/.dg/bin/dg-skills doctor jot bg --json
```

Exit 0 means no check failed (warnings allowed). Exit 1 means at least one check failed. Exit 2 means an unknown item.

The JSON is `{ items: [{ item, checks: [{ id, status, detail, fix }] }], ok }`. `status` is `ok`, `warn` or `fail`. `fix` is the exact command that repairs the check, or `null`.

## Explain and fix

1. Print one line: how many checks passed, warned and failed.
2. List the failures first, then the warnings. For each one, say in plain words what is wrong, what stops working because of it, and the `fix` command.
3. Walk the fixes one by one, failures first. For each fix, ask before you run it. Show the exact command and what it changes. Run it only after a yes. On a no, skip it and go on.
4. A fix can touch the machine: it can install a tool, change a file mode, or edit `~/.claude/settings.json` by adding an allow rule. Say so before you ask. Never batch several fixes into one approval.
5. After the last fix, run the same doctor command again and report what changed. Name any check that still fails and stop; do not loop.

## Rules

- Never run a fix that the report did not print.
- Never edit settings, decrypt a credential, start the daemon or open a browser on your own. A fix that does one of these still needs the yes.
- A warning is not a failure. Offer its fix; do not press for it.
- If the doctor command itself fails to start, run the bootstrap block above and retry once.
