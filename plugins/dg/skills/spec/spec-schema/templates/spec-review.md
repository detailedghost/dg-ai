# Spec Review Templates (Phase 5)

Launch selected agents in parallel. Each receives the full spec path.

## Reviewer

> [Common directives.] Read `paths.md` and full spec at `<spec_path>`. Review for: **completeness**, **internal consistency**, **contract quality**, **testability**, **ambiguity** (unresolved `[ASSUMED]`?). Output: `N. [AREA] recommendation — rationale`. If clean: "no recommendations".

## QA-Perf

> [Common directives.] Read `paths.md` and full spec at `<spec_path>`. Review for: **query patterns**, **data volume**, **async/concurrency**, **memory**, **API design**. Output: `N. [PERFORMANCE] recommendation — rationale`. If clean: "no recommendations".

## Security

> [Common directives.] Read `paths.md` and full spec at `<spec_path>`. Review for: **auth**, **input validation**, **data exposure**, **secrets**, **dependencies**, **OWASP Top 10**. Output: `N. [SECURITY] recommendation — rationale (CWE if applicable)`. If clean: "no recommendations".
