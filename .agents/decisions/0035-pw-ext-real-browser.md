---
covers: ["pkg/common/src/pw-ext-format.ts", "pkg/dg-daemon/src/server/pw-ext.ts", "pkg/extension/lib/background/pw-ext.ts", "pkg/extension/lib/features/pw-ext-page.ts", "pkg/extension/lib/features/pw-ext-main.ts", "pkg/skills-cli/src/pw/ext.ts"]
---

[ADR 0035](../../docs/adr/0035-pw-ext-real-browser.md)

- Treat `--ext` on the CLI as the explicit grant. Never add a per-call approval popup, a consent field on the wire, or a setting that restores one. The per-site Allow of ADR 0045, the unmask window of ADR 0041 and the Web MCP approvals of ADR 0046 are not per-call approvals.
- Send `pw --ext <verb>` as one `cli-pw-ext-request` on the `/cli` socket. The daemon forwards `pw-ext-browser-request` to the one paired extension at `PW_EXT_MIN_EXTENSION_VERSION` or newer.
- Add a verb only through an ADR. The base set is `current`, `snapshot`, `screenshot`, `selection`, `console`, `tools` read; `open`, `click`, `fill`, `upload`, `call` write. Later records add verbs such as `unmask` (0041), `dialog` (0044) and `network` (0051). Make the `pw-ext-format.ts` validators accept an exact field set per verb. The wire carries no code.
- Act on the selected tab of the agent's own tab group. `--tab <id>` names another tab of the group.
- Refuse browser settings pages, extension pages, `file:` and `about:` pages, web stores, private windows and the signed-in Proton Mail tab (`PW_EXT_BLOCKED_ERROR`, `PW_EXT_MAILBOX_ERROR`).
- Redact text and URLs in the extension and again in the CLI. Keep the output caps: 100,000 characters of text, or the proto preview limit for an image.
- Run a fixed function from `pw-ext-page.ts` in the isolated world through `scripting.executeScript`. Check the document URL against the tab URL before acting. Discard a screenshot if the window shows another tab after capture.
- Resolve the target and act in one page call. Keep no element handle or fingerprint.
- Allow upload only to `https:` pages. Stage the file in the daemon asset store with `postAsset`. Delete the staged file right after the fetch. Refuse a size that differs from the declared size. Keep the 25 MiB cap.
- Take upload files only from regular files in the working directory, the dg scratch directory or the dg demos directory. Refuse hidden paths and symbolic links. Pin the file identity on open.
- Keep timeouts, the relay deadline and cancel on a closed session or a stopped CLI (`cli-pw-ext-cancel`, `pw-ext-browser-cancel`).
- Keep daemon session ownership, CLI auth, the pending request caps and the `PW_EXT_MIN_EXTENSION_VERSION` gate. Keep the constant at 1.42.0 while the CLI works with both extension versions.
- Run `console` and `tools`/`call` MAIN-world code only through `pwExtConsoleHook` and `pwExtWebMcp`. Redact and cap their output in the worker. Keep the last 50 console entries.
- Make `pwExtWebMcp` drop `window`, cap each description, schema and output, recheck the URL after each await, and bound discovery and the call with timeouts.
- Refuse `call` for an unknown tool. Give `tools` and `call` their own approvals under ADR 0046. The pw --ext site allowlist and Stop of ADR 0045 do not apply to them.
- Refuse on Firefox. Support only Chromium-family browsers.
