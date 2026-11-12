import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prunePluginCache } from "../src/install/prune-plugin-cache";
import { installEnv, writeReleaseServer } from "./runtime-bundle-fixtures";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 3, 12);
const DEAD_PID = 2 ** 22 + 12345;
const roots: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "dg-prune-cache-"));
	roots.push(dir);
	return dir;
}

function version(home: string, name: string, opts: { orphanedAt?: number; readAgoMs?: number; plugin?: string } = {}): string {
	const dir = join(home, ".claude", "plugins", "cache", "dg-ai", opts.plugin ?? "dg", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "payload.txt"), "x".repeat(2048));
	if (opts.orphanedAt !== undefined) writeFileSync(join(dir, ".orphaned_at"), String(opts.orphanedAt));
	if (opts.readAgoMs !== undefined) {
		const inUse = join(dir, ".in_use");
		mkdirSync(inUse);
		const marker = join(inUse, "session");
		writeFileSync(marker, JSON.stringify({ pid: DEAD_PID, procStart: "1" }));
		const at = new Date(NOW - opts.readAgoMs);
		utimesSync(marker, at, at);
		utimesSync(inUse, at, at);
	}
	return dir;
}

function installedPlugins(home: string, activeVersion: string): void {
	const dir = join(home, ".claude", "plugins");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "installed_plugins.json"),
		JSON.stringify({ version: 2, plugins: { "dg@dg-ai": [{ version: activeVersion }] } }),
	);
}

function prune(home: string, keep = false): string[] {
	const lines: string[] = [];
	prunePluginCache({ home, now: NOW, keep, log: (line) => lines.push(line) });
	return lines;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prunePluginCache", () => {
	test("removes orphaned versions, keeps the active one, and prints the summary line", () => {
		const home = tempRoot();
		const stale = ["1.20.0", "1.21.0"].map((name) => version(home, name, { orphanedAt: NOW - 24 * HOUR }));
		const active = version(home, "1.24.0", { orphanedAt: NOW - 24 * HOUR });
		installedPlugins(home, "1.24.0");
		const lines = prune(home);
		expect(stale.map(existsSync)).toEqual([false, false]);
		expect(existsSync(active)).toBe(true);
		expect(lines).toEqual(["plugin cache: removed 1.20.0, 1.21.0 (0 MB); kept 1.24.0 (active)"]);
	});

	test("lists a recently read version with its age", () => {
		const home = tempRoot();
		const read = version(home, "1.23.0", { orphanedAt: NOW - 48 * HOUR, readAgoMs: HOUR });
		version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		installedPlugins(home, "1.24.0");
		const lines = prune(home);
		expect(existsSync(read)).toBe(true);
		expect(lines).toEqual(["plugin cache: removed 1.20.0 (0 MB); kept 1.23.0 (read 1h ago)"]);
	});

	test("prints nothing to remove when every version is kept", () => {
		const home = tempRoot();
		version(home, "1.24.0");
		installedPlugins(home, "1.24.0");
		expect(prune(home)).toEqual(["plugin cache: nothing to remove"]);
	});

	test("names a version in unknown state as kept", () => {
		const home = tempRoot();
		const unknown = version(home, "1.19.0");
		installedPlugins(home, "1.24.0");
		const lines = prune(home);
		expect(existsSync(unknown)).toBe(true);
		expect(lines).toEqual(["plugin cache: nothing to remove; kept 1.19.0 (unknown state)"]);
	});

	test("names unknown state alongside removals", () => {
		const home = tempRoot();
		version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		version(home, "1.19.0");
		installedPlugins(home, "1.24.0");
		expect(prune(home)).toEqual(["plugin cache: removed 1.20.0 (0 MB); kept 1.19.0 (unknown state)"]);
	});

	test("removes nothing and logs the reason when installed_plugins.json is unreadable", () => {
		const home = tempRoot();
		const stale = version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		expect(prune(home)).toEqual(["plugin cache: skipped (installed_plugins.json unreadable)"]);
		expect(existsSync(stale)).toBe(true);
	});

	test("does nothing and prints nothing when keep is set", () => {
		const home = tempRoot();
		const stale = version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		installedPlugins(home, "1.24.0");
		expect(prune(home, true)).toEqual([]);
		expect(existsSync(stale)).toBe(true);
	});

	test("leaves sibling plugin cache folders untouched", () => {
		const home = tempRoot();
		const sibling = version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR, plugin: "other" });
		installedPlugins(home, "1.24.0");
		prune(home);
		expect(existsSync(sibling)).toBe(true);
	});

	test("never follows a symlinked version directory out of the cache", () => {
		const home = tempRoot();
		const outside = tempRoot();
		writeFileSync(join(outside, "precious.txt"), "keep");
		writeFileSync(join(outside, ".orphaned_at"), "1");
		const plugin = join(home, ".claude", "plugins", "cache", "dg-ai", "dg");
		mkdirSync(plugin, { recursive: true });
		symlinkSync(outside, join(plugin, "1.20.0"));
		installedPlugins(home, "1.24.0");
		expect(prune(home)).toEqual(["plugin cache: nothing to remove"]);
		expect(existsSync(join(outside, "precious.txt"))).toBe(true);
	});

	test("removes a symlink inside a stale version without touching its target", () => {
		const home = tempRoot();
		const outside = tempRoot();
		writeFileSync(join(outside, "precious.txt"), "keep");
		const stale = version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		symlinkSync(outside, join(stale, "link"));
		installedPlugins(home, "1.24.0");
		prune(home);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(join(outside, "precious.txt"))).toBe(true);
	});

	test("skips a version swapped for a symlink after the plan was made", () => {
		const home = tempRoot();
		const outside = tempRoot();
		writeFileSync(join(outside, "precious.txt"), "keep");
		const stale = version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		installedPlugins(home, "1.24.0");
		const lines: string[] = [];
		prunePluginCache({
			home,
			now: NOW,
			keep: false,
			log: (line) => lines.push(line),
			beforeRemove: () => {
				rmSync(stale, { recursive: true });
				symlinkSync(outside, stale);
			},
		});
		expect(lstatSync(stale).isSymbolicLink()).toBe(true);
		expect(existsSync(join(outside, "precious.txt"))).toBe(true);
		expect(lines[0]).not.toContain("removed");
	});

	test("refuses to delete when the cache root is swapped for a symlink after the plan was made", () => {
		const home = tempRoot();
		const outside = tempRoot();
		version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		const victim = join(outside, "dg-ai", "dg", "1.20.0");
		mkdirSync(victim, { recursive: true });
		writeFileSync(join(victim, "precious.txt"), "keep");
		writeFileSync(join(victim, ".orphaned_at"), "1");
		installedPlugins(home, "1.24.0");
		const cache = join(home, ".claude", "plugins", "cache");
		const lines: string[] = [];
		prunePluginCache({
			home,
			now: NOW,
			keep: false,
			log: (line) => lines.push(line),
			beforeRemove: () => {
				renameSync(cache, `${cache}.real`);
				symlinkSync(outside, cache);
			},
		});
		expect(existsSync(join(victim, "precious.txt"))).toBe(true);
		expect(existsSync(join(`${cache}.real`, "dg-ai", "dg", "1.20.0"))).toBe(true);
		expect(lines).toEqual(["plugin cache: nothing to remove; kept 1.20.0 (could not remove)"]);
	});

	test("refuses to delete when an ancestor of the cache root is swapped for a symlink after the plan was made", () => {
		const home = tempRoot();
		const outside = tempRoot();
		version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		const victim = join(outside, "plugins", "cache", "dg-ai", "dg", "1.20.0");
		mkdirSync(victim, { recursive: true });
		writeFileSync(join(victim, "precious.txt"), "keep");
		writeFileSync(join(victim, ".orphaned_at"), "1");
		installedPlugins(home, "1.24.0");
		writeFileSync(
			join(outside, "plugins", "installed_plugins.json"),
			JSON.stringify({ version: 2, plugins: { "dg@dg-ai": [{ version: "1.24.0" }] } }),
		);
		const claude = join(home, ".claude");
		prunePluginCache({
			home,
			now: NOW,
			keep: false,
			log: () => undefined,
			beforeRemove: () => {
				renameSync(claude, `${claude}.real`);
				symlinkSync(outside, claude);
			},
		});
		expect(existsSync(join(victim, "precious.txt"))).toBe(true);
		expect(existsSync(join(`${claude}.real`, "plugins", "cache", "dg-ai", "dg", "1.20.0"))).toBe(true);
	});

	test("still prunes inside the real target when ~/.claude was a symlink before the plan", () => {
		const home = tempRoot();
		const target = tempRoot();
		const real = join(target, "claude-real");
		mkdirSync(real);
		symlinkSync(real, join(home, ".claude"));
		const stale = version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		const active = version(home, "1.24.0");
		installedPlugins(home, "1.24.0");
		const lines = prune(home);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(active)).toBe(true);
		expect(existsSync(join(real, "plugins", "cache", "dg-ai", "dg", "1.20.0"))).toBe(false);
		expect(lines).toEqual(["plugin cache: removed 1.20.0 (0 MB); kept 1.24.0 (active)"]);
	});

	test("keeps a version that gains a live session marker after the plan was made", () => {
		const home = tempRoot();
		const stale = version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		installedPlugins(home, "1.24.0");
		const lines: string[] = [];
		prunePluginCache({
			home,
			now: NOW,
			keep: false,
			log: (line) => lines.push(line),
			beforeRemove: () => {
				mkdirSync(join(stale, ".in_use"));
				writeFileSync(join(stale, ".in_use", "late"), JSON.stringify({ pid: process.pid }));
			},
		});
		expect(existsSync(stale)).toBe(true);
		expect(lines).toEqual([`plugin cache: nothing to remove`]);
	});

	test("keeps a version that becomes active after the plan was made", () => {
		const home = tempRoot();
		const stale = version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		installedPlugins(home, "1.24.0");
		prunePluginCache({
			home,
			now: NOW,
			keep: false,
			log: () => undefined,
			beforeRemove: () => installedPlugins(home, "1.20.0"),
		});
		expect(existsSync(stale)).toBe(true);
	});

	test("keeps a version when installed_plugins.json becomes unreadable after the plan was made", () => {
		const home = tempRoot();
		const stale = version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		installedPlugins(home, "1.24.0");
		prunePluginCache({
			home,
			now: NOW,
			keep: false,
			log: () => undefined,
			beforeRemove: () => writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "{"),
		});
		expect(existsSync(stale)).toBe(true);
	});

	test("names a version kept because installed_plugins.json became unreadable", () => {
		const home = tempRoot();
		version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		installedPlugins(home, "1.24.0");
		const lines: string[] = [];
		prunePluginCache({
			home,
			now: NOW,
			keep: false,
			log: (line) => lines.push(line),
			beforeRemove: () => writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "{"),
		});
		expect(lines).toEqual(["plugin cache: nothing to remove; kept 1.20.0 (installed_plugins.json unreadable)"]);
	});

	test("names a version kept because its in-use state is unreadable", () => {
		const home = tempRoot();
		const dir = version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		mkdirSync(join(dir, ".in_use"));
		const marker = join(dir, ".in_use", "session");
		writeFileSync(marker, "{");
		const old = new Date(NOW - 48 * HOUR);
		utimesSync(marker, old, old);
		utimesSync(join(dir, ".in_use"), old, old);
		installedPlugins(home, "1.24.0");
		expect(prune(home)).toEqual(["plugin cache: nothing to remove; kept 1.20.0 (in-use state unreadable)"]);
	});

	test.skipIf(process.getuid?.() === 0)("names the only version it cannot delete instead of reporting a clean cache", () => {
		const home = tempRoot();
		const locked = version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		installedPlugins(home, "1.24.0");
		chmodSync(locked, 0o555);
		try {
			expect(prune(home)).toEqual(["plugin cache: nothing to remove; kept 1.20.0 (could not remove)"]);
		} finally {
			chmodSync(locked, 0o755);
		}
	});

	test.skipIf(process.getuid?.() === 0)("reports a version it cannot delete and continues with the rest", () => {
		const home = tempRoot();
		const locked = version(home, "1.20.0", { orphanedAt: NOW - 48 * HOUR });
		const removable = version(home, "1.21.0", { orphanedAt: NOW - 48 * HOUR });
		installedPlugins(home, "1.24.0");
		chmodSync(locked, 0o555);
		try {
			const lines = prune(home);
			expect(existsSync(removable)).toBe(false);
			expect(existsSync(locked)).toBe(true);
			expect(lines).toEqual(["plugin cache: removed 1.21.0 (0 MB); kept 1.20.0 (could not remove)"]);
		} finally {
			chmodSync(locked, 0o755);
		}
	});
});

describe("dg-skills install plugin cache prune", () => {
	function preload(dir: string): string {
		const log = join(dir, "fetch.log");
		writeFileSync(log, "");
		return writeReleaseServer(dir, log, "9.9.9").preload;
	}

	async function runInstall(home: string, dir: string, extra: string[], mode = "--cli-only") {
		const proc = Bun.spawn(["bun", "--preload", preload(dir), ENTRY, "install", mode, ...extra], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...installEnv(home), DG_HOME: join(home, ".dg") },
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr: stderr.replace(`note: DG_HOME=${join(home, ".dg")}; installing there\n`, ""), code };
	}

	function fixtureHome(): { dir: string; home: string; stale: string[]; active: string } {
		const dir = tempRoot();
		const home = join(dir, "home");
		mkdirSync(home, { recursive: true });
		const longAgo = Date.now() - 48 * HOUR;
		const stale = ["1.20.0", "1.21.0"].map((name) => version(home, name, { orphanedAt: longAgo }));
		const active = version(home, "1.24.0");
		installedPlugins(home, "1.24.0");
		return { dir, home, stale, active };
	}

	test("with --keep-cache removes nothing and prints no prune line", async () => {
		const world = fixtureHome();
		const result = await runInstall(world.home, world.dir, ["--keep-cache"]);
		expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
		expect(world.stale.map(existsSync)).toEqual([true, true]);
		expect(result.stdout).not.toContain("plugin cache:");
	});

	test.each(["--cli-only", "--agent-only"])("with --local and %s removes nothing and prints no prune line", async (mode) => {
		const world = fixtureHome();
		const result = await runInstall(world.home, world.dir, ["--local"], mode);
		expect(result.code).toBe(0);
		expect(world.stale.map(existsSync)).toEqual([true, true]);
		expect(result.stdout).not.toContain("plugin cache:");
	});

	test("without the flag removes stale versions and prints the summary line", async () => {
		const world = fixtureHome();
		const result = await runInstall(world.home, world.dir, []);
		expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
		expect(world.stale.map(existsSync)).toEqual([false, false]);
		expect(existsSync(world.active)).toBe(true);
		expect(result.stdout).toContain("plugin cache: removed 1.20.0, 1.21.0 (0 MB); kept 1.24.0 (active)");
	});
});
