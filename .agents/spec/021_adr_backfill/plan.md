---
feature: "ADR backfill: opt dg-ai into dg-skills adr"
feature_snake_case: adr_backfill
date: "2026-11-20"
version: "1.0"
status: in-progress
current_slice: 6
pr_strategy: single
slices:
  - id: 1
    name: "opt-in-and-normalize"
    depends_on: []
    files: ["docs/adr/toc.md", ".agents/decisions/README.md", "docs/adr/0[0-9][0-9][0-9]-*.md"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: medium
  - id: 2
    name: "backfill-0001-0019"
    depends_on: [1]
    files: ["docs/adr/000*.md", "docs/adr/001*.md", ".agents/decisions/000*.md", ".agents/decisions/001*.md"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: medium
  - id: 3
    name: "backfill-0020-0029"
    depends_on: [1]
    files: ["docs/adr/002*.md", ".agents/decisions/002*.md"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: medium
  - id: 4
    name: "backfill-0030-0039"
    depends_on: [1]
    files: ["docs/adr/003*.md", ".agents/decisions/003*.md"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: medium
  - id: 5
    name: "backfill-0040-0051"
    depends_on: [1]
    files: ["docs/adr/004*.md", "docs/adr/005*.md", ".agents/decisions/004*.md", ".agents/decisions/005*.md"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: medium
  - id: 6
    name: "index-tests-verify"
    depends_on: [2, 3, 4, 5]
    files: ["docs/adr/toc.md", "docs/adr/template.md", ".agents/decisions/README.md", "pkg/skills-test/__tests__/job-model-docs.spec.ts", "pkg/skills-test/__tests__/dg-front-door-docs.spec.ts", "pkg/skills-test/__tests__/outside-services-docs.spec.ts", "pkg/skills-test/__tests__/pairing-docs.spec.ts", "pkg/skills-test/__tests__/demo-skill.spec.ts", "pkg/skills-test/__tests__/blt-gate.spec.ts", "pkg/skills-test/__tests__/agents-memory.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:reviewer]
execution:
  profile: balance
---

# ADR backfill: opt dg-ai into dg-skills adr

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

### Slice 1 — opt-in-and-normalize

#### Engineering
- [x] `git mv docs/adr/0046-pw-ext-network.md docs/adr/0051-pw-ext-network.md`; change its H1 number to 0051; fix the toc.md link; `rg 0046-pw-ext-network docs pkg plugins` returns nothing
- [x] Edit toc.md: keep the intro and the "How the pieces fit" Mermaid diagram, keep "Adding an ADR" with the template link replaced by `/dg:adr`, then put `<!-- adr:index -->` on its own line; the old group lists stay below the marker for now
- [x] Run `dg-skills adr init --level high-school`; confirm `.agents/decisions/README.md` frontmatter is `level: high-school`
- [x] Write the normalizer as a Bun script under `$(dg-skills stash -s adhoc adr-backfill)`; it reads each ADR's toc group before the toc is regenerated and, for all 51 files: strips the H1 number prefix, inserts `Topic: <group>` after `Date:`, renames `Alternatives considered` to `Other options` and `Diagrams` to `Diagram`, and changes nothing else
- [x] Fix 0001 by hand: `Status: Accepted` and `Date: 2026-10-16` header lines in place of `## Status`; empty `## Diagram` and `## Other options` stubs are left for slice 2
- [x] Write the covers check and the diff check scripts in the same adhoc dir; the diff check compares each file with `git show origin/master:<old path>` (0051 maps to the old 0046 network path)
- [x] Write the Topic table (number, title, topic) into the PR body draft notes in the adhoc dir for slices 2 to 6

#### Testing Criteria
##### Contracts
- [x] Contract: every ADR has Status, Date and Topic header lines and an H1 with no leading number
- [x] Contract: the diff check reports zero lost Status, Date, amendment line, backticked path or relative link after the normalizer
- [x] `dg-skills adr lint --all` findings are only `missing-pair`, `stale-index`, `missing-mermaid` (0001, 0041), `missing-section` (0001) and `grade-too-high` (0007)
- [x] No two files in docs/adr share a number

#### Acceptance Criteria
- [x] Given `.agents/decisions/README.md`, then its frontmatter is `level: high-school`
- [x] Given docs/adr, when I list it, then 0051-pw-ext-network.md exists and only one 0046 file remains

### Slice 2 — backfill-0001-0019

#### Engineering
- [x] Write 19 decision files (0001 to 0019) per plugins/dg/skills/adr/references/write-decision.md: `covers:` globs that match tracked files, the `[ADR NNNN](../../docs/adr/NNNN-slug.md)` line, imperative one-line rules, at most 25 non-blank lines
- [x] Fill 0001's `## Diagram` (one Mermaid block that shows the mechanism) and `## Other options` from its existing text
- [x] Rewrite 0007 to grade 10 or lower without dropping a fact, or set `Level: technical` with a reason line for the PR body (pending RATIFY)
- [x] Keep every decision, fact, status, date, amendment line and code path; run the diff check and the covers check on this range
- [x] Do not run `adr index`; do not touch toc.md or README.md

#### Testing Criteria
##### Contracts
- [x] Contract: `adr lint --all --json` filtered to this range's files has no finding other than `stale-index`
- [x] Diff check: zero losses for 0001 to 0019; covers check: every glob matches at least one tracked file
- [x] `dg-skills adr relevant pkg/dg-daemon/<one tracked file>` lists 0002

#### Acceptance Criteria
- [x] Given ADRs 0001 to 0019, then each has a paired decision file and passes lint apart from the index

### Slice 3 — backfill-0020-0029

#### Engineering
- [x] Write 7 new decision files (0020, 0021, 0025 to 0029) per write-decision.md
- [x] Convert 0022, 0023, 0024: add `covers:` frontmatter, keep the rules verbatim, replace the `ADR:` line with the relative link line; stay within 25 non-blank lines
- [x] Keep every fact; run the diff check and covers check on this range; no `adr index`

#### Testing Criteria
##### Contracts
- [x] Contract: `adr lint --all --json` filtered to this range's files has no finding other than `stale-index`
- [x] Diff check: zero losses for 0020 to 0029; covers check passes; the rules of 0022 to 0024 match origin/master line for line

#### Acceptance Criteria
- [x] Given ADRs 0020 to 0029, then each has a paired decision file and passes lint apart from the index

### Slice 4 — backfill-0030-0039

#### Engineering
- [x] Write 10 decision files (0030 to 0039) per write-decision.md; long ADRs (0034, 0035, 0038, 0039) still fit 25 non-blank lines: keep only rules an agent must follow
- [x] Keep every fact; run the diff check and covers check on this range; no `adr index`

#### Testing Criteria
##### Contracts
- [x] Contract: `adr lint --all --json` filtered to this range's files has no finding other than `stale-index`
- [x] Diff check: zero losses for 0030 to 0039; covers check passes
- [x] `dg-skills adr relevant` on one `pkg/extension` path returns at least one decision

#### Acceptance Criteria
- [x] Given ADRs 0030 to 0039, then each has a paired decision file and passes lint apart from the index

### Slice 5 — backfill-0040-0051

#### Engineering
- [x] Write 12 decision files (0040 to 0045, 0046 webmcp, 0047 to 0050, 0051 network) per write-decision.md
- [x] Add one Mermaid block to 0041's `## Diagram` that shows the unmask grant flow from its existing text
- [x] Keep every fact; run the diff check (0051 against the old 0046 network file) and covers check on this range; no `adr index`

#### Testing Criteria
##### Contracts
- [x] Contract: `adr lint --all --json` filtered to this range's files has no finding other than `stale-index`
- [x] Diff check: zero losses for 0040 to 0051; covers check passes
- [x] `dg-skills adr relevant` on one `pkg/skills-cli` path returns at least one decision

#### Acceptance Criteria
- [x] Given ADRs 0040 to 0051, then each has a paired decision file and passes lint apart from the index

### Slice 6 — index-tests-verify

#### Engineering
- [x] Remove the old group lists below the marker and run `dg-skills adr index`; delete `docs/adr/template.md`
- [x] Update the specs to the generated toc: `### <Topic>` groups, `- [NNNN — Title](file)` lines with no status summary, H1 with no number (job-model-docs `^# 0049 — `, toc entry and amendment assertions; outside-services Platform entry; pairing-docs template read and 0037/0038/0039/0004 toc rows; dg-front-door toc tests; demo-skill 0029 URL; blt-gate toc path)
- [x] Keep each spec's intent (record listed once, under the right topic, status in the ADR file); do not weaken an assertion to pass
- [x] Run the diff check and covers check over all 51 pairs and paste both outputs and the per-ADR summary/Level notes into the PR body draft
- [x] Run `dg-skills adr lint --all` until it exits 0; run `dg-skills adr index` a second time and confirm no diff

#### Testing Criteria
##### Contracts
- [x] Contract: `dg-skills adr lint --all` exits 0 in dg-ai
- [x] Contract: `dg-skills adr index` run twice changes nothing
- [x] `bun test` in `pkg/skills-test` passes, including the markdown link tests
- [x] Reviewer scope: lint output, the diff-check output, and a 10 percent read of grade versus meaning

#### Acceptance Criteria
- [x] Given a changed file in `pkg/dg-daemon`, when I run `adr relevant` on it, then 0002 comes back; the same holds for one extension path and one skills-cli path
- [x] Given `docs/adr/toc.md`, then every ADR sits under the `### <Topic>` of its old toc group and no two ADRs share a number
- [x] Given `docs/chat.md` and `docs/channel-review.md`, then their `toc.md#security`, `#channel-review` and `#automation` links resolve

## Slice Summaries
- Slice 1: renumbered pw-ext-network to 0051, added the index marker and README (level high-school), normalized 51 ADR headers and headings with a script; diff check 0 losses.
- Slice 2: 19 decisions for 0001-0019; 0001 diagram and Other options filled; 0007 reworded to grade 6.7; 0018 given Consequences, Diagram and Other options from its own text. `adr relevant pkg/dg-daemon/src/store/index.ts` lists 0002.
- Slice 3: 7 new decisions (0020, 0021, 0025-0029); 0022-0024 converted with every rule line identical to origin/master.
- Slice 4: 10 decisions for 0030-0039 with amendments as the live state. `adr relevant pkg/extension/lib/background/pw-ext.ts` returns 0035, 0041, 0044.
- Slice 5: 12 decisions for 0040-0051; 0041 diagram filled. `adr relevant pkg/skills-cli/src/thrash/checkout.ts` returns 0042.
- Slice 6: adr index wrote both indexes; template.md deleted; Diagram moved before Other options in 49 ADRs; five docs specs updated. adr lint --all exits 0, a second adr index changes nothing, skills-test 1806 pass.

## Agent Notes
- (owner, 2026-11-20) RATIFY Topic: map the 11 ADRs of the old "Proposed changes" group (0018, 0019, 0021-0024, 0026, 0027, 0033, 0034, 0036) to subject topics: Channel review, Skills or Installation. Edit dg-front-door-docs or any test that pins this.
- (owner, 2026-11-20) RATIFY H1: remove `NNNN — ` from all 51 H1s and update job-model-docs.spec.ts.
- (owner, 2026-11-20) RATIFY 0007: rewrite to grade 10 or lower. Do not use `Level: technical`.
- (owner, 2026-11-20) RATIFY toc: keep the "Adding an ADR" text above the marker, pointing to `/dg:adr` instead of the template.
- (owner, 2026-11-20) Structure-only edits. No full prose rewrite.
- (slice 1, orchestrator) Topic map for the old Proposed changes group: 0018 and 0019 to Channel review; 0021, 0022, 0023, 0024, 0033 and 0034 to Skills; 0026, 0027 and 0036 to Installation.
- (slice 1, orchestrator) 0018 has no Consequences, Diagram or Other options section; its mermaid sits under Source evidence. Slice 2 adds the three sections from its existing text (structure only).
- (slice 1, orchestrator) toc.md gets a `## Records` heading above the marker so the generated `### <Topic>` groups have a parent. Empty `## Diagram` stubs were added to 0001 and 0041.
- (slice 1, orchestrator) Lint after slice 1: missing-pair x48, stale-index x2, missing-covers x3 (0022-0024), missing-mermaid (0001, 0041 stubs), missing-section x3 (0018), grade-too-high (0007). No broken links, no duplicate numbers.
- (slice 1, orchestrator) `dg-skills spec perms-batch --grant-all` was refused by the auto mode classifier. The orchestrator commits each slice by hand.
- (slice 3, dg:lore) Dead paths dropped from covers: 0025 uses phone/migrate.ts for the gone migrate-home.ts; 0028 drops the untracked browser SKILL.md; 0029 drops the untracked demo/bridge.ts. The ADR bodies still name them as text.
- (slice 4, dg:lore) 0036 covers `pkg/skills-cli/src/install/**` in place of the gone migrate-home.ts; 0038 drops the gone pair-offers.ts.
- (slice 5, dg:lore) 0051 leaves out small details to fit 25 lines: storage read defaults, hook size details, exec env trimming, the stop signal order.
- (slice 6, dg:js) The ADRs had Other options before Diagram, the reverse of the tool template. The orchestrator swapped the two sections (no text change) and kept the exact heading-order check in pairing-docs.
- (slice 6, dg:js) hooks-skill and recommended-plugins-docs also read toc.md; recommended-plugins-docs needed an update, hooks-skill did not.

## Issues Remediation

## Open decisions
- Decided (owner, 2026-11-20): strip `NNNN — ` from all 51 H1s and update job-model-docs.
- Decided (owner, 2026-11-20): map the 11 old Proposed changes ADRs to Channel review, Skills or Installation, and edit the tests that pin the group.
- Decided (owner, 2026-11-20): rewrite 0007 to grade 10 or lower, with no `Level: technical`.
- Decided (owner, 2026-11-20): keep the "Adding an ADR" text above the marker, pointing to `/dg:adr`.
- Decided: `## References` and every amendment section stay verbatim. Lint checks only that the five template sections exist, and outside-services-docs reads the References section of 0043.
- Decided: the renumber target is 0051, the next free number on master. 0049 and 0050 are taken, and no open PR adds an ADR.
- Decided: batch slices own decade ranges (000 to 001, 002, 003, 004 to 005), because lint-waves treats globs with a shared literal prefix as overlapping. Only slice 6 runs `adr index`.
