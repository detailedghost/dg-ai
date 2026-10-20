# Viz Payload Schema

Write to `$("$DG" stash -G viz <slug>/payload.json)` (the temp `VIZ_DIR`). viz is **ephemeral and environment-agnostic** — everything lives in the temp dir, nothing is persisted (`--keep` is deprecated/ignored).

## Required fields

```json
{
  "template": "plan",
  "slug": "my-slug",
  "title": "Title",
  "subtitle": "optional",
  "date": "2026-06-17",
  "session_id": "optional — auto-stamped by render"
}
```

`template` is an **optional hint** — the board derives its render mode (`planning` / `implementation` / `recap`) from payload state. `template: "recap"` forces recap/read-only; `template: "spec"` enables spec sections (slices, contracts, roundtable) and blocks `"$DG" viz phase`.

`session_id` records which Claude Code session produced the plan (shown in the header). The render command auto-stamps it (from `$CLAUDE_SESSION_ID` or the newest transcript in the cwd's project dir) when absent — set it explicitly to override.

`static` (optional boolean, default `false`) disables the live-refresh poller. Non-static boards poll `/api/status` every 2.5s and swap `#viz-main` (or full-reload) on any payload/tracks mtime change — correct for boards driven live via `"$DG" viz track/respond/merge`, but for a read-only explainer/diagnosis board it makes the page appear to reload whenever anything re-touches `payload.json`. Set `"static": true` on those to opt out entirely.

**Sections are registry-driven.** Every field below is rendered when present; the registry's `applies(payload)` determines which sections appear in the TOC and board.

## plan template

```json
{
  "phases": [{"id":"p1","label":"Phase 1","status":"pending","description":"...","dependencies":[],"agents":{"primary":"js","qa":["security"]}}],
  "risks": [{"severity":"high","title":"...","body":"..."}],
  "decisions": [{"question":"...","answer":"","rationale":"","options":["A","B"]}],
  "checklist": [{"id":"ac-1","text":"...","done":false}],
  "open_questions": ["..."],
  "start_command": "/pickup my-slug",
  "live_command": "…optional override for the live-update command shown when complete"
}
```

`phases[].status`: `pending | in_progress | done | partial | blocked | skipped`. `in_progress` marks a phase as actively being implemented (pulsing dot, highlighted row, counted as half-done in the bar). `phases[].agents` (`{primary, qa[]}`) renders assigned-agent chips on the phase.

**Progress bar is phase-aware.** While decisions/open-questions remain, the bar shows **Planning** progress (answered / total). Once all are resolved it flips to **Implementation** progress (phase completion) and the planning sections collapse. Drive implementation live with `"$DG" viz phase <slug> <phase-id> <status>` — the open board refreshes in place.

**Start-work banner.** When a plan's decisions are all resolved (or a spec is `complete`), the board shows a copyable start command (`start_command`, default `/pickup <slug>`) plus a live-update variant that streams phase status back into the board. Override either with `start_command` / `live_command`.

## recap template (adds)

```json
{
  "completion_pct": 72,
  "blockers": ["..."],
  "next_steps": ["..."]
}
```

## spec template (for /spec)

```json
{
  "template": "spec",
  "spec_status": {"status": "in-progress", "version": "0.3", "date": "2026-06-17", "feature": "api-keys"},
  "scope": {"inScope": ["..."], "outOfScope": ["..."], "assumptions": ["..."]},
  "slices": [{"id": 1, "name": "...", "status": "pending", "description": "...", "dependsOn": [], "agents": {"primary": "js", "qa": ["security"]}}],
  "contracts": [{
    "slice": "Slice 1 — ...",
    "sliceId": 1,
    "endpoints": [{"method": "POST", "path": "/v1/...", "auth": "session"}],
    "requestFields": [{"field": "name", "type": "string", "required": true, "assumed": false}],
    "successResponse": {"status": 201, "body": "{ ... }"},
    "errorResponses": [{"status": 422, "body": "{ error }", "trigger": "..."}],
    "interfaces": [{"signature": "fn(...): T", "params": "...", "returns": "...", "exceptions": "..."}]
  }],
  "roundtable": [{"name": "security", "recommendations": [{"text": "...", "flavor": "edit|escalate|prototype", "outcome": "accepted|rejected|deferred"}]}]
}
```

Spec payloads are an **in-flight visualization only** — render ephemerally (default `$("$DG" stash -G viz)`), never `--keep`. The spec is a live view while work is in flight, not a persisted final artifact.

`spec_status.status`: `draft | in-progress | complete | deferred | blocked | abandoned`. The spec template also renders `risks`, `decisions`, `checklist`, `open_questions`, `open_questions_resolved` (shared with plan/recap).

`slices[].status`: `pending | done | partial | blocked | skipped`. A slice is auto-flagged **ready** (green badge + ring) when it is `pending` and every `dependsOn` slice is `done` — so agents can see at a glance what to pick up. The Slices header shows `done / total` and a `N ready to start` count.

`contracts[].sliceId` (optional): the `id` of the slice this contract documents. When set, the slice card shows a **contract →** jump-link and the contract shows a **slice** back-link — bidirectional navigation so agents jump straight from a work item to its API shape.

## review template (for `"$DG" viz review`)

Built entirely by the CLI from two git refs — never hand-authored.

```json
{
  "template": "review",
  "review": {
    "repo": "/path/to/repo",
    "base": "abc123",
    "head": "def456",
    "commits": [{"sha": "c2b4742", "subject": "feat: ..."}],
    "files": [{
      "path": "pkg/lib/Foo.cs",
      "dir": "pkg/lib",
      "status": "added | modified | deleted | renamed | copied",
      "additions": 23,
      "deletions": 0,
      "patch": "diff --git a/... b/...\n@@ ...",
      "slice": "1 — core | \"other\" | null",
      "commitSha": "c149277"
    }],
    "seedComments": [{"file": "pkg/lib/Foo.cs", "lineNumber": 42, "side": "new", "body": "🔴 ..."}]
  }
}
```

`slice` is `null` only when no `--spec` was passed to `review` at all (no slice concept in play); when `--spec` was passed, unmatched files get `"other"` rather than `null`. `commitSha` is the last commit (within `base..head`) that touched the file — drives the board's "By commit" grouping tab; may be `null` if git attribution failed for that path.

`seedComments` (optional) is written by `--comments <file.json>` — a JSON array of `{file, lineNumber?, side?, body}` (omit `lineNumber` for a file-scoped comment; `side` defaults to `"new"`) that the board pre-fills into `state.lineComments` on load, via the same path a human's own click would take. Used by `/review -x` to seed the reviewer agent's findings so the human triages/edits/drops them instead of retyping.

Render mode auto-derives to `"review"` whenever `payload.review` is an object ([slug].astro's `deriveMode()`) — the board then renders full-bleed GitHub-PR chrome (`ReviewSection.astro`) instead of the standard progress-bar/section-registry layout; no other registry section applies alongside it.

**Review submission** (written by the board's "Submit review" button, merged into `payload.review_result` by `doMerge`'s `review_submit` answer-type branch):

```json
{
  "verdict": "approve | request_changes | comment",
  "summary": "optional overall comment",
  "fileApprovals": [{"path": "src/b.ts", "viewed": true, "comment": "optional per-file note"}],
  "lineComments": [{"file": "src/b.ts", "side": "old | new", "lineNumber": 12, "body": "..."}]
}
```

Read it back with `"$DG" viz get <slug> review_result` after `wait`/`review-wait` returns (`all_clear` flips true as soon as a review is submitted — a review payload has no decisions/approval/permissions to gate on). See `loop-protocol.md` for the full submit round-trip.

## lineage (plan + recap)

A cytoscape-rendered node-edge graph — provenance-honest data lineage for a Snowflake/dbt identifier (written by `/lineage`). Solid edges are proven, dashed are inferred.

```json
"lineage": {
  "nodes": [
    {"id": "stg_orders", "label": "stg_orders", "type": "staging", "role": "upstream", "columns": ["order_id","customer_id"], "sql": "select ...", "evidence": "dbt manifest", "verified": true}
  ],
  "edges": [
    {"from": "stg_orders", "to": "fct_orders", "source": "dbt manifest", "confidence": "proven", "kind": "back", "evidence": "..."}
  ],
  "narrative": "optional prose summary shown above the graph",
  "target": "fct_orders"
}
```

`nodes[].type`: `source | staging | intermediate | model | view | dashboard | stub` — drives node shape. `nodes[].role`: `target | upstream | downstream` — drives legend color. `nodes[].collapsed` (optional number): renders a "+N collapsed" stub node instead of expanding every upstream/downstream hop. `edges[].confidence`: `proven | inferred` — solid vs. dashed line. `edges[].kind: "back"` (optional) marks a cycle/back-edge (↺ in the legend). `target` names the node the trace was centered on.

Section `applies` when `typeof payload.lineage === "object"`. Read-only display — no merge round-trip; there is no interactive lineage-editing flow.

## erd (plan + recap)

Code/import flowchart + DB schema ER diagram (`graph`, rendered by `CytoscapeSection.astro`) plus a grouped evidence trail (`evidence`, rendered by `EvidenceSection.astro`) — written by `/erd`.

```json
{
  "graph": {
    "codeNodes": [{"id": "src/auth.ts", "label": "auth.ts"}],
    "codeEdges": [{"from": "src/index.ts", "to": "src/auth.ts"}],
    "dbNodes": [{"id": "users", "label": "users", "columns": [{"name": "id", "dataType": "uuid", "isPrimaryKey": true}]}],
    "dbEdges": [{"from": "orders", "to": "users"}],
    "crossLinks": [],
    "evidence": [{"type": "db-table", "ref": "users", "detail": "postgres"}],
    "truncated": {"codeNodes": 0, "codeEdges": 0, "dbNodes": 0},
    "generatedAt": "2026-07-07T00:00:00Z"
  },
  "evidence": [
    {"type": "db-table", "ref": "users", "detail": "postgres information_schema"},
    {"type": "import", "ref": "src/index.ts -> src/auth.ts"}
  ],
  "scope": "repo",
  "generatedAt": "2026-07-07T00:00:00Z"
}
```

`graph` is an `ArchitectureGraph` (code-side `codeNodes`/`codeEdges` + db-side `dbNodes`/`dbEdges`/`crossLinks`, plus its own `evidence`/`truncated`/`generatedAt`) — rendered as a Cytoscape+dagre flowchart panel and ER panel. `evidence` (top-level, `EvidenceRecord[]`) is grouped by `type` (`db-table | db-column | file | import | <other>`) into labeled sub-tables with per-group counts; an unmapped `type` falls back to its raw string as the group label. `EvidenceRecord.detail` is optional — renders as `—` when absent.

Section `applies` when `typeof payload.graph === "object"` (diagram) or `has(payload, "evidence")` (evidence trail) — they register as separate registry sections (`cytoscape` / `evidence`) and can appear independently.

## discoveries (plan + recap)

Collapsible sections — ideal for /hunt output. `open: true` expands on load.

```json
"discoveries": [{
  "label": "Dead Code",
  "summary": "Short summary shown in collapsed header.",
  "open": false,
  "findings": [
    {"title":"fn()","severity":"low","location":"src/auth.ts:42","body":"...","code":"...","lang":"typescript"}
  ]
}]
```

`findings[].severity`: `critical | high | medium | low | info`

## code_samples (plan + recap)

Shiki-highlighted blocks. Findings in `discoveries` also accept inline `code`+`lang`.

```json
"code_samples": [
  {"title":"Before","lang":"typescript","caption":"src/auth.ts","code":"..."}
]
```

## links (plan + recap)

Rendered near the top of the board — easy to grab at a glance.

```json
"links": [
  {"label": "PR #31", "url": "https://github.com/org/repo/pull/31", "kind": "pr", "status": "open"},
  {"label": "Jira ticket", "url": "", "kind": "jira", "status": "none linked yet"}
]
```

`kind`: `pr | jira | doc | other`. Items with an empty `url` render as plain text (no dead link).
`status`: optional muted annotation shown to the right of the label.

## errors (plan + recap)

Surfaces error entries and/or blocked phases as a prominent callout.

```json
"errors": [
  {"title": "SFTP refused", "detail": "Host key mismatch", "severity": "critical"}
]
```

`applies` when `errors[]` is non-empty **or** any `phases[].status === "blocked"`. Blocked phases are listed in a red callout above the individual error items.

`severity`: `critical | high | medium | low | info` — same color tokens as discoveries findings.

## Field reference

| field | template | notes |
|-------|----------|-------|
| `phases[].status` | both | `pending\|done\|partial\|blocked\|skipped` |
| `risks[].severity` | both | `low\|medium\|high\|critical` |
| `decisions[].answer` | both | empty string = pending; "tbd" also treated as pending |
| `decisions[].thread` | both | `[{role:"user"\|"ai", text:"..."}]` — decision thread messages |
| `decisions[].options` | both | array of strings → renders as radio cards (single-select) |
| `decisions[].multiple` | both | `true` → options render as checkboxes (multi-select); answer stored newline-joined |
| `open_questions_resolved` | both | written by merge CLI; shape `[{question,answer}]` |
| `completion_pct` | recap | 0–100, drives progress bar color (red/yellow/green) |
| `links[].kind` | both | `pr\|jira\|doc\|other` |
| `links[].url` | both | empty string → renders as plain text, no anchor |
| `errors[].severity` | both | `critical\|high\|medium\|low\|info` |

## Payload (minimal)

Write to `$("$DG" stash -G viz <slug>/payload.json)`:
```json
{"template":"plan","slug":"my-slug","title":"...","date":"2026-06-17","phases":[...],"decisions":[{"question":"...","answer":"","options":["A","B"]}]}
```

**Two separate axes — don't conflate them.** `template` is an **authored input** (what you write into payload.json); `mode` is a **derived render state** the board computes from payload content and is never written by hand.

Authorable `template` values: `plan` (default), `recap`, `spec`. `review` is not authorable either — `"$DG" viz review` mints its own payload with a `review` object via a separate code path that bypasses the `template` gate entirely.

Derived `mode` (computed by `deriveMode()`, in this precedence order):
- `review` — `payload.review` is an object (set only by `"$DG" viz review`)
- `recap` — `template: "recap"`, or all phases terminal
- `planning` — unanswered decisions or open questions exist
- `implementation` — decisions resolved + phases present and not all terminal

Full field reference: `references/payload-schema.md`.

**Free-form documents.** To render a prose explainer (memo, breakdown) with formulas, code, tables, and callouts instead of a board, set `payload.doc` to an array of content blocks — no `template` needed. Any skill can hand viz a `doc` payload. Block schema: `references/doc-schema.md`.

Phase status `in_progress` foregrounds the live "Implementation Timeline"; `phases[].agents {primary, qa[]}` shows who's assigned. Once decisions are resolved, the planning sections collapse and the board flips to implementation view.

**Source-of-truth matters for implementation tracking.** A `plan` board *is* its own truth — drive its implementation live with `"$DG" viz phase` (mutates the ephemeral payload). A `spec` board is just an in-flight *view* of a durable spec file; its implementation status must be written back to that file, so `"$DG" viz phase` refuses spec payloads (it would split-brain against the file).
