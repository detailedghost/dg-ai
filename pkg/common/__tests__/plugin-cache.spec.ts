import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	activeVersions,
	listDgPluginVersions,
	pidAlive,
	reinspectPluginVersion,
	planPluginCachePrune,
	READ_WINDOW_MS,
} from "../src/node/plugin-cache";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 3, 12);
const roots: string[] = [];

function fixtureHome(): string {
	const home = mkdtempSync(join(tmpdir(), "dg-plugin-cache-"));
	roots.push(home);
	return home;
}

function versionDir(home: string, version: string, marketplace = "dg-ai", plugin = "dg"): string {
	const dir = join(home, ".claude", "plugins", "cache", marketplace, plugin, version);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "payload.txt"), "x".repeat(100));
	return dir;
}

function orphan(dir: string, at: number): void {
	writeFileSync(join(dir, ".orphaned_at"), String(at));
}

function marker(dir: string, session: string, body: unknown, ageMs: number): void {
	const inUse = join(dir, ".in_use");
	mkdirSync(inUse, { recursive: true });
	const file = join(inUse, session);
	writeFileSync(file, JSON.stringify(body));
	const at = new Date(NOW - ageMs);
	utimesSync(file, at, at);
	utimesSync(inUse, at, at);
}

function installed(home: string, plugins: unknown): void {
	const dir = join(home, ".claude", "plugins");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}

function plan(home: string, activeVersion = "9.9.9") {
	installed(home, { "dg@dg-ai": [{ version: activeVersion }] });
	const active = activeVersions(home);
	if (!active) throw new Error("fixture installed_plugins.json unreadable");
	return planPluginCachePrune(listDgPluginVersions(home), active, NOW);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("planPluginCachePrune", () => {
	test("removes a version orphaned over 24h ago with no .in_use entries", () => {
		const home = fixtureHome();
		orphan(versionDir(home, "1.20.0"), NOW - 48 * HOUR);
		const result = plan(home);
		expect(result.remove.map((v) => v.version)).toEqual(["1.20.0"]);
		expect(result.keep).toEqual([]);
	});

	test("keeps the active version even when it carries .orphaned_at", () => {
		const home = fixtureHome();
		orphan(versionDir(home, "1.24.0"), NOW - 48 * HOUR);
		const result = plan(home, "1.24.0");
		expect(result.remove).toEqual([]);
		expect(result.keep.map((k) => [k.version.version, k.reason])).toEqual([["1.24.0", "active"]]);
	});

	test("keeps every version any dg install names for the marketplace", () => {
		const home = fixtureHome();
		orphan(versionDir(home, "1.22.0"), NOW - 48 * HOUR);
		orphan(versionDir(home, "1.23.0"), NOW - 48 * HOUR);
		installed(home, { "dg@dg-ai": [{ version: "1.23.0" }, { version: "1.22.0" }] });
		const result = planPluginCachePrune(
			listDgPluginVersions(home),
			activeVersions(home) ?? new Map(),
			NOW,
		);
		expect(result.remove).toEqual([]);
	});

	test("keeps a version whose .in_use file is 1h old with the reason read 1h ago", () => {
		const home = fixtureHome();
		const dir = versionDir(home, "1.23.0");
		orphan(dir, NOW - 48 * HOUR);
		marker(dir, "s1", { pid: 2 ** 22 + 12345, procStart: "1" }, HOUR);
		const result = plan(home);
		expect(result.remove).toEqual([]);
		expect(result.keep[0]?.reason).toBe("read 1h ago");
	});

	test("keeps a version whose .in_use file names a live pid even when the mtime is 3 days old", () => {
		const home = fixtureHome();
		const dir = versionDir(home, "1.23.0");
		orphan(dir, NOW - 96 * HOUR);
		marker(dir, "s1", { pid: process.pid }, 72 * HOUR);
		const result = plan(home);
		expect(result.remove).toEqual([]);
		expect(result.keep[0]?.reason).toBe(`in use by pid ${process.pid}`);
	});

	test("removes a version whose .in_use marker names a dead pid and is old", () => {
		const home = fixtureHome();
		const dir = versionDir(home, "1.23.0");
		orphan(dir, NOW - 96 * HOUR);
		marker(dir, "s1", { pid: 2 ** 22 + 12345 }, 72 * HOUR);
		expect(plan(home).remove.map((v) => v.version)).toEqual(["1.23.0"]);
	});

	test("keeps a version with neither .orphaned_at nor .in_use as unknown state", () => {
		const home = fixtureHome();
		versionDir(home, "1.19.0");
		const result = plan(home);
		expect(result.remove).toEqual([]);
		expect(result.keep[0]?.reason).toBe("unknown state");
	});

	test("keeps an unorphaned version whose .in_use is old, because only orphaned versions are deleted", () => {
		const home = fixtureHome();
		marker(versionDir(home, "1.19.0"), "s1", { pid: 2 ** 22 + 12345 }, 72 * HOUR);
		const result = plan(home);
		expect(result.remove).toEqual([]);
		expect(result.keep[0]?.reason).toBe("unknown state");
	});

	test("reports installed_plugins.json as unreadable when it is missing", () => {
		const home = fixtureHome();
		orphan(versionDir(home, "1.20.0"), NOW - 48 * HOUR);
		expect(activeVersions(home)).toBeUndefined();
	});

	test("reports installed_plugins.json as unreadable when it is malformed", () => {
		const home = fixtureHome();
		const dir = join(home, ".claude", "plugins");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "installed_plugins.json"), "{not json");
		expect(activeVersions(home)).toBeUndefined();
	});

	test("reports installed_plugins.json as unreadable when it names no plugins map", () => {
		const home = fixtureHome();
		const dir = join(home, ".claude", "plugins");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify({ version: 2 }));
		expect(activeVersions(home)).toBeUndefined();
	});

	test.each([
		["a plugins array", []],
		["a non-array dg install entry", { "dg@dg-ai": { version: "1.24.0" } }],
		["a dg install without a version", { "dg@dg-ai": [{ gitCommitSha: "abc" }] }],
		["a dg install with a numeric version", { "dg@dg-ai": [{ version: 1 }] }],
	])("reports installed_plugins.json as unreadable for %s", (_name, plugins) => {
		const home = fixtureHome();
		installed(home, plugins);
		expect(activeVersions(home)).toBeUndefined();
	});

	test("ignores malformed entries of other plugins", () => {
		const home = fixtureHome();
		installed(home, { "other@dg-ai": "broken", "dg@dg-ai": [{ version: "1.24.0" }] });
		expect(activeVersions(home)?.get("dg-ai")).toEqual(["1.24.0"]);
	});

	test("keeps an orphaned version whose session marker cannot be parsed", () => {
		const home = fixtureHome();
		const dir = versionDir(home, "1.23.0");
		orphan(dir, NOW - 96 * HOUR);
		marker(dir, "s1", { pid: process.pid }, 72 * HOUR);
		writeFileSync(join(dir, ".in_use", "s1"), "{torn");
		const old = new Date(NOW - 72 * HOUR);
		utimesSync(join(dir, ".in_use", "s1"), old, old);
		utimesSync(join(dir, ".in_use"), old, old);
		const result = plan(home);
		expect(result.remove).toEqual([]);
		expect(result.keep[0]?.reason).toBe("in-use state unreadable");
	});

	test.skipIf(process.getuid?.() === 0)("keeps an orphaned version whose .in_use directory cannot be read", () => {
		const home = fixtureHome();
		const dir = versionDir(home, "1.23.0");
		orphan(dir, NOW - 96 * HOUR);
		mkdirSync(join(dir, ".in_use"));
		const old = new Date(NOW - 72 * HOUR);
		utimesSync(join(dir, ".in_use"), old, old);
		chmodSync(join(dir, ".in_use"), 0o000);
		try {
			const result = plan(home);
			expect(result.remove).toEqual([]);
			expect(result.keep[0]?.reason).toBe("in-use state unreadable");
		} finally {
			chmodSync(join(dir, ".in_use"), 0o755);
		}
	});

	test("keeps an orphaned version whose .in_use is a regular file", () => {
		const home = fixtureHome();
		const dir = versionDir(home, "1.23.0");
		orphan(dir, NOW - 96 * HOUR);
		writeFileSync(join(dir, ".in_use"), "not a directory");
		const result = plan(home);
		expect(result.remove).toEqual([]);
		expect(result.keep[0]?.reason).toBe("in-use state unreadable");
	});

	test.each([[0], [1.5], [-3], ["12"]])("keeps an orphaned version whose marker names the invalid pid %p", (pid) => {
		const home = fixtureHome();
		const dir = versionDir(home, "1.23.0");
		orphan(dir, NOW - 96 * HOUR);
		marker(dir, "s1", { pid }, 72 * HOUR);
		const result = plan(home);
		expect(result.remove).toEqual([]);
		expect(result.keep[0]?.reason).toBe("in-use state unreadable");
	});

	test("honors a custom read window", () => {
		const home = fixtureHome();
		const dir = versionDir(home, "1.23.0");
		orphan(dir, NOW - 96 * HOUR);
		marker(dir, "s1", { pid: 2 ** 22 + 12345 }, 2 * HOUR);
		installed(home, { "dg@dg-ai": [{ version: "9.9.9" }] });
		const result = planPluginCachePrune(
			listDgPluginVersions(home),
			activeVersions(home) ?? new Map(),
			NOW,
			HOUR,
		);
		expect(result.remove.map((v) => v.version)).toEqual(["1.23.0"]);
		expect(READ_WINDOW_MS).toBe(24 * HOUR);
	});
});

describe("listDgPluginVersions", () => {
	test("considers only <cache>/*/dg/* directories and leaves sibling plugins alone", () => {
		const home = fixtureHome();
		versionDir(home, "1.20.0");
		versionDir(home, "1.20.0", "dg-ai", "other");
		versionDir(home, "2.0.0", "market-two", "other");
		versionDir(home, "1.21.0", "market-two", "dg");
		const found = listDgPluginVersions(home).map((v) => `${v.marketplace}/${v.version}`);
		expect(found.sort()).toEqual(["dg-ai/1.20.0", "market-two/1.21.0"]);
	});

	test("lists versions oldest first", () => {
		const home = fixtureHome();
		for (const name of ["1.21.0", "1.9.0", "1.20.1", "1.20.0"]) versionDir(home, name);
		expect(listDgPluginVersions(home).map((v) => v.version)).toEqual(["1.9.0", "1.20.0", "1.20.1", "1.21.0"]);
	});

	test("skips directory names that are not semver", () => {
		const home = fixtureHome();
		versionDir(home, "1.20.0");
		versionDir(home, "latest");
		versionDir(home, "1.20.0-beta");
		expect(listDgPluginVersions(home).map((v) => v.version)).toEqual(["1.20.0"]);
	});

	test("reads orphanedAt, size, lastReadAt and live pids", () => {
		const home = fixtureHome();
		const dir = versionDir(home, "1.20.0");
		orphan(dir, 1234);
		marker(dir, "s1", { pid: process.pid }, 5 * HOUR);
		const [entry] = listDgPluginVersions(home);
		expect(entry?.orphanedAt).toBe(1234);
		expect(entry?.bytes).toBeGreaterThanOrEqual(100);
		expect(entry?.lastReadAt).toBe(NOW - 5 * HOUR);
		expect(entry?.livePids).toEqual([process.pid]);
	});

	test("does not follow a symlinked version directory out of the cache", () => {
		const home = fixtureHome();
		const outside = fixtureHome();
		writeFileSync(join(outside, "keep.txt"), "precious");
		const plugin = join(home, ".claude", "plugins", "cache", "dg-ai", "dg");
		mkdirSync(plugin, { recursive: true });
		symlinkSync(outside, join(plugin, "1.20.0"));
		expect(listDgPluginVersions(home)).toEqual([]);
	});

	test("does not follow a symlinked dg directory or marketplace directory", () => {
		const home = fixtureHome();
		const outside = fixtureHome();
		mkdirSync(join(outside, "1.20.0"), { recursive: true });
		const cache = join(home, ".claude", "plugins", "cache");
		mkdirSync(join(cache, "dg-ai"), { recursive: true });
		symlinkSync(outside, join(cache, "dg-ai", "dg"));
		const target = fixtureHome();
		mkdirSync(join(target, "dg", "1.20.0"), { recursive: true });
		symlinkSync(target, join(cache, "linked-market"));
		expect(listDgPluginVersions(home)).toEqual([]);
	});

	test("ignores a symlinked .in_use directory and symlinked marker files", () => {
		const home = fixtureHome();
		const outside = fixtureHome();
		writeFileSync(join(outside, "s1"), JSON.stringify({ pid: process.pid }));
		const dir = versionDir(home, "1.20.0");
		orphan(dir, 1);
		symlinkSync(outside, join(dir, ".in_use"));
		expect(listDgPluginVersions(home)[0]).toMatchObject({
			livePids: [],
			lastReadAt: undefined,
			inUseUnreadable: true,
		});
		rmSync(join(dir, ".in_use"));
		mkdirSync(join(dir, ".in_use"));
		symlinkSync(join(outside, "s1"), join(dir, ".in_use", "s1"));
		expect(listDgPluginVersions(home)[0]?.livePids).toEqual([]);
	});

	test("does not count bytes through a symlink inside the version", () => {
		const home = fixtureHome();
		const outside = fixtureHome();
		writeFileSync(join(outside, "big.bin"), "x".repeat(5000));
		const dir = versionDir(home, "1.20.0");
		symlinkSync(outside, join(dir, "link"));
		expect(listDgPluginVersions(home)[0]?.bytes).toBeLessThan(1000);
	});
});

describe("reinspectPluginVersion", () => {
	test("re-reads usage markers and keeps the measured size", () => {
		const home = fixtureHome();
		const dir = versionDir(home, "1.20.0");
		orphan(dir, 1);
		const [before] = listDgPluginVersions(home);
		if (!before) throw new Error("fixture version missing");
		expect(before.livePids).toEqual([]);
		marker(dir, "late", { pid: process.pid }, 0);
		const after = reinspectPluginVersion(before);
		expect(after.livePids).toEqual([process.pid]);
		expect(after.bytes).toBe(before.bytes);
	});
});

describe("pidAlive", () => {
	test("is true for the current process and false for an unused pid", () => {
		expect(pidAlive(process.pid)).toBe(true);
		expect(pidAlive(2 ** 22 + 12345)).toBe(false);
	});

	test("is false when procStart differs from the process start time", () => {
		const read = () => "1 (bun) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 4242 0";
		expect(pidAlive(process.pid, "4242", read)).toBe(true);
		expect(pidAlive(process.pid, "9999", read)).toBe(false);
	});

	test("trusts the pid when the start time cannot be read", () => {
		const read = () => {
			throw new Error("no /proc");
		};
		expect(pidAlive(process.pid, "9999", read)).toBe(true);
	});
});
