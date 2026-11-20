---
covers: ["pkg/extension/lib/features/pw-ext-network-main.ts", "pkg/extension/lib/features/pw-ext-page.ts", "pkg/common/src/pw-ext-network.ts", "pkg/extension/lib/background/dialog-shim.ts", "pkg/extension/lib/background/session-control.ts", "pkg/extension/lib/background/approval.ts"]
---

[ADR 0051](../../docs/adr/0051-pw-ext-network.md)

- Default `pw --ext network` to shape only. Never send a value out of the page without a values grant.
- Install the `pwExtNetwork` hook next to the dialog shim through `syncDialogShim`, with the same ownership and lifecycle. Never hook a user tab, a private tab, a mailbox origin or a browser page.
- Keep a ring of the newest 100 calls per page. Read a response through `clone()` up to 1 MiB, then cancel the clone. Cap header values at 512 characters and body text at 8000.
- Keep a header value out of the buffer when its name holds auth, cookie, token, secret, key, session, canary, csrf, xsrf, credential, pass, signature, jwt, dpop, bearer or assertion. Print it as `name (hidden)`.
- Build the shape address without user info, fragment and query values (`name=*`). Mask generated-id parts and keys with `looksLikeOpaqueId`. Keep the value of only `action` and `app`, when it is a plain API name.
- Match `--filter` against the shape address, never the raw address.
- Gate `--values` on one Allow per registrable-domain site (`siteOf`) and session. Never time-box it. End it on Stop and at the session end.
- Use the same Allow for `storage --values`, `fetch` with a method other than GET or HEAD, `fetch --auth page` and `credential save`. Make the popup name all of them.
- Refuse the verb on Deny, a closed window, no answer in 60 seconds or a window that does not open. Never read the page then.
- Mask with `maskCredentialFields` first, then `maskRaw`, `shown()` and `scrub()`. Never give MAIN the held secrets.
- Refuse `network` on browser pages, private tabs, mailbox origins, discarded tabs and sites the session has not allowed. Keep it in `PW_EXT_LISTED_VERBS`.
- Keep sealed sign-in headers, after the Allow, in a closure apart from the buffer. Use them only for same-origin `fetch --auth page` (no redirects) and `credential save --from header:`. Drop them on an anchor change, group exit, new owner or Stop.
- Use the `cookies` permission only for `credential save --from cookie:` on the agent tab URL after the Allow.
- Send a captured credential only in a `pw-ext-credential-store` frame. Let only the daemon read it, and store it encrypted as `pw/<registrable domain>/<name>`.
- Refuse a session or grant-scoped `get` for every name under `pw/`.
- Run `dg-skills credentials exec <name>[=ENV]... -- <cmd>` in the daemon. Send only names, command, cwd and CLI environment. Scrub child output in all encodings. Kill the child on CLI disconnect. Never use the `{{cred:name}}` form.
- Require a pinned `exec-allowlist` line (absolute path, `sha256=<hex>`) for every `pw/` name. Refuse shells, interpreters and general tools unless the line has `allow-any-args`.
- Run the hashed copy from a private 0700 directory as a 0500 file with a private `TMPDIR` and a fixed system `PATH`. Delete it after the run.
- Make `dg-skills credentials allow` print a pinned line and never write the file.
- Print `[redacted]` in `count` for an `id` or `name` value that passes `looksLikeOpaqueId`.
