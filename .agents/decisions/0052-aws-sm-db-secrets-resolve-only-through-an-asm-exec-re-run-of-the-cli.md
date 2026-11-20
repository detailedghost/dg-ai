---
covers: ["pkg/skills-cli/src/db/aws-secret.ts","pkg/skills-cli/src/db/credentials.ts","pkg/skills-cli/__tests__/db-aws-secret.spec.ts"]
---

[ADR 0052](../../docs/adr/0052-aws-sm-db-secrets-resolve-only-through-an-asm-exec-re-run-of-the-cli.md)

- Store only `secretSource=aws-sm`, `secretId`, `secretKey`, and optional `awsProfile` and `awsRegion` on a `db/<name>` credential. Store a non-secret placeholder as its value.
- Resolve an aws-sm secret only by running the db verb again under `asm-exec`.
- Spawn `asm-exec -- env DG_DB_SECRET=<placeholder> dg-skills db <verb> ...`. asm-exec resolves references only in arguments, never in the environment.
- Build the placeholder as `{{resolve:secretsmanager:<id>:SecretString:<key>}}`.
- Set `DG_DB_ASM_CHILD=1` in the spawn environment. Only the child reads `DG_DB_SECRET`.
- Fail the child when `DG_DB_SECRET` is missing or still starts with `{{resolve:`. Never print the value.
- Name `asm-exec` and the placeholder only in `pkg/skills-cli/src/db/aws-secret.ts`.
- Never call `get-secret-value`, `batch-get-secret-value`, `GetSecretValueCommand`, or the Secrets Manager Agent from db code.
- Exit 1 with an install hint when `asm-exec` is missing. Never fall back to another read path.
- Reject a `--secret-id` or `--secret-key` that holds braces or whitespace.
- Refuse `--write` on a read-only connection before the re-run.
