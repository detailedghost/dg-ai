---
name: refactor
description: Find architectural deepening opportunities in the current codebase. Walks the code, surfaces up to 4 verified high-leverage refactor candidates (or accepts your own), then drops into a /dg:grill-me design conversation on the chosen one. Hands off to /dg:kick when the design converges. Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make a codebase more testable.
---

First run: install or refresh the CLI when it is missing or too old. Each Bash call works alone:

```bash
{ dg-skills stash --help >/dev/null 2>&1 &&
  dg-skills thrash --help 2>/dev/null | grep -q investigate; } ||
  { "${DG_HOME:-$HOME/.local}/bin/dg-skills" stash --help >/dev/null 2>&1 &&
  "${DG_HOME:-$HOME/.local}/bin/dg-skills" thrash --help 2>/dev/null | grep -q investigate; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg-skills` in every later step. If a bare name does not answer, also after the bootstrap, call it by its `${DG_HOME:-$HOME/.local}/bin` path instead.

If a step fails, run dg-skills doctor stash thrash.

# /dg:refactor — Codebase Architecture Improvement

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. Goal: testability, locality, AI-navigability.

## Arguments

| Form | Effect |
|---|---|
| `/dg:refactor` | Walk the current working directory. |
| `/dg:refactor <path>` | Scope the walk to `<path>` (relative to cwd or absolute). |

## References (lazy-load)

| File | When to read |
|---|---|
| [references/language.md](references/language.md) | Step 1 — always. Architecture vocabulary and key principles. |
| [references/discovery.md](references/discovery.md) | Step 1 — always. Domain context read order, Explore brief, investigate and verify steps, candidate format. |
| [references/deepening.md](references/deepening.md) | Step 4 — classify dependencies for the chosen candidate. |
| [references/design-handoff.md](references/design-handoff.md) | Step 4 — after candidate selected. Design conversation template, hand-off mechanics, rules. |
| [references/interface-design.md](references/interface-design.md) | Step 4 — only when multiple interfaces are plausible; parallel sub-agent protocol. |

## Phase Sequence

1. **Domain context** — read project context files and architecture vocabulary.
2. **Explore** — launch Explore agent on scope path. Returns 5–10 friction areas ranked by impact. Then run one `dg-skills thrash investigate` call with the files that the Explore agent named. Pass the paths as given, relative to the working directory. Never pass a directory. Pass 40 paths at most, and say how many paths you left out. Attach the dependents, callers and tests to each area. The verb has no time budget. When the call exits non-zero (for example: not a git repository), skip the attach step, say so, and continue.
3. **Verify and present candidates** — synthesize 4 at most candidates. Before you show them, launch one `dg:thrash-verify` agent per candidate, all in one message (one agent for each of the 4 at most). `REPO` is the `root` of the investigate JSON, or the scope path when investigate did not run. Make no checkout. Do not fill the candidates up again after verification. Show only the candidates with a `confirmed` or `adjusted` verdict. Do not show a candidate with a `rejected` verdict or with no verdict. An `adjusted` verdict keeps the candidate, ignores a verdict `tier`, and adds the verdict `reason` to the candidate description. A verdict file counts only when it parses and its `id` is the id of its task. Never resume a verifier. Present the candidates through `AskUserQuestion` (single-select, plus the automatic "Other"):
   - 2 to 4 verified candidates: show them all.
   - 1 verified candidate: `AskUserQuestion` has two options, accept it or give my own.
   - 0 verified candidates: send a plain message, with no `AskUserQuestion`. Say that no candidate passed verification and how many had no verdict. Then wait for the user's own candidate.

   **GATE:** user picks one or supplies their own via "Other."
4. **Design conversation** — invoke `/dg:grill-me` with chosen candidate. **GATE:** Final Summary confirmed.
5. **Hand-off** — write design summary; ask: park the build (`/dg:kick`) or print only. **GATE:** summary file written.
