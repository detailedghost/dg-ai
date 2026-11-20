---
covers: ["pkg/extension/lib/features/pw-ext-dialog-main.ts", "pkg/extension/lib/background/dialog-shim.ts", "pkg/extension/lib/background/pw-ext.ts", "pkg/common/src/pw-ext-format.ts", "pkg/common/src/relay-features.ts"]
---

[ADR 0044](../../docs/adr/0044-pw-ext-dialogs.md)

- Answer `alert`, `confirm` and `prompt` in agent tabs with the MAIN-world `pwExtDialogs` shim. Add no `debugger` or `webNavigation` permission.
- Never inject the shim into a user tab, a private tab, a mailbox origin or a browser page.
- Inject with `injectImmediately` when an agent-group tab reports `loading` or `complete`, and check the document URL at each injection.
- Remove the shim when a tab leaves its agent group or its dg session ends. After removal, refuse every later shim call for that document.
- Clear the shim records and pending answer when a tab moves to another session.
- Default each new document to dismiss. Let `dialog accept [--text <answer>]` and `dialog dismiss` set a one-shot policy.
- Keep the last 10 dialogs as raw, size-capped records. Validate them in the worker, mask them like other page text, and show them in `dialog` and under `### Dialog` in `snapshot`.
- Treat the shim records as untrusted page text.
- Refuse `dialog accept --text` with a value the session filled as a secret.
- Stop page verbs that wait on the page after 15 seconds with an error that names a dialog the shim could not catch.
- Refuse the verb when the extension does not list `dialog` in `pwExtVerbs`.
