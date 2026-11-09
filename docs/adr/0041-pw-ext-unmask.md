# 0041 — pw --ext: user-approved, time-boxed unmask

Status: Accepted (implemented)
Date: 2026-11-09

## Context

- [ADR 0035](0035-pw-ext-real-browser.md) redacts emails, tokens and keys from
  every `pw --ext` text output. It also refuses `fill` on password and secret
  fields. Both rules protect the human from an agent that reads or writes more
  than the task needs.
- An agent onboarded accounts on a production web app. It could not verify the
  email values on the page, because every address showed as masked. It could not
  accept an invite that needs a one-time password, because `fill` refused the
  field.
- The human can see the real values and can decide that the agent may see them
  too. The agent cannot make that decision for the human.
- A setting the CLI can change, or a flag the CLI can pass, would let an agent
  approve itself. ADR 0035 already rejects that shape.
- The extension can open its own popup window. Only a click in that window
  proves that a human answered.

## Decision

`dg-skills pw --ext unmask [--minutes N]` asks for a time-boxed unmask on the
origin of the agent's selected tab. `N` is 1 to 60 and defaults to 15.
`pw --ext unmask --off` ends the grant at once.

The extension opens a small popup window. It shows the session, the site
origin, what the grant allows, and the duration. It has Allow and Deny, and Deny
has focus. No answer in 60 seconds means deny. Closing the window means deny.
Only a click in that extension-owned window grants. The wire carries no consent
field, so an agent cannot grant itself.

While the grant holds, and only for that origin and only in that session's agent
tab group:

- Email addresses and user names are no longer masked in snapshots and other
  page text.
- Tokens, API keys, JWTs and `password=` values stay masked.
- `fill` may set a password or secret field.

The grant is bound to the tab group id. It ends at its time, on `--off`, or when
the tab group changes or closes. It never covers a mailbox origin (the Proton
Mail guard of ADR 0035) or a browser-internal page.

Each page reply under a grant starts with this block:

```text
### Unmask
unmasked on <origin> until HH:MM (approved in the browser)
```

A secret fill takes its value from the CLI environment or from stdin:
`pw --ext fill <ref|selector> --value-env NAME` or `--value-stdin`. The CLI
never accepts a secret value as a positional argument, so the value stays out of
argv and the process list. A secret fill works only on a password or secret
field. The extension keeps each secret fill value in `storage.session` for the
session (at most 50 values) and removes it from all later output of that
session, and the result says only `filled <field>`. Without a grant, the refusal
names `pw --ext unmask`.

An extension that does not list `unmask` in its `pwExtVerbs` handshake refuses
the verb at once.

This decision amends ADR 0035. It adds one exception to text redaction and one
to the secret-field rule. The human approves it in the browser, for one origin
and for a short time. Every other guard of ADR 0035 stays.

## Consequences

- **Good:** an agent can verify real values and complete one-time-password flows
  on a site the human trusts, without a standing exception.
- **Good:** the human grants in a window that the extension owns. The CLI has no
  path to grant.
- **Good:** the grant is small. It covers one origin, one tab group and at most
  60 minutes, and it never covers a mailbox.
- **Good:** secret values do not reach argv, shell history or output.
- **Bad:** the human must be at the browser to answer. An unattended agent gets
  a denial after 60 seconds.
- **Bad:** while the grant holds, the agent reads real emails and user names from
  that origin. Screenshots were never redacted, so they gain nothing new.
- **Bad:** the secret value is in the CLI environment or stdin until the CLI
  reads it. The human must trust the agent's shell.
- **Neutral:** an extension without `unmask` in `pwExtVerbs` refuses the verb.
  The minimum extension version does not change.

## Alternatives considered

- **Agent self-grant.** A flag or wire field that the agent sets. It removes the
  human from the decision, so it defeats the redaction it relaxes.
- **Permanent per-site setting.** Less friction, but the exception outlives the
  task. A forgotten setting keeps real values flowing to every later session.
- **CLI-side approval prompt.** The agent controls the CLI process and its
  terminal. It can answer its own prompt. Only an extension-owned window is out
  of the agent's reach.

## References

- [ADR 0035](0035-pw-ext-real-browser.md)
- [ADR 0038](0038-extension-pairing-only.md) (agent tab groups)
- `pkg/common/src/pw-ext-format.ts`
- `pkg/common/src/redact.ts`
- `pkg/extension/lib/background/pw-ext.ts`
