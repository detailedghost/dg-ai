---
name: adr
description: 'Write a paired architecture decision record (a plain-English ADR in docs/adr plus a terse agent decision in .agents/decisions), or answer a question about the codebase from those records at a chosen reading level. Use after a decision passes the three gates, or to explain a feature from its ADRs.'
---

# /dg:adr — Decision Records

Every decision is two files with one number and one slug. A people-facing ADR lives in `docs/adr/`. A terse agent decision lives in `.agents/decisions/`. `dg adr` does the numbering, scaffolding, indexing, linting and lookup. This skill owns the rules.

First run: the block installs the CLI when it is missing. It prints an upgrade hint when the CLI is too old. Each Bash call works alone:

```bash
dg adr --help >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg" adr --help >/dev/null 2>&1 ||
  { { dg --version >/dev/null 2>&1 || "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } && echo "run dg upgrade"; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg` in every later step. If `dg` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg` instead. If the block prints "run dg upgrade", run `dg upgrade`, then run the step again.

If a step fails, run dg doctor adr.

## Usage

**Usage:** `/dg:adr [new '<title>' --topic '<t>' [--covers '<glob>']... [--level <l>] | ask '<question>' [--level <l>]]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `new "<title>"` | none | Write mode. Apply the three gates, scaffold the pair, fill both files, lint. | no mode |
| `ask "<question>"` | none | Ask mode. Answer from the ADRs, cite their numbers, write no file. | no mode |
| `--topic <t>` | none | `new` only. The `Topic:` line, the group in both indexes. Required. | none |
| `--covers <glob>` | none | `new` only. A path glob the decision governs. Repeat the flag for more globs. | `[]` |
| `--level <l>` | none | Reading level: `eli5`, `high-school`, `college`, `phd` or `technical`. | `new`: no `Level:` line; `ask`: README `level:`, else `high-school` |

No mode: ask which mode the user wants.

## Route

| Mode | Read | Then |
|---|---|---|
| `new` | [three-gates.md](references/three-gates.md), [write-adr.md](references/write-adr.md), [write-decision.md](references/write-decision.md), [levels.md](references/levels.md) | Run the write steps below. |
| `ask` | [ask.md](references/ask.md), [levels.md](references/levels.md) | Answer at the level. Stop. |

Grade limits: `eli5` 4, `high-school` 10, `college` 14, `phd` and `technical` none.

## Write mode

1. Apply the three gates. Any "no" stops here: the decision needs no record.
2. Run `dg adr new '<title>' --topic '<t>' [--covers '<glob>']... [--level <l>]`. Single-quote every user-derived argument and write an embedded single quote as `'\''`. Never pass a title that holds a newline. Repeat `--covers` once per glob. A repo without `.agents/decisions/README.md` needs `dg adr init` first; ask before you run it.
3. Fill the ADR and the decision file.
4. Run `dg adr index`, then `dg adr lint --changed`. Fix every finding. Repeat until lint exits 0. `decision-too-long` flags a decision over 25 non-blank lines below its front matter: cut or split it.

## Ask mode

Answer from the ADRs only. Cite ADR numbers. Quote each word and path as in [ask.md](references/ask.md). Check the answer with `dg adr lint --grade - --level <l>` before you reply. Details: [ask.md](references/ask.md).
