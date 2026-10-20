# `/monolith` orchestration protocol

Phase-by-phase recipe for the orchestrator. The orchestrator (main agent) does no synthesis — it only dispatches agents and runs the helper. All term writing happens in the `lore` agent.

Helper: `~/.dg/bin/dg-skills monolith` — run it with `--help` for the full subcommand list.

## Phase 0 — Parse args

Inputs: `--shallow` / `-s` (bool), `--prune` (bool). They are independent.

`--shallow` follows the same convention as `/kick --shallow` and `/pickup --shallow`: output under `$(~/.dg/bin/dg-skills stash -r -s)` instead of the repo, no `.agents/` prerequisite, no AGENTS.md/CLAUDE.md retrofit, no git commit. Use it for first-pass scans on repos without `.agents/` infrastructure or for throwaway exploration. Resume the same shallow file by re-running `/monolith --shallow` from the same repo.

`--shallow` ALSO reduces scan parallelism to a single Explore agent. The two behaviors are fused — you cannot have one without the other. To go full → shallow, just delete `.agents/monolith.md` and run `/monolith --shallow`. To promote shallow → full, copy `$(~/.dg/bin/dg-skills stash -s monolith <slug>)/monolith.md` to `.agents/monolith.md` and run `/monolith` (no flag) to refresh.

If `--prune` is set:

1. Run `~/.dg/bin/dg-skills monolith prune <MONOLITH_PATH>` where `<MONOLITH_PATH>` comes from a `bootstrap` call (also passing `--shallow` if the user did). Capture stdout (removed term names).
2. Run `~/.dg/bin/dg-skills monolith validate <MONOLITH_PATH>`.
3. Print "`/monolith --prune`: removed N entries" + the removed list.
4. Exit. Do not scan, do not invoke agents.

Otherwise continue with Phase 1.

## Phase 1 — Bootstrap

```sh
# Standard:
eval "$(~/.dg/bin/dg-skills monolith bootstrap .)"

# Shallow:
eval "$(~/.dg/bin/dg-skills monolith bootstrap --shallow .)"
```

Standard mode captures: `APPEND_MODE`, `MONOLITH_PATH`, `LIGHT_MODE=0`.
Shallow mode captures additionally: `LIGHT_DIR` (the `$(~/.dg/bin/dg-skills stash -s monolith <slug>)/` parent), `ORIGIN_REPO` (absolute path of the repo, or empty if not in a repo), `SLUG`.

If `APPEND_MODE=1`, also capture the existing-term list (used to softly hint scanners away from re-defining settled terms; lore still receives the full file):

```sh
EXISTING_TERMS=$(~/.dg/bin/dg-skills monolith list-terms "$MONOLITH_PATH")
```

`$EXISTING_TERMS` is one term per line; embed it in scanner prompts as "these are already known — focus on what's missing."

## Phase 1.4 — Worktree routing

Scanners search from the session cwd — for a worktree workflow (`/pickup -t`) that's usually the MAIN checkout on another branch, so the stock scan misses branch-local code. Detect a linked worktree:

```sh
[ "$LIGHT_MODE" = "1" ] && REPO_ROOT="$ORIGIN_REPO" || REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$MONOLITH_PATH")/.." && pwd)
case "$(git -C "$REPO_ROOT" rev-parse --git-dir 2>/dev/null)" in */worktrees/*) IS_WORKTREE=1;; *) IS_WORKTREE=0;; esac
```

`IS_WORKTREE=1` → SKIP Phase 1.5 + Build-args; use the generator in Phase 2-3 (it owns stack detection, inlining, and absolute `SCAN_ROOT`).

## Phase 1.5 — Detect stack (performance routing)

Pick scanner agents based on the dominant language and infrastructure signals so each agent works in its strongest domain. Cheap heuristic — read manifest files at the repo root.

```sh
STACK=""
[ -f requirements.txt ] || [ -f pyproject.toml ] || [ -f setup.py ] && STACK="$STACK python"
[ -f package.json ] && STACK="$STACK js"
[ -f Cargo.toml ] && STACK="$STACK rust"
[ -f go.mod ] && STACK="$STACK go"
ls *.csproj *.sln 2>/dev/null | head -1 | grep -q . && STACK="$STACK csharp"
[ -f atlas.hcl ] || [ -f prisma/schema.prisma ] || ls db/migrations 2>/dev/null | head -1 | grep -q . && STACK="$STACK dba"
[ -d terraform ] && STACK="$STACK devops"
```

### Agent selection table

| Scanner | Polyglot | python repo | js/ts repo | csharp repo | DB-heavy add-on |
|---|---|---|---|---|---|
| Domain vocabulary | `Explore` | `python` | `js` | `csharp` | swap to `dba` if SQL/migrations dominate |
| Naming + patterns | `Explore` | `Explore` | `Explore` | `Explore` | n/a (language-agnostic) |
| Concepts + relationships | `Explore` | `python` | `js` | `csharp` | `dba` if FK/ORM relationships are the headline |

**Rule of thumb:** if `STACK` contains exactly one language token, use that language's agent for Domain + Concepts. If it contains 2+, use `Explore`. Naming + Patterns always uses `Explore`. If `dba` is in `STACK` AND a relationally-modelled DB is the architectural center, prefer `dba` for Concepts.

Set `model: "haiku"` on scanner agents — they're doing extraction (read code → emit TSV), not deep reasoning. Sonnet stays for `lore` (synthesis).

## Phase 2-3 — Scan + Consolidate (Workflow)

Scanning and synthesis run as a single background **Workflow**. Invoking `/monolith`
*is* the opt-in to the Workflow tool — no extra keyword needed. The scanner and
`lore` prompts live inside the script (`references/scan.workflow.mjs`), so they no
longer bloat this protocol or the orchestrator's context window. The orchestrator's
only job here is to assemble `args` and call the tool.

### Build args

| Arg | Source |
|-----|--------|
| `mode` | `'shallow'` if `LIGHT_MODE=1`, else `'full'` |
| `existingTerms` | `$EXISTING_TERMS` from Phase 1 (empty unless APPEND_MODE) |
| `existingFileContent` | contents of `$MONOLITH_PATH` read inline if APPEND_MODE, else `''` |
| `monolithPath` | `$MONOLITH_PATH` |
| `stagingPath` | `${MONOLITH_PATH}.new` |
| `agentTypes` | `{ domain, naming, concept }` — resolved from the Phase 1.5 routing table |
| `template` | full contents of `references/template.md`, read inline by the orchestrator |

`mode: 'shallow'` makes the script dispatch a single scanner instead of three.

### Invoke

**Worktree (`IS_WORKTREE=1`):** the generator bakes every input in as consts — run it, pass NO args:

```sh
M=full; [ "$LIGHT_MODE" = "1" ] && M=shallow
SCOPED=$(~/.dg/bin/dg-skills monolith worktree-gen "$REPO_ROOT" --mode "$M" \
  --monolith-path "$MONOLITH_PATH" --staging-path "${MONOLITH_PATH}.new")
```

Then `Workflow({ scriptPath: SCOPED })`. Skip the Build-args table above.

**Normal checkout:** assemble args (Phase 1.5 routing + Build args) and run the stock script:

```
Workflow({
  scriptPath: "<skills>/monolith/references/scan.workflow.mjs",
  args: { mode, existingTerms, existingFileContent, monolithPath, stagingPath, agentTypes, template }
})
```

The workflow runs scanners (haiku, parallel) → `lore` (synthesis) and writes the
full updated file to `stagingPath`. It returns `{ staged, stagingPath, summary }`.
`lore` is the only writer in both full and `--shallow` modes; the orchestrator never
writes term tables itself.

If it returns `staged: false` (empty scan), report "no new vocabulary found" and
skip to Phase 5 — there is nothing to promote.

**Self-containment guarantee:** the script passes the template and existing-file
content *inline* into the `lore` prompt and never references the skill directory, so
no sub-agent reads `SKILL.md` and trips the `disable-model-invocation` guard.

Once the workflow returns with `staged: true`, continue to Phase 3.5 against
`$STAGING`.

## Phase 3.5 — Conflict resolution

```sh
STAGING="${MONOLITH_PATH}.new"
CONFLICTS=$(~/.dg/bin/dg-skills stash -u monolith conflicts)

if [ -f "$MONOLITH_PATH" ]; then
  ~/.dg/bin/dg-skills monolith detect-conflicts "$MONOLITH_PATH" "$STAGING" >"$CONFLICTS"
fi
```

If `$CONFLICTS` is non-empty, branch on interactivity:

### Interactive (`[ -t 0 ]` true AND `MONOLITH_NONINTERACTIVE` unset)

For each TSV line in `$CONFLICTS`, parse `section`, `term`, `old_row`, `new_row` and use `AskUserQuestion` with three options:

- **Keep existing** — appends term to a `keep-old.tsv` companion file
- **Use new** — appends to `keep-new.tsv` (no action; staging already has the new row)
- **Defer to log** — appends to `keep-old.tsv` AND falls through to the non-interactive logger

After collecting answers, run:

```sh
~/.dg/bin/dg-skills monolith apply-conflict-resolution "$STAGING" "$keep_old_tsv" .agents/school/monolith-conflicts.md
```

This restores OLD rows in staging for every term the user chose to keep existing or defer.

### Non-interactive (`MONOLITH_NONINTERACTIVE=1` OR stdin not a tty)

```sh
~/.dg/bin/dg-skills monolith apply-conflict-resolution "$STAGING" "$CONFLICTS" .agents/school/monolith-conflicts.md
```

Default behavior: keep all existing rows; log the rejected new candidates with a timestamp. Surface the count in the run summary so the user can review later.

### Promote staging

```sh
mv "$STAGING" "$MONOLITH_PATH"
```

## Phase 4 — Post-process

```sh

# 4a. Validate format.
~/.dg/bin/dg-skills monolith validate "$MONOLITH_PATH"

# 4b. Cap check.
set +e
~/.dg/bin/dg-skills monolith cap-report "$MONOLITH_PATH"
CAP_EXIT=$?
set -e
```

`cap-report` exit codes:

- `0` — under all caps → continue
- `1` — at least one section over its 40-row cap → **domain split** (4c)
- `2` — total file over ~6 KB but no section over its row cap → **domain split** (4c)

### 4c. Domain split (cap exit `1` or `2`)

A vocabulary that outgrows the cap has earned more room. Do not delete rows to fit, and
do not ask `lore` to pick "lowest-signal" entries — partition deterministically instead:

```sh
set +e
~/.dg/bin/dg-skills monolith split "$MONOLITH_PATH"
SPLIT_EXIT=$?
set -e
```

`split` derives each row's domain from its `_src:_` path, writes one file per domain
beside the live file, and rewrites the live file as an index:

- Standard: `.agents/monolith/<domain>.md`, index at `.agents/monolith.md`
- Light: `$LIGHT_DIR/monolith/<domain>.md`, index at `$LIGHT_DIR/monolith.md`

Domain derivation: a monorepo container segment (`pkg`, `packages`, `apps`, `services`,
`libs`, `crates`, `modules`, `projects`) contributes its child name, so
`pkg/Portal.Api/...` becomes `portal-api`; anything else contributes its first path
segment, so `.github/workflows/...` becomes `github`. A row with no `_src:_`, or one
citing a bare root file, lands in `general`. Any domain holding fewer than 3 rows folds
into `general` too, so the split never scatters single rows across files.

`split` exit codes:

- `0` — split written, every domain file under cap
- `1` — every row landed in one domain, so splitting would gain nothing. Leave the file
  whole and warn: `"Vocabulary file at <bytes> bytes is over the 6 KB soft cap and is
  single-domain. Consider /monolith --prune or hand-trim."`
- `2` — split written but a domain file is still over cap. Accept and warn, naming the
  domains it printed on stderr. Do not loop, and do not split a domain file again.

Cross-domain sections (`Relationships`, `Flagged Ambiguities`) stay on the index,
because they reference terms from more than one domain.

**Once split, the layout is the steady state.** A later `/monolith` run appends to the
index as usual and Phase 4 re-splits, which is idempotent: rows return to the same
domain files. Anything that reads the vocabulary should follow the index table rather
than assuming every term lives in `monolith.md`.

### 4e. Pointer retrofit (skip in shallow mode)

```sh
if [ "$LIGHT_MODE" = "0" ]; then
  if [ -f .agents/AGENTS.md ]; then
    ~/.dg/bin/dg-skills monolith patch-pointer .agents/AGENTS.md
    POINTER_TARGET=.agents/AGENTS.md
  elif [ -f CLAUDE.md ]; then
    ~/.dg/bin/dg-skills monolith patch-pointer CLAUDE.md
    POINTER_TARGET=CLAUDE.md
  else
    echo "warn: no AGENTS.md or CLAUDE.md found — agents won't auto-discover monolith.md. Run /agent-seed to formalize, or add a pointer by hand." >&2
    POINTER_TARGET=
  fi
fi
```

Shallow mode skips pointer retrofit entirely — the file is ephemeral; we don't modify the repo.

## Phase 5 — Report

Print a one-paragraph summary covering:

- Mode: standard or `--shallow` (with origin repo + tmp path if shallow)
- Terms added (per section)
- Ambiguities flagged (count)
- Relationships emitted (count)
- Cap handling: under cap / domain split (naming the domains and their files) / single-domain warning / accepted-bloat
- Pointer target: AGENTS.md / CLAUDE.md / none (warned)

End with the path to the file:

- Standard: `Wrote .agents/monolith.md (<bytes> bytes).`
- Shallow: `Wrote $(~/.dg/bin/dg-skills stash -s monolith <slug>)/monolith.md (<bytes> bytes, uncommitted). Re-run /monolith --shallow from this repo to refresh; promote with cp + /monolith when ready.`

## Notes

- **Phase 1 no longer builds an exclusion list.** Lore receives the full existing file inline so it can decide whether to update or preserve each existing term. The `list-terms` subcommand remains available for future use (e.g. quick stats) but is not invoked in the default flow.
- **All conflicts surface through the same path** (helper detection + AskUserQuestion or log). There is no third "skip silently" mode.
- **AGENTS.md retrofit runs AFTER conflict resolution** so the live file always reflects the human-resolved state.
