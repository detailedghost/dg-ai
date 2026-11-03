import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { migrateLegacyHome } from "../src/install/migrate-home";

let dir: string;
let home: string;
let paths: DgPaths;
const lines: string[] = [];
const log = (line: string) => lines.push(line);

function put(path: string, body: string, mode = 0o644): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body, { mode });
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-migrate-home-"));
	home = join(dir, "home");
	paths = resolveDgPaths({ platform: "linux", homeDir: home, env: {} });
	lines.length = 0;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedLegacy(): string {
	const legacy = join(home, ".dg");
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
	put(join(legacy, "channel-review", "config.json"), '{"env":{}}');
	put(join(legacy, "channel-review", "state.dev.json"), "{}");
	put(join(legacy, "lib", "1.0.0", "dg.js"), "bundle");
	symlinkSync("1.0.0", join(legacy, "lib", "current"));
	put(join(legacy, "runtime", "bun-v1.4.1", "bun"), "bun", 0o755);
	symlinkSync(
		join(legacy, "runtime", "bun-v1.4.1"),
		join(legacy, "runtime", "current"),
	);
	return legacy;
}

describe("migrateLegacyHome", () => {
	test("moves every role to its new root and leaves only bin/ in the legacy dir", () => {
		const legacy = seedLegacy();

		const result = migrateLegacyHome(paths, { log });

		expect(result.failed).toEqual([]);
		expect(readdirSync(legacy)).toEqual(["bin"]);
		expect(readFileSync(join(paths.daemonDir, "daemon.db"), "utf8")).toBe(
			"db bytes",
		);
		expect(readFileSync(join(paths.logDir, "daemon-1.log"), "utf8")).toBe(
			"log line\n",
		);
		expect(readFileSync(join(paths.skillsDir, "jot", "SKILL.md"), "utf8")).toBe(
			"# jot\n",
		);
		expect(
			readFileSync(join(paths.cacheDir, "proto", "demo", "index.html"), "utf8"),
		).toBe("<p>proto</p>");
		expect(
			readFileSync(join(paths.cacheDir, "demos", "a.demo.md"), "utf8"),
		).toBe("demo");
		expect(readFileSync(join(paths.personasDir, "js.md"), "utf8")).toBe(
			"persona",
		);
		expect(readFileSync(paths.memoryDbPath, "utf8")).toBe("memory");
		expect(readFileSync(join(paths.sessionsDir, "s1.json"), "utf8")).toBe("{}");
		expect(readFileSync(paths.configPath, "utf8")).toBe('{"hooks":{}}');
		expect(existsSync(paths.cliOnlyMarker)).toBe(true);
		expect(existsSync(paths.pairingPath)).toBe(true);
		expect(
			readFileSync(
				join(paths.configDir, "channel-review", "config.json"),
				"utf8",
			),
		).toBe('{"env":{}}');
		expect(
			existsSync(join(paths.stateDir, "channel-review", "state.dev.json")),
		).toBe(true);
		expect(readFileSync(join(paths.libDir, "current", "dg.js"), "utf8")).toBe(
			"bundle",
		);
		expect(readlinkSync(join(paths.libDir, "current"))).toBe("1.0.0");
		expect(readlinkSync(join(paths.runtimeDir, "current"))).toBe(
			join(paths.runtimeDir, "bun-v1.4.1"),
		);
		expect(
			statSync(join(paths.runtimeDir, "bun-v1.4.1", "bun")).mode & 0o777,
		).toBe(0o755);
	});

	test("leaves the phone state and the staged extension folders for their own steps", () => {
		const legacy = join(home, ".dg");
		put(join(legacy, "phone", "line", "phone.db"), "phone");
		put(join(legacy, "dg-ai-extension-chrome", "manifest.json"), "{}");

		const result = migrateLegacyHome(paths, { log });

		expect(result.failed).toEqual([]);
		expect(readdirSync(legacy).sort()).toEqual([
			"dg-ai-extension-chrome",
			"phone",
		]);
	});

	test("keeps the source untouched and returns the failing path when a copy does not verify", () => {
		const legacy = seedLegacy();

		const result = migrateLegacyHome(paths, {
			log,
			afterCopy: (_from, to) => {
				if (to === paths.daemonDir) truncateSync(join(to, "daemon.db"), 2);
			},
		});

		expect(result.failed).toEqual([join(legacy, "daemon")]);
		expect(readFileSync(join(legacy, "daemon", "daemon.db"), "utf8")).toBe(
			"db bytes",
		);
		expect(existsSync(paths.daemonDir)).toBe(false);
		expect(lines.some((line) => line.includes(join(legacy, "daemon")))).toBe(
			true,
		);
		expect(existsSync(join(legacy, "skills"))).toBe(false);
	});

	test("keeps the parent folder when one of its children did not move", () => {
		const legacy = seedLegacy();

		const result = migrateLegacyHome(paths, {
			log,
			afterCopy: (_from, to) => {
				if (to === join(paths.agentsDir, "memory.db")) truncateSync(to, 1);
			},
		});

		expect(result.failed).toEqual([join(legacy, "agents", "memory.db")]);
		expect(result.kept).toContain(join(legacy, "agents"));
		expect(readFileSync(join(legacy, "agents", "memory.db"), "utf8")).toBe("memory");
		expect(readFileSync(join(legacy, "agents", "js.md"), "utf8")).toBe("persona");
		expect(existsSync(paths.personasDir)).toBe(false);
	});

	test("skips a folder whose pid file names a live process", () => {
		const legacy = seedLegacy();
		put(join(legacy, "daemon", "daemon.pid"), JSON.stringify({ pid: process.pid }));

		const result = migrateLegacyHome(paths, { log });

		expect(result.kept).toContain(join(legacy, "daemon"));
		expect(readFileSync(join(legacy, "daemon", "daemon.db"), "utf8")).toBe("db bytes");
		expect(existsSync(paths.daemonDir)).toBe(false);
		expect(lines.join("\n")).toContain("is running");
	});

	test("keeps the agent state while the old daemon runs", () => {
		const legacy = seedLegacy();
		put(join(legacy, "daemon", "daemon.pid"), JSON.stringify({ pid: process.pid }));
		put(join(legacy, "agents", "memory.db"), "memory");
		put(join(legacy, "agents", "assets", "a.png"), "png");

		const result = migrateLegacyHome(paths, { log });

		expect(result.kept).toContain(join(legacy, "agents"));
		expect(readFileSync(join(legacy, "agents", "memory.db"), "utf8")).toBe("memory");
		expect(existsSync(paths.memoryDbPath)).toBe(false);
		expect(existsSync(paths.assetsDir)).toBe(false);
	});

	test("schedules a copied folder that is in use and removes it on the next run", () => {
		const legacy = seedLegacy();
		const busy = (from: string, to: string) => {
			if (from === join(legacy, "runtime")) throw Object.assign(new Error("in use"), { code: "EBUSY" });
			renameSync(from, to);
		};

		const first = migrateLegacyHome(paths, { log, rename: busy });

		expect(first.scheduled).toEqual([join(legacy, "runtime")]);
		expect(existsSync(join(legacy, "runtime", "bun-v1.4.1", "bun"))).toBe(true);
		expect(existsSync(join(paths.runtimeDir, "bun-v1.4.1", "bun"))).toBe(true);
		expect(lines.join("\n")).toContain("the next dg-skills install removes it");

		const second = migrateLegacyHome(paths, { log });

		expect(second.scheduled).toEqual([]);
		expect(second.moved).toEqual([join(legacy, "runtime")]);
		expect(readdirSync(legacy)).toEqual(["bin"]);
		expect(existsSync(join(paths.runtimeDir, "bun-v1.4.1", "bun"))).toBe(true);
	});

	test("keeps a scheduled folder while it is still in use", () => {
		const legacy = seedLegacy();
		const busy = (from: string, to: string) => {
			if (from === join(legacy, "runtime")) throw Object.assign(new Error("in use"), { code: "EBUSY" });
			renameSync(from, to);
		};
		migrateLegacyHome(paths, { log, rename: busy });
		lines.length = 0;

		const again = migrateLegacyHome(paths, { log, rename: busy });

		expect(again.scheduled).toEqual([join(legacy, "runtime")]);
		expect(existsSync(join(legacy, "runtime", "bun-v1.4.1", "bun"))).toBe(true);
		expect(again.kept).not.toContain(join(legacy, "runtime"));
		expect(lines).toEqual([]);
	});

	test("moves the ssms state to the state root and its fixed config to the given config folder", () => {
		const legacy = join(home, ".dg");
		put(join(legacy, "ssms", "drafts", "d1.json"), "{}");
		put(join(legacy, "ssms", "config.yaml"), "allow_send: true\n");
		const fixed = join(home, "fixed-config");

		const result = migrateLegacyHome(paths, { log, ssmsConfigDir: fixed });

		expect(result.failed).toEqual([]);
		expect(readFileSync(join(fixed, "ssms", "config.yaml"), "utf8")).toBe("allow_send: true\n");
		expect(readFileSync(join(paths.stateDir, "ssms", "drafts", "d1.json"), "utf8")).toBe("{}");
		expect(existsSync(join(paths.stateDir, "ssms", "config.yaml"))).toBe(false);
		expect(existsSync(join(legacy, "ssms"))).toBe(false);
	});

	test("never overwrites an ssms config that already exists in the new folder", () => {
		const legacy = join(home, ".dg");
		put(join(legacy, "ssms", "config.yaml"), "allow_send: true\n");
		put(join(paths.configDir, "ssms", "config.yaml"), "allow_send: false\n");

		const result = migrateLegacyHome(paths, { log });

		expect(result.kept).toContain(join(legacy, "ssms", "config.yaml"));
		expect(readFileSync(join(paths.configDir, "ssms", "config.yaml"), "utf8")).toBe("allow_send: false\n");
		expect(readFileSync(join(legacy, "ssms", "config.yaml"), "utf8")).toBe("allow_send: true\n");
	});

	test("keeps a scheduled folder whose copy lost a file before the retry", () => {
		const legacy = seedLegacy();
		const busy = (from: string, to: string) => {
			if (from === join(legacy, "runtime")) throw Object.assign(new Error("in use"), { code: "EBUSY" });
			renameSync(from, to);
		};
		migrateLegacyHome(paths, { log, rename: busy });
		rmSync(join(paths.runtimeDir, "bun-v1.4.1", "bun"));

		const again = migrateLegacyHome(paths, { log });

		expect(existsSync(join(legacy, "runtime", "bun-v1.4.1", "bun"))).toBe(true);
		expect(again.kept).toContain(join(legacy, "runtime"));
		expect(again.scheduled).toEqual([]);
	});

	test("does not retry a scheduled folder that a live process writes", () => {
		const legacy = seedLegacy();
		const busy = (from: string, to: string) => {
			if (from === join(legacy, "daemon")) throw Object.assign(new Error("in use"), { code: "EBUSY" });
			renameSync(from, to);
		};
		migrateLegacyHome(paths, { log, rename: busy });
		put(join(legacy, "daemon", "daemon.pid"), JSON.stringify({ pid: process.pid }));

		migrateLegacyHome(paths, { log });

		expect(readFileSync(join(legacy, "daemon", "daemon.db"), "utf8")).toBe("db bytes");
	});

	test("finishes a removal whose delete failed after the rename", () => {
		const legacy = seedLegacy();
		let fail = true;
		const removeTree = (path: string) => {
			if (fail && path.includes("runtime")) throw new Error("EPERM");
			rmSync(path, { recursive: true, force: true });
		};

		expect(() => migrateLegacyHome(paths, { log, removeTree })).not.toThrow();
		expect(existsSync(join(legacy, "runtime"))).toBe(false);
		fail = false;
		migrateLegacyHome(paths, { log, removeTree });

		expect(readdirSync(legacy)).toEqual(["bin"]);
	});

	test("never overwrites a destination that already exists", () => {
		const legacy = seedLegacy();
		put(join(paths.skillsDir, "new", "SKILL.md"), "newer");

		const result = migrateLegacyHome(paths, { log });

		expect(result.kept).toContain(join(legacy, "skills"));
		expect(
			readFileSync(join(legacy, "skills", "jot", "SKILL.md"), "utf8"),
		).toBe("# jot\n");
		expect(existsSync(join(paths.skillsDir, "jot"))).toBe(false);
	});

	test("does nothing when there is no legacy home", () => {
		const result = migrateLegacyHome(paths, { log });

		expect(result).toEqual({ moved: [], failed: [], kept: [], scheduled: [] });
		expect(existsSync(home)).toBe(false);
	});

	test("moves a flat DG_HOME into its role folders without leaving DG_HOME", () => {
		const root = join(dir, "dg-home");
		put(join(root, "bin", "dg-skills"), "shim", 0o755);
		put(join(root, "daemon", "daemon.db"), "db");
		put(join(root, "skills", "jot", "SKILL.md"), "jot");
		const flat = resolveDgPaths({
			platform: "linux",
			homeDir: home,
			env: { DG_HOME: root },
		});

		const result = migrateLegacyHome(flat, { log });

		expect(result.failed).toEqual([]);
		expect(
			readFileSync(join(root, "state", "daemon", "daemon.db"), "utf8"),
		).toBe("db");
		expect(
			readFileSync(join(root, "data", "skills", "jot", "SKILL.md"), "utf8"),
		).toBe("jot");
		expect(readdirSync(root).sort()).toEqual(["bin", "data", "state"]);
		expect(existsSync(home)).toBe(false);
	});

	test("a second run over migrated role folders under DG_HOME moves nothing", () => {
		const root = join(dir, "dg-home");
		put(join(root, "state", "daemon", "daemon.db"), "db");
		const flat = resolveDgPaths({
			platform: "linux",
			homeDir: home,
			env: { DG_HOME: root },
		});

		expect(migrateLegacyHome(flat, { log })).toEqual({
			moved: [],
			failed: [],
			kept: [],
			scheduled: [],
		});
	});

	test("names a folder it does not know only on the run that moved something", () => {
		const legacy = join(home, ".dg");
		put(join(legacy, "skills", "jot", "SKILL.md"), "jot");
		put(join(legacy, "notes", "a.txt"), "mine");

		const first = migrateLegacyHome(paths, { log });
		const firstLines = [...lines];
		lines.length = 0;
		const second = migrateLegacyHome(paths, { log });

		expect(first.kept).toEqual([join(legacy, "notes")]);
		expect(firstLines.join("\n")).toContain(join(legacy, "notes"));
		expect(second.kept).toEqual([join(legacy, "notes")]);
		expect(lines).toEqual([]);
	});
});
