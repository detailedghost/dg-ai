# Duplicate sweep

Finds a different failure mode than steps 1-6: not "this entry point is too big" but "this SKILL.md section
restates facts its own references/*.md file already has at comparable or greater depth" — two copies of the
same content that will silently drift the next time one gets edited and the other doesn't.

This is **not** about flagging normal progressive disclosure. A short summary + "read references/foo.md for
details" is the intended pattern, not a finding. The bar: could the inline text shrink to a one-line pointer
or a bare list of names, at the point where it sits, without losing anything a reader needs *right there*?
If yes — genuine duplicate. If the inline text is doing a different job (unconditional control-flow every
invocation needs, a briefing block that gets pasted verbatim into a sub-agent prompt, a flag reference a
user needs without opening another file) — not a finding, even if it overlaps in topic.

Calibration example (fixed this way already, in this skill estate):

1. `polish/SKILL.md` had a "Dimensions" section listing all 9 dimensions with full descriptions (512 tok) —
   `polish/references/dimensions.md` already had the same 9 with *more* detail (canonical smells, examples),
   and was already read at the exact point of use (Process step 3) regardless. Fix: shrunk inline to bare
   names, made the reference the sole source of full text.
2. A skill with an "External review" section (overview + 4 numbered steps) whose
   `references/external.md` has the same overview + 5 more-detailed steps covering identical ground — the
   fix is to delete the inline section and keep only a routing-table pointer.

## Cost

This step is subagent-driven content comparison, not a script — there's no mechanical way to detect
"restates the same facts." Each agent needs to read a skill's SKILL.md and every file under its references/
in full, which is expensive relative to steps 1-6 (near-free CLI calls). A full estate sweep run
this way costs roughly 500-700k tokens across several parallel agents. Scope it:

- **Touched skills only** (after a step 5 restructure) — cheap, usually 1-4 skills.
- **Named skills** — whatever the invocation specified.
- **Whole estate** — only when nothing was named and the user explicitly wants the broad sweep; say the rough
  cost out loud before launching (per the global token-cost gate), since this is well above steps 1-6's cost.

## Running it

1. List candidate skills: anything with a `references/` directory containing at least one `.md` file.
   Exclude `[vendor]` skills unless explicitly named (same rule as step 4).
2. Batch them for parallel agents — group so each agent reads roughly 10-15 reference files total (a skill
   with 10+ reference files gets its own agent; small skills batch 3-8
   together). Use the Agent tool, `model: sonnet` (judgment task — is this really the same content — not
   mechanical, so not haiku), one call per batch, all launched **in a single message** so they run
   concurrently. Do not use the Workflow tool here unless the user has separately opted into workflow
   orchestration for this session.
3. Prompt each agent with:
   - The pattern definition and calibration example above (copy them in — the agent starts with no context).
   - The exact skill list for its batch.
   - Instructions: read SKILL.md in full, read every references/*.md file in full, compare each SKILL.md
     section that has (or logically maps to) a references/ pointer against that file's coverage of the same
     ground.
   - Report format per finding: skill, SKILL.md section, reference file, a short description or quote showing
     the overlap, a token estimate of the inline duplicate, and a confidence call — **CONFIRMED** (safe to
     shrink/cut) vs **UNCERTAIN** (looks similar but may serve a distinct purpose — the agent must say why).
   - Explicit: investigation only, no edits.
   - Ask for a compact report — skills with nothing worth flagging noted in one line, not narrated in full.
4. Collect all batch reports and merge into one findings list before presenting anything to the user.

## After the sweep

Same discipline as steps 4-6, not a free-for-all:

1. **Report.** Present CONFIRMED findings as the primary list; mention UNCERTAIN ones separately with the
   agent's stated reasoning, but don't pre-select them.
2. **Pick.** AskUserQuestion, multiSelect, over the CONFIRMED findings (and any UNCERTAIN ones the user wants
   included after reading the reasoning). None picked → done.
3. **Apply.** These are hand-edits, not `~/.dg/bin/dg-skills skill-split` moves — the fix is usually "shrink to a pointer" or
   "delete the redundant part," not a section relocation. Before cutting anything: verify **every fact** in
   the inline text you're about to remove is actually present in the reference file (fact-by-fact — re-read
   both side by side, don't trust the sweep agent's summary as sufficient proof). If the inline text has any
   fact the reference lacks, keep that fact — fold it into the reference or leave a trimmed remainder, never
   silently drop it. Fix any dangling `above`/`below`/named-section cross-references the edit creates (same
   check as `references/protocol.md` step 6).
4. **Verify.** Re-run `~/.dg/bin/dg-skills skill-audit` on touched skills (broken links, entry size) and manually grep the
   touched files for `above`/`below` to confirm no cross-reference was left dangling.

## A duplicate sweep can also surface plain bugs, not just style

If two copies of "the same fact" actually disagree (e.g. one file says a default is 3, the other says 2),
that's a documentation defect, not a style judgment — flag it clearly as a factual inconsistency needing a
decision on which value is correct, separate from the token-cleanup findings. Don't fold it into a
CONFIRMED/UNCERTAIN token-savings bucket; it needs the user's or a maintainer's call on which value is right,
then both copies get corrected (or one gets removed) to match.
