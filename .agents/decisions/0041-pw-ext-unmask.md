---
covers: ["pkg/common/src/pw-ext-format.ts", "pkg/common/src/redact.ts", "pkg/extension/lib/background/pw-ext.ts"]
---

[ADR 0041](../../docs/adr/0041-pw-ext-unmask.md)

- Grant unmask only from a click in the extension-owned popup window. Never add a flag, setting, CLI prompt or wire consent field that grants it.
- Treat Deny, no answer in 60 seconds, a closed window and a window that cannot open as no grant. Name which one occurred in the reply.
- Give no button focus in the unmask popup.
- Take `--minutes N` as 1 to 60, default 15. `unmask --off` ends the grant at once.
- Bind the grant to one origin and one tab group. End it at its time, on `--off`, or when the tab group changes or closes.
- Never grant on a mailbox origin or a browser-internal page.
- Under a grant, unmask only email addresses. Keep tokens, API keys, JWTs and `password=` values masked. Never mask user names.
- Allow `fill` on a password or secret field only under a grant, with a value of at least 4 characters.
- Take a secret fill value only from `--value-env NAME` or `--value-stdin`. Never accept it as a positional argument.
- Keep each secret fill value in `storage.session` (at most 50) and remove it from all later output of the session. Reply only `filled <field>`.
- Start each page reply under a grant with the `### Unmask` block.
- Give the page MAIN world no grant state and no held secret. Mask held secrets and token patterns in the worker in one pass, before shortening text.
- Refuse the verb when the extension does not list `unmask` in `pwExtVerbs`.
