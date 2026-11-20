---
covers: ["pkg/dg-daemon/src/crypto/**", "pkg/dg-agent/src/memory/store.ts"]
---

[ADR 0005](../../docs/adr/0005-field-encryption.md)

- Encrypt secret daemon fields with AES-256-GCM envelopes, a fresh IV, and AAD that binds the domain, session, row and format version.
- Wrap the random store data key with a key-encryption key from the OS keychain.
- Use Linux Secret Service, macOS Keychain or a Windows DPAPI file. Use a private key file only as the fallback.
- Refuse to open the store on a recorded key mismatch.
- Keep agent `memory.db` plain text so full-text search works.
- Never use one keychain entry per field.
- Treat memory entries as unencrypted local notes.
