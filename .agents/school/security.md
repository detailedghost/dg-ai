<!-- Security learnings. Max 100 lines. Prune oldest when full. -->
<!-- Format: - [YYYY-MM-DD] one learning per line, concise and actionable -->
<!-- Any agent may add entries. Prune the oldest lines when the file passes 100 lines. -->
- [2026-11-20] A secret-intake POST notes the value for redaction before any refusal, so a rejected post cannot leak the value into logs.
- [2026-11-20] The intake validates the value before it redeems the code, so a bad value does not burn the single-use code.
- [2026-11-20] The secret page never gets a session token or session meta. It holds one intake code and nothing else.
- [2026-11-20] A form polls `list` (`updatedAt`), never `get`, to see that a value landed. `get` would return the value to the page.
- [2026-11-20] `asm-exec` resolves `{{resolve:...}}` only in argv. Pass a secret to a child through `env NAME=<placeholder>`.
- [2026-11-20] Any daemon path that calls credentials.getCredential directly must refuse sealed pw/ and reserved prefixes itself; sealed() exists only in server/credentials.ts.
