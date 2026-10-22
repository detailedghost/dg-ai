# --ext mode

`~/.dg/bin/dg-skills pw --ext <verb> [args]` drives the browser the user is actually looking at, through the dg-ai-extension, instead of a browser pw starts and owns.

## Verbs

Write (need the user's approval every call):

```bash
~/.dg/bin/dg-skills pw --ext open https://example.com
~/.dg/bin/dg-skills pw --ext click "getByRole('button', { name: 'Submit' })"
~/.dg/bin/dg-skills pw --ext fill "getByLabel('Email')" "user@example.com" --submit
```

Read (never change the page; still ask once per call, naming the tab):

```bash
~/.dg/bin/dg-skills pw --ext current
~/.dg/bin/dg-skills pw --ext snapshot [--depth=N]
~/.dg/bin/dg-skills pw --ext screenshot
~/.dg/bin/dg-skills pw --ext selection
~/.dg/bin/dg-skills pw --ext console
```

There is no `--ext eval` and no `--ext run-code`: `--ext` never executes code in the page.

## Safety

- Every call asks the user once, naming the tab. A denial exits 1 with `pw --ext: denied for tab "<title>" (<url>) (<read|write> access to <verb>)`.
- Write verbs need their own approval, separate from read verbs.
- `open` refuses `chrome:`, `chrome-extension:`, `about:`, `edge:`, `brave:`, and `devtools:` URLs before any request reaches the extension (`pkg/skills-cli/src/pw/ext/dispatch.ts`'s `assertOpenableUrl`), so browser settings and other extensions stay out of bounds even with no transport at all.
- Output is redacted and size-capped (`pkg/skills-cli/src/pw/ext/redact.ts`): password-field-shaped values and token-like strings (reusing `@dg/common`'s `redactText`) are replaced with `[redacted]`, and text over 20 KB is truncated.
- Chromium only.

## What is implemented

The CLI side and the message contract, fully tested against a fake transport:

- `pkg/skills-cli/src/pw/ext/protocol.ts` — the typed request/response shapes (`ExtRequest`, `ExtOutcome`, `ExtPayload`, `ExtTransport`).
- `pkg/skills-cli/src/pw/ext/dispatch.ts` — argv parsing, the URL-scheme refusal, and rendering an `ExtOutcome` to stdout/stderr and the process exit code.
- `pkg/skills-cli/src/pw/ext/redact.ts` — the redaction and size cap applied to every read verb's output.
- `pkg/skills-cli/__tests__/pw/ext/*.spec.ts` — coverage with a fake `ExtTransport`, including denied/blocked outcomes and the URL-scheme refusal.

## What is not implemented

`defaultExtTransport` (`pkg/skills-cli/src/pw/ext/transport.ts`) confirms the extension is installed with the existing CLI-only guard, then fails clearly with `ExtBridgeNotImplementedError`. None of the following exist yet:

- A dg-daemon message type carrying an `ExtRequest` to the extension and an `ExtOutcome` back. `pkg/common/src/cli-wire.ts`'s `CliFrame` union has no `pw-ext-*` member.
- A dg-daemon server handler that relays that frame to the paired extension connection and waits for its reply.
- The extension-side content-script/background handler that executes `open`/`click`/`fill` against the active tab, builds the accessibility snapshot or screenshot, and surfaces the per-call approval prompt (naming the tab, write vs. read).
- Any manifest permission the extension needs to read/act on the active tab for this feature (beyond what it already has for other features).

A future slice should design the wire frame and the extension handler against the `ExtRequest`/`ExtOutcome` shapes above, then swap `defaultExtTransport` for a real implementation — the CLI side, `dispatch.ts`, and the tests should not need to change.
