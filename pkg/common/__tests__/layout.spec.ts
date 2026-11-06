import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type DgPaths, resolveDgPaths, withInstallLock } from "@dg/common/node";
import {
	assertNotBlocked,
	blockedText,
	ensureLayout,
	LAYOUT_TABLE,
	layoutResult,
	type LayoutHooks,
} from "@dg/common/node/layout";
import { planLayout, snapshot } from "@dg/common/node/layout-work";
import { DgCliError } from "../src/errors";
import { makeTempDir, removeTempDirs } from "./utils/temp-dirs";

const posix = describe.skipIf(process.platform === "win32");
const SRC = join(import.meta.dir, "..", "src", "node");
const FAST_LOCK = { tries: 2, waitMs: 1 };

type TableEntry = { name: string; from: string | readonly string[]; [key: string]: unknown };
const table = LAYOUT_TABLE as unknown as readonly TableEntry[];
const firstFrom = (entry: TableEntry): string => [entry.from].flat()[0] as string;
const nameOf = (from: string): string => {
	const entry = table.find((candidate) => firstFrom(candidate) === from);
	if (!entry) throw new Error(`no table entry reads ${from}`);
	return entry.name;
};

let dir: string;
let home: string;
let paths: DgPaths;
let lines: string[];

const log = (line: string): void => {
	lines.push(line);
};

function put(path: string, body: string, mode = 0o644): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body, { mode });
}

function sqliteFile(file: string, rows: number): void {
	mkdirSync(dirname(file), { recursive: true });
	const db = new Database(file);
	db.run("CREATE TABLE keys (id INTEGER PRIMARY KEY, name TEXT)");
	for (let row = 0; row < rows; row++) db.run("INSERT INTO keys (name) VALUES (?)", [`k${row}`]);
	db.close();
}

const legacyAt = (...parts: string[]): string => join(paths.legacyHome, ...parts);
const livePid = (): string => JSON.stringify({ pid: process.pid });
const run = (hooks: Partial<LayoutHooks> = {}, target: DgPaths = paths) =>
	ensureLayout(target, { log, launchers: true, ...hooks });
const outcomeAt = (result: Awaited<ReturnType<typeof run>>, from: string) =>
	(result as Record<string, { kind: string; [key: string]: unknown }>)[nameOf(from)];

function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

function counted(): { counts: { readdir: number; load: number; lock: number }; hooks: Partial<LayoutHooks> } {
	const counts = { readdir: 0, load: 0, lock: 0 };
	return {
		counts,
		hooks: {
			log,
			readdir: (path: string) => {
				counts.readdir++;
				return readdirSync(path);
			},
			load: () => {
				counts.load++;
				return import("@dg/common/node/layout-work");
			},
			lock: (root: string, fn: () => unknown) => {
				counts.lock++;
				return withInstallLock(root, fn as () => Promise<unknown>);
			},
		} as unknown as Partial<LayoutHooks>,
	};
}

function seedLegacy(): string {
	const legacy = paths.legacyHome;
	put(join(legacy, "bin", "dg-skills"), "#!/bin/sh\n", 0o755);
	put(join(legacy, "daemon", "daemon.db"), "db bytes");
	put(join(legacy, "daemon", "logs", "daemon-1.log"), "log line\n");
	put(join(legacy, "skills", "jot", "SKILL.md"), "# jot\n");
	put(join(legacy, "proto", "demo", "index.html"), "<p>proto</p>");
	put(join(legacy, "demos", "a.demo.md"), "demo");
	put(join(legacy, "agents", "js.md"), "persona");
	put(join(legacy, "agents", "memory.db"), "memory");
	put(join(legacy, "agents", "sessions", "s1.json"), "{}");
	put(join(legacy, "config.json"), '{"hooks":{}}');
	put(join(legacy, "cli-only"), "");
	put(join(legacy, "pairing.json"), "{}");
	put(join(legacy, "phone-friend", "state.json"), "{}");
	put(join(legacy, "channel-review", "config.json"), '{"env":{}}');
	put(join(legacy, "channel-review", "state.dev.json"), "{}");
	put(join(legacy, "lib", "1.0.0", "dg.js"), "bundle");
	symlinkSync("1.0.0", join(legacy, "lib", "current"));
	put(join(legacy, "runtime", "bun-v1.4.1", "bun"), "bun", 0o755);
	symlinkSync(join(legacy, "runtime", "bun-v1.4.1"), join(legacy, "runtime", "current"));
	return legacy;
}

function residue(root: string): string[] {
	return readdirSync(root).filter((name) => name !== "bin" && !name.startsWith("dg-ai-") && !name.startsWith("."));
}

function emptySetAsides(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		const own = entry.name.includes(".empty-") ? [path] : [];
		return entry.isDirectory() && !entry.isSymbolicLink() ? [...own, ...emptySetAsides(path)] : own;
	});
}

beforeEach(() => {
	dir = makeTempDir("dg-layout-");
	home = join(dir, "home");
	paths = resolveDgPaths({ platform: "linux", homeDir: home, env: {} });
	lines = [];
});

afterEach(removeTempDirs);

describe("LAYOUT_TABLE", () => {
	test("lists today's moves in the same order, with phone and bin as the only additions", () => {
		const order = table.filter((entry) => !["phone", "bin"].includes(entry.name)).map(firstFrom);

		expect(order).toEqual([
			"runtime",
			"lib",
			"skills",
			"browsers",
			"demo-narration",
			"agents/sessions",
			"agents/assets",
			"agents/memory.db",
			"agents",
			"daemon/logs",
			"daemon",
			"grants",
			"pairing.json",
			"phone-friend",
			"inbox",
			"browser-profiles",
			"demo-profile",
			"channel-review/config.json",
			"channel-review",
			"ssms/config.yaml",
			"ssms",
			"proto",
			"demos",
			"config.json",
			"cli-only",
		]);
		expect(table.some((entry) => entry.name === "bin")).toBe(true);
		expect(table.some((entry) => "steps" in entry)).toBe(false);
	});

	test("carries the stop, live, unused and hook keys the spec names", () => {
		const byName = (name: string) => table.find((entry) => entry.name === name);

		expect(byName(nameOf("agents/sessions"))).toMatchObject({ stop: "daemon.stop", live: "daemon/*.pid" });
		expect(byName(nameOf("agents/assets"))).toMatchObject({ stop: "daemon.stop", live: "daemon/*.pid" });
		expect(byName(nameOf("daemon"))).toMatchObject({ stop: "daemon.stop", live: "daemon/*.pid", unused: "folder" });
		expect(byName("phone")).toMatchObject({
			from: "phone",
			unused: { sqlite: "phone.db" },
			live: "phone/listener.pid",
			verify: "phone.verify",
			stop: "phone.stop",
		});
		expect(byName(nameOf("phone-friend"))).not.toHaveProperty("stop");
		expect(byName(nameOf("phone-friend"))).not.toHaveProperty("verify");
		expect(byName(nameOf("channel-review"))).toMatchObject({ unused: "folder" });
		expect(byName(nameOf("ssms/config.yaml"))).toMatchObject({ needsKey: "ssms.configDir" });
		expect(byName("memory")).toMatchObject({ from: ["agents/memory.db", "agents/memory.db-wal", "agents/memory.db-shm"] });
		expect(byName("memory")).not.toHaveProperty("stop");
	});

	test("resolves each target from the paths and the hooks", () => {
		const entry = (name: string) => table.find((candidate) => candidate.name === name) as unknown as {
			to: (paths: DgPaths, hooks: Record<string, () => string>) => string;
		};

		expect(entry("phone").to(paths, {})).toBe(paths.phoneRoot);
		expect(entry("memory").to(paths, {})).toBe(paths.agentsDir);
		expect(entry(nameOf("ssms/config.yaml")).to(paths, { "ssms.configDir": () => "/trusted" })).toBe(
			join("/trusted", "ssms", "config.yaml"),
		);
	});
});

describe("planLayout", () => {
	test("calls no side-effect seam without hooks and returns the same plan for the same snapshot twice", async () => {
		seedLegacy();
		const snap = await snapshot(paths, {});
		const { counts, hooks } = counted();
		const seams = {
			...hooks,
			lstat: () => {
				throw new Error("lstat seam called");
			},
			now: () => {
				throw new Error("now seam called");
			},
		};

		const first = planLayout(LAYOUT_TABLE, snap, {});
		const second = planLayout(LAYOUT_TABLE, snap, {});
		planLayout(LAYOUT_TABLE, snap, seams as never);

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(counts).toEqual({ readdir: 0, load: 0, lock: 0 });
	});

	test("plans keepUsed, not a no-hook block, for a used phone target when no hooks are supplied", async () => {
		put(legacyAt("phone", "phone.db"), "legacy");
		sqliteFile(join(paths.phoneRoot, "phone.db"), 1);

		const plan = JSON.stringify(planLayout(LAYOUT_TABLE, await snapshot(paths, {}), {}));

		expect(plan).toContain("keepUsed");
		expect(plan).not.toContain("no-hook");
	});
});

posix("ensureLayout fast path", () => {
	test.each([
		["bin and a dotfile", (legacy: string) => (put(join(legacy, "bin", "dg-skills"), "x"), put(join(legacy, ".foo"), "x"))],
		["no legacy home", () => {}],
		["bin and an unknown file", (legacy: string) => (put(join(legacy, "bin", "dg-skills"), "x"), put(join(legacy, "notes.txt"), "x"))],
	])("makes one readdir, no load and no lock for %s", async (_label, seed) => {
		seed(paths.legacyHome);
		const { counts, hooks } = counted();

		await ensureLayout(paths, hooks as LayoutHooks);

		expect(counts).toEqual({ readdir: 1, load: 0, lock: 0 });
		expect(existsSync(join(paths.dataDir, ".install.lock"))).toBe(false);
		expect(lines).toEqual([]);
	});

	test("does not touch the legacy home when none exists", async () => {
		await run();

		expect(existsSync(home)).toBe(false);
		expect(lines).toEqual([]);
	});

	test("loads the work module and takes the lock for a non-empty pending-removal record", async () => {
		put(legacyAt("bin", "dg-skills"), "x");
		put(legacyAt("runtime", "bun"), "bun");
		put(join(paths.runtimeDir, "bun"), "bun");
		put(
			legacyAt(".pending-removal.json"),
			JSON.stringify([{ name: nameOf("runtime"), from: legacyAt("runtime"), to: paths.runtimeDir }]),
		);
		const { counts, hooks } = counted();

		await ensureLayout(paths, hooks as LayoutHooks);

		expect(counts.load).toBe(1);
		expect(counts.lock).toBe(1);
	});

	test("counts a detached .removing leftover as work and sweeps it", async () => {
		put(legacyAt(".removing-runtime-1", "bun"), "bun");
		const { counts, hooks } = counted();

		await ensureLayout(paths, hooks as LayoutHooks);

		expect(counts.load).toBe(1);
		expect(existsSync(legacyAt(".removing-runtime-1"))).toBe(false);
	});

	test("loads the work module but takes no lock for a used split, and prints the kept line once for two DgPaths objects", async () => {
		put(legacyAt("phone", "phone.db"), "legacy");
		sqliteFile(join(paths.phoneRoot, "phone.db"), 1);
		const { counts, hooks } = counted();

		await ensureLayout(paths, hooks as LayoutHooks);
		await ensureLayout({ ...paths }, hooks as LayoutHooks);

		expect(counts.load).toBeGreaterThanOrEqual(1);
		expect(counts.lock).toBe(0);
		expect(lines.filter((line) => line.includes("already exists"))).toEqual([
			`dg: kept ${legacyAt("phone")}; ${paths.phoneRoot} already exists and holds data. dg-skills doctor reports both copies`,
		]);
	});

	test("makes no readdir call on a second call with the same DgPaths object and returns the identical result", async () => {
		put(legacyAt("bin", "dg-skills"), "x");
		const { counts, hooks } = counted();

		const first = await ensureLayout(paths, hooks as LayoutHooks);
		const again = await ensureLayout(paths, hooks as LayoutHooks);

		expect(counts.readdir).toBe(1);
		expect(again).toBe(first);
		expect(layoutResult(paths)).toBe(first);

		await ensureLayout({ ...paths }, hooks as LayoutHooks);
		expect(counts.readdir).toBe(2);
	});

	test("skips role folders under a flat DG_HOME in the fast path and the plan", async () => {
		const root = join(dir, "dg-home");
		put(join(root, "state", "daemon", "daemon.db"), "db");
		put(join(root, "data", "skills", "jot", "SKILL.md"), "jot");
		put(join(root, "config", "config.json"), "{}");
		const flat = resolveDgPaths({ platform: "linux", homeDir: home, env: { DG_HOME: root } });
		const { counts, hooks } = counted();

		await ensureLayout(flat, hooks as LayoutHooks);

		expect(counts).toEqual({ readdir: 1, load: 0, lock: 0 });
		expect(lines).toEqual([]);
	});
});

posix("ensureLayout moves", () => {
	test("moves every role to its per-OS root and leaves only bin in the legacy home", async () => {
		const legacy = seedLegacy();
		const configDir = join(dir, "trusted");

		const result = await run({ "ssms.configDir": () => configDir });

		expect(Object.values(result).filter((outcome) => outcome.kind === "failed")).toEqual([]);
		expect("bin" in result).toBe(false);
		expect(readdirSync(legacy)).toEqual(["bin"]);
		expect(residue(legacy)).toEqual([]);
		expect(emptySetAsides(paths.stateDir)).toEqual([]);
		expect(emptySetAsides(paths.dataDir)).toEqual([]);
		expect(readFileSync(join(paths.daemonDir, "daemon.db"), "utf8")).toBe("db bytes");
		expect(readFileSync(join(paths.logDir, "daemon-1.log"), "utf8")).toBe("log line\n");
		expect(readFileSync(join(paths.skillsDir, "jot", "SKILL.md"), "utf8")).toBe("# jot\n");
		expect(readFileSync(join(paths.cacheDir, "proto", "demo", "index.html"), "utf8")).toBe("<p>proto</p>");
		expect(readFileSync(join(paths.cacheDir, "demos", "a.demo.md"), "utf8")).toBe("demo");
		expect(readFileSync(join(paths.personasDir, "js.md"), "utf8")).toBe("persona");
		expect(readFileSync(paths.memoryDbPath, "utf8")).toBe("memory");
		expect(readFileSync(join(paths.sessionsDir, "s1.json"), "utf8")).toBe("{}");
		expect(readFileSync(paths.configPath, "utf8")).toBe('{"hooks":{}}');
		expect(existsSync(paths.cliOnlyMarker)).toBe(true);
		expect(existsSync(paths.pairingPath)).toBe(true);
		expect(existsSync(join(paths.phoneFriendRoot, "state.json"))).toBe(true);
		expect(readFileSync(join(paths.configDir, "channel-review", "config.json"), "utf8")).toBe('{"env":{}}');
		expect(existsSync(join(paths.stateDir, "channel-review", "state.dev.json"))).toBe(true);
		expect(readFileSync(join(paths.libDir, "current", "dg.js"), "utf8")).toBe("bundle");
		expect(lstatSync(join(paths.libDir, "current")).isSymbolicLink()).toBe(true);
		expect(lines).toEqual([]);
	});

	test("moves memory.db with its -wal and -shm files into the agents folder", async () => {
		put(legacyAt("agents", "memory.db"), "memory");
		put(legacyAt("agents", "memory.db-wal"), "wal");
		put(legacyAt("agents", "memory.db-shm"), "shm");

		const result = await run();

		expect(result.memory.kind).toBe("moved");
		expect(readFileSync(join(paths.agentsDir, "memory.db"), "utf8")).toBe("memory");
		expect(readFileSync(join(paths.agentsDir, "memory.db-wal"), "utf8")).toBe("wal");
		expect(readFileSync(join(paths.agentsDir, "memory.db-shm"), "utf8")).toBe("shm");
	});

	test("does not move a memory.db-wal alone when memory.db is absent", async () => {
		put(legacyAt("agents", "memory.db-wal"), "wal");

		const result = await run();

		expect(result.memory.kind).toBe("absent");
		expect(existsSync(join(paths.agentsDir, "memory.db-wal"))).toBe(false);
	});

	test("moves a flat DG_HOME into its role folders without leaving DG_HOME", async () => {
		const root = join(dir, "dg-home");
		put(join(root, "bin", "dg-skills"), "shim", 0o755);
		put(join(root, "daemon", "daemon.db"), "db");
		put(join(root, "skills", "jot", "SKILL.md"), "jot");
		const flat = resolveDgPaths({ platform: "linux", homeDir: home, env: { DG_HOME: root } });

		const result = await run({}, flat);

		expect(Object.values(result).filter((outcome) => outcome.kind === "failed")).toEqual([]);
		expect(readFileSync(join(root, "state", "daemon", "daemon.db"), "utf8")).toBe("db");
		expect(readFileSync(join(root, "data", "skills", "jot", "SKILL.md"), "utf8")).toBe("jot");
		expect(readdirSync(root).sort()).toEqual(["bin", "data", "state"]);
		expect(existsSync(home)).toBe(false);
	});

	test("moves the contents of a symlinked legacy home and keeps the link", async () => {
		const real = join(dir, "real-dg");
		put(join(real, "skills", "jot", "SKILL.md"), "jot");
		mkdirSync(home, { recursive: true });
		symlinkSync(real, paths.legacyHome);

		await run();

		expect(lstatSync(paths.legacyHome).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(paths.skillsDir, "jot", "SKILL.md"), "utf8")).toBe("jot");
		expect(existsSync(join(real, "skills"))).toBe(false);
	});

	test("logs nothing for a fresh move and no removed line", async () => {
		put(legacyAt("skills", "jot", "SKILL.md"), "jot");

		await run();

		expect(lines).toEqual([]);
	});

	test("takes the install lock once for a move and releases it afterwards", async () => {
		put(legacyAt("skills", "jot", "SKILL.md"), "jot");
		const { counts, hooks } = counted();

		await ensureLayout(paths, hooks as LayoutHooks);

		expect(counts.lock).toBe(1);
		expect(existsSync(join(paths.dataDir, ".install.lock"))).toBe(false);
	});
});

posix("ensureLayout launcher-bound entries", () => {
	const bound = ["runtime", "lib"];

	test("leaves runtime and lib in place, silent and blocked, without the launchers hook", async () => {
		seedLegacy();

		const result = await ensureLayout(paths, { log });

		for (const from of bound) {
			expect(outcomeAt(result, from)).toMatchObject({ kind: "blocked", reason: "no-hook" });
			expect(existsSync(legacyAt(from))).toBe(true);
			expect(existsSync(from === "runtime" ? paths.runtimeDir : paths.libDir)).toBe(false);
		}
		expect(lines).toEqual([]);
	});

	test("still moves the other entries without the launchers hook", async () => {
		seedLegacy();

		const result = await ensureLayout(paths, { log });

		expect(outcomeAt(result, "skills")).toMatchObject({ kind: "moved" });
	});

	test("moves runtime and lib when the launchers hook is supplied", async () => {
		seedLegacy();

		const result = await ensureLayout(paths, { log, launchers: true });

		for (const from of bound) expect(outcomeAt(result, from)).toMatchObject({ kind: "moved" });
		expect(existsSync(join(paths.libDir, "1.0.0", "dg.js"))).toBe(true);
	});

	test("reports a used target as kept, not as unmoved, without the hook", async () => {
		put(legacyAt("lib", "1.0.0", "dg.js"), "old");
		put(join(paths.libDir, "2.0.0", "dg.js"), "new");

		const result = await ensureLayout(paths, { log });

		expect(outcomeAt(result, "lib")).toMatchObject({ kind: "kept", reason: "target-used" });
	});
});

posix("ensureLayout ssms config", () => {
	test("blocks ssms/config.yaml silently without ssms.configDir and keeps ssms as child-kept", async () => {
		put(legacyAt("ssms", "config.yaml"), "allow_send: true\n");
		put(legacyAt("ssms", "drafts", "d1.json"), "{}");

		const result = await run();

		expect(outcomeAt(result, "ssms/config.yaml")).toMatchObject({ kind: "blocked", reason: "no-hook" });
		expect(outcomeAt(result, "ssms")).toMatchObject({ kind: "kept", reason: "child-kept" });
		expect(readFileSync(legacyAt("ssms", "config.yaml"), "utf8")).toBe("allow_send: true\n");
		expect(lines).toEqual([]);
	});

	test("moves both entries when ssms.configDir is supplied", async () => {
		put(legacyAt("ssms", "config.yaml"), "allow_send: true\n");
		put(legacyAt("ssms", "drafts", "d1.json"), "{}");
		const fixed = join(dir, "fixed-config");

		await run({ "ssms.configDir": () => fixed });

		expect(readFileSync(join(fixed, "ssms", "config.yaml"), "utf8")).toBe("allow_send: true\n");
		expect(readFileSync(join(paths.stateDir, "ssms", "drafts", "d1.json"), "utf8")).toBe("{}");
		expect(existsSync(join(paths.stateDir, "ssms", "config.yaml"))).toBe(false);
		expect(existsSync(legacyAt("ssms"))).toBe(false);
	});

	test("moves a DG_HOME ssms config into the config root when the hook names it", async () => {
		const root = join(dir, "dg-home");
		put(join(root, "ssms", "config.yaml"), "allow_send: true\n");
		const flat = resolveDgPaths({ platform: "linux", homeDir: home, env: { DG_HOME: root } });

		await run({ "ssms.configDir": () => flat.configDir }, flat);

		expect(readFileSync(join(flat.configDir, "ssms", "config.yaml"), "utf8")).toBe("allow_send: true\n");
	});

	test("never overwrites an ssms config that already exists in the target folder", async () => {
		put(legacyAt("ssms", "config.yaml"), "allow_send: true\n");
		put(join(paths.configDir, "ssms", "config.yaml"), "allow_send: false\n");

		const result = await run({ "ssms.configDir": () => paths.configDir });

		expect(outcomeAt(result, "ssms/config.yaml")).toMatchObject({ kind: "kept", reason: "target-used" });
		expect(readFileSync(join(paths.configDir, "ssms", "config.yaml"), "utf8")).toBe("allow_send: false\n");
		expect(readFileSync(legacyAt("ssms", "config.yaml"), "utf8")).toBe("allow_send: true\n");
	});
});

posix("ensureLayout live writers", () => {
	const seedDaemon = (): void => {
		put(legacyAt("daemon", "daemon.db"), "db bytes");
		put(legacyAt("agents", "memory.db"), "memory");
		put(legacyAt("agents", "sessions", "s1.json"), "{}");
		put(legacyAt("agents", "assets", "a.png"), "png");
	};

	test("moves memory while a live daemon pid blocks sessions, assets and daemon without a stop hook", async () => {
		seedDaemon();
		put(legacyAt("daemon", "daemon.pid"), livePid());

		const result = await run();

		expect(result.memory.kind).toBe("moved");
		for (const from of ["agents/sessions", "agents/assets", "daemon"])
			expect(outcomeAt(result, from)).toMatchObject({ kind: "blocked", reason: "live-writer" });
		expect(readFileSync(paths.memoryDbPath, "utf8")).toBe("memory");
		expect(readFileSync(legacyAt("daemon", "daemon.db"), "utf8")).toBe("db bytes");
		expect(existsSync(paths.daemonDir)).toBe(false);
		expect(existsSync(paths.assetsDir)).toBe(false);
	});

	test("moves the three entries without a stop when no pid is live", async () => {
		seedDaemon();

		const result = await run();

		for (const from of ["agents/sessions", "agents/assets", "daemon"])
			expect(outcomeAt(result, from)).toMatchObject({ kind: "moved", stopped: false });
		expect(readFileSync(join(paths.daemonDir, "daemon.db"), "utf8")).toBe("db bytes");
	});

	test("calls daemon.stop once for the three entries that name it and blocks all three on still-running", async () => {
		seedDaemon();
		put(legacyAt("daemon", "daemon.pid"), livePid());
		const calls: string[] = [];

		const result = await run({
			"daemon.stop": async (legacyDir: string) => {
				calls.push(legacyDir);
				return "still-running" as const;
			},
		});

		expect(calls).toHaveLength(1);
		for (const from of ["agents/sessions", "agents/assets", "daemon"])
			expect(outcomeAt(result, from)).toMatchObject({ kind: "blocked", reason: "live-writer" });
		expect(existsSync(paths.daemonDir)).toBe(false);
	});

	test("moves the three entries as stopped when daemon.stop returns stopped", async () => {
		seedDaemon();
		put(legacyAt("daemon", "daemon.pid"), livePid());
		const calls: string[] = [];

		const result = await run({
			"daemon.stop": async (legacyDir: string) => {
				calls.push(legacyDir);
				return "stopped" as const;
			},
		});

		expect(calls).toHaveLength(1);
		for (const from of ["agents/sessions", "agents/assets", "daemon"])
			expect(outcomeAt(result, from)).toMatchObject({ kind: "moved", stopped: true });
	});

	test("blocks a phone entry whose legacy root holds a live listener pid file when phone.stop is missing", async () => {
		put(legacyAt("phone", "listener.pid"), livePid());
		put(legacyAt("phone", "phone.db"), "legacy");

		const result = await run({ "phone.verify": () => [] });

		expect(result.phone).toMatchObject({ kind: "blocked", reason: "live-writer" });
		expect(existsSync(paths.phoneRoot)).toBe(false);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(legacyAt("phone"));
	});

	test("blocks a phone-friend entry whose line holds a live listener pid file", async () => {
		put(legacyAt("phone-friend", "default", "listener.pid"), livePid());
		put(legacyAt("phone-friend", "default", "phone-friend.db"), "legacy");

		const result = await run();

		expect(result["phone-friend"]).toMatchObject({ kind: "blocked", reason: "live-writer" });
		expect(existsSync(paths.phoneFriendRoot)).toBe(false);
	});

	test("moves a phone-friend entry whose line pid file names a dead process", async () => {
		put(legacyAt("phone-friend", "default", "listener.pid"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
		put(legacyAt("phone-friend", "default", "phone-friend.db"), "legacy");

		const result = await run();

		expect(result["phone-friend"]).toMatchObject({ kind: "moved" });
	});

	test("blocks an entry that needs phone.verify without the hook, touches nothing and logs nothing", async () => {
		put(legacyAt("phone", "phone.db"), "legacy");

		const result = await run();

		expect(result.phone).toMatchObject({ kind: "blocked", reason: "no-hook" });
		expect(readFileSync(legacyAt("phone", "phone.db"), "utf8")).toBe("legacy");
		expect(existsSync(paths.phoneRoot)).toBe(false);
		expect(existsSync(paths.stateDir)).toBe(false);
		expect(lines).toEqual([]);
	});

	test("stays silent about phone while a live daemon block logs only its own lines", async () => {
		seedDaemon();
		put(legacyAt("daemon", "daemon.pid"), livePid());
		put(legacyAt("phone", "phone.db"), "legacy");

		await run();

		expect(lines.some((line) => line.includes(legacyAt("phone")))).toBe(false);
		expect(lines.length).toBeGreaterThan(0);
	});
});

describe("ensureLayout error paths", () => {
	test("rethrows a readdir failure that is not a missing legacy home", async () => {
		const denied = Object.assign(new Error("denied"), { code: "EACCES" });
		const hooks = {
			readdir: () => {
				throw denied;
			},
		} as unknown as Partial<LayoutHooks>;

		await expect(run(hooks)).rejects.toBe(denied);
		expect(layoutResult(paths)).toBeUndefined();
	});

	test("does not count a malformed or empty .pending-removal.json as work", async () => {
		put(legacyAt("bin", "dg-skills"), "#!/bin/sh\n", 0o755);
		put(legacyAt(".pending-removal.json"), "{not json");
		const malformed = counted();
		await ensureLayout(paths, malformed.hooks as LayoutHooks);

		put(legacyAt(".pending-removal.json"), "[]");
		const empty = counted();
		await ensureLayout({ ...paths }, empty.hooks as LayoutHooks);

		expect(malformed.counts).toEqual({ readdir: 1, load: 0, lock: 0 });
		expect(empty.counts).toEqual({ readdir: 1, load: 0, lock: 0 });
	});

	test("does not count a pending-removal object that is not a list as work", async () => {
		put(legacyAt(".pending-removal.json"), '{"a":1}');
		const { counts, hooks } = counted();

		await ensureLayout(paths, hooks as LayoutHooks);

		expect(counts).toEqual({ readdir: 1, load: 0, lock: 0 });
	});

	test("returns the same result for an empty legacy home and reports no entry as moved", async () => {
		const result = await run();

		expect(Object.values(result as Record<string, { kind: string }>).every((outcome) => outcome.kind === "absent")).toBe(true);
		expect(lines).toEqual([]);
	});
});

posix("ensureLayout targets", () => {
	test("sets an unused target aside as <to>.empty-<ts> with the injected now, then moves the source in", async () => {
		put(legacyAt("daemon", "daemon.db"), "db bytes");
		mkdirSync(paths.daemonDir, { recursive: true });

		const result = await run({ now: () => 1_700_000_000_000 } as Partial<LayoutHooks>);

		const outcome = outcomeAt(result, "daemon");
		expect(outcome).toMatchObject({ kind: "setAside" });
		expect(outcome).toHaveProperty("stopped");
		expect(String(outcome?.asideTo).startsWith(`${paths.daemonDir}.empty-`)).toBe(true);
		expect(existsSync(String(outcome?.asideTo))).toBe(true);
		expect(readFileSync(join(paths.daemonDir, "daemon.db"), "utf8")).toBe("db bytes");
		expect(lines).toEqual([`dg: set aside unused ${paths.daemonDir} as ${outcome?.asideTo}; dg-skills clean removes it`]);
	});

	test("fails the entry, keeps the source and logs one line when the set-aside name is already taken", async () => {
		const now = 1_700_000_000_000;
		put(legacyAt("daemon", "daemon.db"), "db bytes");
		mkdirSync(paths.daemonDir, { recursive: true });
		put(join(`${paths.daemonDir}.empty-${now}`, "occupied"), "x");

		const result = await run({ now: () => now } as Partial<LayoutHooks>);

		const outcome = outcomeAt(result, "daemon");
		expect(outcome).toMatchObject({ kind: "failed" });
		expect(String(outcome?.error).length).toBeGreaterThan(0);
		expect(readFileSync(legacyAt("daemon", "daemon.db"), "utf8")).toBe("db bytes");
		expect(readdirSync(paths.daemonDir)).toEqual([]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith(`dg: kept ${legacyAt("daemon")}; setting aside ${paths.daemonDir} failed: `);
	});

	test("keeps a used target and the source, and logs one line naming both paths", async () => {
		put(legacyAt("daemon", "daemon.db"), "db bytes");
		put(join(paths.daemonDir, "key"), "k");

		const result = await run();

		expect(outcomeAt(result, "daemon")).toMatchObject({ kind: "kept", reason: "target-used" });
		expect(readFileSync(legacyAt("daemon", "daemon.db"), "utf8")).toBe("db bytes");
		expect(readFileSync(join(paths.daemonDir, "key"), "utf8")).toBe("k");
		expect(lines).toEqual([
			`dg: kept ${legacyAt("daemon")}; ${paths.daemonDir} already exists and holds data. dg-skills doctor reports both copies`,
		]);
	});

	test("never overwrites an existing target of an entry with no unused tag", async () => {
		put(legacyAt("skills", "jot", "SKILL.md"), "# jot\n");
		put(join(paths.skillsDir, "new", "SKILL.md"), "newer");

		const result = await run();

		expect(outcomeAt(result, "skills")).toMatchObject({ kind: "kept", reason: "target-used" });
		expect(readFileSync(legacyAt("skills", "jot", "SKILL.md"), "utf8")).toBe("# jot\n");
		expect(existsSync(join(paths.skillsDir, "jot"))).toBe(false);
	});

	test("fails the move on a verify problem, removes the copy, keeps the source and logs the failed-check line", async () => {
		put(legacyAt("phone", "phone.db"), "legacy");

		const result = await run({ "phone.verify": () => ["row count differs"], "phone.stop": async () => "stopped" as const });

		expect(result.phone).toMatchObject({ kind: "failed" });
		expect(String((result.phone as { error: string }).error)).toContain("row count differs");
		expect(existsSync(paths.phoneRoot)).toBe(false);
		expect(readFileSync(legacyAt("phone", "phone.db"), "utf8")).toBe("legacy");
		expect(lines).toEqual([`dg: kept ${legacyAt("phone")}; the copy failed its check: row count differs`]);
	});
});

posix("ensureLayout pending removals", () => {
	const seedPending = (): void => {
		put(legacyAt("runtime", "bun-v1.4.1", "bun"), "bun");
		put(join(paths.runtimeDir, "bun-v1.4.1", "bun"), "bun");
		put(
			legacyAt(".pending-removal.json"),
			JSON.stringify([{ name: nameOf("runtime"), from: legacyAt("runtime"), to: paths.runtimeDir }]),
		);
	};

	test("removes a source whose copy is complete, reports moved, and logs the removed line once across two DgPaths objects", async () => {
		seedPending();

		const result = await run();

		expect(outcomeAt(result, "runtime")).toMatchObject({ kind: "moved" });
		expect(existsSync(legacyAt("runtime"))).toBe(false);

		seedPending();
		await run({}, { ...paths });

		const removed = `dg: removed ${legacyAt("runtime")}; its copy at ${paths.runtimeDir} was complete`;
		expect(lines.filter((line) => line === removed)).toHaveLength(1);
	});

	test("removes the source of a record from the previous release that holds only from and to", async () => {
		seedPending();
		put(legacyAt(".pending-removal.json"), JSON.stringify([{ from: legacyAt("runtime"), to: paths.runtimeDir }]));

		const result = await run();

		expect(outcomeAt(result, "runtime")).toMatchObject({ kind: "moved" });
		expect(existsSync(legacyAt("runtime"))).toBe(false);
		expect(existsSync(legacyAt(".pending-removal.json"))).toBe(false);
	});

	test("keeps and names a source whose copy no longer holds every file", async () => {
		seedPending();
		writeFileSync(join(paths.runtimeDir, "bun-v1.4.1", "bun"), "other bytes");
		put(join(paths.runtimeDir, "extra"), "x");

		const result = await run();

		expect(outcomeAt(result, "runtime")).toMatchObject({ kind: "kept", reason: "copy-incomplete" });
		expect(readFileSync(legacyAt("runtime", "bun-v1.4.1", "bun"), "utf8")).toBe("bun");
		expect(lines).toEqual([`dg: kept ${legacyAt("runtime")}; its copy at ${paths.runtimeDir} no longer holds every file`]);
	});
});

posix("ensureLayout multi-file retry", () => {
	test("removes a held -wal file on the next run and logs the removed line once", async () => {
		const wal = legacyAt("agents", "memory.db-wal");
		const hold = legacyAt("agents", `.removing-memory.db-wal-${process.pid}`);
		put(legacyAt("agents", "memory.db"), "memory");
		put(wal, "wal");
		put(join(hold, "keep"), "x");
		const pendingFile = legacyAt(".pending-removal.json");

		const first = await run();

		expect(outcomeAt(first, "agents/memory.db")).toMatchObject({ kind: "scheduled" });
		expect(existsSync(legacyAt("agents", "memory.db"))).toBe(false);
		expect(JSON.parse(readFileSync(pendingFile, "utf8"))).toEqual([
			{ name: nameOf("agents/memory.db"), from: wal, to: join(paths.agentsDir, "memory.db-wal") },
		]);

		const second = await run({}, { ...paths });

		expect(outcomeAt(second, "agents/memory.db")).toMatchObject({ kind: "scheduled" });
		expect(existsSync(wal)).toBe(true);
		expect(existsSync(pendingFile)).toBe(true);

		rmSync(hold, { recursive: true, force: true });
		const third = await run({}, { ...paths });

		expect(outcomeAt(third, "agents/memory.db")).toMatchObject({ kind: "moved" });
		expect(existsSync(wal)).toBe(false);
		expect(existsSync(pendingFile)).toBe(false);
		const removed = `dg: removed ${wal}; its copy at ${join(paths.agentsDir, "memory.db-wal")} was complete`;
		expect(lines.filter((line) => line === removed)).toHaveLength(1);
	});
});

posix("ensureLayout running entry file", () => {
	test("keeps the lib source that holds the running file, schedules its removal, and removes it on a later start", async () => {
		const running = legacyAt("lib", "1.0.0", "dg.js");
		put(running, "bundle");
		put(legacyAt("lib", "1.0.0", "other.js"), "other");
		const pendingFile = legacyAt(".pending-removal.json");

		const first = await run({ entryFile: () => running });

		expect(outcomeAt(first, "lib")).toMatchObject({ kind: "scheduled" });
		expect(readFileSync(running, "utf8")).toBe("bundle");
		expect(readFileSync(join(paths.libDir, "1.0.0", "dg.js"), "utf8")).toBe("bundle");
		expect(JSON.parse(readFileSync(pendingFile, "utf8"))).toEqual([
			{ name: nameOf("lib"), from: legacyAt("lib"), to: paths.libDir },
		]);

		const second = await run({ entryFile: () => running }, { ...paths });

		expect(outcomeAt(second, "lib")).toMatchObject({ kind: "scheduled" });
		expect(existsSync(running)).toBe(true);

		const third = await run({ entryFile: () => join(paths.libDir, "1.0.0", "dg.js") }, { ...paths });

		expect(outcomeAt(third, "lib")).toMatchObject({ kind: "moved" });
		expect(existsSync(legacyAt("lib"))).toBe(false);
		expect(existsSync(pendingFile)).toBe(false);
	});
});

posix("ensureLayout running executable", () => {
	test("keeps the runtime source that holds the running executable, then removes it on a start from the new path", async () => {
		const bun = legacyAt("runtime", "bun-v1.4.1", "bun");
		put(bun, "bun", 0o755);
		symlinkSync(legacyAt("runtime", "bun-v1.4.1"), legacyAt("runtime", "current"));
		const pendingFile = legacyAt(".pending-removal.json");

		const first = await run({ execPath: () => legacyAt("runtime", "current", "bun") });

		expect(outcomeAt(first, "runtime")).toMatchObject({ kind: "scheduled" });
		expect(readFileSync(bun, "utf8")).toBe("bun");
		expect(readFileSync(join(paths.runtimeDir, "bun-v1.4.1", "bun"), "utf8")).toBe("bun");
		expect(JSON.parse(readFileSync(pendingFile, "utf8"))).toEqual([
			{ name: nameOf("runtime"), from: legacyAt("runtime"), to: paths.runtimeDir },
		]);

		const second = await run({ execPath: () => join(paths.runtimeDir, "bun-v1.4.1", "bun") }, { ...paths });

		expect(outcomeAt(second, "runtime")).toMatchObject({ kind: "moved" });
		expect(existsSync(legacyAt("runtime"))).toBe(false);
		expect(existsSync(pendingFile)).toBe(false);
	});
});

posix("ensureLayout stale pending records", () => {
	test("takes the lock to drop a record whose source is gone and removes the pending file", async () => {
		put(legacyAt("bin", "dg-skills"), "x");
		put(legacyAt(".pending-removal.json"), JSON.stringify([{ name: nameOf("runtime"), from: legacyAt("runtime"), to: paths.runtimeDir }]));
		const { counts, hooks } = counted();

		const result = await ensureLayout(paths, hooks as LayoutHooks);

		expect(counts.lock).toBe(1);
		expect(outcomeAt(result, "runtime")).toMatchObject({ kind: "absent" });
		expect(existsSync(legacyAt(".pending-removal.json"))).toBe(false);
		expect(lines).toEqual([]);
	});
});

posix("ensureLayout lock", () => {
	test("throws the lock message naming the live owner and leaves the legacy tree untouched", async () => {
		put(legacyAt("skills", "jot", "SKILL.md"), "# jot\n");
		mkdirSync(paths.dataDir, { recursive: true });
		writeFileSync(join(paths.dataDir, ".install.lock"), `${process.pid}::token`);

		await expect(
			run({ lock: (root: string, fn: () => unknown) => withInstallLock(root, fn as () => Promise<unknown>, FAST_LOCK) } as Partial<LayoutHooks>),
		).rejects.toThrow(`pid ${process.pid}`);

		expect(readFileSync(legacyAt("skills", "jot", "SKILL.md"), "utf8")).toBe("# jot\n");
		expect(existsSync(paths.skillsDir)).toBe(false);
	});

	test("fails fast with the lock message when called from inside a held install lock", async () => {
		put(legacyAt("skills", "jot", "SKILL.md"), "# jot\n");

		await expect(
			withInstallLock(paths.dataDir, () =>
				run({ lock: (root: string, fn: () => unknown) => withInstallLock(root, fn as () => Promise<unknown>, FAST_LOCK) } as Partial<LayoutHooks>),
			),
		).rejects.toThrow("is held");
	});

	test("never runs inside installBundleLocked", () => {
		const cli = readFileSync(join(import.meta.dir, "..", "..", "skills-cli", "src", "install", "cli.ts"), "utf8");

		expect(cli).not.toContain("ensureLayout");
	});
});

posix("assertNotBlocked", () => {
	const kept = (from: string): string =>
		`dg: kept ${from}; a process that writes it is running. Stop it, then run dg-skills install again`;
	const notMoved = (from: string, to: string): string => `dg: ${from} has not moved to ${to}; run dg-skills install`;

	test("throws the exact kept text after a live-writer block", async () => {
		put(legacyAt("daemon", "daemon.db"), "db");
		put(legacyAt("daemon", "daemon.pid"), livePid());
		await run();

		const error = thrown(() => assertNotBlocked(paths, "daemon"));

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toBe(kept(legacyAt("daemon")));
	});

	test("throws the has-not-moved text after a no-hook block", async () => {
		put(legacyAt("phone", "phone.db"), "legacy");
		await run();

		const error = thrown(() => assertNotBlocked(paths, "phone"));

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toBe(notMoved(legacyAt("phone"), paths.phoneRoot));
	});

	test("throws the failed-check line after a failed move", async () => {
		put(legacyAt("phone", "phone.db"), "legacy");
		await run({ "phone.verify": () => ["row count differs"], "phone.stop": async () => "stopped" as const });

		const error = thrown(() => assertNotBlocked(paths, "phone"));

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toBe(`dg: kept ${legacyAt("phone")}; the copy failed its check: row count differs`);
	});

	test("throws the set-aside failure line after a failed set-aside", async () => {
		const now = 1_700_000_000_000;
		put(legacyAt("daemon", "daemon.db"), "db bytes");
		mkdirSync(paths.daemonDir, { recursive: true });
		put(join(`${paths.daemonDir}.empty-${now}`, "occupied"), "x");
		await run({ now: () => now } as Partial<LayoutHooks>);

		const error = thrown(() => assertNotBlocked(paths, "daemon"));

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toStartWith(`dg: kept ${legacyAt("daemon")}; setting aside ${paths.daemonDir} failed: `);
	});

	test("builds the same texts through blockedText", async () => {
		put(legacyAt("daemon", "daemon.db"), "db");
		put(legacyAt("daemon", "daemon.pid"), livePid());
		const result = await run();

		expect(blockedText(result.daemon as never)).toBe(kept(legacyAt("daemon")));
	});

	test("throws the has-not-moved text on a cache miss when the source exists and the target does not", () => {
		put(legacyAt("daemon", "daemon.db"), "db");

		const error = thrown(() => assertNotBlocked({ ...paths }, "daemon"));

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toBe(notMoved(legacyAt("daemon"), paths.daemonDir));
		expect(existsSync(paths.stateDir)).toBe(false);
	});

	test("throws the has-not-moved text for a child-kept parent whose target is missing", async () => {
		put(legacyAt("daemon", "daemon.db"), "db");
		put(legacyAt("daemon", "logs", "daemon-1.log"), "legacy log");
		put(join(paths.logDir, "daemon-2.log"), "current log");
		const result = await run();
		expect(outcomeAt(result, "daemon")).toMatchObject({ kind: "kept", reason: "child-kept" });

		const error = thrown(() => assertNotBlocked(paths, "daemon"));

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toBe(notMoved(legacyAt("daemon"), paths.daemonDir));
		expect(existsSync(paths.daemonDir)).toBe(false);
	});

	test("returns for a target-used kept entry because its target exists", async () => {
		put(legacyAt("daemon", "daemon.db"), "legacy");
		put(join(paths.daemonDir, "daemon.db"), "current");
		const result = await run();
		expect(outcomeAt(result, "daemon")).toMatchObject({ kind: "kept", reason: "target-used" });

		expect(thrown(() => assertNotBlocked(paths, "daemon"))).toBeUndefined();
	});

	test("returns on a cache miss when both exist, when only the target exists, and when neither exists", () => {
		expect(thrown(() => assertNotBlocked({ ...paths }, "daemon"))).toBeUndefined();

		put(join(paths.daemonDir, "daemon.db"), "db");
		expect(thrown(() => assertNotBlocked({ ...paths }, "daemon"))).toBeUndefined();

		put(legacyAt("daemon", "daemon.db"), "db");
		expect(thrown(() => assertNotBlocked({ ...paths }, "daemon"))).toBeUndefined();
	});
});

describe("layout module graph", () => {
	const staticSpecifiers = (file: string): string[] =>
		[...readFileSync(join(SRC, file), "utf8").matchAll(/^\s*(?:import|export)\s[^;"']*?\sfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)].map(
			(match) => (match[1] ?? match[2]) as string,
		);

	test("keeps the static imports of layout.ts to the fast-path set", () => {
		const specifiers = staticSpecifiers("layout.ts");

		expect(specifiers.length).toBeGreaterThan(0);
		for (const specifier of specifiers)
			expect(["node:fs", "node:path", "./dg-paths", "./install-lock", "../errors"]).toContain(specifier);
	});

	test("does not export layout-work from the node index and keeps install-lock free of the node index", () => {
		expect(readFileSync(join(SRC, "index.ts"), "utf8")).not.toContain("layout-work");
		expect(readFileSync(join(SRC, "install-lock.ts"), "utf8")).not.toContain("@dg/common/node");
	});

	test("resolves the layout and layout-work package exports", async () => {
		const layout = await import("@dg/common/node/layout");
		const work = await import("@dg/common/node/layout-work");

		expect(typeof layout.ensureLayout).toBe("function");
		expect(layout.LAYOUT_TABLE.map((entry) => entry.name)).toContain("memory");
		expect(typeof layout.layoutResult).toBe("function");
		expect(typeof layout.blockedText).toBe("function");
		expect(typeof layout.assertNotBlocked).toBe("function");
		expect(typeof work.snapshot).toBe("function");
		expect(typeof work.planLayout).toBe("function");
		expect(typeof work.applyLayout).toBe("function");
	});

	test("removes the old skills-cli lock and migrate-home modules", () => {
		const install = join(import.meta.dir, "..", "..", "skills-cli", "src", "install");

		expect(existsSync(join(install, "lock.ts"))).toBe(false);
		expect(existsSync(join(install, "migrate-home.ts"))).toBe(false);
	});
});
