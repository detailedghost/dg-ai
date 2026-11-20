---
covers: ["plugins/dg/skills/channel-review/references/config.example.json", ".env.example", ".gitignore", "pkg/channel-review/src/credentials.ts", "pkg/channel-review/src/automation/start.ts"]
---

[ADR 0007](../../docs/adr/0007-private-configuration.md)

- Use placeholders in tracked examples. Never commit deployment values.
- Keep relay endpoints, chat IDs and owner IDs in private configuration, ignored `.env` files or the encrypted credential store.
- Keep fetched relay secrets in process memory only.
- Report configured variable names and availability in status. Never report secret values.
- Never add a built-in private default environment.
- Never treat redaction as permission to log private data.
