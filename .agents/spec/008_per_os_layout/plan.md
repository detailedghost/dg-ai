---
feature: "Per-OS directory layout"
feature_snake_case: per_os_layout
date: "2026-10-29"
version: "1.0"
status: complete
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "dg-paths-helper"
    depends_on: []
    files: ["pkg/common/src/node/dg-paths.ts", "pkg/common/src/node/paths.ts", "pkg/common/src/node/install-skills.ts", "pkg/common/src/node/index.ts", "pkg/common/__tests__/dg-paths.spec.ts", "pkg/common/__tests__/node-paths.spec.ts", "pkg/common/__tests__/install-skills.spec.ts"]
  - id: 2
    name: "install-launchers-and-migration"
    depends_on: [1]
    files: ["pkg/skills-cli/src/install/**", "pkg/skills-cli/src/commands/install.ts", "pkg/skills-cli/src/utils/lib.ts", "pkg/skills-cli/src/utils/cli-only.ts", "pkg/skills-cli/src/doctor/probes.ts", "pkg/skills-cli/src/doctor/checks.ts", "pkg/skills-cli/src/doctor/shared.ts", "pkg/skills-cli/bootstrap.sh", "pkg/skills-cli/bootstrap.ps1", "pkg/skills-cli/__tests__/**", "pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts"]
  - id: 3
    name: "phone-and-daemon-state-move"
    depends_on: [1]
    files: ["pkg/dg-agent/src/phone/**", "pkg/dg-agent/__tests__/**", "pkg/dg-daemon/src/**", "pkg/dg-daemon/__tests__/**", "pkg/channel-review/**"]
  - id: 4
    name: "skills-bare-command-block"
    depends_on: [2]
    files: ["plugins/dg/skills/**", "scripts/skill-bootstrap-block.ts", "pkg/skills-test/__tests__/skill-bootstrap-block.spec.ts", "pkg/skills-test/__tests__/doctor-coverage.spec.ts", "pkg/skills-test/__tests__/skill-cli-invocation.spec.ts", "pkg/skills-test/__tests__/skill-manifests.spec.ts", "pkg/skills-test/__tests__/*-skill*.spec.ts", "pkg/skills-cli/__tests__/*-skill-tree*.spec.ts", "pkg/skills-cli/__tests__/skill-tree-helpers.ts"]
  - id: 5
    name: "docs-adr-f"
    depends_on: [2, 3, 4]
    files: ["docs/install.md", "docs/AGENT-INSTALL.md", "docs/DEVELOPER.md", "docs/phone.md", "docs/adr/0025-per-os-layout.md", "docs/adr/toc.md", "README.md", ".mise/config.toml"]
---

# Per-OS directory layout

## Purpose
Move every dg path to the standard per-OS layout: XDG on Linux, Library folders on macOS, APPDATA and LOCALAPPDATA on Windows, with one shared path helper in pkg/common that every package uses and that DG_HOME still overrides as a whole. Skills call the bare `dg-skills` launcher with a uniform fallback, phone keys and the phone database move with a verify step, and the old ~/.dg launcher paths keep working for two minor releases.

## Scope
### Included
- pkg/common/src/node/dg-paths.ts replaces paths.ts and the home logic in install-skills.ts
- Launchers in the per-OS bin dir; runtime, bundles and the downloaded browser in the data dir; config in the config dir; phone and daemon state in the state dir; caches in the cache dir
- Migration of ~/.dg contents on the first install after this release, with verify and kept-until-verified copies for phone keys and phone.db
- Compatibility launchers at ~/.dg/bin/* for two minor releases with a one-line stderr notice
- Bare `dg-skills` bootstrap block in every SKILL.md, generated and linted
- ADR 0025 and docs
### Excluded
- Moving scratch and state roots managed by scratch-paths.ts (already XDG aware)
- Changing the chat daemon database schema or the credential store format
- New commands

### Slice 1 — dg-paths-helper

#### Engineering
- [x] dg-paths.ts exports resolveDgPaths(seams) with the same seams (platform, homeDir, env) and these roots: binDir, configDir, dataDir, stateDir, cacheDir, logDir; and these files and dirs: configPath, runtimeDir, libDir, browsersDir, skillsDir, agentsDir(personas), daemonDir, pidPath, dbPath, credentialsDbPath, keyPath, daemonConfigPath, sessionsDir, assetsDir, memoryDbPath, grantsDir, phoneRoot, cliOnlyMarker, legacyHome
- [x] Per-OS rule table: linux: bin ~/.local/bin, config $XDG_CONFIG_HOME/dg, data $XDG_DATA_HOME/dg, state $XDG_STATE_HOME/dg, cache $XDG_CACHE_HOME/dg, log <state>/log; darwin: bin ~/.local/bin, config ~/Library/Application Support/dg, data ~/Library/Application Support/dg, state ~/Library/Application Support/dg/state, cache ~/Library/Caches/dg, log ~/Library/Logs/dg; win32: bin %LOCALAPPDATA%\dg\bin, config %APPDATA%\dg, data %LOCALAPPDATA%\dg, state %LOCALAPPDATA%\dg\state, cache %LOCALAPPDATA%\dg\cache, log %LOCALAPPDATA%\dg\log
- [x] DG_HOME set: every root is <DG_HOME>/<role> (bin, config, data, state, cache, log) so tests and channel-review homes keep one root
- [x] paths.ts is deleted; index.ts exports dg-paths; every importer of the removed field names (phoneFriendRoot, configPath meaning daemon config) is updated in the same slice only where the type forces it
- [x] install-skills.ts skillsInstallDest uses resolveDgPaths().skillsDir (data dir) unless DG_SKILLS_DEST is set; personasDest sits beside it

#### Testing Criteria
##### Contracts
- [x] Contract: resolveDgPaths({platform:'linux', homeDir:'/h', env:{}}).binDir === '/h/.local/bin' and dataDir === '/h/.local/share/dg'
- [x] Contract: XDG_DATA_HOME=/x gives dataDir /x/dg; XDG_STATE_HOME honored for stateDir
- [x] Contract: darwin dataDir is /h/Library/Application Support/dg and cacheDir /h/Library/Caches/dg
- [x] Contract: win32 with APPDATA and LOCALAPPDATA gives configDir %APPDATA%\dg and binDir %LOCALAPPDATA%\dg\bin
- [x] Contract: DG_HOME=/t gives binDir /t/bin, stateDir /t/state, configDir /t/config on every platform
- [x] Contract: legacyHome is <home>/.dg on posix and %USERPROFILE%\.dg on win32
- [x] install-skills.spec.ts: default dest is <dataDir>/skills

#### Acceptance Criteria
- [x] Given pkg/common, when `bun test` runs, then dg-paths.spec.ts covers all three platforms and the DG_HOME override
- [x] Given the monorepo, when `bun run lint:all` runs, then no package imports the removed paths.ts

### Slice 2 — install-launchers-and-migration

#### Engineering
- [x] install/layout.ts: launchers go to binDir; runtime and lib to dataDir; the cli-only marker to configDir; shims embed absolute dataDir paths
- [x] install/migrate-home.ts: migrateLegacyHome(paths) moves <legacyHome>/bin|runtime|lib -> dataDir, daemon -> stateDir/daemon, agents -> dataDir/agents, skills -> dataDir/skills, proto and demos -> cacheDir, channel-review/config.json -> configDir; phone is moved by slice 3's verify step; each move is copy, verify (file count and sizes), then remove; a failed verify keeps the source and prints the path
- [x] Compatibility launchers: after migration install writes <legacyHome>/bin/dg-skills|dg-agent|dg-daemon that print one stderr line 'dg: ~/.dg/bin/<name> is now <binDir>/<name>; this path is removed in <current minor + 2>.0' and exec the new launcher; removed by install when the running version is >= the named release
- [x] bootstrap.sh/bootstrap.ps1 use the per-OS roots; bootstrap.sh and `dg-skills install` print the PATH line for ~/.local/bin when it is missing from PATH (Linux and macOS); bootstrap.ps1 reads the HKCU user PATH, appends %LOCALAPPDATA%\dg\bin once when it is missing, and prints `added %LOCALAPPDATA%\dg\bin to the user PATH; open a new shell`
- [x] doctor: CLI_PATH becomes the bare `dg-skills`; allowRuleCheck accepts Bash(dg-skills <sub>:*) or Bash(dg-skills:*), warns when only the ~/.dg/bin form is present and prints the replacement rule; new shared check launcher-on-path
- [x] Update every pkg/skills-cli test fixture that builds a DG_HOME path by hand to the role sub-layout (<DG_HOME>/state/daemon, <DG_HOME>/config, ...)

#### Testing Criteria
##### Contracts
- [x] Contract: migrateLegacyHome on a fixture ~/.dg with bin, daemon, skills, proto ends with the files under the new roots and an empty legacy dir except bin/
- [x] Contract: a verify failure (size mismatch injected) leaves the source untouched and returns the failing path
- [x] Contract: compatibility launcher text names the removal release computed from the current version (1.28.x -> 1.30.0)
- [x] Contract: compatibility launchers are removed when the installed version >= the removal release
- [x] install.spec.ts: a fresh install on linux writes ~/.local/bin/dg-skills and ~/.local/share/dg/lib/current
- [x] bootstrap-asset-selection.spec.ts: linux and darwin runs write launchers to ~/.local/bin; DG_HOME run writes <DG_HOME>/bin
- [x] doctor tests: allow rule check accepts the bare form and flags the old form with the replacement

#### Acceptance Criteria
- [ ] Given a user on the previous release with ~/.dg populated, when `dg-skills install` runs once, then launchers exist in ~/.local/bin, state is under ~/.local/state/dg, and `~/.dg/bin/dg-skills --version` still works with one notice line
- [x] Given DG_HOME=/tmp/x, when install runs, then nothing is written outside /tmp/x

### Slice 3 — phone-and-daemon-state-move

#### Engineering
- [x] phone/store.ts and phone/db.ts read phoneRoot from resolveDgPaths (stateDir/phone); phone/migrate-home.ts movePhoneState(oldRoot, newRoot): copy each line directory (phone.db, key files, listener.pid, listener.log), then verify: open each phone.db read-only and run `PRAGMA integrity_check`, load each key with the existing loadKey path; only after every verify passes remove the old copy; a failure keeps both and prints the rollback line
- [x] Rollback documented and implemented as `dg-agent phone __rollback-home` (hidden): copies state back to legacyHome/phone when the new root fails verify later
- [x] autostart.ts units always use launcherCommand('dg-agent', ...) absolute paths from the new layout; `phone __refresh` regenerates them
- [x] dg-daemon: daemonDir, pid, db, key, logs come from resolveDgPaths stateDir and logDir; no code path builds ~/.dg by hand (grep gate)
- [x] Update the dg-daemon, dg-agent and channel-review test fixtures that build a DG_HOME path by hand (with slice 2's share, 113 files in all) to the role sub-layout

#### Testing Criteria
##### Contracts
- [x] Contract: movePhoneState on a fixture with two lines ends with both lines under the new root, integrity_check ok, keys loadable, old root removed
- [x] Contract: a corrupted copy (bytes truncated after copy, injected) fails verify, keeps the old root, writes nothing else
- [x] Contract: systemd, launchd and schtasks unit text contains the absolute launcher path and no ~ or $HOME
- [x] dg-daemon tests: temp DG_HOME runs put daemon.db under <DG_HOME>/state/daemon
- [x] grep gate test: no source file under pkg/*/src contains the literal '.dg' path segment except dg-paths.ts legacyHome

#### Acceptance Criteria
- [ ] Given a phone line with messages, when install migrates it, then `dg-agent phone voicemail` lists the same messages from the new root
- [ ] Given a running listener unit from the old layout, when `phone __refresh` runs, then the unit points at the new launcher and the listener is live

### Slice 4 — skills-bare-command-block

#### Engineering
- [x] scripts/skill-bootstrap-block.ts: renders the uniform first-run block for a probe subcommand and rewrites every SKILL.md that calls the CLI (`--write`) or reports drift (`--check`); the block: `dg-skills <probe> --help >/dev/null 2>&1 || "$HOME/.local/bin/dg-skills" <probe> --help >/dev/null 2>&1 || curl -fsSL …/bootstrap.sh | sh -s -- --cli-only` followed by one sentence: 'Call `dg-skills` in every later step; if only the fallback path answered, call `$HOME/.local/bin/dg-skills` instead.'
- [x] Every `~/.dg/bin/dg-skills` and `~/.dg/bin/dg-agent` in plugins/dg/skills becomes `dg-skills` / `dg-agent` (304 occurrences in 103 files); doctor lines become `If a step fails, run dg-skills doctor …`
- [x] skill-bootstrap-block.spec.ts runs the generator in --check mode so drift fails CI; doctor-coverage.spec.ts DOCTOR_LINE and skill-cli-invocation.spec.ts patterns match the bare form

#### Testing Criteria
##### Contracts
- [x] Contract: `bun scripts/skill-bootstrap-block.ts --check` exits 0 on the committed tree and 1 after one SKILL.md block is edited by hand
- [x] Contract: no file under plugins/dg/skills contains '~/.dg/bin/'
- [x] doctor-coverage.spec.ts passes with the bare doctor line

#### Acceptance Criteria
- [x] Given a shell without ~/.local/bin on PATH, when an agent runs a skill's first-run block, then the fallback path answers and the sentence tells the agent which path to use
- [x] Given a fresh machine, when the block runs, then bootstrap installs and the second line passes

### Slice 5 — docs-adr-f

#### Engineering
- [x] docs/install.md: layout table per OS, DG_HOME override, migration and rollback, compatibility launcher retirement release
- [x] docs/phone.md: new phone state path, verify step, rollback command
- [x] docs/adr/0025-per-os-layout.md and toc entry
- [x] .mise tasks use `dg-skills` from PATH with the data dir fallback

#### Testing Criteria
##### Contracts
- [x] Contract: markdownlint and vale pass
- [x] skill-index-docs.spec.ts passes

#### Acceptance Criteria
- [x] Given docs/install.md, when a reader looks for where dg stores phone data on macOS, then the table names ~/Library/Application Support/dg/state/phone

## Slice Summaries

## Agent Notes

## Issues Remediation

## Decisions

- [DECIDED] Standard per-OS layout on all platforms; `DG_HOME` still overrides everything as one root.
- [DECIDED] Skills call bare `dg-skills` with a fallback to the absolute launcher path; a generator keeps the first-run block uniform across the 103 SKILL.md files and a lint test fails on drift.
- [DECIDED] Units (systemd, launchd, Task Scheduler) use absolute paths.
- [DECIDED] Phone keys and phone.db move with a verify step; the old copy stays until verify passes; rollback is documented.
- [DECIDED] `~/.dg` stays for two minor releases, then is removed, mirroring the phone-friend alias retirement (one stderr line naming the removal release).
- [DECIDED] "Compatibility link" is implemented as notice-printing launchers at `~/.dg/bin/*` for two minor releases, not one symlink: the old home splits into four roots (config, data, state, cache), so no single link can represent it.
- [DECIDED] macOS launchers go to `~/.local/bin`: user-writable, no sudo; bootstrap and `dg-skills install` print the PATH line when the directory is not on PATH. Rejected: `/usr/local/bin` (sudo on Intel Macs) and the Homebrew prefix (only present with Homebrew).
- [DECIDED] Windows launchers go to `%LOCALAPPDATA%\dg\bin`; `bootstrap.ps1` appends it to the HKCU user PATH once when it is missing and prints the change (the same approach Bun's installer uses). Rejected: `%LOCALAPPDATA%\Microsoft\WindowsApps` (reserved for app execution aliases).
- [DECIDED] The old `Bash(~/.dg/bin/dg-skills <sub>:*)` allow rules stop matching once skills call `dg-skills`; doctor prints the replacement `Bash(dg-skills <sub>:*)`.

## Layout table

| Role | Linux (XDG) | macOS | Windows | DG_HOME set |
| --- | --- | --- | --- | --- |
| launchers | `~/.local/bin` | `~/.local/bin` | `%LOCALAPPDATA%\dg\bin` | `$DG_HOME/bin` |
| config (`config.json`, cli-only marker, channel-review config) | `$XDG_CONFIG_HOME/dg` | `~/Library/Application Support/dg` | `%APPDATA%\dg` | `$DG_HOME/config` |
| data (runtime, lib, skills, agents, browsers) | `$XDG_DATA_HOME/dg` | `~/Library/Application Support/dg` | `%LOCALAPPDATA%\dg` | `$DG_HOME/data` |
| state (daemon, phone, grants) | `$XDG_STATE_HOME/dg` | `~/Library/Application Support/dg/state` | `%LOCALAPPDATA%\dg\state` | `$DG_HOME/state` |
| cache (proto, demos, extension staging) | `$XDG_CACHE_HOME/dg` | `~/Library/Caches/dg` | `%LOCALAPPDATA%\dg\cache` | `$DG_HOME/cache` |
| logs | `<state>/log` | `~/Library/Logs/dg` | `%LOCALAPPDATA%\dg\log` | `$DG_HOME/log` |

`pkg/common/src/node/scratch-paths.ts` (AI scratch and state roots) already honors `XDG_STATE_HOME` and is not touched.

## Code Structure

```text
pkg/common/src/node/dg-paths.ts                 resolveDgPaths(seams): per-OS roots, every dg file and dir, legacyHome
pkg/common/src/node/paths.ts                    deleted (resolveDgPaths moves to dg-paths.ts with new fields)
pkg/common/src/node/install-skills.ts           skillsInstallDest -> resolveDgPaths().skillsDir unless DG_SKILLS_DEST
pkg/common/__tests__/dg-paths.spec.ts           three platforms, XDG vars, DG_HOME override, legacyHome
pkg/skills-cli/src/install/layout.ts            where install writes launchers, runtime, lib, markers
pkg/skills-cli/src/install/migrate-home.ts      migrateLegacyHome(paths): copy, verify, remove per role
pkg/skills-cli/src/install/compat-launchers.ts  write and retire ~/.dg/bin/* launchers with the notice line
pkg/skills-cli/src/doctor/probes.ts             CLI_PATH = "dg-skills"; allow rule probe accepts bare and old forms
pkg/dg-agent/src/phone/migrate-home.ts          movePhoneState(oldRoot, newRoot): copy, integrity_check, key load, remove
pkg/dg-agent/src/phone/autostart.ts             units from launcherCommand(absolute)
pkg/dg-daemon/src/**                            stateDir and logDir from resolveDgPaths
scripts/skill-bootstrap-block.ts                --write / --check the uniform first-run block in every SKILL.md
pkg/skills-test/__tests__/skill-bootstrap-block.spec.ts   drift gate
plugins/dg/skills/**/SKILL.md                   bare `dg-skills`, generated block (103 files)
docs/adr/0025-per-os-layout.md                  ADR
```

## Code sample: the path helper and the generated skill block

`pkg/common/src/node/dg-paths.ts`:

```ts
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type SystemSeams = { platform?: NodeJS.Platform; homeDir?: string; env?: Record<string, string | undefined> };

export type DgRoots = { binDir: string; configDir: string; dataDir: string; stateDir: string; cacheDir: string; logDir: string };

export type DgPaths = DgRoots & {
	configPath: string;
	cliOnlyMarker: string;
	runtimeDir: string;
	libDir: string;
	browsersDir: string;
	skillsDir: string;
	personasDir: string;
	daemonDir: string;
	pidPath: string;
	dbPath: string;
	credentialsDbPath: string;
	keyPath: string;
	daemonConfigPath: string;
	grantsDir: string;
	phoneRoot: string;
	legacyHome: string;
};

function roots(platform: NodeJS.Platform, home: string, env: Record<string, string | undefined>): DgRoots {
	const path = platform === "win32" ? win32 : posix;
	if (env.DG_HOME) {
		const root = env.DG_HOME;
		return {
			binDir: path.join(root, "bin"),
			configDir: path.join(root, "config"),
			dataDir: path.join(root, "data"),
			stateDir: path.join(root, "state"),
			cacheDir: path.join(root, "cache"),
			logDir: path.join(root, "log"),
		};
	}
	if (platform === "win32") {
		const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
		const roaming = env.APPDATA ?? path.join(home, "AppData", "Roaming");
		return {
			binDir: path.join(local, "dg", "bin"),
			configDir: path.join(roaming, "dg"),
			dataDir: path.join(local, "dg"),
			stateDir: path.join(local, "dg", "state"),
			cacheDir: path.join(local, "dg", "cache"),
			logDir: path.join(local, "dg", "log"),
		};
	}
	if (platform === "darwin") {
		const support = path.join(home, "Library", "Application Support", "dg");
		return {
			binDir: path.join(home, ".local", "bin"),
			configDir: support,
			dataDir: support,
			stateDir: path.join(support, "state"),
			cacheDir: path.join(home, "Library", "Caches", "dg"),
			logDir: path.join(home, "Library", "Logs", "dg"),
		};
	}
	const xdg = (name: string, fallback: string) => path.join(env[name] || path.join(home, fallback), "dg");
	const stateDir = xdg("XDG_STATE_HOME", ".local/state");
	return {
		binDir: path.join(home, ".local", "bin"),
		configDir: xdg("XDG_CONFIG_HOME", ".config"),
		dataDir: xdg("XDG_DATA_HOME", ".local/share"),
		stateDir,
		cacheDir: xdg("XDG_CACHE_HOME", ".cache"),
		logDir: path.join(stateDir, "log"),
	};
}

export function resolveDgPaths(seams: SystemSeams = {}): DgPaths {
	const platform = seams.platform ?? process.platform;
	const home = seams.homeDir ?? homedir();
	const env = seams.env ?? process.env;
	const path = platform === "win32" ? win32 : posix;
	const r = roots(platform, home, env);
	const daemonDir = path.join(r.stateDir, "daemon");
	return {
		...r,
		configPath: path.join(r.configDir, "config.json"),
		cliOnlyMarker: path.join(r.configDir, "cli-only"),
		runtimeDir: path.join(r.dataDir, "runtime"),
		libDir: path.join(r.dataDir, "lib"),
		browsersDir: path.join(r.dataDir, "browsers"),
		skillsDir: path.join(r.dataDir, "skills"),
		personasDir: path.join(r.dataDir, "agents"),
		daemonDir,
		pidPath: path.join(daemonDir, "daemon.pid"),
		dbPath: path.join(daemonDir, "daemon.db"),
		credentialsDbPath: path.join(daemonDir, "credentials.db"),
		keyPath: path.join(daemonDir, "key"),
		daemonConfigPath: path.join(daemonDir, "config.json"),
		grantsDir: path.join(r.stateDir, "grants"),
		phoneRoot: path.join(r.stateDir, "phone"),
		legacyHome: path.join(home, ".dg"),
	};
}
```

`pkg/dg-agent/src/phone/migrate-home.ts`, the verify step:

```ts
export async function movePhoneState(oldRoot: string, newRoot: string, log: (line: string) => void): Promise<MoveResult> {
	if (!existsSync(oldRoot)) return { moved: [], skipped: "no legacy phone state" };
	mkdirSync(newRoot, { recursive: true, mode: 0o700 });
	const lines = readdirSync(oldRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	for (const line of lines) copyDirPrivate(join(oldRoot, line), join(newRoot, line));
	const failures = lines.flatMap((line) => verifyLine(join(newRoot, line)));
	if (failures.length > 0) {
		log(`phone state kept at ${oldRoot}; verify failed: ${failures.join("; ")}`);
		log(`rollback: dg-agent phone __rollback-home`);
		return { moved: [], failures };
	}
	rmSync(oldRoot, { recursive: true, force: true });
	return { moved: lines };
}

function verifyLine(dir: string): string[] {
	const problems: string[] = [];
	const db = new Database(join(dir, "phone.db"), { readonly: true });
	try {
		const row = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
		if (row.integrity_check !== "ok") problems.push(`${dir}/phone.db: ${row.integrity_check}`);
	} finally {
		db.close();
	}
	if (!loadKeyFile(dir)) problems.push(`${dir}: key does not load`);
	return problems;
}
```

The generated first-run block that `scripts/skill-bootstrap-block.ts` writes into every CLI-calling SKILL.md (probe subcommand varies):

```bash
dg-skills worktree --help >/dev/null 2>&1 ||
  "$HOME/.local/bin/dg-skills" worktree --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

followed by one fixed sentence: "Call `dg-skills` in every later step. If only the second line answered, call `$HOME/.local/bin/dg-skills` instead." and the doctor line `If a step fails, run dg-skills doctor <items>.` The block is 70 characters shorter per call site than today's `~/.dg/bin/dg-skills` form, across about 300 call sites.

Compatibility launcher written at `~/.dg/bin/dg-skills` (and the two others) until the named release:

```sh
#!/bin/sh
printf 'dg: ~/.dg/bin/dg-skills is now %s; this path is removed in 1.30.0\n' "/home/u/.local/bin/dg-skills" >&2
exec "/home/u/.local/bin/dg-skills" "$@"
```

## Migration, rollback

1. First `dg-skills install` after F: `migrateLegacyHome` moves `~/.dg/{runtime,lib,skills,agents}` to the data dir, `~/.dg/daemon` to the state dir, `~/.dg/{proto,demos}` to the cache dir, `~/.dg/channel-review/config.json` and `~/.dg/cli-only` to the config dir, each as copy, verify (count and sizes), remove.
2. `movePhoneState` copies each phone line, opens every `phone.db` with `PRAGMA integrity_check`, loads every key, then removes the old copy. A failure keeps both copies and prints the rollback command.
3. `phone __refresh` regenerates units with `launcherCommand` absolute paths; `refreshPhoneListener` in install already calls it.
4. Compatibility launchers are written at `~/.dg/bin/*`; install removes them when the running version is at or past the named release (first F release 1.28.0 -> removal in 1.30.0).
5. Rollback: `dg-agent phone __rollback-home` copies phone state back to `~/.dg/phone`; `install --version <pre-F>` restores the old launchers (the old release writes `~/.dg/bin`); data under the new roots is left in place.

## Size, speed and token impact

No binary or bundle size change. One extra `stat` per launch for the PATH fallback only when the first command fails. Tokens: about 300 call sites lose `~/.dg/bin/` (10 characters each); each SKILL.md first-run block grows by one fallback line (about 20 tokens) once.

## Risks and early signals

- `Bash(~/.dg/bin/dg-skills …)` allow rules in user settings stop matching; doctor warns with the exact replacement before the user hits a prompt.
- Task Scheduler and launchd units that embed the old binary path break until `phone __refresh` runs; install runs it.
- A host where `~/.local/bin` is not on PATH gets the fallback line; the generated sentence tells the agent which path to use.

## ADR draft: docs/adr/0025-per-os-layout.md

Status: Proposed. Context: every dg path hangs off `~/.dg` built by hand in `paths.ts`, `install-skills.ts`, `lib.ts` and `cli-only.ts`; the per-OS conventions (XDG, Library, APPDATA) separate config, data, state and cache so backups and cleaners treat them differently; tests leak `DG_HOME`. Decision: one helper, `resolveDgPaths`, owns every root and file; `DG_HOME` maps to `<DG_HOME>/<role>`; launchers live in the per-OS bin dir; skills call `dg-skills` from PATH with one generated fallback block; `~/.dg/bin/*` stay as notice-printing launchers for two minor releases. Consequences: good — standard locations, one place to change, shorter skill text; bad — a migration with a verify step for phone state, allow rules need a one-time update; neutral — scratch and state roots for AI tools are unchanged. Alternatives: keep `~/.dg` (simple, non-standard); XDG only on Linux (three code paths for the same thing).

## Ratified decisions

- [DECIDED] `~/.dg` compatibility: notice-printing launchers at `~/.dg/bin/*` for two minor releases.
- [DECIDED] macOS launchers live in `~/.local/bin`; install prints the PATH line when the directory is missing from PATH.
- [DECIDED] `bootstrap.ps1` appends `%LOCALAPPDATA%\dg\bin` to the HKCU user PATH once when it is missing and prints the change.

## Chain position

Layer 2 on `feat/shared-runtime-bundle`. Branch `feat/per-os-layout`. A-D build on this branch so they use `resolveDgPaths()` roots (browsersDir, configPath, libDir) and the bare `dg-skills` skill block from day one.

## DG_HOME sub-layout

- [DECIDED] With `DG_HOME=/t` the roots are `/t/bin`, `/t/config`, `/t/data`, `/t/state`, `/t/cache`, `/t/log`. Today the layout under DG_HOME is flat (`/t/bin`, `/t/daemon`, `/t/skills`, `/t/phone`). The change moves `<DG_HOME>/daemon/daemon.pid` and friends to `<DG_HOME>/state/daemon/`.
- Cost: 113 test files reference `DG_HOME` (85 in dg-daemon, dg-agent and channel-review), the `.mise` remote tasks use the flat form, and channel-review remote homes are flat on disk; each DG_HOME user gets the same migration as `~/.dg`.
- [DECIDED] DG_HOME uses role subfolders (`<DG_HOME>/bin|config|data|state|cache|log`); the 113 test files that reference DG_HOME are updated in slices 2 and 3.

## Agent Notes

- Merged as #136 (095a4da7), with the four follow-up changes the human asked for: Windows runtime cleanup, keychain re-scope, extension folder in the data root, ssms move.
- Human decisions: warn for any DG_HOME; always move the ssms allow file, with paths from the passwd home only; resolve a relative DG_HOME for every root, hooks included.
- Left open: the three upgrade checks above. They need a real install on a machine with an old ~/.dg.
