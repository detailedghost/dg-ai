# /dg:refactor Discovery Reference

Covers domain context, Explore briefing, investigation, verification, and candidate format. Load at Step 1.

---

## §1 — Domain Context Read Order

Read in this order, skipping any that don't exist:

1. `AGENTS.md` (or `CLAUDE.md` fallback) at the repo root.
1. `.agents/paths.md` — repo-specific paths.
1. `.agents/monolith.md` — canonical domain vocabulary. Use these terms in candidate descriptions; don't invent new ones when an established term fits.
1. `.agents/school/*.md` — relevant topic clusters for the scoped path.

**Domain language:** This skill is informed by the project's domain model. Use `.agents/monolith.md` terms exactly when naming a deepened module. If the deepened module needs a concept not in `monolith.md`, flag it during the design conversation: `"This refactor would introduce '<concept>' as a first-class term — propose adding it to monolith.md."`

If `.agents/monolith.md` is missing, note: `"No monolith.md found — candidate names will use file/module paths instead of domain concepts. Run /dg:agent-seed if .agents/ itself is missing."`

---

## §2 — Explore Agent Brief

Launch the **Explore** agent on the scope path. Brief it verbatim:

> Walk `<path>` looking for **architectural friction**. Don't follow rigid heuristics — note where understanding requires bouncing between modules. For each suspicious area, note:
>
> - Files involved (paths + line ranges if useful).
> - Why the current shape causes friction (callers? tests? change locality?).
> - Apply the **deletion test**: would deleting concentrate complexity (it earns its keep) or just move it (it's a pass-through)?
>
> Heuristics — non-exhaustive:
>
> - **Shallow modules** — interface nearly as complex as the implementation.
> - **Pass-throughs** — file just forwards calls; deletion test would say "pass-through."
> - **Pure-for-testability extraction** — pure helper exists for tests, but real bugs hide in the wrapper that calls it (no locality).
> - **Tightly-coupled modules** — repeated import chains; one change forces N edits.
> - **Hard-to-test interfaces** — code only testable via heavy mocks, integration tests, or by reaching past the seam.
> - **Concept fragmentation** — one domain concept (per `.agents/monolith.md`) split across many modules.
>
> Return a list of 5–10 friction areas, ranked by impact. Use file paths + monolith.md vocabulary. Don't propose fixes yet — just surface friction.

---

## §3 — Investigate and Verify

### Investigate call

After the Explore agent returns, run one call with the files from its areas. Pass each path as given, relative to the working directory. Never pass a directory. Pass 40 paths at most, and say how many you left out:

```bash
dg-skills thrash investigate <path...>
```

The call prints JSON. When it exits non-zero, skip this section's attach step, say so, and continue. The skill reads these fields:

| Field | Use |
|---|---|
| `root` | Absolute path of the tree. It is `REPO` for each verifier. |
| `files[].path` | The file that the entry describes. |
| `symbols` | Symbols that the file declares. |
| `dependents` | Files that import the file. |
| `callers[].path` | File of one caller hit. |
| `callers[].line` | Line of that hit. |
| `callers[].symbol` | Symbol that the hit names. |
| `tests` | Test files that pair with the file. |
| `truncated` | `true` when the caller list of the file was cut. |

Attach the entries to the area of their file. They give each candidate its callers, dependents and tests.

### Verify task

Write one task file per candidate at `$(dg-skills stash refactor <id>.task.json)`. Its fields are `id`, `path`, `line`, `title`, `body`, `evidence`. It has no `tier`.

- `title` and `body` are statements of fact that can be checked: the files, the call counts, the deletion-test claim.
- `evidence` has 5 entries at most `{ "path", "line", "note" }`: the top caller hits (`note` is the symbol name) and the dependents (`line: null`).

The verdict file is `$(dg-skills stash refactor <id>.verdict.json)`. Launch one `dg:thrash-verify` agent per candidate, all in one message, 4 agents at most. The prompt gives `TASK`, `REPO` (the `root`, or the scope path when investigate did not run) and `VERDICT_PATH`, and has this line: `verify the facts in title and body about the code`.

The verifier has no shell step. It reads with Read, Grep and Glob and writes only the verdict file. It replies `WROTE <path> <verdict>` or `NO_REPO <id>`.

A verdict file counts only when it parses and its `id` is the id of its task. Never resume a verifier. Keep `confirmed` and `adjusted` candidates. Drop `rejected` candidates and candidates with no verdict. An `adjusted` verdict ignores its `tier` and adds its `reason` to the candidate description.

---

## §4 — Candidate Format Spec

Turn the verified candidates into **4 at most** for `AskUserQuestion` (single-select). Each candidate:

- **header** — short concept name (≤12 chars), drawn from `monolith.md` if possible.
- **label** — concept-level action ("merge X into Y intake module").
- **description** — `Files: ... | Problem: ... | Solution: ... | Benefits: ...` packed into ~300 chars. Use **locality** and **leverage** when describing benefits.
- **Verified** — `confirmed` or `adjusted`.
- **Callers** — the count of different caller paths over the files of the area, without the files of the area. Show `N+` when a file of the area is `truncated`.

Do not fill empty slots. With 2 to 4 candidates, show them all. With 1, give two options: accept it, or give my own. With 0, send a plain message with no `AskUserQuestion`: no candidate passed verification, and how many had no verdict.

The user's "Other" option (always available in `AskUserQuestion`) lets them type their own refactor target. Treat it as the chosen candidate and skip to step 4.

**GATE:** User picked one candidate (or supplied their own). If they decline each candidate with no "Other" input, exit gracefully: `"No candidate chosen. Run /dg:refactor again or pick a different scope."`
