---
feature: "Prune old Claude plugin cache versions on install"
feature_snake_case: install_prune_plugin_cache
date: "2026-10-29"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "plugin-cache-prune"
    depends_on: []
    files: ["pkg/common/src/node/plugin-cache.ts","pkg/common/src/node/index.ts","pkg/common/__tests__/plugin-cache.spec.ts","pkg/skills-cli/src/install/prune-plugin-cache.ts","pkg/skills-cli/src/install/doctor.ts","pkg/skills-cli/src/commands/install.ts","pkg/skills-cli/__tests__/install-prune-cache.spec.ts","pkg/skills-cli/__tests__/install.spec.ts","docs/install.md"]
---

# Prune old Claude plugin cache versions on install

## Purpose
Claude Code keeps every dg plugin version under ~/.claude/plugins/cache/<marketplace>/dg/<version>/ and only removes orphaned ones about 14 days after it marks them. `dg-skills install` reclaims that space now: it keeps the version named in installed_plugins.json and any version a session read in the last 24 hours, deletes the rest, and prints what it removed. `--keep-cache` skips the step. Install also tells the user when DG_HOME points somewhere other than the default home.

## Scope
### Included
- pkg/common plugin-cache helper: list versions, read installed_plugins.json, read .in_use markers and .orphaned_at, plan keep/remove
- install runs the prune automatically in every mode except --skills-only; --keep-cache skips it; one summary line
- doctor install check reporting reclaimable versions
- DG_HOME notice on install and a doctor warning when DG_HOME is set
### Excluded
- Other plugins' cache folders
- Marketplace clones under ~/.claude/plugins/marketplaces
- A standalone prune command

### Slice 1 — plugin-cache-prune

#### Engineering
- [ ] plugin-cache.ts: listDgPluginVersions(home) -> {marketplace, version, path, bytes, orphanedAt?: number, lastReadAt?: number}[] where lastReadAt is the newest mtime of files under <version>/.in_use/ (Claude writes {pid, procStart} per session there)
- [ ] plugin-cache.ts: activeVersions(home) reads ~/.claude/plugins/installed_plugins.json and returns the version per `dg@<marketplace>` key
- [ ] plugin-cache.ts: planPluginCachePrune(versions, active, now, readWindowMs = 24h) keeps a version when it is active, when lastReadAt >= now - readWindowMs, or when any .in_use entry names a live pid; everything else is removed; an unreadable installed_plugins.json removes nothing
- [ ] install/prune-plugin-cache.ts: prunePluginCache({home, now, keep: boolean, log}) removes each planned dir with rmSync recursive and prints `plugin cache: removed <versions> (<MB>); kept <active> (active), <v> (read <n>h ago)` or `plugin cache: nothing to remove`
- [ ] commands/install.ts: option `--keep-cache` ('leave old dg plugin versions in the Claude plugin cache'); the prune runs after the binaries step in default, --cli-only, --agent-only and --prune paths; --skills-only never prunes
- [ ] commands/install.ts: when process.env.DG_HOME is set and differs from the default home, print `note: DG_HOME=<path>; installing there` to stderr before any change
- [ ] install/doctor.ts: check plugin-cache reports `n stale version(s), <MB> reclaimable` as warn with fix `dg-skills install`; shared check dg-home warns when DG_HOME is set

#### Testing Criteria
##### Contracts
- [ ] Contract: a version with .orphaned_at older than 24h and no .in_use entries is removed
- [ ] Contract: the active version is kept even when it carries .orphaned_at
- [ ] Contract: a version whose .in_use file mtime is 1h old is kept with the reason `read 1h ago`
- [ ] Contract: a version whose .in_use file names a live pid (process.pid) is kept even when the mtime is 3 days old
- [ ] Contract: a version with neither .orphaned_at nor .in_use is kept with the reason `unknown state` and the summary prints `kept <version> (unknown state)`
- [ ] Contract: a missing or malformed installed_plugins.json plans no removal and logs `plugin cache: skipped (installed_plugins.json unreadable)`
- [ ] Contract: only <cache>/*/dg/* directories are considered; sibling plugins are untouched
- [ ] install-prune-cache.spec.ts: `install --cli-only --keep-cache` on a fixture home removes nothing; without the flag it removes the stale fixture versions and prints the summary line
- [ ] install.spec.ts: DG_HOME=/tmp/x prints the note line to stderr once
- [ ] doctor test: plugin-cache check warns with the reclaimable size

#### Acceptance Criteria
- [ ] Given the real cache with 1.20.0-1.23.0 orphaned yesterday and 1.24.0 active, when `dg-skills install --cli-only` runs, then 1.20.0-1.23.0 are removed, 1.24.0 stays, and the summary names about 58 MB
- [ ] Given a Claude session started on 1.23.0 one hour ago, when install runs, then 1.23.0 is kept with `read 1h ago`

## Slice Summaries

## Agent Notes

## Issues Remediation

## Decisions

- [DECIDED] Automatic on every `dg-skills install`; keep the version in `installed_plugins.json` plus any version a session read in the last 24 h; delete the rest; print what it removed; `--keep-cache` skips it.
- Pivot from the brief: Claude Code does mark and remove old versions. On disk today `1.20.0` to `1.23.0` each carry `.orphaned_at` (epoch ms) and every version has `.in_use/<session>` files holding `{"pid","procStart"}`; the docs say orphaned directories are removed by a background job 14 days later, only while at least one plugin is installed. So this PR reclaims space now (14-15 MB per version today, 1.8 GB when a version carried node_modules) and uses Claude's own signals instead of inventing one: `.in_use` mtime and live pids for "a session read it", `installed_plugins.json` for "active".
- [DECIDED] "Read in the last 24 h" means the newest mtime under `<version>/.in_use/`, or an `.in_use` entry whose pid is alive (checked with `process.kill(pid, 0)`; `procStart` guards pid reuse on Linux through `/proc/<pid>/stat` field 22 when readable). A version with no `.in_use` dir and no `.orphaned_at` is kept (unknown state is never deleted).
- [DECIDED] `--skills-only` never prunes: that mode copies files for another agent and must not touch Claude's cache.
- [DECIDED] DG_HOME: install does not refuse a foreign `DG_HOME` (tests and channel-review homes set it on purpose); it prints one stderr note and doctor warns. The observed leak (a channel-review test home) is a shell that exported `DG_HOME`; `doctor-coverage.spec.ts` already spawns with `DG_HOME: undefined` for this reason.

## Code Structure

```text
pkg/common/src/node/plugin-cache.ts            listDgPluginVersions, activeVersions, planPluginCachePrune (pure, injectable fs)
pkg/common/__tests__/plugin-cache.spec.ts      fixture caches with .orphaned_at and .in_use files
pkg/skills-cli/src/install/prune-plugin-cache.ts  prunePluginCache({home, now, keep, log}): rmSync + summary line
pkg/skills-cli/src/install/doctor.ts           check plugin-cache (warn with reclaimable MB)
pkg/skills-cli/src/doctor/shared.ts            check dg-home (warn when DG_HOME is set)
pkg/skills-cli/src/commands/install.ts         --keep-cache option, DG_HOME note, call site after the binaries step
pkg/skills-cli/__tests__/install-prune-cache.spec.ts
docs/install.md                                "Plugin cache" section
```

## Code sample: the plan and its call site

`pkg/common/src/node/plugin-cache.ts`:

```ts
export type PluginCacheVersion = {
	marketplace: string;
	version: string;
	path: string;
	bytes: number;
	orphanedAt?: number;
	lastReadAt?: number;
	livePids: number[];
};

export type PrunePlan = { keep: { version: PluginCacheVersion; reason: string }[]; remove: PluginCacheVersion[] };

export const READ_WINDOW_MS = 24 * 60 * 60 * 1000;

export function listDgPluginVersions(home: string, fs: CacheFs = realFs): PluginCacheVersion[] {
	const cache = join(home, ".claude", "plugins", "cache");
	return fs.dirs(cache).flatMap((marketplace) =>
		fs.dirs(join(cache, marketplace, "dg")).filter(isSemver).map((version) => {
			const path = join(cache, marketplace, "dg", version);
			const inUse = fs.files(join(path, ".in_use"));
			return {
				marketplace,
				version,
				path,
				bytes: fs.treeBytes(path),
				orphanedAt: fs.readNumber(join(path, ".orphaned_at")),
				lastReadAt: inUse.length ? Math.max(...inUse.map((f) => fs.mtime(f))) : undefined,
				livePids: inUse.map((f) => fs.readJson<{ pid: number }>(f)?.pid).filter((pid): pid is number => pid !== undefined && fs.alive(pid)),
			};
		}),
	);
}

/** installed_plugins.json: "dg@<marketplace>" -> [{ version }]. Unreadable file -> undefined, and the caller removes nothing. */
export function activeVersions(home: string, fs: CacheFs = realFs): Map<string, string> | undefined {
	const parsed = fs.readJson<{ plugins?: Record<string, { version: string }[]> }>(join(home, ".claude", "plugins", "installed_plugins.json"));
	if (!parsed?.plugins) return undefined;
	const active = new Map<string, string>();
	for (const [key, installs] of Object.entries(parsed.plugins)) {
		const [plugin, marketplace] = key.split("@");
		if (plugin === "dg" && marketplace && installs[0]) active.set(marketplace, installs[0].version);
	}
	return active;
}

export function planPluginCachePrune(versions: PluginCacheVersion[], active: Map<string, string>, now: number, readWindowMs = READ_WINDOW_MS): PrunePlan {
	const plan: PrunePlan = { keep: [], remove: [] };
	for (const v of versions) {
		if (active.get(v.marketplace) === v.version) plan.keep.push({ version: v, reason: "active" });
		else if (v.livePids.length > 0) plan.keep.push({ version: v, reason: `in use by pid ${v.livePids[0]}` });
		else if (v.lastReadAt !== undefined && now - v.lastReadAt < readWindowMs) plan.keep.push({ version: v, reason: `read ${hoursAgo(now, v.lastReadAt)}h ago` });
		else if (v.orphanedAt === undefined && v.lastReadAt === undefined) plan.keep.push({ version: v, reason: "unknown state" });
		else plan.remove.push(v);
	}
	return plan;
}
```

`pkg/skills-cli/src/install/prune-plugin-cache.ts` and its call site in `commands/install.ts`:

```ts
export function prunePluginCache(opts: { home: string; now: number; keep: boolean; log: (line: string) => void }): PrunePlan | undefined {
	if (opts.keep) return undefined;
	const active = activeVersions(opts.home);
	if (!active) {
		opts.log("plugin cache: skipped (installed_plugins.json unreadable)");
		return undefined;
	}
	const plan = planPluginCachePrune(listDgPluginVersions(opts.home), active, opts.now);
	for (const v of plan.remove) rmSync(v.path, { recursive: true, force: true });
	opts.log(summaryLine(plan));
	return plan;
}

async function installCli(opts: { keepCache: boolean }): Promise<void> {
	const releases = await listReleases();
	await installBundleAndRuntime(releases);
	removeRetiredBinaries();
	refreshPhoneListener();
	prunePluginCache({ home: homedir(), now: Date.now(), keep: opts.keepCache, log: console.log });
}
```

Summary line format: `plugin cache: removed 1.20.0, 1.21.1, 1.22.0, 1.23.0 (58 MB); kept 1.24.0 (active)` or `plugin cache: nothing to remove`; a version with neither marker prints as `kept <version> (unknown state)`.

DG_HOME note in `registerInstall`'s action, before any mode runs:

```ts
const home = process.env.DG_HOME;
if (home && resolve(home) !== resolve(resolveDgPaths({ env: {} }).legacyHome)) {
	console.error(`note: DG_HOME=${home}; installing there`);
}
```

## Size, speed and token impact

Size: about +3 KB in the install chunk. Speed: one directory walk of `~/.claude/plugins/cache/*/dg/*` per install (about 5 dirs, 15 MB each: under 50 ms); never on a hot path. Tokens: one summary line in install output.

## Risks and early signals

- A session that started before the window and never touched `.in_use` again is still live; the live-pid check covers it. Signal: a `Read` of a plugin reference fails in an old session.
- `installed_plugins.json` format change: the parser returns undefined and the prune skips with a printed reason.

## Ratified decisions

- [DECIDED] A version with neither `.orphaned_at` nor `.in_use` is kept and printed as `kept <version> (unknown state)`.

## Chain position

Layer 3 on `feat/per-os-layout`. Branch `feat/install-prune-plugin-cache`. Independent of A. C and D also edit `commands/install.ts`, so they chain after this branch.

## What `.in_use` holds (checked on disk)

- The active version `1.24.0` has `.in_use/<session-id>` files with `{"pid":35157,"procStart":"7509745"}` for live sessions. The orphaned versions `1.20.0` to `1.23.0` have an empty `.in_use/` directory: Claude removes a session's marker when the session ends.
- So two signals exist and the plan uses both: a marker file that names a live pid means "in use now"; the mtime of the `.in_use/` directory itself is the time of the last marker add or remove, which is the last session start or end. `lastReadAt` is the newer of the directory mtime and any marker mtime. A version whose `.in_use/` directory changed in the last 24 h is kept with `read <n>h ago`; a version with a live marker is kept with `in use by pid <n>`.
