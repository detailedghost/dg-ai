import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
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

		expect(result).toEqual({ moved: [], failed: [], kept: [] });
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
