# Human Docs

People read `docs/`. Agents read `AGENTS.md` and `.agents/`. Each rule lives in one place. Agent files link to
the human docs and never repeat them.

```
docs/
  CONTRIBUTING.md        <- how a change gets in: branch, commits, PR contents, merge rules, release
  code_standards.md      <- how code must look: tools, naming, one section per language
  code_review.md         <- how a reviewer judges a PR: tiers, comment format, summary, verdict
  adr/                   <- architecture decision records for people
.agents/decisions/       <- agent rules that follow from an ADR; each file links its ADR
.github/copilot-instructions.md   <- under 4,000 characters; points to docs/code_review.md
```

## Rules

- Create a file only when it is missing. When it exists, report the gaps against these templates. Do not rewrite it.
- State only facts the repo shows: tool versions from the lock or pin files, task names from `mise.toml` or the
  build scripts, paths that exist. Use `<placeholder>` for anything you cannot find.
- State a gap as a gap, for example "No tool lints SQL in this repo yet." Never hide it.
- Two writing styles. `docs/`, and ADRs most of all, use simple English: short sentences, common words, active
  voice. `AGENTS.md` files and everything under `.agents/` are dense and terse: fragments, precise technical terms,
  no filler. State this rule in `docs/CONTRIBUTING.md`, the root `AGENTS.md` Rules, and `docs/code_review.md`.
- Before you move text out of a file, find the tests that read that file (`git grep` the file name in test folders).
  Keep what they assert, or move the assertion with the text.

## docs/CONTRIBUTING.md

Plain English, short sentences. One question per section:

1. Which branch is the default?
1. How do I start a change?
1. How do I write commits? (Conventional Commits with a scope)
1. What must every pull request include? (code, tests, docs, an ADR when a decision changes)
1. How do I write the PR description? (what, why, how to test)
1. When can I merge? (required checks, Copilot review, resolved conversations, one approval)
1. How does it get to users? (release flow and tags)
1. What if I am stuck?

Section 4 also says where decisions live: `docs/adr/` for people, `.agents/decisions/` for agents, and the two
writing styles: simple English for `docs/` and ADRs, dense and terse for `AGENTS.md` and `.agents/`.

## docs/code_standards.md

```markdown
# Code Standards

## Everywhere

- <rules that hold in every language, for example line length and indent from .editorconfig>
- Use the newest language features that the pinned versions allow.

## Lint and format tools

If a tool accepts or fixes a style on its own, it is not a review finding.

| Code | Tool | Config | Check | Fix |
| --- | --- | --- | --- | --- |
| <language> | <tool> <pinned version> (`<pin file>`) | `<config>` | `mise run <task>` | `mise run <task>` |

- <each gap: a pinned tool that no task runs, or a language with no linter>

## Naming

| Code | Rule | Examples |
| --- | --- | --- |
| C# types, methods, properties | PascalCase | `<real example>` |
| TypeScript variables, functions | camelCase | `<real example>` |
| TypeScript and React file names | kebab-case | `<real example>` |
| Database tables, columns | snake_case | `<real example>` |

## <Language> (`<path>`)

- <language and runtime version>. Use the current features where they make the code shorter and clearer.
- <rules a reviewer can check>
```

Keep only the rows and sections for languages the repo uses. Take each example from the repo.

## docs/code_review.md

This file copies the `/dg:thrash --spice 5` review, so people, Copilot, and agents judge a PR the same way.

- **What to check:** every changed line against `CONTRIBUTING.md` and `code_standards.md`. The change keeps
  `mise run ci` (or the repo's full check task) green. Flag a weakened, skipped, or deleted check or test. Do not flag
  style that the tool configs accept.
- **Tiers:** a table with 💀 Critical, 🔥 High, ⚠️ Medium, 🧹 Low, and 🔬 Nit, and when to assign each. The finding alone
  sets the tier, never the PR size.
- **Comment format:** `🔥 **High** <one-sentence problem>. <why it matters>. <the fix>.`
- **Summary:** headed `Code Review`, with no peppers. Use a `[!NOTE]` What changed, a `[!TIP]` Strengths, a
  `[!WARNING]` Opportunities, then the tally line and the verdict.
- **Verdict:** approve only with 0 critical, 0 high, 0 medium, and at most 4 low. Otherwise request changes.
- **Tone:** direct and specific. Aim at the code, never at a person.
- **Writing style:** flag an ADR or `docs/` page that is not simple English, and an `AGENTS.md` or `.agents/` file
  with filler prose.

## .github/copilot-instructions.md

Copilot code review reads only the first 4,000 characters, so keep the file short:

```markdown
# GitHub Copilot Instructions

## Code review scope

Do not review files under `.agents/`. That folder holds AI agent files. It is not product code.

## How to review

Read `docs/code_review.md` before you review, and follow it exactly. It points to `docs/CONTRIBUTING.md` and
`docs/code_standards.md`, so read those too.

`mise.toml` defines every lint, format, build, and test check. Use its tasks and the tool configs it names, not your
own style rules.
```

## .agents/decisions/

One file for each ADR that changes how an agent works, with the same number and slug as the ADR:

```markdown
# <NNNN> — <ADR title>

ADR: [docs/adr/<NNNN>-<slug>.md](../../docs/adr/<NNNN>-<slug>.md)

- <agent rule that follows from the decision, one line each>
```

Do not repeat the ADR's context or alternatives. Cite a decision by number and do not argue it again.
