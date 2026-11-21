import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelReviewPaths, createStateStore, readStateSnapshot, type EnvName, type StateStore } from "@dg/channel-review";
import { resolveDgPaths } from "@dg/common/node";
import { skillsEntry } from "./inbox-cli-harness";
import { mergeEnv } from "./module-call";

type Result = { code: number; stdout: string; stderr: string };

let cwd: string;
let dgHome: string;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "dg-channel-review-export-"));
	dgHome = join(cwd, "dg-home");
});

afterEach(() => {
	for (const child of children.splice(0)) child.kill();
	rmSync(cwd, { recursive: true, force: true });
});

const pathsFor = (env: EnvName) => channelReviewPaths(env, { env: { DG_HOME: dgHome } });
const importPath = (label: string) => join(dgHome, "state", "jobs", label, "import.json");
const readImport = (label: string) => JSON.parse(readFileSync(importPath(label), "utf8"));

async function run(args: string[], overrides: Record<string, string | undefined> = {}): Promise<Result> {
	const proc = Bun.spawn([process.execPath, skillsEntry, "channel-review", "export", ...args], {
		cwd,
		env: mergeEnv({ DG_HOME: dgHome, PATH: join(cwd, "empty-bin"), ...overrides }),
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), 30_000);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { code, stdout, stderr };
}

function seed(env: EnvName, fill: (store: StateStore) => void, clock?: () => Date): void {
	const store = createStateStore(pathsFor(env), clock);
	try {
		fill(store);
	} finally {
		store.close();
	}
}

function at(iso: string): () => Date {
	return () => new Date(iso);
}

function writeConfig(chats: unknown[]): void {
	const path = pathsFor("dev").configPath;
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({
			envs: {
				dev: { baseUrl: "https://relay.example.test/dev/api", awsProfile: "a", botName: "bot" },
				prod: { baseUrl: "https://relay.example.test/prod/api", awsProfile: "b", botName: "bot" },
			},
			chats,
			owner: { token: "!owner", email: "owner@example.com" },
			relay: { appName: "bot", secret: { id: "relay/chat", key: "RELAY__CHAT__SECRET", region: "us-east-1" } },
		}),
	);
}

function writeLegacyState(env: EnvName, body: Record<string, unknown>): void {
	const path = pathsFor(env).statePath;
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(body));
}

const PR = "https://github.com/example/tools/pull/";
const JOB = { messageId: "m3", chatId: "a", url: `${PR}3`, number: 3, startedAt: "2026-01-01T00:00:00.000Z", pid: 4242, pidStart: "x" };

function seedFull(env: EnvName): void {
	seed(env, (store) => {
		store.setLastEventId("a", `${env}-e1`);
		store.setLastEventId("b", `${env}-e2`);
		store.flush();
		store.markHandled("m3", "running", "a");
		store.markHandled("m1", "done", "a");
		store.markHandled("m2", "failed");
		store.setCurrent(JOB);
	});
}

describe("channel-review export", () => {
	test("writes version, cursors, handled and current for the env", async () => {
		seedFull("dev");

		const result = await run(["--env", "dev", "--label", "bot"]);

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(
			`exported channel-review dev state to ${importPath("bot")}: 3 handled, 2 chat cursors, current m3\n`,
		);
		const file = readImport("bot");
		expect(Object.keys(file)).toEqual(["version", "cursor", "handled", "current", "automation"]);
		expect(file.version).toBe(1);
		expect(file.cursor).toEqual({ a: "dev-e1", b: "dev-e2" });
		expect(file.current).toEqual(JOB);
		expect(file.handled.map((entry: { messageId: string }) => entry.messageId).sort()).toEqual(["m1", "m2", "m3"]);
		expect(new Set(file.handled.map((entry: { status: string }) => entry.status))).toEqual(new Set(["running", "done", "failed"]));
	});

	test("lists each handled message once in ascending at order and omits an absent chatId", async () => {
		seed("dev", (store) => store.markHandled("m-late", "done", "a"), at("2026-01-03T00:00:00.000Z"));
		seed("dev", (store) => {
			store.markHandled("m-b", "done");
			store.markHandled("m-a", "pending", "a");
		}, at("2026-01-02T00:00:00.000Z"));

		await run(["--env", "dev", "--label", "bot"]);

		const { handled } = readImport("bot");
		expect(handled).toEqual([
			{ messageId: "m-a", status: "pending", at: "2026-01-02T00:00:00.000Z", chatId: "a" },
			{ messageId: "m-b", status: "done", at: "2026-01-02T00:00:00.000Z" },
			{ messageId: "m-late", status: "done", at: "2026-01-03T00:00:00.000Z", chatId: "a" },
		]);
		expect(Object.keys(handled[0])).toEqual(["messageId", "status", "at", "chatId"]);
		expect(Object.keys(handled[1])).toEqual(["messageId", "status", "at"]);
	});

	test("exports a handled entry that is 30 hours old", async () => {
		seed("dev", (store) => store.markHandled("old", "done", "a"), () => new Date(Date.now() - 30 * 3_600_000));

		await run(["--env", "dev", "--label", "bot"]);

		expect(readImport("bot").handled.map((entry: { messageId: string }) => entry.messageId)).toEqual(["old"]);
	});

	test("matches the handled count and current job of the state snapshot", async () => {
		seedFull("dev");
		const snapshot = readStateSnapshot(pathsFor("dev"));

		await run(["--env", "dev", "--label", "bot"]);

		const file = readImport("bot");
		expect(file.handled).toHaveLength(Object.keys(snapshot.handled).length);
		expect(file.current).toEqual(snapshot.current);
	});

	test("writes null for current when no job runs", async () => {
		seed("dev", (store) => store.markHandled("m1", "done", "a"));

		await run(["--env", "dev", "--label", "bot"]);

		expect(readFileSync(importPath("bot"), "utf8")).toContain('"current": null');
		expect(readImport("bot").current).toBeNull();
	});

	test("writes the empty file for an env with no row and no legacy state", async () => {
		const result = await run(["--env", "dev", "--label", "bot"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(": 0 handled, 0 chat cursors, current none");
		expect(readImport("bot")).toEqual({
			version: 1,
			cursor: {},
			handled: [],
			current: null,
			automation: { blocked: {}, issues: {}, sinks: {}, prWatch: {}, deps: { lastRun: {} } },
		});
	});

	test("writes two files for two envs, each with its own state", async () => {
		seedFull("dev");
		seedFull("prod");

		await run(["--env", "prod", "--label", "bot-prod"]);
		await run(["--env", "dev", "--label", "bot-dev"]);

		expect(readImport("bot-prod").cursor).toEqual({ a: "prod-e1", b: "prod-e2" });
		expect(readImport("bot-dev").cursor).toEqual({ a: "dev-e1", b: "dev-e2" });
	});

	test("replaces an existing import.json on a second export", async () => {
		seed("dev", (store) => store.markHandled("m1", "done", "a"));
		await run(["--env", "dev", "--label", "bot"]);
		seed("dev", (store) => store.markHandled("m2", "done", "a"));

		await run(["--env", "dev", "--label", "bot"]);

		expect(readImport("bot").handled).toHaveLength(2);
		expect(readdirSync(join(dgHome, "state", "jobs", "bot"))).toEqual(["import.json"]);
	});

	test("reads the legacy state file when the schema has no channel-review table", async () => {
		writeLegacyState("dev", { lastEventIds: { a: "e1" }, handled: { m1: { status: "done", at: "2026-01-01T00:00:00.000Z", chatId: "a" } } });

		const result = await run(["--env", "dev", "--label", "bot"]);

		expect(result.code).toBe(0);
		expect(readImport("bot").cursor).toEqual({ a: "e1" });
		expect(readImport("bot").handled).toHaveLength(1);
	});

	test("creates the file with mode 0600 and the folder with mode 0700", async () => {
		if (process.platform === "win32") return;
		await run(["--env", "dev", "--label", "bot"]);

		expect(statSync(importPath("bot")).mode & 0o777).toBe(0o600);
		expect(statSync(join(dgHome, "state", "jobs", "bot")).mode & 0o777).toBe(0o700);
	});

	test("puts the file under DG_HOME state jobs for the label", async () => {
		await run(["--env", "dev", "--label", "bot"]);

		expect(resolveDgPaths({ env: { DG_HOME: dgHome } }).jobStateRoot).toBe(join(dgHome, "state", "jobs"));
		expect(existsSync(join(dgHome, "state", "jobs", "bot", "import.json"))).toBe(true);
	});
});

describe("channel-review export automation", () => {
	function seedAutomation(): void {
		seed("dev", (store) => {
			store.markBlocked(`${PR}7`, "m7", { comment: true, fun: false, spice: 2 }, "a");
			store.setIssue("ISSUE-1", { status: "seen", firstSeen: "2026-01-01T00:00:00.000Z" });
			store.updateSink("sentry", { cursor: "c-9", lastError: "boom", counts: { seen: 4 } });
			store.watchPr(`${PR}8`, { repo: "example/tools", kind: "fix" });
			store.recordDepsRun("example/tools", { windowStart: "2026-01-01T00:00:00.000Z", result: "ok" });
			store.recordFixStart();
		});
	}

	test("holds blocked, issues, sinks, prWatch and deps below automation as the state has them", async () => {
		seedAutomation();
		const snapshot = readStateSnapshot(pathsFor("dev"));

		await run(["--env", "dev", "--label", "bot"]);

		const { automation } = readImport("bot");
		expect(Object.keys(automation)).toEqual(["blocked", "issues", "sinks", "prWatch", "deps"]);
		expect(automation.blocked).toEqual(JSON.parse(JSON.stringify(snapshot.blocked)));
		expect(Object.values(automation.blocked)[0]).toMatchObject({ messageId: "m7", chatId: "a", options: { comment: true, fun: false, spice: 2 } });
		expect(automation.issues).toEqual(JSON.parse(JSON.stringify(snapshot.issues)));
		expect(automation.sinks).toEqual({ sentry: { cursor: "c-9", lastError: "boom", counts: { seen: 4 } } });
		expect(automation.prWatch).toEqual(JSON.parse(JSON.stringify(snapshot.prWatch)));
		expect(automation.deps).toEqual({ lastRun: JSON.parse(JSON.stringify(snapshot.deps.lastRun)) });
		expect(Object.keys(automation.deps)).toEqual(["lastRun"]);
	});

	test("writes no running key and no fixStarts key at any level", async () => {
		seedAutomation();
		seed("dev", (store) => store.setRunning("m9", JOB));

		await run(["--env", "dev", "--label", "bot"]);

		const text = readFileSync(importPath("bot"), "utf8");
		expect(text).not.toContain('"running"');
		expect(text).not.toContain('"fixStarts"');
		expect(Object.keys(readImport("bot"))).toEqual(["version", "cursor", "handled", "current", "automation"]);
	});
});

describe("channel-review export read-only guarantee", () => {
	test("leaves daemon.db, its wal file and the state row unchanged", async () => {
		seedFull("dev");
		const { dbPath } = pathsFor("dev");
		const read = (path: string) => (existsSync(path) ? readFileSync(path) : Buffer.alloc(0));
		const before = { db: read(dbPath), wal: read(`${dbPath}-wal`), row: JSON.stringify(readStateSnapshot(pathsFor("dev"))) };

		const result = await run(["--env", "dev", "--label", "bot"]);

		expect(result.code).toBe(0);
		expect(read(dbPath).equals(before.db)).toBe(true);
		expect(read(`${dbPath}-wal`).equals(before.wal)).toBe(true);
		expect(JSON.stringify(readStateSnapshot(pathsFor("dev")))).toBe(before.row);
	});
});

describe("channel-review export legacy cursor", () => {
	test("uses the first configured chat id for a legacy lastEventId", async () => {
		writeConfig([{ id: "c1" }]);
		writeLegacyState("dev", { lastEventId: "e1" });

		const result = await run(["--env", "dev", "--label", "bot"]);

		expect(result.code).toBe(0);
		expect(readImport("bot").cursor).toEqual({ c1: "e1" });
	});

	const NO_CHAT = "channel-review export: the dev state has a legacy cursor and no chat id is configured";

	test.each([
		["no config file", () => undefined],
		["a first chat with a topic and no id", () => writeConfig([{ topic: "Team Reviews" }])],
		["a config that cannot be read", () => {
			mkdirSync(join(pathsFor("dev").configPath, ".."), { recursive: true });
			writeFileSync(pathsFor("dev").configPath, "{not json");
		}],
	])("exits 1 and writes no file with %s", async (_name, arrange) => {
		arrange();
		writeLegacyState("dev", { lastEventId: "e1" });

		const result = await run(["--env", "dev", "--label", "bot"]);

		expect(result.code).toBe(1);
		expect(result.stderr.trim()).toBe(NO_CHAT);
		expect(existsSync(join(dgHome, "state", "jobs"))).toBe(false);
	});
});

describe("channel-review export argument errors", () => {
	const BAD_LABEL = `channel-review export: "--label" must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit`;

	test.each(["Bad/Label", "UPPER", "-lead", "a".repeat(65), "../x"])("rejects the label %p and creates no directory", async (label) => {
		const result = await run(["--env", "dev", "--label", label]);

		expect(result.code).toBe(1);
		expect(result.stderr.trim()).toBe(BAD_LABEL);
		expect(existsSync(join(dgHome, "state"))).toBe(false);
	});

	test("rejects an env other than dev or prod with the commander text", async () => {
		const result = await run(["--env", "stage", "--label", "bot"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("error: option '--env <env>' argument 'stage' is invalid");
		expect(existsSync(join(dgHome, "state"))).toBe(false);
	});

	test("requires --env", async () => {
		const result = await run(["--label", "bot"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("required option '--env <env>' not specified");
	});

	test("requires --label", async () => {
		const result = await run(["--env", "dev"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("required option '--label <label>' not specified");
	});
});

describe("channel-review export daemon liveness", () => {
	function writePid(env: EnvName, pid: number): void {
		const { pidPath } = pathsFor(env);
		mkdirSync(join(pidPath, ".."), { recursive: true });
		writeFileSync(pidPath, JSON.stringify({ pid }));
	}

	function spawnSleeper(args: string[]): number {
		const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)", ...args], { stdout: "ignore", stderr: "ignore" });
		children.push(child);
		return child.pid;
	}

	test("refuses a live daemon, names the stop command and creates nothing", async () => {
		seedFull("dev");
		const pid = spawnSleeper(["channel-review", "run", "--env", "dev"]);
		writePid("dev", pid);

		const result = await run(["--env", "dev", "--label", "bot"], { PATH: "/usr/bin:/bin" });

		expect(result.code).toBe(1);
		expect(result.stderr.trim()).toBe(
			`channel-review export: the dev daemon is running (pid ${pid}) — stop it first with dg channel-review stop --env dev`,
		);
		expect(existsSync(join(dgHome, "state", "jobs"))).toBe(false);
	});

	test("refuses a live daemon before it reads the config or the state", async () => {
		mkdirSync(join(pathsFor("dev").configPath, ".."), { recursive: true });
		writeFileSync(pathsFor("dev").configPath, "{not json");
		writeLegacyState("dev", { lastEventId: "e1" });
		const pid = spawnSleeper(["channel-review", "run", "--env", "dev"]);
		writePid("dev", pid);

		const result = await run(["--env", "dev", "--label", "bot"], { PATH: "/usr/bin:/bin" });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`the dev daemon is running (pid ${pid})`);
		expect(result.stderr).not.toContain("legacy cursor");
	});

	test("goes on when the pid file names a dead process", async () => {
		const dead = Bun.spawnSync([process.execPath, "-e", "0"]);
		writePid("dev", dead.pid ?? 2 ** 22 - 1);

		const result = await run(["--env", "dev", "--label", "bot"], { PATH: "/usr/bin:/bin" });

		expect(result.code).toBe(0);
	});

	test("goes on when the pid file names a process that is not the channel-review daemon", async () => {
		writePid("dev", spawnSleeper(["other", "job"]));

		const result = await run(["--env", "dev", "--label", "bot"], { PATH: "/usr/bin:/bin" });

		expect(result.code).toBe(0);
	});

	test("goes on for dev when only the prod daemon runs", async () => {
		writePid("prod", spawnSleeper(["channel-review", "run", "--env", "prod"]));

		const result = await run(["--env", "dev", "--label", "bot"], { PATH: "/usr/bin:/bin" });

		expect(result.code).toBe(0);
	});
});

describe("channel-review export layout block", () => {
	test("prints the block text, exits 78 and opens no database when two daemon folders hold data", async () => {
		const home = join(cwd, "home");
		const paths = resolveDgPaths({ platform: process.platform, homeDir: home, env: {} });
		for (const folder of [join(paths.legacyHome, "daemon"), paths.daemonDir]) {
			mkdirSync(folder, { recursive: true });
			writeFileSync(join(folder, "key"), "k");
		}

		const result = await run(["--env", "dev", "--label", "bot"], { DG_HOME: undefined, HOME: home });

		expect(result.stderr).toContain("two daemon folders hold data");
		expect(result.code).toBe(78);
		expect(existsSync(paths.dbPath)).toBe(false);
		expect(existsSync(join(paths.stateDir, "jobs"))).toBe(false);
	});
	test("prints the block text, exits 1 and opens no database when a live writer keeps the config in the old folder", async () => {
		const home = join(cwd, "home");
		const paths = resolveDgPaths({ platform: process.platform, homeDir: home, env: {} });
		const legacy = join(paths.legacyHome, "channel-review", "config.json");
		mkdirSync(join(legacy, ".."), { recursive: true });
		writeFileSync(legacy, "{}");
		writeFileSync(join(legacy, "..", "daemon.dev.pid"), JSON.stringify({ pid: process.pid }));

		const result = await run(["--env", "dev", "--label", "bot"], { DG_HOME: undefined, HOME: home });

		expect(result.stderr).toContain(legacy);
		expect(result.code).toBe(1);
		expect(existsSync(paths.dbPath)).toBe(false);
		expect(existsSync(join(paths.stateDir, "jobs"))).toBe(false);
	});
});

describe("channel-review export failures", () => {
	function expectOneLine(result: Result): void {
		expect(result.code).toBe(1);
		const lines = result.stderr.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith("channel-review export:");
		expect(result.stderr).not.toContain("    at ");
		expect(existsSync(importPath("bot"))).toBe(false);
	}

	test("reports a daemon.db of a newer build on one line", async () => {
		seedFull("dev");
		const { Database } = await import("bun:sqlite");
		const db = new Database(pathsFor("dev").dbPath);
		db.run("PRAGMA user_version = 9999");
		db.close();

		expectOneLine(await run(["--env", "dev", "--label", "bot"]));
	});

	test("reports a state that parseState refuses on one line", async () => {
		seedFull("dev");
		const { Database } = await import("bun:sqlite");
		const db = new Database(pathsFor("dev").dbPath);
		db.run("UPDATE channel_review_state SET state_json = ?", [JSON.stringify({ handled: "nope" })]);
		db.close();

		expectOneLine(await run(["--env", "dev", "--label", "bot"]));
	});

	test("reports a daemon.db that cannot be read on one line", async () => {
		const { dbPath } = pathsFor("dev");
		mkdirSync(join(dbPath, ".."), { recursive: true });
		writeFileSync(dbPath, "this is not a database file at all");

		expectOneLine(await run(["--env", "dev", "--label", "bot"]));
	});

	test("reports a write that fails on one line", async () => {
		mkdirSync(join(dgHome, "state"), { recursive: true });
		writeFileSync(join(dgHome, "state", "jobs"), "a file where the folder belongs");

		expectOneLine(await run(["--env", "dev", "--label", "bot"]));
	});
});
