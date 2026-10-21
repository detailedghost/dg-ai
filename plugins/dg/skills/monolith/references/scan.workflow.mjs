export const meta = {
  name: 'monolith-scan',
  description: 'Scan codebase vocabulary with parallel scanners, consolidate via lore into a staging file',
  phases: [
    { title: 'Scan', detail: 'parallel domain/naming/concept scanners (haiku)' },
    { title: 'Consolidate', detail: 'lore synthesizes TSV into staging file' },
  ],
}

// args (built by the /monolith orchestrator — see references/protocol.md):
//   mode               'full' | 'shallow'
//   existingTerms      newline-separated known terms, or '' (APPEND hint)
//   existingFileContent full current monolith.md inlined, or '' if new
//   monolithPath       live file path (lore reads it via inlined content, never the path)
//   stagingPath        where lore writes the full updated file (= monolithPath + '.new')
//   agentTypes         { domain, naming, concept } — subagent types from the Phase 1.5 routing table
//   template           the full monolith.md markdown skeleton, inlined
const {
  mode = 'full',
  existingTerms = '',
  existingFileContent = '',
  monolithPath,
  stagingPath,
  agentTypes = {},
  template = '',
} = args || {}

const SEARCH_HIERARCHY = [
  'SEARCH HIERARCHY (use in this order — fall through only on failure):',
  '',
  '1. fff-ai MCP tools (frecency-ranked, fastest):',
  '   - mcp__fff__find_files for finding files by name/glob',
  '   - mcp__fff__grep for searching file contents (single pattern)',
  '   - mcp__fff__multi_grep for OR-logic across multiple identifiers',
  '2. ripgrep via Bash: `rg \'pattern\' path/` or `rg --files path/ | rg \'name\'`',
  '3. Built-in Grep / Glob — last resort only.',
  '',
  'NEVER use `find`, `cat`, `head`, `tail`, `ls -R`, `grep -r` for searching.',
  'Stop after 2 grep calls and READ the top-result file. More greps != better',
  "understanding. Search bare identifiers, not regex (e.g. 'PortfolioManager'",
  "not 'Portfolio.*Manager') unless you genuinely need alternation.",
].join('\n')

const KNOWN = existingTerms
  ? `\nAlready-known terms (focus on what's MISSING; don't re-list these unless you\nhave materially better info to offer):\n${existingTerms}\n`
  : ''

const EXCLUSIONS =
  'Hard exclusions (never enter these directories): .git, node_modules, vendor,\n' +
  'dist, build, target, out, anything matching *.generated.*, anything covered by\n' +
  '.gitignore at the repo root.'

const DOMAIN_PROMPT = `${SEARCH_HIERARCHY}

You are scanning a codebase for its DOMAIN vocabulary — the nouns and verbs the
business cares about. NOT generic programming concepts. NOT framework names.

${EXCLUSIONS}
${KNOWN}
Find domain terms in: ORM models / Prisma schema / SQL DDL, type definitions
(types/*, schemas/*), README + docs/*, test fixtures (for plain-English names),
and module folder names that map to business concepts.

For each term found, return one line of TSV:

  section <TAB> term <TAB> one-sentence definition (≤15 words) <TAB> relative-path-to-best-source-file <TAB> aliases-found-in-code

\`section\` must be exactly: Domain Terms

If you find the same concept named differently in different files (e.g. \`User\`
vs \`Member\`), pick the one that appears in the schema/model layer as canonical
and put the others in the aliases column (comma-separated).

If you find one term used for two distinct things (one term, two meanings),
emit a separate AMBIGUITY line:

  AMBIGUITY <TAB> term <TAB> meaning-A <TAB> meaning-B <TAB> recommended-canonical

Cap: 30 terms total. Be opinionated; if you find more, surface only the
highest-signal ones. Return ONLY the TSV lines — no prose, no preamble.`

const NAMING_PROMPT = `${SEARCH_HIERARCHY}

You are scanning a codebase for its NAMING CONVENTIONS and ARCHITECTURAL
PATTERNS. Two categories, one report.

${EXCLUSIONS}
${KNOWN}
For NAMING CONVENTIONS: file/dir naming (kebab vs snake vs Pascal), type
naming, function/hook naming, test file naming. Sources: tsconfig.json,
.eslintrc, package.json scripts, Makefile, observed file names in src/.

For ARCHITECTURAL PATTERNS: layers (controllers/services/repos), adapters,
job/worker patterns, error handling style, dependency injection style.
Sources: directory structure, framework configs, base classes, decorators.

Format per line of TSV:

  section <TAB> term <TAB> one-sentence summary (≤15 words) <TAB> relative-path-to-best-source-file <TAB> aliases-or-empty

\`section\` must be exactly: Naming Conventions or Architectural Patterns

Cap: 15 terms total across both sections. Return ONLY the TSV lines.`

const CONCEPT_PROMPT = `${SEARCH_HIERARCHY}

You are scanning a codebase for cross-cutting CONCEPTS and the
RELATIONSHIPS between domain entities.

${EXCLUSIONS}
${KNOWN}
For CONCEPTS: cross-cutting ideas that don't fit "domain noun" or "naming
rule" or "pattern" — soft-delete semantics, multi-tenancy strategy, audit
trail conventions, feature-flag system, idempotency strategy, etc.

For RELATIONSHIPS: cardinality between domain entities, drawn from foreign
keys, type composition, repository membership, and explicit ORM relations.
ONLY emit relationships you can ground in concrete evidence — do not infer
from naming similarity.

Format per line of TSV:

  CONCEPT <TAB> term <TAB> one-sentence summary (≤15 words) <TAB> relative-path-to-best-source-file <TAB> aliases-or-empty
  RELATIONSHIP <TAB> "An **X** belongs to exactly one **Y**." <TAB> evidence-source-path

Cap: 10 concepts and 10 relationships. Return ONLY the TSV lines.`

const LIGHT_PROMPT = `${SEARCH_HIERARCHY}

You are scanning a codebase to extract its native vocabulary in a single pass:
DOMAIN terms, NAMING conventions, ARCHITECTURAL patterns, cross-cutting
CONCEPTS, and entity RELATIONSHIPS.

${EXCLUSIONS}
${KNOWN}
Emit TSV lines using these exact section/row formats:

  <section> <TAB> term <TAB> one-sentence summary (≤15 words) <TAB> relative-path <TAB> aliases-or-empty
  AMBIGUITY <TAB> term <TAB> meaning-A <TAB> meaning-B <TAB> recommended-canonical
  RELATIONSHIP <TAB> "An **X** belongs to exactly one **Y**." <TAB> evidence-source-path

\`section\` is one of: Domain Terms, Naming Conventions, Architectural Patterns, Concepts.

Cap: 30 total entries across all sections + 5 relationships. Be opinionated.
Return ONLY the TSV lines — no prose.`

phase('Scan')

let scanResults
if (mode === 'shallow') {
  const out = await agent(LIGHT_PROMPT, {
    label: 'scan:shallow',
    phase: 'Scan',
    model: 'haiku',
    agentType: agentTypes.domain || 'Explore',
  })
  scanResults = [out]
} else {
  scanResults = await parallel([
    () => agent(DOMAIN_PROMPT, { label: 'scan:domain', phase: 'Scan', model: 'haiku', agentType: agentTypes.domain || 'Explore' }),
    () => agent(NAMING_PROMPT, { label: 'scan:naming', phase: 'Scan', model: 'haiku', agentType: agentTypes.naming || 'Explore' }),
    () => agent(CONCEPT_PROMPT, { label: 'scan:concepts', phase: 'Scan', model: 'haiku', agentType: agentTypes.concept || 'Explore' }),
  ])
}

const tsv = scanResults.filter(Boolean).join('\n').trim()
if (!tsv) {
  log('Scanners returned no vocabulary — nothing to consolidate.')
  return { staged: false, stagingPath, reason: 'empty-scan' }
}

phase('Consolidate')

const APPEND_BLOCK = existingFileContent
  ? `\nEXISTING FILE CONTENT (canonical — this is the current ${monolithPath}; do not\nre-fetch it from disk):\n\n${existingFileContent}\n`
  : '\nThere is no existing file — you are creating it fresh.\n'

const LORE_PROMPT = `You are consolidating raw codebase-vocabulary scan output into a single
\`monolith.md\` file. You are the ONLY writer — produce the full file content
and write it to the staging path with the Write tool.

STYLE RULES (non-negotiable):

- Define what it IS, not what it does.
- One sentence per definition. ≤15 words BEFORE the \`_src:_\` citation.
- Be opinionated — pick the canonical name; list synonyms in the Aliases column.
- Skip generic programming concepts (array, function, endpoint) unless they
  carry domain-specific meaning here.
- A term lives in exactly one section. Never duplicate.
- No code blocks, no examples, no prose paragraphs. Anywhere. Cite a path
  with \`_src:_\` and trust the reader to open the file.
- Row format: | **Term** | Definition. (avoid: X, Y) _src:_ relative/path |
  The \`(avoid: ...)\` clause is optional — include it ONLY when synonyms exist
  in the codebase; omit it entirely when none. List at most 2 aliases.
  \`_src:_\` must appear at the END of the cell.
- DO NOT escape \`<\`, \`>\`, \`_\`, \`*\` in term names with backslashes. Markdown
  table cells render those characters literally (\`<entity>State\` works fine).
- Omit \`## Relationships\` and \`## Flagged Ambiguities\` entirely if their
  source data is empty.

TEMPLATE (the exact skeleton to fill — match its section order and headers):

${template}

RAW SCAN OUTPUT (TSV — section, term, definition, source path, aliases; plus
AMBIGUITY and RELATIONSHIP lines):

${tsv}
${APPEND_BLOCK}
WRITING TASK:

Produce the FULL updated file content.

For terms that ALREADY exist in the file:
  - Default: leave the row exactly as-is. Hand edits and prior generations
    are equally canonical and must be preserved.
  - Exception: if the scan reveals MATERIALLY better information (a more
    accurate definition, a better source path, additional synonyms), you
    may propose an updated row. Only do this when the improvement is
    substantive — not for cosmetic changes.

For terms NOT in the file: add freely under the matching section.

Write the full updated file to ${stagingPath} (the staging path — NEVER write
to ${monolithPath} directly). Return a one-line summary of how many rows you
wrote per section.`

const summary = await agent(LORE_PROMPT, { label: 'consolidate', phase: 'Consolidate', model: 'sonnet', agentType: 'dg:lore' })

return { staged: true, stagingPath, summary }
