# Profiles — cost-profile mechanics

Read this file only when a profile flag is present. `balance` needs no delta; `cheap` and `expensive`
change plan-mode effort and the `-s` entry sequence.

## Plan-mode effort

Plan mode never skips step 5 or step 6 under any profile.

| Profile | Delta |
|---|---|
| `--cheap` | Steps 1, 2 and 6 personas run at `fable`/`medium`. Steps 1.5 and 5 run at `sonnet`/`low`. |
| `--expensive` | The step-5 review of each `complexity: high` slice runs at `opus`/`medium`. |

## `-s --profile <profile>` sequence

Run these before execute.md §1 reads `context.md`. The first command writes the origin checkout's
`plan.md`, the same file as `SPEC_PATH`.

```sh
dg-skills spec set <bundle>/plan.md execution.profile <profile>
dg-skills spec context <bundle>
```

Then, when `<profile>` is `expensive` and any slice lacks `agents.complexity`, run `/dg:assign <bundle>/plan.md`.
Its backfill rates each unrated slice and asks nothing.
