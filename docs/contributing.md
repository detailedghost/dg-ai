# Contributing

## Pull Requests

- Open PRs against `master` (the default branch).
- Both BLT checks (`ext-blt`, `skills-blt`) must pass before merge.
- Follow the PR template in `docs/pull_request_template.md`.

## Test Standards

- Test files: `*.spec.ts` in `__tests__/` folders co-located with their package source.
- Runner: `bun test`.
- No placeholder assertions. No re-implemented logic — import the real module.

## Commit Style

Use conventional commits: `feat(scope):`, `fix(scope):`, `ci:`, `docs:`, `refactor:`.
