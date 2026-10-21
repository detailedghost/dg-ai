# phone-friend v2 — Initial Notes

## Purpose
Rename the CLI to `dg-agent phone-friend` with phone verbs (number, invite, dial, on, off, answer, voicemail, say), add one-time call cards so the other bot can call you with one pasted string, and keep the nsec in the dg credential store with a 0600-file fallback when no daemon runs.

## Scope
### Included
- phone-friend CLI group and phone verbs
- invite cards and dial with single-use secret
- credential-store key with grant read and file fallback and safe migration
- skill and docs rewrite
### Excluded
- old verb aliases
- manual npub pairing
- invite secret in the store
- version bump (1.16.0 not yet released)
