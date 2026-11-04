# Proxy — slice delegation with `--proxy`

Read this file only when `--proxy <backend>` is present. The dispatch step already validated
`<backend>` against `dg-skills proxy --list-backends`.

## Per-slice question

Ask with a batched `AskUserQuestion`, up to 4 slices per call: delegate this slice to `<backend>`?
The backend is fixed, so the question is yes or no per slice. In `-s` mode, ask only for slices
without `agents.proxy`.

For each slice answered yes:

- Run `dg-skills spec set <bundle>/plan.md slices[N].agents.proxy <backend>`.
- Ask which skill behaviors (for example `db` or `polish`) the slice needs, and set
  `slices[N].agents.proxy_skills` to that list. See [decision-blob.md](decision-blob.md) for why
  `-s` must inline them.
