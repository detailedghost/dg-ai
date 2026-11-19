import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DgCliError } from "@dg/common/errors";
import { resolveDgPaths } from "@dg/common/node";
import { ensureLayout } from "@dg/common/node/layout";
import { parseJobs } from "../../src/jobs/config";
import {
	isMigrated,
	JOBS_VERSION,
	migrateServicesKey,
	SERVICES_MARK,
} from "../../src/jobs/migrate";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) cleanupDgHome(home);
});

function setup(contents?: unknown) {
	const dgHome = freshDgHome();
	homes.push(dgHome);
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	if (contents !== undefined) {
		mkdirSync(dirname(paths.daemonConfigPath), { recursive: true });
		writeFileSync(
			paths.daemonConfigPath,
			typeof contents === "string" ? contents : JSON.stringify(contents),
		);
	}
	return paths;
}

const backupOf = (paths: ReturnType<typeof setup>) =>
	join(paths.daemonDir, "config.json.pre-jobs");
const configOf = (paths: ReturnType<typeof setup>) =>
	JSON.parse(readFileSync(paths.daemonConfigPath, "utf8"));
const posix = process.platform === "win32" ? it.skip : it;

const entry = { argv: ["/b"], cwd: "/c" };

describe("migration constants", () => {
	it("holds the version 2 and the literal mark 1", () => {
		expect(JOBS_VERSION).toBe(2);
		expect(SERVICES_MARK).toBe(1);
	});

	it.each([
		[{}, false],
		[{ jobsVersion: 0 }, false],
		[{ jobsVersion: "1" }, false],
		[{ jobsVersion: null }, false],
		[{ jobsVersion: Number.NaN }, false],
		[{ jobsVersion: JOBS_VERSION }, true],
		[{ jobsVersion: JOBS_VERSION + 1 }, true],
		[{ jobsVersion: 5 }, true],
	])("isMigrated(%p) is %p", (config, expected) => {
		expect(isMigrated(config)).toBe(expected);
	});
});

describe("migrateServicesKey move", () => {
	it("turns services into jobs, keeps other keys and backs up the old bytes", () => {
		const before = JSON.stringify({
			pinnedOrigin: "x",
			services: { a: { ...entry, autostart: true } },
		});
		const paths = setup(before);
		expect(migrateServicesKey(paths)).toEqual({ moved: ["a"] });
		expect(configOf(paths)).toEqual({
			pinnedOrigin: "x",
			jobsVersion: SERVICES_MARK,
			jobs: { a: { ...entry, continuous: true, enabled: true } },
		});
		expect(Object.hasOwn(configOf(paths), "services")).toBe(false);
		expect(readFileSync(backupOf(paths), "utf8")).toBe(before);
	});

	it("gives no enabled key for autostart false or no autostart", () => {
		const paths = setup({
			services: { off: { ...entry, autostart: false }, bare: entry },
		});
		migrateServicesKey(paths);
		const { jobs } = configOf(paths);
		expect(jobs.off).toEqual({ ...entry, continuous: true });
		expect(jobs.bare).toEqual({ ...entry, continuous: true });
	});

	it("keeps an autostart value that is not a boolean, so the entry stays invalid", () => {
		const paths = setup({ services: { a: { ...entry, autostart: "yes" } } });
		migrateServicesKey(paths);
		expect(configOf(paths).jobs.a).toEqual({
			...entry,
			autostart: "yes",
			continuous: true,
		});
	});

	it("moves an entry with a key outside the services keys with no change", () => {
		const refused = { argv: [], zed: 1, cwd: "rel", autostart: true };
		const paths = setup({ services: { a: refused } });
		migrateServicesKey(paths);
		expect(configOf(paths).jobs.a).toEqual(refused);
	});

	it.each([
		{ ...entry, autostart: false, enabled: true },
		{ ...entry, grant: "x", credentials: ["token"], autostart: true },
	])("moves %p with no change, so it stays invalid and never autostarts", (held) => {
		const paths = setup({ services: { a: held } });
		migrateServicesKey(paths);
		const { jobs } = configOf(paths);
		expect(jobs.a).toEqual(held);
		expect(parseJobs({ jobs })[0]?.ok).toBe(false);
	});

	it("keeps an existing continuous or enabled value", () => {
		const paths = setup({
			services: {
				a: { ...entry, continuous: false },
				b: { ...entry, autostart: true, enabled: false },
			},
		});
		migrateServicesKey(paths);
		const { jobs } = configOf(paths);
		expect(jobs.a).toEqual({ ...entry, continuous: false });
		expect(jobs.b).toEqual({ ...entry, autostart: true, enabled: false });
		expect(parseJobs({ jobs })[0]?.ok).toBe(false);
	});

	it("moves an entry that is not an object as it is", () => {
		const paths = setup({ services: { a: 5, b: [1], c: null } });
		expect(migrateServicesKey(paths).moved.sort()).toEqual(["a", "b", "c"]);
		expect(configOf(paths).jobs).toEqual({ a: 5, b: [1], c: null });
	});

	it("keeps the entries already in jobs and adds the moved ones", () => {
		const paths = setup({
			jobs: { old: { ...entry, every: "15m" } },
			services: { fresh: entry },
		});
		migrateServicesKey(paths);
		expect(configOf(paths).jobs).toEqual({
			old: { ...entry, every: "15m" },
			fresh: { ...entry, continuous: true },
		});
	});

	it("stores a __proto__ name as an own key of jobs", () => {
		const paths = setup(`{"services":{"__proto__":${JSON.stringify(entry)}}}`);
		migrateServicesKey(paths);
		expect(Object.hasOwn(configOf(paths).jobs, "__proto__")).toBe(true);
		expect(({} as Record<string, unknown>).argv).toBeUndefined();
	});

	it("moves an empty services table to an empty jobs table", () => {
		const paths = setup({ services: {} });
		expect(migrateServicesKey(paths)).toEqual({ moved: [] });
		expect(configOf(paths)).toMatchObject({
			jobs: {},
			jobsVersion: SERVICES_MARK,
		});
		expect(Object.hasOwn(configOf(paths), "services")).toBe(false);
	});
});

describe("migrateServicesKey no-op and marks", () => {
	it("writes nothing the second time: bytes and mtime stay", () => {
		const paths = setup({ services: { a: entry } });
		migrateServicesKey(paths);
		const old = new Date(Date.now() - 60_000);
		utimesSync(paths.daemonConfigPath, old, old);
		const bytes = readFileSync(paths.daemonConfigPath, "utf8");
		const mtime = statSync(paths.daemonConfigPath).mtimeMs;
		expect(migrateServicesKey(paths)).toEqual({ moved: [] });
		expect(readFileSync(paths.daemonConfigPath, "utf8")).toBe(bytes);
		expect(statSync(paths.daemonConfigPath).mtimeMs).toBe(mtime);
	});

	posix(
		"creates the file with the mark alone, mode 0600 and a private directory, with no backup",
		() => {
			const paths = setup();
			expect(migrateServicesKey(paths)).toEqual({ moved: [] });
			expect(configOf(paths)).toEqual({ jobsVersion: SERVICES_MARK });
			expect(statSync(paths.daemonConfigPath).mode & 0o777).toBe(0o600);
			expect(statSync(dirname(paths.daemonConfigPath)).mode & 0o077).toBe(0);
			expect(existsSync(backupOf(paths))).toBe(false);
		},
	);

	it("writes the mark alone, with no backup, when the config has no services key", () => {
		const paths = setup({ pinnedOrigin: "p" });
		migrateServicesKey(paths);
		expect(configOf(paths)).toEqual({
			pinnedOrigin: "p",
			jobsVersion: SERVICES_MARK,
		});
		expect(existsSync(backupOf(paths))).toBe(false);
	});

	it("keeps a mark above the current one", () => {
		const paths = setup({ jobsVersion: 5, jobs: {} });
		const bytes = readFileSync(paths.daemonConfigPath, "utf8");
		migrateServicesKey(paths);
		expect(readFileSync(paths.daemonConfigPath, "utf8")).toBe(bytes);
	});

	it("keeps a mark above the current one when it moves a services key", () => {
		const paths = setup({ jobsVersion: 5, services: { a: entry } });
		migrateServicesKey(paths);
		expect(configOf(paths).jobsVersion).toBe(5);
		expect(configOf(paths).jobs.a).toEqual({ ...entry, continuous: true });
	});

	it("moves a services key that comes back after the mark", () => {
		const paths = setup({ jobsVersion: SERVICES_MARK, services: { a: entry } });
		expect(migrateServicesKey(paths)).toEqual({ moved: ["a"] });
		expect(Object.hasOwn(configOf(paths), "services")).toBe(false);
		expect(configOf(paths).jobs.a).toEqual({ ...entry, continuous: true });
	});

	it("leaves a services value that is not an object in the file and writes the mark", () => {
		const paths = setup({ services: [1] });
		expect(() => migrateServicesKey(paths)).not.toThrow();
		expect(configOf(paths)).toMatchObject({
			services: [1],
			jobsVersion: SERVICES_MARK,
		});
		expect(migrateServicesKey(paths)).toEqual({ moved: [] });
	});
});

describe("migrateServicesKey refusals", () => {
	it("throws naming the file and the name when a name is in both tables, and writes nothing", () => {
		const body = JSON.stringify({
			jobs: { a: { ...entry, continuous: true } },
			services: { a: entry },
		});
		const paths = setup(body);
		expect(() => migrateServicesKey(paths)).toThrow(
			`${paths.daemonConfigPath}: "a" is in "services" and in "jobs" — remove one of them`,
		);
		expect(readFileSync(paths.daemonConfigPath, "utf8")).toBe(body);
		expect(existsSync(backupOf(paths))).toBe(false);
	});

	it("throws on a config that is not valid JSON and leaves the bytes", () => {
		const paths = setup('{"services":');
		expect(() => migrateServicesKey(paths)).toThrow(paths.daemonConfigPath);
		expect(readFileSync(paths.daemonConfigPath, "utf8")).toBe('{"services":');
		expect(existsSync(backupOf(paths))).toBe(false);
	});

	it("throws exit code 78 and writes nothing when two daemon folders are used", async () => {
		const paths = setup();
		mkdirSync(join(paths.legacyHome, "daemon"), { recursive: true });
		writeFileSync(join(paths.legacyHome, "daemon", "key"), "legacy-key");
		mkdirSync(paths.daemonDir, { recursive: true });
		writeFileSync(join(paths.daemonDir, "key"), "target-key");
		await ensureLayout(paths, { log: () => {} });
		let code: unknown;
		try {
			migrateServicesKey(paths);
		} catch (error) {
			code = error instanceof DgCliError ? error.exitCode : error;
		}
		expect(code).toBe(78);
		expect(existsSync(paths.daemonConfigPath)).toBe(false);
	});
});

describe("migrateServicesKey backup and mode", () => {
	posix("sets the config mode to 0600 after a move, also from 0644", () => {
		const paths = setup({ services: { a: entry } });
		chmodSync(paths.daemonConfigPath, 0o644);
		migrateServicesKey(paths);
		expect(statSync(paths.daemonConfigPath).mode & 0o777).toBe(0o600);
		expect(statSync(backupOf(paths)).mode & 0o777).toBe(0o600);
	});

	it("does not replace an existing backup", () => {
		const paths = setup({ services: { a: entry } });
		writeFileSync(backupOf(paths), "older bytes");
		migrateServicesKey(paths);
		expect(readFileSync(backupOf(paths), "utf8")).toBe("older bytes");
		expect(configOf(paths).jobs.a).toBeDefined();
	});

	posix(
		"backs up the target of a config that is a link, and keeps the link",
		() => {
			const paths = setup();
			const target = join(dirname(paths.daemonConfigPath), "real.json");
			const before = JSON.stringify({ services: { a: entry } });
			mkdirSync(dirname(paths.daemonConfigPath), { recursive: true });
			writeFileSync(target, before);
			symlinkSync(target, paths.daemonConfigPath);
			migrateServicesKey(paths);
			expect(lstatSync(paths.daemonConfigPath).isSymbolicLink()).toBe(true);
			expect(lstatSync(backupOf(paths)).isSymbolicLink()).toBe(false);
			expect(readFileSync(backupOf(paths), "utf8")).toBe(before);
			expect(JSON.parse(readFileSync(target, "utf8")).jobs.a).toBeDefined();
		},
	);

	const asRoot = process.platform === "win32" || process.getuid?.() === 0;
	(asRoot ? it.skip : it)(
		"stops and writes nothing when the backup cannot be made",
		() => {
			const before = JSON.stringify({ services: { a: entry } });
			const paths = setup(before);
			chmodSync(paths.daemonDir, 0o500);
			try {
				expect(() => migrateServicesKey(paths)).toThrow();
			} finally {
				chmodSync(paths.daemonDir, 0o700);
			}
			expect(readFileSync(paths.daemonConfigPath, "utf8")).toBe(before);
			expect(existsSync(backupOf(paths))).toBe(false);
		},
	);
});
