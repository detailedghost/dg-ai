---
covers: ["pkg/dg-daemon/src/services/**", "pkg/dg-agent/src/start.ts", "pkg/channel-review/src/runners/index.ts", "pkg/skills-test/__tests__/release-triggers.spec.ts"]
---

[ADR 0020](../../docs/adr/0020-one-dg-command.md)

Superseded by [ADR 0055](0055-one-dg-program-with-flat-commands.md) where they disagree.

- Each command tree keeps its commands in its own package; `dg` routes to it (ADR 0055).
- Do not build the `dg-v<x>` tag or `dg review`.
- Do not register a `review-<env>` service in install or in the daemon.
- Keep service commands under `dg service`.
- `dg daemon serve` starts the long-running process. Do not add `dg daemon run`.
- The daemon keeps its own command tree.
- A job or service stores the argument list its owner gave it. The job model is in [ADR 0049](../../docs/adr/0049-jobs.md).
- `dg autostart` installs, removes and reports the daemon login unit.
- Autostart writes a systemd user unit with linger on Linux and WSL, a launchd LaunchAgent on macOS, and a scheduled task on Windows.
- In WSL, autostart also adds a Windows login task that runs `wsl.exe -d <distro> --exec sleep infinity`. `remove` undoes both.
- The supervisor restarts a service only when its process exits. A review result such as CR-208 is not a process exit.
- Keep the release guards in `release-triggers.spec.ts` in step with the tags the release flow publishes.
