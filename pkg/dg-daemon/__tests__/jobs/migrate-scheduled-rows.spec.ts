import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { formatIntervalMs } from "@dg/common";
import {
	isMigrated,
	JOBS_VERSION,
	migrateScheduledRows,
	migrateServicesKey,
	SERVICES_MARK,
} from "../../src/jobs/migrate";
import type { ChatStore } from "../../src/store";
import { cleanupDgHome } from "../utils/daemon-harness";
import {
	configOf,
	FUTURE,
	openStoreAt,
	pathsOf,
	QUARTER_HOUR_MS,
	rawJob,
	rawRun,
	rowInput,
	seedHome,
	workDir,
} from "./scheduled-fixtures";

const homes: string[] = [];
const stores: ChatStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const home of homes.splice(0)) cleanupDgHome(home);
});

async function setup(
	rows: Parameters<typeof rowInput>[0][] = [],
	jobs: Record<string, unknown> = {},
) {
	const { dgHome, ids } = await seedHome({
		jobs,
		rows: rows.map((row) => rowInput({ cwd: workDir(), ...row })),
	});
	homes.push(dgHome);
	const store = await openStoreAt(dgHome);
	stores.push(store);
	return { dgHome, store, ids, paths: pathsOf(dgHome) };
}

const move = async (store: ChatStore, paths: ReturnType<typeof pathsOf>) => {
	await Promise.resolve(migrateScheduledRows(store, paths));
};

const posix = process.platform === "win32" ? it.skip : it;

describe("migrateScheduledRows mapping", () => {
	it("turns a row into a jobs entry and keeps its id, next run and feed items", async () => {
		const cwd = workDir();
		const argv = ["jira", "issue", "list"];
		const { dgHome, store, ids, paths } = await setup([
			{
				label: "jira-sprint",
				argv,
				cwd,
				intervalMs: 900_000,
				enabled: true,
				notifyIdentity: "reviewer",
				nextRunAt: "2031-05-06T07:08:09.000Z",
			},
		]);
		store.insertFeedItems(ids[0], [{ fingerprint: "a", title: "A" }]);

		await move(store, paths);

		expect(configOf(dgHome).jobs["jira-sprint"]).toEqual({
			argv,
			cwd,
			every: formatIntervalMs(900_000),
			enabled: true,
			feed: true,
			notify: "reviewer",
		});
		const job = store.getJob(ids[0]);
		expect(job?.id).toBe(ids[0]);
		expect(job?.nextRunAt).toBe("2031-05-06T07:08:09.000Z");
		expect(job?.argv).toEqual([]);
		expect(store.listFeedItems({ jobId: ids[0] })).toHaveLength(1);
		expect(rawJob(store, ids[0]).moved_at).not.toBeNull();
	});

	it("gives schedule, not every, for a row with a cron text and an interval", async () => {
		const { dgHome, store, paths } = await setup([
			{
				label: "nine",
				cronExpr: "0 9 * * 1-5",
				intervalMs: QUARTER_HOUR_MS,
				nextRunAt: FUTURE,
			},
		]);

		await move(store, paths);

		const entry = configOf(dgHome).jobs.nine;
		expect(entry.schedule).toBe("0 9 * * 1-5");
		expect(Object.hasOwn(entry, "every")).toBe(false);
	});

	it("gives no enabled key for a disabled row", async () => {
		const { dgHome, store, paths } = await setup([
			{ label: "off", enabled: false },
		]);

		await move(store, paths);

		expect(Object.hasOwn(configOf(dgHome).jobs.off, "enabled")).toBe(false);
	});

	it("gives no notify key for a row with no notify_identity", async () => {
		const { dgHome, store, paths } = await setup([{ label: "quiet" }]);

		await move(store, paths);

		const entry = configOf(dgHome).jobs.quiet;
		expect(Object.hasOwn(entry, "notify")).toBe(false);
		expect(entry.feed).toBe(true);
	});

	it("keeps the next run time of each job", async () => {
		const { store, ids, paths } = await setup([
			{ label: "one", nextRunAt: "2031-01-01T00:00:00.000Z" },
			{ label: "two", nextRunAt: "2032-02-02T00:00:00.000Z" },
		]);

		await move(store, paths);

		expect(store.getJob(ids[0])?.nextRunAt).toBe("2031-01-01T00:00:00.000Z");
		expect(store.getJob(ids[1])?.nextRunAt).toBe("2032-02-02T00:00:00.000Z");
	});
});

describe("migrateScheduledRows names", () => {
	const longLabel = "a".repeat(80);
	it.each([
		["Jira Sprint", "jira-sprint"],
		["-Nightly!", "nightly-"],
		[longLabel, longLabel.slice(0, 64)],
		["!!!", "job"],
	])("gives the row %p the name %p", async (label, name) => {
		const { dgHome, store, ids, paths } = await setup([{ label }]);

		await move(store, paths);

		expect(Object.keys(configOf(dgHome).jobs)).toEqual([name]);
		expect(store.getJob(ids[0])?.label).toBe(name);
		expect(rawJob(store, ids[0]).renamed_from).toBe(label);
	});

	it("keeps a valid label and leaves renamed_from empty", async () => {
		const { dgHome, store, ids, paths } = await setup([{ label: "good-1" }]);

		await move(store, paths);

		expect(Object.keys(configOf(dgHome).jobs)).toEqual(["good-1"]);
		expect(rawJob(store, ids[0]).renamed_from).toBeNull();
	});

	it("adds -2, then -3, for a label that another entry has, and keeps that entry", async () => {
		const bot = { continuous: true, argv: ["/b"], cwd: "/c" };
		const first = await setup([{ label: "bot" }], { bot });
		await move(first.store, first.paths);
		expect(Object.keys(configOf(first.dgHome).jobs).sort()).toEqual([
			"bot",
			"bot-2",
		]);
		expect(configOf(first.dgHome).jobs.bot).toEqual(bot);

		const second = await setup([{ label: "bot" }], {
			bot,
			"bot-2": { continuous: true, argv: ["/b"], cwd: "/c" },
		});
		await move(second.store, second.paths);
		expect(second.store.getJob(second.ids[0])?.label).toBe("bot-3");
		expect(configOf(second.dgHome).jobs.bot).toEqual(bot);
	});

	it("cuts the base so a suffixed name keeps 64 characters at most", async () => {
		const base = "a".repeat(64);
		const { dgHome, store, ids, paths } = await setup([{ label: base }], {
			[base]: { continuous: true, argv: ["/b"], cwd: "/c" },
		});

		await move(store, paths);

		const name = store.getJob(ids[0])?.label ?? "";
		expect(name).toBe(`${"a".repeat(62)}-2`);
		expect(Object.hasOwn(configOf(dgHome).jobs, name)).toBe(true);
	});
});

describe("migrateScheduledRows rows that cannot move", () => {
	const missing = () => join(workDir(), "gone");
	const corruptArgv = (store: ChatStore, id: string) =>
		rawRun(
			store,
			"UPDATE scheduled_jobs SET argv_tag = zeroblob(16) WHERE id = ?",
			id,
		);

	it.each([
		["an argv that does not decrypt", {}, corruptArgv],
		[
			"a cron text that is not valid",
			{ cronExpr: "not a cron", nextRunAt: FUTURE },
			undefined,
		],
		["a cwd that is gone", { cwd: missing() }, undefined],
		["an entry that fails parseJobEntry", { intervalMs: 0 }, undefined],
		["an interval that is not whole seconds", { intervalMs: 1500 }, undefined],
	] as const)(
		"leaves a row with %s in place and writes the mark",
		async (_cause, overrides, damage) => {
			const { dgHome, store, ids, paths } = await setup([
				{ label: "broken", ...overrides },
				{ label: "fine" },
			]);
			damage?.(store, ids[0]);

			await move(store, paths);

			const config = configOf(dgHome);
			expect(Object.keys(config.jobs)).toEqual(["fine"]);
			expect(config.jobsVersion).toBe(JOBS_VERSION);
			expect(isMigrated(config)).toBe(true);
			const raw = rawJob(store, ids[0]);
			expect(raw.moved_at).toBeNull();
			expect(raw.label).toBe("broken");
			expect(rawJob(store, ids[1]).moved_at).not.toBeNull();
		},
	);
});

describe("migrateScheduledRows marks and repeats", () => {
	it("holds the version 2 and the services mark 1", () => {
		expect(JOBS_VERSION).toBe(2);
		expect(SERVICES_MARK).toBe(1);
	});

	it("keeps the mark 1 after the services move while a row is not moved", async () => {
		const { dgHome, paths } = await setup([{ label: "waiting" }], {});
		writeFileSync(
			paths.daemonConfigPath,
			JSON.stringify({ services: { a: { argv: ["/b"], cwd: "/c" } } }),
		);

		migrateServicesKey(paths);

		const config = configOf(dgHome);
		expect(config.jobsVersion).toBe(SERVICES_MARK);
		expect(isMigrated(config)).toBe(false);
	});

	it("gives the mark 2 to a config with no services key and a store with no row", async () => {
		const { dgHome, store, paths } = await setup();

		await move(store, paths);

		expect(configOf(dgHome).jobsVersion).toBe(2);
	});

	it("moves nothing and writes no file on a second call", async () => {
		const { dgHome, store, paths } = await setup([{ label: "once" }]);
		await move(store, paths);
		const file = paths.daemonConfigPath;
		const bytes = readFileSync(file, "utf8");
		const old = new Date("2020-01-01T00:00:00.000Z");
		utimesSync(file, old, old);

		await move(store, paths);

		expect(readFileSync(file, "utf8")).toBe(bytes);
		expect(statSync(file).mtimeMs).toBe(old.getTime());
		expect(Object.keys(configOf(dgHome).jobs)).toEqual(["once"]);
	});

	it("gives one move for two calls at the same time", async () => {
		const { dgHome, store, ids, paths } = await setup([{ label: "twin" }]);
		const other = await openStoreAt(dgHome);
		stores.push(other);

		await Promise.all([move(store, paths), move(other, paths)]);

		expect(Object.keys(configOf(dgHome).jobs)).toEqual(["twin"]);
		expect(rawJob(store, ids[0]).moved_at).not.toBeNull();
		expect(store.getJob(ids[0])?.argv).toEqual([]);
	});
});

describe("migrateScheduledRows restart between steps", () => {
	posix(
		"finishes after a failed config write and writes one entry",
		async () => {
			if (process.getuid?.() === 0) return;
			const argv = ["jira", "issue", "list"];
			const { dgHome, store, ids, paths } = await setup([
				{ label: "resume", argv },
			]);
			const before = readFileSync(paths.daemonConfigPath, "utf8");
			chmodSync(paths.daemonConfigPath, 0o400);
			chmodSync(paths.daemonDir, 0o500);

			await move(store, paths).catch(() => {});

			chmodSync(paths.daemonDir, 0o700);
			chmodSync(paths.daemonConfigPath, 0o600);
			expect(readFileSync(paths.daemonConfigPath, "utf8")).toBe(before);
			expect(rawJob(store, ids[0]).moved_at).toBeNull();
			expect(store.getJob(ids[0])?.argv).toEqual(argv);

			await move(store, paths);

			expect(Object.keys(configOf(dgHome).jobs)).toEqual(["resume"]);
			expect(rawJob(store, ids[0]).moved_at).not.toBeNull();
			expect(store.getJob(ids[0])?.argv).toEqual([]);
		},
	);

	it("sets moved_at, clears the argv and writes no second entry after a stop behind the config write", async () => {
		const cwd = workDir();
		const argv = ["jira", "issue", "list"];
		const written = {
			argv,
			cwd,
			every: "15m",
			enabled: true,
			feed: true,
		};
		const { dgHome, store, ids, paths } = await setup(
			[{ label: "saved", argv, cwd }],
			{ saved: written },
		);

		await move(store, paths);

		expect(configOf(dgHome).jobs).toEqual({ saved: written });
		expect(rawJob(store, ids[0]).moved_at).not.toBeNull();
		expect(store.getJob(ids[0])?.argv).toEqual([]);
	});

	it("gives no second entry for a renamed row whose saved name is in the table", async () => {
		const cwd = workDir();
		const argv = ["jira", "issue", "list"];
		const written = { argv, cwd, every: "15m", enabled: true, feed: true };
		const { dgHome, store, ids, paths } = await setup(
			[{ label: "jira-sprint", argv, cwd }],
			{ "jira-sprint": written },
		);
		rawRun(
			store,
			"UPDATE scheduled_jobs SET renamed_from = ? WHERE id = ?",
			"Jira Sprint",
			ids[0],
		);

		await move(store, paths);

		expect(Object.keys(configOf(dgHome).jobs)).toEqual(["jira-sprint"]);
		expect(rawJob(store, ids[0]).moved_at).not.toBeNull();
		expect(rawJob(store, ids[0]).renamed_from).toBe("Jira Sprint");
		expect(store.getJob(ids[0])?.argv).toEqual([]);
	});

	it("logs the rename line for a renamed row that resumes", async () => {
		const cwd = workDir();
		const argv = ["jira", "issue", "list"];
		const written = { argv, cwd, every: "15m", enabled: true, feed: true };
		const { store, ids, paths } = await setup(
			[{ label: "jira-sprint", argv, cwd }],
			{ "jira-sprint": written },
		);
		rawRun(
			store,
			"UPDATE scheduled_jobs SET renamed_from = ? WHERE id = ?",
			"Jira Sprint",
			ids[0],
		);
		const lines: string[] = [];

		await Promise.resolve(
			migrateScheduledRows(store, paths, {
				info: (line) => lines.push(line),
				warn: () => {},
			}),
		);

		expect(lines).toEqual(['scheduled job "Jira Sprint" is now "jira-sprint"']);
	});
});
