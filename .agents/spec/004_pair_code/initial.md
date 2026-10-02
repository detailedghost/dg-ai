# Pair code and release pipeline fix — Initial Notes

## Purpose
Let the user pair the dg extension from the extension itself with a short one-time code printed by the CLI, instead of opening a dg-agent start link. The code proves the user has local terminal access, so pairing stays as safe as today. Also fix the release pipeline so merges to master ship new binaries and extension builds again.

## Scope
### Included
- dg-daemon pair command: prints a 6 digit one-time code, valid 5 minutes, max 5 attempts, stored hashed in DG_HOME with mode 0600
- Daemon POST /pair: validates the code (constant time, single use, expiry, attempts), refuses when another origin is pinned, then mints a session bootstrap for the extension
- Extension Pair UI: Not paired state with a Pair button, daemon discovery on ports 47823 to 47832, code entry, success and error states
- Background feeds the returned bootstrap into the existing marker-captured connect path, so the existing handshake pins the origin
- The overwatch board and chat page show Not paired with a Pair button when the daemon is reachable but the extension is not connected
- Release pipeline: replace retired macos-13 smoke runners, bump all package versions to 1.10.0 so releases publish
### Excluded
- Removing the existing dg-agent start link flow (it stays)
- Remote or non-loopback pairing
- Multiple pinned origins
