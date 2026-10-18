export const meta = {
  name: 'hunt-threads',
  description: 'Run parallel evidence-gathering threads, then adversarially verify each root-cause claim',
  phases: [
    { title: 'Investigate', detail: 'one agent per independent thread' },
    { title: 'Verify', detail: 'skeptic confirms each claim against the cited lines' },
  ],
}

// args (built by /hunt orchestrator after triage — see references/protocol.md):
//   threads      [{ id, agentType, prompt }]  — ≤3, each self-contained
//   monolithHint string appended to every prompt, or '' when no monolith.md
//   verify       bool — run the Verify stage (default true)
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
const { threads = [], monolithHint = '', verify = true } = parsedArgs || {}

const FINDING = {
  type: 'object',
  required: ['rootCause', 'evidence', 'confidence', 'needsDesignDecision'],
  properties: {
    rootCause: { type: 'string', description: 'root cause in ≤3 sentences with file:line refs' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ref', 'shows'],
        properties: {
          ref: { type: 'string', description: 'file:line, git SHA, or log line' },
          shows: { type: 'string', description: 'what it proves, ≤20 words' },
        },
      },
    },
    confidence: { enum: ['high', 'medium', 'low'] },
    needsDesignDecision: { type: 'boolean', description: 'true if the fix requires an unmade design decision (→ /grill-me)' },
  },
}

const VERDICT = {
  type: 'object',
  required: ['confirmed', 'note'],
  properties: {
    confirmed: { type: 'boolean', description: 'did reading the cited lines confirm the root cause?' },
    note: { type: 'string', description: 'what the lines actually showed, ≤25 words' },
  },
}

phase('Investigate')

// Pin fan-out off session Opus: deep-reasoning domains keep opus, rest → sonnet.
const modelFor = (a) => (a === 'security' || a === 'dba' ? 'opus' : 'sonnet')

const results = await pipeline(
  threads,
  (t) =>
    agent(`${t.prompt}${monolithHint ? `\n\n${monolithHint}` : ''}`, {
      label: `hunt:${t.id}`,
      phase: 'Investigate',
      model: t.model || modelFor(t.agentType),
      agentType: t.agentType || 'Explore',
      schema: FINDING,
    }),
  (finding, t) => {
    if (!finding || !verify) return finding ? { ...finding, verified: null } : null
    return agent(
      `Adversarially verify this diagnosis by READING the cited lines yourself — do not trust the summary.\n\n` +
        `Claimed root cause: ${finding.rootCause}\n` +
        `Cited evidence:\n${finding.evidence.map((e) => `- ${e.ref}: ${e.shows}`).join('\n')}\n\n` +
        `Open each ref. Default to confirmed=false if the lines don't actually support the claim.`,
      { label: `verify:${t.id}`, phase: 'Verify', model: 'sonnet', agentType: t.agentType || 'Explore', schema: VERDICT },
    ).then((v) => ({ ...finding, threadId: t.id, verified: v }))
  },
)

return { findings: results.filter(Boolean) }
