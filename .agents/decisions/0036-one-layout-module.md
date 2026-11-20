---
covers: ["pkg/common/src/node/layout.ts", "pkg/common/src/node/layout-work.ts", "pkg/common/src/node/layout-preaction.ts", "pkg/skills-cli/src/install/**", "pkg/dg-agent/src/phone/migrate.ts", "pkg/dg-daemon/src/crypto/keychain-backends.ts"]
---

[ADR 0036](../../docs/adr/0036-one-layout-module.md)

- Keep the table of where each piece of dg state lives, and how a legacy copy moves, in `pkg/common/src/node/layout.ts`. Add no second migrator.
- Run `ensureLayout` at the start of every program (`dg-skills`, `dg-agent`, `dg-daemon`) through the shared `installLayoutPreAction`, before any store opens.
- Run `ensureLayout` once per process. Use a lock-free fast path with one `readdir` of the legacy home. Take the install lock only when work exists, then plan again and apply.
- Move an unused target aside as `<name>.empty-<ts>` and move the legacy copy in. Never merge or delete a used target or its legacy copy.
- Stop a live writer through an owner hook, or block the entry. Keep a `no-hook` block silent. Log one stderr line per process for `live-writer`, `kept`, `failed`, `scheduled` and `setAside`, and one `removed` line when a pending removal completes.
- Move phone as a table entry with `verify` and `stop` hooks. Supply `phone.stop` in `dg-agent` only under `phone` verbs.
- Run the phone-friend conversion and the keychain move after `ensureLayout`, under the install lock. Overwrite the current keychain account only when this run set an empty daemon store aside.
- Move `ssms/config.yaml` only through the install-only `ssms.configDir` hook.
- Memoize `resolveDgPaths` by its inputs, with the per-process result in a `WeakMap`.
- Make `dg-skills doctor` run the preAction and report the `layout` check from the exported table.
- Add no rollback command. Document a manual rollback: stop the writers, copy the per-OS folders back to `~/.dg`, install the older release.
- Make `dg-skills clean` remove only unused `<name>.empty-<ts>` copies, the `~/.dg/bin` notice launchers and the empty `~/.dg`. Never remove a copy that holds data. Leave `dg-ai-*` folders. Refuse while any entry is blocked.
- Keep the layout contract spec and the upgrade matrix passing.
