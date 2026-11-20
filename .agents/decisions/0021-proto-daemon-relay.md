---
covers: ["pkg/dg-daemon/src/server/proto.ts", "pkg/skills-cli/src/commands/proto.ts", "pkg/extension/lib/background/proto.ts", "pkg/extension/entrypoints/demo-tour.content.ts", "pkg/common/src/proto-format.ts", "pkg/common/src/cli-wire.ts"]
---

[ADR 0021](../../docs/adr/0021-proto-daemon-relay.md)

- Relay `--ext scrape` and `--ext plant` through the daemon session, as `inbox` does. Never use Downloads or any browser-process filesystem path.
- The daemon holds one pending record per `(sessionId, requestId)`. A second CLI that reuses an in-flight pair gets `{ ok: false, error: "duplicate requestId" }`. The original entry stays.
- Settle a request when the extension answers, times out, or the session closes. A timeout names the extension's last reported status.
- Closing the prototype tab settles the request with an error.
- The extension finishes a request at `PROTO_DEFAULT_TIMEOUT_MS` plus a short margin, drops any captured preview, and closes a tab that `tabs.create` returns after that deadline.
- Correlate the content script's report by tab id, never by slug.
- Run `detectPageNotReady` before a scrape or plant. Report a typed `ProtoNotReadyError` with code, message and the landed URL.
- Report `login-page` only when the browser left `expectedUrl`, or the status is 401 or 403 and the page still looks like a sign-in wall. A password field alone is not a wall.
- `markedUrl` must be an `http:` or `https:` URL no longer than the marker ceiling plus 256 characters. The extension checks the limit again before `tabs.create`.
- `previewDataUrl` is a `data:image/png` or `data:image/jpeg` URL of at most 600,000 characters. The extension captures JPEG and downscales. Omit a preview that still cannot fit.
- The CLI writes JPEG bytes to `preview.jpg` and PNG bytes to `preview.png`.
- Namespace planted variation markup: `id`, radio `name`, and every reference to those ids. Remove a `form`, `list` or `for` value that is not one of the variation's own ids.
- Set `form=""` only on controls that are not inside a variation `<form>`. Cancel a label click that resolves outside the variation.
- Re-serialize planted CSS from `CSSStyleSheet` rules inside `@scope`. Drop the sheet unless every top-level rule is that `@scope` block or a keyframes wrapper.
- Prefix id selectors, id attribute selectors, `url(#...)` fragments and `@keyframes` names, and rewrite `animation` and `animation-name` to match.
- The content script asks `browser.runtime.sendMessage` whether the tab has a pending relay request before it scrapes or plants.
- The human opens the pairing popup and the agent runs `dg-agent pair <code>`. There is no `/start#_chat=` page (ADR 0038).
