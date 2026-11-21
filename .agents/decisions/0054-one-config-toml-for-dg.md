---
covers: ["pkg/common/src/node/dg-toml*.ts","pkg/common/src/node/dg-config.ts","pkg/skills-cli/src/config/**","docs/config.md"]
---

[ADR 0054](../../docs/adr/0054-one-config-toml-for-dg.md)

- Keep dg settings in `resolveDgPaths().configTomlPath`. Read and write it only through `readDgToml`, `writeDgToml`, `mergeDgToml` and `setting` in `pkg/common/src/node/dg-toml.ts`.
- Resolve a setting as flag, then env, then `config.toml`, then default.
- Put only `{ credential = "<name>" }` in a secret field. Never write a secret value or `{{resolve:...}}` into the file. Never print a refused value in an error.
- Give each validation error the file, the line, the key and a next step.
- Migrate under the install lock: check every source, back each up as `<file>.pre-toml` (0600) and compare, store secrets, then write. On any failure, write nothing. Never overwrite a differing backup.
- Keep old config files in place and never read them once `config.toml` exists.
- Keep the jobs table, job sources, exec allowlist and channel review config out of `config.toml`.
- Read `[ssms]` only from the `config.toml` under the passwd home. Do not let `dg config set` change `ssms.allow_send` or `ssms.google.send_enabled`.
- Isolate config in tests with `DG_HOME` in a temp folder. Use fake credentials only.
