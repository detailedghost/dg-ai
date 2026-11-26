# dg plugin admission is signed, and plugin tokens stay off plain TCP

Status: Accepted (implemented in the native front door and the Bun CLI; follow-up to spec 027)
Date: 2026-11-25
Topic: Security

Related: [ADR 0059](0059-dg-plugins-are-built-in-or-external-with-one-transport-contract.md),
[ADR 0006](0006-credential-store.md), [ADR 0049](0049-jobs.md).

## Context

- ADR 0059 admits a plugin when `dg-plugin.json` says it is approved and the tree hash matches. Any process that
  can write the plugin folder can also write that record, so an agent could approve a plugin by editing a file.
- The Windows named pipe used a user-only ACL but did not refuse network logons.
- TCP plugins sent their token in a plain-text hello. Loopback TCP is readable by any local process that can sniff
  or proxy the port.
- A crash or a timeout of an external hook plugin always let the action go ahead.
- Job plugins could be pinned by a tag, a branch or a short commit, which can move.
- `PluginHost.Admit` hashed the whole plugin tree on every call.

## Decision

1. **Signed approvals.** The approval record carries `mac`, an HMAC-SHA256 over the record fields (name, kind,
   source, pin, tree hash, approved hash) with a domain prefix. The key is the dg credential
   `dg/plugin-approval-key` in the daemon credential store, not a file in the plugin folder. An unsigned record or a
   bad MAC fails admission, and so does a record whose signed fields hold a NUL byte. Only
   `dg plugin verify <name> --approve` signs, and it keeps the stdin TTY gate. Without a running daemon, a
   registered session or the key, no plugin is approved.
2. **Pipe DACL.** The Windows named pipe allows the current user SID only and denies the network logon SID.
3. **No tokens over TCP.** A plugin that needs a token must use IPC or HTTPS. dg refuses a TCP plugin with a token
   at manifest validation and never sends a token over TCP. TCP stays for plugins without authentication.
4. **`fail_closed`.** `[plugins.<name>] fail_closed = true` makes a crash or a timeout of that hook plugin block
   the action. The default stays `false`.
5. **Job pins.** A job plugin pin is a full commit SHA (40 or 64 hex). dg checks the commit and the tree hash at
   install and again at load, and refuses tags, branches and short SHAs. It also refuses a clone with uncommitted
   or untracked files that are not ignored, index entries marked assume-unchanged or skip-worktree, and local
   `.git/info/exclude` rules.
6. **Admission stat cache.** `PluginHost.Admit` keeps a stat cache per plugin: size, mtime in nanoseconds and file
   identity (inode, or the Windows file index) for each file in the plugin tree, the attested tree hash and the
   time of the last full hash, in `stat-cache.json` in the plugin folder. Times are nanoseconds since the Unix epoch. The cache is signed with the same key. dg hashes the tree again when any stat
   changes, when the signature fails, when the attested hash differs from the record, and fully once a day.

## Consequences

- Editing `dg-plugin.json` no longer approves a plugin. An agent that can run code as the user can still reach the
  credential store through an active session; the TTY gate and the store raise the cost, they do not remove it.
- Records written before this change are unsigned. Users approve each plugin again once.
- External hook plugins need a running dg daemon and a registered session to be admitted. A plugin that fails
  admission never blocks the tool call, even with `fail_closed = true`. The C# front door has no credential client, so
  native `dg plugin list`, `verify` and `enable` hand a record that claims approval to the Bun program.
- Most admissions skip the tree hash; a daily full hash bounds how long a stat-preserving edit can last.

## Diagram

```mermaid
flowchart LR
  V["dg plugin verify --approve (TTY)"] -- get or create key --> K["credential store: dg/plugin-approval-key"]
  V -- writes mac --> R["dg-plugin.json"]
  A["admission (hook run, PluginHost.Admit)"] -- reads key --> K
  A -- checks mac and tree --> R
  A -- stat cache hit skips the hash --> C["signed stat cache"]
```

## Other options

- A key file next to the record: any writer of the folder could also write the key.
- Signing and verifying inside the daemon so the key never leaves it: stronger, but needs a new daemon operation.
  Kept as a follow-up.
- Refusing tokens over plain `http://` loopback too: out of scope here; HTTP stays for simple authoring.
