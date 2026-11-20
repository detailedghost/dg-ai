---
covers: ["pkg/skills-cli/src/hooks/**", "docs/hooks.md"]
---

[ADR 0026](../../docs/adr/0026-opt-in-hooks.md)

- Hooks are off by default. Never enable one at plugin install.
- The user turns one on with `dg-skills hooks enable <id>`, after the `hooks` skill asks.
- List every hook in `pkg/skills-cli/src/hooks/manifest.ts`.
- Give each runtime a `SettingsWriter` in `hooks/settings`. Claude and Codex write JSON hook groups.
- opencode gets a generated `dg-hooks.js` in its `plugins` folder. Do not list `dg-hooks` in `opencode.json`.
- dg owns an entry only when it matches the anchored marker in `hooks/settings/marker.ts`: a `dg-skills` path, `hooks run`, and one id.
- Writers touch owned entries only. User entries and unrelated keys survive `enable` and `disable`.
- `updateJsonFile` rereads the file before the atomic write and retries up to three times.
- `dg-skills doctor hooks` reports unreadable settings and stale entries.
- Do not ship shell scripts as hooks.
