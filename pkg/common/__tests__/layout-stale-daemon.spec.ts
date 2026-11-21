import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { assertNotBlocked, ensureLayout, LAYOUT_TABLE, type LayoutHooks } from "@dg/common/node/layout";
import { planLayout, snapshot } from "@dg/common/node/layout-work";
import * as errors from "../src/errors";
import { DgCliError } from "../src/errors";
import { makeTempDir, removeTempDirs } from "./utils/temp-dirs";

const posix = describe.skipIf(process.platform === "win32");

const RENAME_SENTENCE = "Move the folder that you do not want to a different name, then run the command again";
const STALE_CONFIG = '{"services":{"stale":{"port":1}}}';
const LEGACY_CONFIG = '{"hooks":{"legacy":true}}';

let paths: DgPaths;
let lines: string[];

beforeEach(() => {
	paths = resolveDgPaths({ platform: "linux", homeDir: join(makeTempDir("dg-stale-daemon-"), "home"), env: {} });
	lines = [];
});

afterEach(removeTempDirs);

const legacyAt = (...parts: string[]): string => join(paths.legacyHome, ...parts);
const livePid = (): string => JSON.stringify({ pid: process.pid });
const twoUsedText = (from: string, to: string): string =>
	`dg: two daemon folders hold data: ${from} and ${to}. dg does not choose one and does not merge them. ${RENAME_SENTENCE}`;
const asideLine = (dest: string, to: string): string =>
	`dg: set aside ${dest} as ${to}; dg copied no file from it, and dg clean keeps it`;

function put(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
}

function daemonDb(file: string, rows: number): void {
	mkdirSync(dirname(file), { recursive: true });
	const db = new Database(file);
	db.run("CREATE TABLE crypto_meta (id INTEGER PRIMARY KEY, key_id TEXT)");
	for (let row = 0; row < rows; row++) db.run("INSERT INTO crypto_meta (id, key_id) VALUES (?, ?)", [row + 1, `k${row}`]);
	db.close();
}

function tree(root: string): Record<string, string> {
	if (!existsSync(root)) return {};
	return Object.fromEntries(
		readdirSync(root, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => {
				const file = join(entry.parentPath, entry.name);
				return [file.slice(root.length), readFileSync(file).toString("hex")];
			}),
	);
}

const bothTrees = (): Record<string, Record<string, string>> => ({
	legacy: tree(legacyAt("daemon")),
	target: tree(paths.daemonDir),
});

const hooksOf = (extra: Partial<LayoutHooks> = {}): LayoutHooks => ({
	log: (line: string) => void lines.push(line),
	launchers: true,
	...extra,
});

const run = (extra: Partial<LayoutHooks> = {}, target: DgPaths = paths) => ensureLayout(target, hooksOf(extra));
const fresh = (): DgPaths => ({ ...paths });

function planOf(name: string, extra: Partial<LayoutHooks> = {}) {
	const hooks = hooksOf(extra);
	const step = planLayout(LAYOUT_TABLE, snapshot(paths, hooks), hooks).steps.find((candidate) => candidate.name === name);
	if (!step) throw new Error(`no plan step ${name}`);
	return step;
}

const outcomeOf = (result: Awaited<ReturnType<typeof run>>, name: string) =>
	(result as unknown as Record<string, { kind: string; [key: string]: unknown }>)[name];

function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

function seedStale(): void {
	put(legacyAt("bin", "dg-skills"), "#!/bin/sh\n");
	daemonDb(legacyAt("daemon", "daemon.db"), 1);
	put(legacyAt("daemon", "key"), "legacy-key");
	put(legacyAt("daemon", "credentials.db"), "legacy-credentials");
	put(legacyAt("daemon", "config.json"), LEGACY_CONFIG);
	put(join(paths.daemonDir, "config.json"), STALE_CONFIG);
}

function seedTwoUsed(): void {
	seedStale();
	daemonDb(join(paths.daemonDir, "daemon.db"), 1);
}

function seedTwoUsedWithSiblings(): void {
	seedTwoUsed();
	put(legacyAt("daemon", "logs", "daemon-1.log"), "log\n");
	put(legacyAt("agents", "sessions", "s1.json"), "{}");
	put(legacyAt("agents", "assets", "a1.bin"), "a");
	put(legacyAt("agents", "js.md"), "persona");
}

posix("daemon entry plan", () => {
	test("plans setAside, not keepUsed, for a used legacy daemon.db and a target that holds only config.json", () => {
		seedStale();

		expect(planOf("daemon").action.kind).toBe("setAside");
	});

	test("plans absent with no legacy daemon folder", () => {
		put(legacyAt("bin", "dg-skills"), "x");
		put(join(paths.daemonDir, "key"), "k");

		expect(planOf("daemon").action.kind).toBe("absent");
	});

	test("plans move for a legacy folder and no target", () => {
		daemonDb(legacyAt("daemon", "daemon.db"), 1);

		expect(planOf("daemon").action.kind).toBe("move");
	});

	test("plans setAside for a legacy folder and an empty target", () => {
		daemonDb(legacyAt("daemon", "daemon.db"), 1);
		mkdirSync(paths.daemonDir, { recursive: true });

		expect(planOf("daemon").action.kind).toBe("setAside");
	});

	test.each(["key", "credentials.db"])("plans block two-used for used folders when the target holds %s", (file) => {
		daemonDb(legacyAt("daemon", "daemon.db"), 1);
		put(join(paths.daemonDir, file), "x");

		expect(planOf("daemon").action).toEqual({ kind: "block", reason: "two-used" });
	});

	test("plans block two-used for a used legacy daemon.db and a used target daemon.db", () => {
		seedTwoUsed();

		expect(planOf("daemon").action).toEqual({ kind: "block", reason: "two-used" });
	});

	test("plans keepUsed for a used target when the legacy folder holds no key, credentials or used daemon.db", () => {
		put(legacyAt("daemon", "config.json"), LEGACY_CONFIG);
		daemonDb(join(paths.daemonDir, "daemon.db"), 1);

		expect(planOf("daemon").action.kind).toBe("keepUsed");
	});

	test("plans keepUsed for a legacy folder that holds only logs and a target that holds only config.json", () => {
		put(legacyAt("daemon", "logs", "daemon-1.log"), "log\n");
		put(join(paths.daemonDir, "config.json"), STALE_CONFIG);

		expect(planOf("daemon").action.kind).toBe("keepUsed");
	});

	test("plans keepUsed for a legacy daemon.db with no row and a target that holds only config.json", () => {
		daemonDb(legacyAt("daemon", "daemon.db"), 0);
		put(join(paths.daemonDir, "config.json"), STALE_CONFIG);

		expect(planOf("daemon").action.kind).toBe("keepUsed");
	});

	test("reads a pending record before the two-used check", () => {
		seedTwoUsed();
		put(legacyAt(".pending-removal.json"), JSON.stringify([{ name: "daemon", from: legacyAt("daemon"), to: paths.daemonDir }]));

		expect(planOf("daemon").action.kind).toBe("retryPending");
	});

	test("plans without throwing when the legacy daemon path is a file", () => {
		put(legacyAt("daemon"), "not a folder");
		put(join(paths.daemonDir, "config.json"), STALE_CONFIG);

		expect(planOf("daemon").action.kind).toBe("keepUsed");
	});

	test("plans without throwing when the legacy daemon path is a link", () => {
		put(legacyAt("elsewhere", "daemon.db"), "x");
		symlinkSync(legacyAt("elsewhere"), legacyAt("daemon"));
		put(join(paths.daemonDir, "config.json"), STALE_CONFIG);

		expect(planOf("daemon").action.kind).toBe("keepUsed");
	});
});

posix("daemon target that is not a folder", () => {
	test("keeps a target that is a file when the legacy folder is used", () => {
		put(legacyAt("daemon", "key"), "legacy-key");
		put(paths.daemonDir, "not a folder");

		expect(planOf("daemon").action.kind).toBe("keepUsed");
	});

	test("keeps a target that is a link to a used folder when the legacy folder is used", () => {
		put(legacyAt("daemon", "key"), "legacy-key");
		put(legacyAt("elsewhere", "key"), "other-key");
		mkdirSync(dirname(paths.daemonDir), { recursive: true });
		symlinkSync(legacyAt("elsewhere"), paths.daemonDir);

		expect(planOf("daemon").action.kind).toBe("keepUsed");
	});
});

posix("stale target set aside", () => {
	test("puts the legacy daemon.db in the target and the old target content in the set-aside folder", async () => {
		seedStale();
		const legacyDb = readFileSync(legacyAt("daemon", "daemon.db")).toString("hex");

		const result = await run();

		const outcome = outcomeOf(result, "daemon");
		expect(outcome?.kind).toBe("setAside");
		expect(String(outcome?.asideTo)).toMatch(/\.empty-\d+$/);
		expect(readFileSync(join(paths.daemonDir, "daemon.db")).toString("hex")).toBe(legacyDb);
		expect(readFileSync(join(paths.daemonDir, "key"), "utf8")).toBe("legacy-key");
		expect(readFileSync(join(paths.daemonDir, "credentials.db"), "utf8")).toBe("legacy-credentials");
		expect(readFileSync(join(String(outcome?.asideTo), "config.json"), "utf8")).toBe(STALE_CONFIG);
	});

	test("keeps the live config.json equal to the legacy file and copies no key of the stale file into it", async () => {
		seedStale();

		await run();

		const live = readFileSync(join(paths.daemonDir, "config.json"), "utf8");
		expect(live).toBe(LEGACY_CONFIG);
		expect(live).not.toContain("services");
	});

	test("leaves the stale services table in the set-aside folder only", async () => {
		seedStale();

		const result = await run();

		const holders = [paths.daemonDir, String(outcomeOf(result, "daemon")?.asideTo)].filter((folder) =>
			readFileSync(join(folder, "config.json"), "utf8").includes("services"),
		);
		expect(holders).toEqual([String(outcomeOf(result, "daemon")?.asideTo)]);
	});

	test("prints the no-file-copied line naming the set-aside folder when the target held a file", async () => {
		seedStale();

		const result = await run();

		expect(lines).toEqual([asideLine(paths.daemonDir, String(outcomeOf(result, "daemon")?.asideTo))]);
	});

	test("keeps the line of master for an empty target", async () => {
		daemonDb(legacyAt("daemon", "daemon.db"), 1);
		mkdirSync(paths.daemonDir, { recursive: true });

		const result = await run();

		expect(lines).toEqual([
			`dg: set aside unused ${paths.daemonDir} as ${String(outcomeOf(result, "daemon")?.asideTo)}; dg clean removes it`,
		]);
	});

	test("plans absent for daemon on a second start and moves nothing", async () => {
		seedStale();
		await run();
		const after = bothTrees();

		const second = await run({}, fresh());

		expect(outcomeOf(second, "daemon")?.kind).toBe("absent");
		expect(bothTrees()).toEqual(after);
	});

	test("blocks with live-writer when a live legacy daemon has no daemon.stop hook", async () => {
		seedStale();
		put(legacyAt("daemon", "daemon.pid"), livePid());

		const result = await run();

		expect(outcomeOf(result, "daemon")).toMatchObject({ kind: "blocked", reason: "live-writer" });
	});

	test("stops a live legacy daemon through daemon.stop before the set-aside", async () => {
		seedStale();
		put(legacyAt("daemon", "daemon.pid"), livePid());
		let stops = 0;

		const result = await run({
			"daemon.stop": async () => {
				stops++;
				return "stopped" as const;
			},
		});

		expect(stops).toBe(1);
		expect(outcomeOf(result, "daemon")).toMatchObject({ kind: "setAside", stopped: true });
	});
});

posix("two used daemon folders", () => {
	test("blocks with the two-used text and leaves every file name and byte of both folders as before", async () => {
		seedTwoUsed();
		const before = bothTrees();

		const result = await run();

		expect(outcomeOf(result, "daemon")).toMatchObject({
			kind: "blocked",
			reason: "two-used",
			fix: twoUsedText(legacyAt("daemon"), paths.daemonDir),
		});
		expect(bothTrees()).toEqual(before);
	});

	test("prints the text one time for the run", async () => {
		seedTwoUsedWithSiblings();

		await run();

		expect(lines.filter((line) => line === twoUsedText(legacyAt("daemon"), paths.daemonDir))).toHaveLength(1);
	});

	test("blocks sessions, assets, daemon-logs and personas with the reason two-used and the daemon text", async () => {
		seedTwoUsedWithSiblings();

		const result = await run();

		for (const name of ["sessions", "assets", "daemon-logs", "personas"]) {
			expect(outcomeOf(result, name)).toMatchObject({
				kind: "blocked",
				reason: "two-used",
				fix: twoUsedText(legacyAt("daemon"), paths.daemonDir),
			});
		}
		expect(existsSync(legacyAt("agents", "sessions", "s1.json"))).toBe(true);
		expect(existsSync(legacyAt("daemon", "logs", "daemon-1.log"))).toBe(true);
	});

	test("changes the plan of no other entry", async () => {
		seedTwoUsedWithSiblings();
		put(legacyAt("skills", "jot", "SKILL.md"), "# jot\n");
		put(legacyAt("proto", "demo", "index.html"), "p");

		const result = await run();

		expect(outcomeOf(result, "skills")?.kind).toBe("moved");
		expect(outcomeOf(result, "proto")?.kind).toBe("moved");
	});

	test("throws a DgCliError with the text and exit code 78 from assertNotBlocked for daemon and assets", async () => {
		seedTwoUsedWithSiblings();
		await run();

		for (const name of ["daemon", "assets"] as const) {
			const error = thrown(() => assertNotBlocked(paths, name));
			expect(error).toBeInstanceOf(DgCliError);
			expect((error as DgCliError).message).toBe(twoUsedText(legacyAt("daemon"), paths.daemonDir));
			expect((error as DgCliError).exitCode).toBe(78);
		}
		expect((errors as Record<string, unknown>).EXIT_LAYOUT_BLOCKED).toBe(78);
	});

	test("keeps the exit code 1 for a live-writer block", async () => {
		daemonDb(legacyAt("daemon", "daemon.db"), 1);
		put(legacyAt("daemon", "daemon.pid"), livePid());
		await run();

		const error = thrown(() => assertNotBlocked(paths, "daemon"));

		expect((error as DgCliError).exitCode).toBe(1);
	});

	test("reports two-used, calls no stop hook and keeps logs in place when a live daemon runs in the legacy folder", async () => {
		seedTwoUsedWithSiblings();
		put(legacyAt("daemon", "daemon.pid"), livePid());
		let stops = 0;

		const result = await run({
			"daemon.stop": async () => {
				stops++;
				return "stopped" as const;
			},
		});

		expect(outcomeOf(result, "daemon")).toMatchObject({ kind: "blocked", reason: "two-used" });
		expect(stops).toBe(0);
		expect(existsSync(legacyAt("daemon", "logs", "daemon-1.log"))).toBe(true);
	});

	test("plans absent after the owner renames the legacy folder", async () => {
		seedTwoUsed();
		await run();
		renameSync(legacyAt("daemon"), legacyAt("daemon-old"));

		const next = await run({}, fresh());

		expect(outcomeOf(next, "daemon")?.kind).toBe("absent");
	});

	test("moves the legacy folder in after the owner renames the target", async () => {
		seedTwoUsed();
		await run();
		renameSync(paths.daemonDir, `${paths.daemonDir}-old`);

		const next = await run({}, fresh());

		expect(outcomeOf(next, "daemon")?.kind).toBe("moved");
		expect(readFileSync(join(paths.daemonDir, "key"), "utf8")).toBe("legacy-key");
	});
});

describe("two-used text", () => {
	test("is built from the exported rename sentence", async () => {
		const { blockedText, TWO_USED_RENAME } = (await import("@dg/common/node/layout")) as unknown as {
			blockedText: (input: Record<string, unknown>) => string;
			TWO_USED_RENAME: string;
		};

		expect(TWO_USED_RENAME).toBe(RENAME_SENTENCE);
		expect(blockedText({ reason: "two-used", from: "/a", to: "/b" })).toBe(twoUsedText("/a", "/b"));
	});
});

