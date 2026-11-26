# Stat views and long rows

Detail for `/dg:stat` output. The main skill links here.

Example (`/dg:stat`, default view):

```
1. ✅ Sign in to GitHub
2. 🔄 Phone feature to PR [~1 hr]  ← you are here
   1. 🔄 Fix the flaky listener test
3. 🛑 Approve the Wave 6/7 PR batch
4. ⏳ Slice 6 [~15 min]

Off the critical path:
5. 👀 Sign the vendor form

Total: ~1 hr (critical path: 2 Phone feature to PR)
Waiting on you: 2 items. Run /dg:walk stat to walk them.
```

The same checklist, `--plain`:

```text
1. [x] done: Sign in to GitHub
2. [ ] running: Phone feature to PR [~1 hr]  <- you are here
   1. [ ] running: Fix the flaky listener test
3. [ ] blocked-user: Approve the Wave 6/7 PR batch
4. [ ] queued: Slice 6 [~15 min]

Off the critical path:
5. [ ] needs-user: Sign the vendor form

# Total: ~1 hr (critical path: 2 Phone feature to PR)
Waiting on you: 2 items. Run /dg:walk stat to walk them.
```

The same checklist, `--long` (tab-separated):

```text
ORDER	OWNER	STATUS	WORK	DETAIL	PR/MR	ETA
1	-	done	Sign in to GitHub	-	-	-
2	agent	running	Phone feature to PR	-	-	~1 hr
-	agent	running	Fix the flaky listener test	-	-	-
3	user	blocked-user	Approve the Wave 6/7 PR batch	-	-	-
4	agent	queued	Slice 6	-	-	~15 min
5	user	needs-user	Sign the vendor form	-	-	-
# Total: ~1 hr (critical path: 2 Phone feature to PR)
# Waiting on you: 2 items. Run /dg:walk stat to walk them.
```

The list reads in plan order, so it shows where the plan stands. Done items come first, oldest first, and take the first numbers. Older done items past the cap are hidden behind an `...and N earlier done` line at the top, and keep their numbers, so ticking the current step changes no other number. Open items follow in stored order, which is the plan order: add them in the order the work runs, and use `--at` to place one. `blocked-user` items stay in place, because they hold up the plan. `needs-user` and `parked` items move after the plan, under an `Off the critical path:` line. The default and `--plain` views mark the first open plan step with `← you are here` (`<- you are here` in `--plain`). `--long` prints neither line, so its rows stay a plain table. `--at` and `--under` take the number shown. A sub-item nests one level under its parent and restarts its own number at 1 in the default and `--plain` views. On `--long`, a sub-item row carries `-` in `ORDER` instead and prints directly under its parent, in stored order — rows already print in plan order, so there is nothing to sort. When a sub-item is the critical path, that total reads `(critical path: <text>, under <parent number>)`, using the parent number visible in ORDER. A sub-item can be ticked on its own; ticking a parent does not tick its sub-items, and finishing every sub-item does not tick the parent — mark each explicitly. User items (`blocked-user`/`needs-user`) never show an ETA, because the wait is on the user, not the agent.

## `--long` rows for session-only work

Append extra rows in the same 7 tab-separated fields the CLI prints (`ORDER OWNER STATUS WORK DETAIL PR/MR ETA`), ASCII only, no embedded tabs or newlines:

- `ORDER`: `-` (these rows have no place in the checklist's plan order).
- `OWNER`: `agent` for work the agent is driving, `user` for an externally gated row (old "waiting on you").
- `STATUS`: one of the checklist's seven words, plus `unknown` for a bg job whose state cannot be read (mirrors the old table's `unknown` status).
- `DETAIL`: CI detail when a PR row has a pipeline (a failed pipeline reads `CI failed: verify:e2e`; a blocked one reads `at production:approve`), else `-`.
- `PR/MR`, `ETA`: same ladder and judgment as before (`<5 min`, `~15 min`, `~30 min`, `~1 hr`, `>1 hr`, `unknown`); `-` when there is none.

Recompute the `#`-prefixed total line (see above) instead of keeping the CLI's own.
