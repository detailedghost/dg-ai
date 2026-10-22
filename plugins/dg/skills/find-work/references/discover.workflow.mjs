export const meta = {
  name: 'find-work-discover',
  description: 'Run parallel discovery scanners, then merge/dedup/rank into the top 5 actionable items',
  phases: [{ title: 'Discover', detail: '4 parallel source scanners (haiku)' }],
}

const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
const { scanners = [] } = parsedArgs || {}

const ITEMS = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source', 'title', 'effort', 'kind'],
        properties: {
          id: { type: 'string', description: 'issue #, PR #, or stable identifier; "" if none' },
          source: { type: 'string', description: 'vcs-issue | code-quality | pr-backlog | codebase-scan' },
          title: { type: 'string' },
          effort: { enum: ['patch', 'minor', 'moderate'] },
          kind: { enum: ['test-failure', 'bug', 'pr-review', 'tech-debt', 'style'] },
          file: { type: 'string', description: 'relative path or ""' },
          line: { type: 'integer', description: '0 if N/A' },
          ageDays: { type: 'integer', description: 'days since surfaced; -1 if unknown' },
          description: { type: 'string', description: '≤1 sentence' },
        },
      },
    },
  },
}

phase('Discover')

const raw = await parallel(
  scanners.map((s) => () =>
    agent(s.prompt, { label: `discover:${s.key}`, phase: 'Discover', model: 'haiku', agentType: s.agentType || 'Explore', schema: ITEMS }),
  ),
)

const answered = raw.filter(Boolean)
const silent = raw.length - answered.length
if (silent > 0) log(`${silent} of ${raw.length} scanners returned nothing.`)
if (raw.length > 0 && answered.length === 0) throw new Error('All discovery scanners returned nothing.')

const merged = answered.flatMap((r) => r.items || [])

const byKey = new Map()
for (const it of merged) {
  const key = it.id ? `id:${it.id}` : `loc:${it.file || ''}:${it.line || 0}:${it.title || ''}`
  const prev = byKey.get(key)
  if (!prev || (it.description || '').length > (prev.description || '').length) byKey.set(key, { ...prev, ...it })
}

const EFFORT = { patch: 3, minor: 2, moderate: 1 }
const IMPACT = { 'test-failure': 3, bug: 2.5, 'pr-review': 2, 'tech-debt': 1.5, style: 1 }
const recency = (d) => (d < 0 ? 0 : d <= 7 ? 2 : d <= 30 ? 1 : 0)
const score = (it) => 0.4 * (EFFORT[it.effort] || 1) + 0.4 * (IMPACT[it.kind] || 1) + 0.2 * recency(it.ageDays ?? -1)

const ranked = [...byKey.values()].sort((a, b) => score(b) - score(a)).slice(0, 5)

log(`Discovered ${merged.length} raw → ${byKey.size} deduped → top ${ranked.length}.`)
return { items: ranked }
