---
covers: ["pkg/skills-cli/src/demo/player-process.ts", "plugins/dg/skills/demo/SKILL.md", "docs/install.md"]
---

[ADR 0029](../../docs/adr/0029-local-demo-player-wsl-debug-port.md)

- On WSL with a Windows browser, a default local `demo` and `--video` open an unauthenticated 127.0.0.1 remote-debugging port. The risk is accepted. Do not add authentication.
- Bind the port to loopback only.
- Close the port when the run ends. The window lasts at most `--timeout`, 30 minutes by default.
- `--video --browser chromium` stays headless inside WSL and opens no Windows port.
- The bridge accepts calls only from the main frame of a page on a plan origin. `trustedSource` rejects every other frame and origin.
- Keep the port and the `--video --browser chromium` opt-out stated in the demo skill and `docs/install.md`.
