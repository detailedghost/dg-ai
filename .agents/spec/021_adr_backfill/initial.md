# ADR backfill: opt dg-ai into dg-skills adr — Initial Notes

## Purpose
Opt dg-ai into the decision records tool from bundle 020. Give every numbered ADR in docs/adr the simple template and a paired agent decision in .agents/decisions, fix the duplicate number 0046, and make `dg-skills adr lint --all` exit 0. After this PR, agents read short decisions through `adr relevant` and land's `adr lint --changed` gate is live in dg-ai.

## Scope
### Included
- Master holds 51 ADR files (0001 to 0050, with 0046 used twice) and 3 decision files (0022, 0023, 0024). The backfill writes 48 new decision files and converts 3. The brief's 49 and 46 are stale.
- Renumber `docs/adr/0046-pw-ext-network.md` to `0051-pw-ext-network.md` (0049 and 0050 are taken); fix its H1 and its one inbound link (toc.md). `0046-webmcp-approvals-apart-from-pw-ext.md` keeps its number and its five inbound links.
- `dg-skills adr init --level high-school` after toc.md gets the `<!-- adr:index -->` marker; README frontmatter `level: high-school`
- Header lines Status, Date, Topic on every ADR; Level only when overridden (`Level: technical` allowed, one-line reason per ADR in the PR body)
- Topic per ADR = its current toc group heading (Installation, Platform, Security, Channel review, Automation, Proposed changes, Skills); 0051 takes Skills from the old 0046 network entry. Topic names stay as they are so links like `toc.md#security`, `#channel-review` and `#automation` keep working.
- Strip the `NNNN — ` or `NNNN. ` prefix from every H1, because `adr index` prints the number itself (pending RATIFY)
- Rename `## Alternatives considered` to `## Other options` and `## Diagrams` to `## Diagram`; keep `## References` and every `## Amended …` / `## Amendment …` section verbatim
- Add a Mermaid block to 0001 and 0041 (the only two without one); give 0001 `Status: Accepted` and `Date: 2026-10-16` lines in place of its `## Status` section
- 48 new decision files with `covers:` globs, the ADR link line and terse imperative rules; at most 25 non-blank lines below the frontmatter (`decision-too-long`); a decision with no agent rules says `No agent rules.`
- Convert 0022, 0023, 0024: add `covers:` frontmatter, keep rules verbatim, replace the `ADR:` line with the relative link line
- The toc per-ADR summary lines drop with the generated index; each summary moves into its decision's first rule or is dropped, stated per ADR in the PR body
- Delete `docs/adr/template.md`; keep the toc intro, the "How the pieces fit" diagram and the "Adding an ADR" guidance (minus the template link, pointing to `/dg:adr`) above the marker
- Update the six skills-test specs that read docs/adr: job-model-docs, dg-front-door-docs, outside-services-docs, pairing-docs, demo-skill, blt-gate (plus agents-memory only if it breaks)
- One-time Bun scripts in the state dir (`dg-skills stash -s adhoc adr-backfill`, not committed): a header/heading normalizer, a covers check, and a diff check of Status, Date, amendment lines, backticked paths and relative links old vs new
- One PR; `dg-skills adr index` and `dg-skills adr lint --all` exit 0
### Excluded
- A full prose rewrite of ADRs that already grade 10 or lower (50 of 51 do today); only 0007 (grade 11.9) needs wording work
- Any change to `pkg/skills-cli/src/adr/**` (the tool from 020 is used as is)
- A CI job for adr lint; adr init in other repos
- A new ADR for any other feature in this PR (numbers would collide)
- Rewording old spec bundles that name `0046-pw-ext-network` (history)
