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

const fill = (it) =>
  template
    .replaceAll('{ITEM_TITLE}', it.title || '')
    .replaceAll('{ITEM_SOURCE}', it.source || '')
    .replaceAll('{ITEM_ID}', it.id || '')
    .replaceAll('{ITEM_DESCRIPTION}', it.description || '')
    .replaceAll('{ITEM_FILE}', it.file || '')
    .replaceAll('{ITEM_LINE}', String(it.line || ''))
    .replaceAll('{JIRA_TICKET}', it.jira || '')
    .replaceAll('{DEFAULT_BRANCH}', it.defaultBranch || '')
    .replaceAll('{WORKTREE_PATH}', it.worktreePath || '')
    .replaceAll('{BRANCH_NAME}', it.branch || '')

phase('Execute')

const results = await parallel(
  items.map((it) => () => {
    const opts = { label: `exec:${(it.title || 'item').slice(0, 30)}`, phase: 'Execute', model: 'sonnet', schema: RESULT }
    return agent(fill(it), opts).then((r) => ({ item: it.title, ...(r || { status: 'failed', summary: '', error: 'no result' }) }))
  }),
)

return { results: results.filter(Boolean) }
