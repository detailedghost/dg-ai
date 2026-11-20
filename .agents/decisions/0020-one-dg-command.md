---
covers: ["pkg/dg-daemon/src/services/**", "pkg/dg-agent/src/start.ts", "pkg/channel-review/src/runners/index.ts", "pkg/skills-test/__tests__/release-triggers.spec.ts"]
---

[ADR 0020](../../docs/adr/0020-one-dg-command.md)

- Install keeps one bundle for the three programs and writes `dg` as a fourth launcher beside `dg-skills`, `dg-agent` and `dg-daemon`.
- `dg` mounts a command tree and never replaces one. Each program keeps its commands in its own package.
- Do not build the single `dg` binary, the `dg-v<x>` tag, `dg review`, or the `dg service` group.
- Do not register a `review-<env>` service in install or in the daemon.
- Keep service commands under `dg-daemon service`.
- `dg daemon` runs `dg-daemon`. `dg-daemon serve` starts the long-running process. Do not add `dg daemon run`.
- `dg-daemon` keeps its own command tree.
- A job or service stores the argument list of the one program it names, never a `dg <command>` list. The job model is in [ADR 0049](../../docs/adr/0049-jobs.md).
- `dg autostart` mounts `dg-daemon autostart`. It installs, removes and reports the daemon login unit.
- Autostart writes a systemd user unit with linger on Linux and WSL, a launchd LaunchAgent on macOS, and a scheduled task on Windows.
- In WSL, autostart also adds a Windows login task that runs `wsl.exe -d <distro> --exec sleep infinity`. `remove` undoes both.
- The supervisor restarts a service only when its process exits. A review result such as CR-208 is not a process exit.
- Keep the release guards in `release-triggers.spec.ts` in step with the tags the release flow publishes.
