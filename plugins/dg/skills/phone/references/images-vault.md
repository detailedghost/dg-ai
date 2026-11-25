# Images and the PHI vault

## Images

```bash
dg phone files on                          # prints {"files": "on"}; files off turns it off
dg phone text +grok --image ./shot.png      # one image, no text; send words with a second text command
dg phone text '#ops' --image ./shot.png --phi
```

`files` is off by default. It gates both sending and receiving. The sender
strips metadata, encrypts the image, and keeps the ciphertext until the
receiver's listener fetches it through Magic Wormhole. An image row shows
`[image pending]` while the fetch runs, then `[image]` or
`[image unavailable: <reason>]`. A stored image adds
`file: {path, type, size, sha256, untrusted: true}` to `messages`, `unread`,
and the `--on-message` JSON. A finished image comes back as unread, so
`unread` can show the same row twice: once pending, once final.
`--phi` rows and their files are deleted 24 hours after they arrive. A
received PHI image goes into the vault instead; see [The PHI vault](images-vault.md).

`untrusted: true` means the rules for received files in
[safety.md](safety.md) apply.

## The PHI vault

```bash
dg phone vault add lab-1 ./result.txt       # or - for stdin; prints the lowercase name, size, and dates only
dg phone vault add lab-1 -
dg phone vault list                         # names, sizes, types, senders, dates; never content
dg phone text +grok --vault lab-1           # sends the item; implies --phi
dg phone vault exec lab-1 --out lab-1-sum -- ./summarize   # item on stdin, stdout to a new item
dg phone vault rm lab-1
```

The vault holds PHI that you can use but never read. Each item is
AES-256-GCM encrypted under a weekly key in the dg credential store
(`phone-vault/<yyyy>-w<ww>`, one per ISO week by local time; `yyyy-W<ww>` is the same week), and each key is
deleted 48 hours after its week ends. Every item expires 24 hours after it was stored. A name's letters may be
any case; it is stored in lowercase, so `Lab` and `lab` are one item. `vault add` reads stdin when the file is omitted or is `-`.
Vault commands refuse when the credential store is not reachable. A store that is up and rejects a name reports that rejection.

A received `dg-phi` text or image goes straight into the vault. `unread`,
`messages`, and the `--on-message` JSON show only
`[PHI: vault item <name> from +handle]`, with a name this phone made:
`<handle>-<yyyymmddhhmm>-<4 hex>`. When no vault key can be reached, the
text is dropped and the row reads `[PHI: vault unavailable from +handle]`; an
image retries until its deadline.

`phone vault exec` passes the item on stdin, or in one env var with
`--env`, with no `DG_*` or cloud credential variables in its env, and stores the command's stdout (5 MiB at most) as a new item. It
prints only `{"name", "exit", "out", "size", "stderr_lines"}`. A nonzero
exit stores nothing and exits with the command's code. A command still
running after `--timeout` (default 120 s) is killed and exits 124.

`phone vault open <name>` is for a human at a terminal. It refuses inside
Claude Code, Codex, opencode, Gemini CLI, or a Grok CLI hook, and without a TTY on stdin and stdout. Do not run it.

Agents run as the same OS user as the vault, so the vault is a guardrail, not a hard wall.
Follow the vault rules in [safety.md](safety.md).

