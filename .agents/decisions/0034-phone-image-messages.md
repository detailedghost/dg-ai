---
covers: ["pkg/dg-agent/src/phone/**", "plugins/dg/skills/phone/**", "docs/phone.md", "scripts/pin-wormhole.ts", ".github/workflows/wormhole-pin.yml"]
---

[ADR 0034](../../docs/adr/0034-phone-image-messages.md)

- Never send PHI over the phone, as text or image. Keep the rule in `plugins/dg/skills/phone/references/safety.md`. Guard sends with the default-off `files` setting and the per-send `--no-phi` flag.
- Send an image as a NIP-17 kind 15 rumor with `content` of `dg-wormhole:<x>`, never a URL. Use AES-256-GCM with a fresh key and nonce per file.
- Allow PNG, JPEG and WebP only, chosen by magic bytes of the decrypted image. Reject SVG. Cap plaintext at 5 MiB. Send one image per `say`, with no caption. Strip metadata before encryption.
- Require human approval to send an image. Keep a received image closed unless the human asks.
- Stage the ciphertext in `<phoneRoot>/outbox/<x>`. The receiver requests it with a kind 25015 rumor (tags `p`, `x`, `code`, empty content) sealed and gift wrapped to the key that sent the kind 15. Never let kind 25015 leave a gift wrap.
- Make the receiver generate `<8 random digits>-<base32 of 16 random bytes>` for each attempt and never reuse it. The sender accepts only `^[0-9]{1,16}-[a-z2-7]{20,40}$`. Never store or log a code.
- Make the sender check: x is 64 lowercase hex, `created_at` within 5 minutes, rumor id and code new within the hour, seal signer is a contact and an allowed recipient, the wrap reached the key that sent x, the outbox entry is a regular file. Refuse silently.
- Limit sends to one at a time behind a queue of 4, one open request per requester and x, 20 sends per contact per day, and 90 seconds.
- Run `wormhole-william send --code <code> --hide-progress <file>` and discard its output.
- Run `receive --hide-progress` in a fresh 0700 temp dir with the code on stdin. Answer `y` only to an offer that names x at the expected size. Check exact length and sha256 after exit, on exactly one regular file. Kill the process tree above the size tag or after 120 seconds. Always remove the temp dir.
- Download wormhole-william v1.0.8 on first use into `<phoneRoot>/tools/`, never onto PATH, and run it by absolute path. Follow only https redirects, stop at 20 MiB, write to an O_EXCL 0600 `.part` file, check the pinned sha256, set 0700, rename. Rehash before every run. Refuse `arm` and unknown platforms. Give children an empty environment.
- Land a pin only when `scripts/pin-wormhole.ts --check` and the dev-machine hashes both match.
- Check receive order: hash of ciphertext, one-call GCM decrypt, hash of plaintext, magic bytes. Validate tags first: `x` and `ox` are 64 lowercase hex, key 32 bytes, nonce 12 bytes.
- Set the row text of a kind 15 message to `[image]`, never the URL. Store `[image pending]` first, update to `[image]` or a fixed placeholder reason, then notify the hook.
- Use a fixed reason list. Never write raw error text, host body, URL or key to a row or `listener.log`.
- Let only kind 14 carry `dg-call` or create a contact. Drop kind 15 from non-contacts.
- Store decrypted images under the phone folder with mode 0600. Delete them with the 7-day message TTL. Cap the `files/` folder size and the per-contact daily count.
