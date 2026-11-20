---
covers: ["pkg/dg-daemon/src/jobs/**","pkg/dg-daemon/src/commands/job-*.ts","pkg/dg-daemon/src/server/job-credentials.ts","pkg/dg-daemon/src/server/service-api.ts","pkg/common/src/node/job-credentials-client.ts","docs/jobs-and-services.md","docs/service-api.md"]
---

[ADR 0053](../../docs/adr/0053-job-sources-and-credentials.md)

- Take a job from a repository (pinned to a full commit id, with consent at a terminal or `--yes`) or from a local path (no pin, no question). Keep both in `<data>/jobs/sources.json`.
- Run `git` and the build in the CLI process. Never run `git` in the daemon.
- Let the `dg` block of `package.json` set only `jobs`, `credentials`, `requires` and `build`. Set `cwd`, `grant`, `enabled`, `passEnv` and `credentialEnv` in dg.
- Accept one source type, `aws-secretsmanager`. Never let a request name a secret id, a region, a key, a profile or an argv.
- Make the credential prefix from the source name. Refuse `pw`, `extension`, `phone-friend`, `phone-vault` and `db`.
- Ask the adoption question once for a prefix that already holds credentials. Pass it only on an answer at a terminal, also for `setup --rotate-token` and `setup --refresh`.
- On `update` to a new commit, ask `Update to this commit? [y/N]` for an unchanged block and `Apply these changes? [y/N]` for a changed block. Refuse with no terminal and no `--yes`. Refuse while a job of the source is `running` or in `backoff`.
- Write job credentials only through `POST /jobs/<name>/credentials` with the owner token. Return no value from it.
- Take `--setup` as a file path or `-`. Never take JSON text. Refuse a file that other users can read.
- Add `refresh` to service API v1 with the body keys `operation`, `name` and `job`. Answer 409 unless `setupDone` lists the job and the record key equals the grant.
- Start `aws` only for `refresh`, with the fixed argv of the declared source. Read `sources.json` in the daemon only for it.
- Allow one fetch for one credential in 60 s. Start no refresh on a timer.
- Require a credential bound to an environment variable at launch. Refuse `env` on a credential with `required: false`.
