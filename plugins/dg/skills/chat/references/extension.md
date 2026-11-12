# Chat through the extension

The extension pairs with every new session on its own. The agent runs one
command:

```bash
dg-agent start
```

Expected output on stderr, with nothing on stdout:

```text
Paired <identity> (<id8>) with the browser extension.
```

If no extension is connected, the command prints this line instead:

```text
No browser extension is connected. Install it with: dg-skills install
```

Run `dg-skills install`. Then ask the human to load the extension once.

- The human opens `chrome://extensions`, turns on Developer mode, and chooses
  **Load unpacked**. The folder path is in the `dg-skills install` output.
  This is the only human step.
- Run `dg-agent start` again. It prints the Paired line.
- Pass `--ext` to require the extension. Gate it first:

```text
--ext only: dg-skills require-extension chat || exit 1
dg-agent start --ext --open
```

- `dg-agent start --open` opens the daemon's local chat page through a
  one-time code and prints no URL. The code works once, within 60 seconds.
- The extension keeps a link to its daemon and adopts each new session. It
  stays paired until the session closes. If the human clicks **Unpair** in the
  popup, that session stays unpaired until it closes.
- After a daemon home reset, the popup shows "The daemon changed". The human
  chooses **Trust this daemon**. This step is rare.
- On WSL the daemon needs **mirrored** networking mode. NAT mode cannot reach
  the loopback port from the Windows-side browser, and the daemon exits with
  code 3 rather than pretending to be reachable.

If a step fails, run dg-skills doctor require-extension install.
