export const meta = {
  name: 'find-work-execute',
  description: 'Implement, test, commit, push, and draft a PR for each selected item — one isolated agent per item',
  phases: [{ title: 'Execute', detail: 'one sonnet worktree agent per selected item' }],
}

const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
const { template = '', items = [] } = parsedArgs || {}

const RESULT = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    status: { enum: ['success', 'partial', 'failed'] },
    branch: { type: 'string' },
    pr_body_draft: { type: 'string', description: 'full PR body; orchestrator opens the PR after human review' },
    summary: { type: 'string', description: '≤1 sentence' },
    error: { type: 'string', description: 'reason when partial/failed; "" otherwise' },
    tests: { type: 'object', description: 'pass/fail/skip counts; orchestrator discards unless status is partial' },
  },
}

const fill = (it) => {
  const values = {
    ITEM_TITLE: it.title || '',
    ITEM_SOURCE: it.source || '',
    ITEM_ID: it.id || '',
    ITEM_DESCRIPTION: it.description || '',
    ITEM_FILE: it.file || '',
    ITEM_LINE: String(it.line || ''),
    JIRA_TICKET: it.jira || '',
    DEFAULT_BRANCH: it.defaultBranch || '',
    WORKTREE_PATH: it.worktreePath || '',
    BRANCH_NAME: it.branch || '',
  }
  return template.replace(/\{(\w+)\}/g, (token, key) => values[key] ?? token)
}

phase('Execute')

const results = await parallel(
  items.map((it) => () => {
    const opts = { label: `exec:${(it.title || 'item').slice(0, 30)}`, phase: 'Execute', model: 'sonnet', schema: RESULT }
    return agent(fill(it), opts)
      .then((r) => ({ item: it.title, ...(r || { status: 'failed', summary: '', error: 'no result' }) }))
      .catch((e) => ({ item: it.title, status: 'failed', summary: '', error: String((e && e.message) || e) }))
  }),
)

return { results: results.filter(Boolean) }
