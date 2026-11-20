import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { updateMarks } from "../../src/jobs/sources";
import {
	allocatePort,
	freshTempDir,
	killDaemonByPidFile,
	spawnServe,
	stopServe,
	waitForDaemonExit,
	waitForHealth,
} from "../utils/daemon-harness";
import { configPathOf, writeConfigFile } from "../utils/service-daemon";
import {
	fetchJobRows,
	homeTracker,
	jobsTable,
	lines,
	pathsOf,
	postJob,
	readConfigFile,
	runCli,
	SLEEPER_ARGV,
	seedJobs,
	sleeperEntry,
	waitUntil,
} from "./job-cli-helpers";
import {
	addFixture,
	changeBlock,
	jobDeclaration,
	makeRepo,
	QUICK_SCRIPT,
	runJob,
	RUN_SCRIPT,
	type Sandbox,
	sandbox,
} from "./job-source-kit";

const homes = homeTracker();
const procs: ReturnType<typeof spawnServe>[] = [];
afterEach(async () => {
	for (const proc of procs.splice(0)) await stopServe(proc).catch(() => {});
	await homes.cleanup();
});

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function bootAgain(dgHome: string) {
	const port = allocatePort();
	const proc = spawnServe(dgHome, port);
	procs.push(proc);
	await waitForHealth(port, 8000);
	return port;
}

describe("daemon boot after enable and disable", () => {
	it("starts the job at boot with no job start call after enable", async () => {
		const { dgHome, port, proc } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));
		const enable = await runCli(dgHome, ["job", "enable", "x"], { port });
		expect(enable.code).toBe(0);
		await stopServe(proc);
		await waitForDaemonExit(dgHome);

		const next = await bootAgain(dgHome);

		await waitUntil(async () => (await fetchJobRows(dgHome, next))[0]?.state === "running");
	});

	it("leaves the job stopped at boot after disable", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {
			x: sleeperEntry(freshTempDir("job-cwd"), { enabled: true }),
		});
		const disable = await runCli(dgHome, ["job", "disable", "x"]);
		expect(disable.code).toBe(0);

		const port = await bootAgain(dgHome);

		await Bun.sleep(1500);
		expect((await fetchJobRows(dgHome, port))[0].state).toBe("stopped");
	});

	it("starts an enabled job at boot (control for the disable case)", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {
			x: sleeperEntry(freshTempDir("job-cwd"), { enabled: true }),
		});

		const port = await bootAgain(dgHome);

		await waitUntil(async () => (await fetchJobRows(dgHome, port))[0]?.state === "running");
	});
});

describe("job restart of a running job", () => {
	it("runs with a new pid, and enabled is as it was", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd, { enabled: true }),
		}));
		expect((await postJob(port, "x", "start")).ok).toBe(true);
		const pidBefore = (await fetchJobRows(dgHome, port))[0].pid as number;
		const configBefore = readFileSync(configPathOf(dgHome), "utf8");

		const result = await runCli(dgHome, ["job", "restart", "x"], { port });

		expect(result.code).toBe(0);
		const status = lines(result.stdout).at(-1) ?? "";
		const pidAfter = Number(/pid (\d+)/.exec(status)?.[1]);
		expect(status).toMatch(/^x +running/);
		expect(pidAfter).not.toBe(pidBefore);
		await waitUntil(() => !isAlive(pidBefore));
		expect((await fetchJobRows(dgHome, port))[0].pid).toBe(pidAfter);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(configBefore);
	});
});

describe("a config with no jobsVersion", () => {
	const legacy = (dgHome: string) =>
		writeConfigFile(dgHome, {
			pinnedOrigin: "p",
			services: { x: { argv: SLEEPER_ARGV, cwd: dgHome } },
		});

	type Table = ReturnType<typeof jobsTable>;
	const cases: [string, (cwd: string) => string[], (table: Table) => void][] = [
		[
			"add",
			(cwd) => [
				"job",
				"add",
				"--name",
				"y",
				"--continuous",
				"--cwd",
				cwd,
				"--",
				process.execPath,
				"-e",
				"1",
			],
			(table) => {
				expect(table.x).toBeDefined();
				expect(table.y).toBeDefined();
			},
		],
		[
			"enable",
			() => ["job", "enable", "x"],
			(table) => expect(table.x).toBeDefined(),
		],
		[
			"disable",
			() => ["job", "disable", "x"],
			(table) => expect(table.x).toBeDefined(),
		],
		[
			"update",
			() => ["job", "update", "x", "--every", "30m"],
			(table) => expect(table.x).toBeDefined(),
		],
		[
			"remove",
			() => ["job", "remove", "x"],
			(table) => expect(table.x).toBeUndefined(),
		],
	];

	for (const [verb, args, expectTable] of cases) {
		it(`${verb} starts the daemon one time, waits for the mark, then continues`, async () => {
			const dgHome = homes.fresh();
			legacy(dgHome);
			expect(existsSync(pathsOf(dgHome).pidPath)).toBe(false);

			try {
				const result = await runCli(dgHome, args(dgHome));

				expect(result.code).toBe(0);
				expect(existsSync(pathsOf(dgHome).pidPath)).toBe(true);
				const config = readConfigFile(dgHome) as Record<string, unknown>;
				expect(config.jobsVersion).toBe(2);
				expectTable(jobsTable(config));
			} finally {
				killDaemonByPidFile(dgHome);
			}
		});
	}
});

describe("job --credential and the registry marks", () => {
	const box = sandbox(["tool", "sh"]);
	let sb: Sandbox;
	let cwd: string;
	beforeEach(() => {
		sb = box.create();
		cwd = freshTempDir("job-cwd");
	});
	afterEach(() => box.cleanup());

	const table = () =>
		JSON.parse(readFileSync(sb.paths.daemonConfigPath, "utf8")).jobs as Record<string, Record<string, unknown>>;
	const registry = () =>
		existsSync(sb.paths.jobSourcesPath)
			? (JSON.parse(readFileSync(sb.paths.jobSourcesPath, "utf8")) as Record<string, Record<string, unknown>>)
			: {};
	const add = (name: string, flags: string[] = []) =>
		runJob(["add", "--name", name, "--cwd", cwd, "--continuous", ...flags, "--", process.execPath], sb.deps());
	const FILES = { "bin/run": RUN_SCRIPT, "bin/quick": QUICK_SCRIPT };
	const BLOCK_TEXT = 'declares this in its "dg" block';

	it("writes the credentials list and sets the grant to the job name", async () => {
		const result = await add("x", ["--credential", "api-key"]);

		expect(result.code).toBe(0);
		expect(table().x.credentials).toEqual(["api-key"]);
		expect(table().x.grant).toBe("x");
	});

	it("keeps each repeated --credential in order and lower-cases it", async () => {
		await add("x", ["--credential", "Api-Key", "--credential", "other", "--credential", "api-key"]);

		expect(table().x.credentials).toEqual(["api-key", "other"]);
	});

	it("adds a credential at update and keeps the earlier ones", async () => {
		await add("x", ["--credential", "api-key"]);

		const result = await runJob(["update", "x", "--credential", "other"], sb.deps());

		expect(result.code).toBe(0);
		expect(table().x.credentials).toEqual(["api-key", "other"]);
		expect(table().x.grant).toBe("x");
		expect(result.stdout).toContain("changed credentials");
		expect(result.stdout).toContain("next: dg job setup x");
	});

	it("adds credentials at update to a job that has none", async () => {
		await add("x");

		await runJob(["update", "x", "--credential", "api-key"], sb.deps());

		expect(table().x.credentials).toEqual(["api-key"]);
		expect(table().x.grant).toBe("x");
	});

	it("refuses a name that is empty before the = and writes nothing", async () => {
		const result = await add("x", ["--credential", "=API_KEY"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--credential takes a name");
		expect(table().x).toBeUndefined();
	});

	it("refuses a credential name that is not valid", async () => {
		const result = await add("x", ["--credential", "a b"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("credentials");
		expect(table().x).toBeUndefined();
	});

	it("writes credentials and grant for a scheduled add", async () => {
		const result = await runJob(
			["add", "--name", "s", "--cwd", cwd, "--every", "15m", "--credential", "k", "--", process.execPath],
			sb.deps(),
		);

		expect(result.code).toBe(0);
		expect(table().s.credentials).toEqual(["k"]);
		expect(table().s.grant).toBe("s");
	});

	it("lets update add a credential to a job that already has its own grant", async () => {
		await add("x", ["--credential", "k"]);

		const result = await runJob(["update", "x", "--credential", "m"], sb.deps());

		expect(result.code).toBe(0);
	});

	it("refuses update --credential for a job whose grant is another prefix", async () => {
		await add("x", ["--credential", "k"]);
		const config = JSON.parse(readFileSync(sb.paths.daemonConfigPath, "utf8"));
		config.jobs.x.grant = "other";
		writeFileSync(sb.paths.daemonConfigPath, JSON.stringify(config));

		const result = await runJob(["update", "x", "--credential", "m"], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job update: the job uses the credential prefix "other", not its own name');
		expect(table().x.credentials).toEqual(["k"]);
	});

	it("refuses update --credential when another job uses the name as its grant", async () => {
		await add("x");
		const config = JSON.parse(readFileSync(sb.paths.daemonConfigPath, "utf8"));
		config.jobs.y = { continuous: true, argv: [process.execPath], cwd, credentials: ["k"], grant: "x" };
		writeFileSync(sb.paths.daemonConfigPath, JSON.stringify(config));

		const result = await runJob(["update", "x", "--credential", "m"], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job update: "x" is already used as a credential prefix by y');
		expect(result.stderr).toContain("already used as a credential prefix");
	});

	it("refuses a reserved job name with --credential", async () => {
		const result = await add("db", ["--credential", "k"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("reserved");
	});

	it("refuses update --credential for a job whose name is reserved", async () => {
		const config = JSON.parse(readFileSync(sb.paths.daemonConfigPath, "utf8"));
		config.jobs.db = { continuous: true, argv: [process.execPath], cwd };
		writeFileSync(sb.paths.daemonConfigPath, JSON.stringify(config));

		const result = await runJob(["update", "db", "--credential", "k"], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("reserved");
		expect(table().db.credentials).toBeUndefined();
	});

	it("refuses --credential with a URL and starts no git process", async () => {
		const result = await runJob(["add", "https://example.invalid/r.git", "--credential", "k"], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(BLOCK_TEXT);
		expect(sb.gitCalls).toEqual([]);
	});

	it("refuses update --credential on a repository job and starts no git process", async () => {
		await addFixture(sb, makeRepo({ dg: jobDeclaration("bot"), files: FILES }));
		sb.gitCalls.length = 0;

		const result = await runJob(["update", "bot", "--credential", "k"], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(BLOCK_TEXT);
		expect(sb.gitCalls).toEqual([]);
	});

	it("refuses a git source named like a command job that has credentials", async () => {
		await add("tools", ["--credential", "k"]);
		const repo = makeRepo({ dg: jobDeclaration("bot"), files: FILES });

		const result = await runJob(["add", `file://${repo.dir}`, "--name", "tools", "--yes"], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('"tools" is already used as a credential prefix');
	});

	it("refuses a command job named like a git source", async () => {
		await addFixture(sb, makeRepo({ dg: jobDeclaration("bot"), files: FILES }));

		const result = await add("tools", ["--credential", "k"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('"tools" is already used as a credential prefix');
	});

	it("deletes the command record at remove, so a new add of the name has no old mark", async () => {
		await add("x", ["--credential", "k"]);
		updateMarks(sb.paths, "x", { prefixAccepted: true, setupDone: "x" });
		expect(registry().x).toEqual({ kind: "command", prefixAccepted: true, setupDone: ["x"] });

		const removed = await runJob(["remove", "x"], sb.deps());
		const again = await add("x", ["--credential", "k"]);

		expect(removed.code).toBe(0);
		expect(again.code).toBe(0);
		expect(registry().x).toBeUndefined();
	});

	it("deletes the command record of a scheduled job at remove", async () => {
		await add("x", ["--credential", "k"]);
		const config = JSON.parse(readFileSync(sb.paths.daemonConfigPath, "utf8"));
		delete config.jobs.x.continuous;
		config.jobs.x.every = "15m";
		writeFileSync(sb.paths.daemonConfigPath, JSON.stringify(config));
		updateMarks(sb.paths, "x", { setupDone: "x" });

		const removed = await runJob(["remove", "x"], sb.deps());

		expect(removed.code).toBe(0);
		expect(registry().x).toBeUndefined();
	});

	it("keeps the marks of a repository record when update moves the commit", async () => {
		const repo = makeRepo({ dg: jobDeclaration("bot"), files: FILES });
		await addFixture(sb, repo);
		updateMarks(sb.paths, "bot", { prefixAccepted: true, setupDone: "bot" });
		changeBlock(repo, jobDeclaration("bot"), { "bin/extra": "x" });

		const result = await runJob(["update", "bot", "--yes"], sb.deps());

		expect(result.code).toBe(0);
		expect(registry().tools.prefixAccepted).toBe(true);
		expect(registry().tools.setupDone).toEqual(["bot"]);
	});

	it("keeps the marks of a repository record when update changes the block", async () => {
		const repo = makeRepo({ dg: jobDeclaration("bot"), files: FILES });
		await addFixture(sb, repo);
		updateMarks(sb.paths, "bot", { prefixAccepted: true, setupDone: "bot" });
		changeBlock(
			repo,
			{ jobs: { bot: { argv: ["./bin/quick"], continuous: true, credentials: ["token"] } } },
			FILES,
		);

		const result = await runJob(["update", "bot", "--yes"], sb.deps());

		expect(result.code).toBe(0);
		expect(registry().tools.prefixAccepted).toBe(true);
		expect(registry().tools.setupDone).toEqual(["bot"]);
	});

	describe("a changed credential source", () => {
		const declared = (secretId: string, prompt = "Token") => ({
			jobs: { bot: { argv: ["./bin/run"], continuous: true, credentials: ["token"] } },
			credentials: {
				token: { prompt, source: { type: "aws-secretsmanager", secretId, region: "us-east-1" } },
			},
		});

		it("removes the job from the setupDone list of a repository record and says to run setup", async () => {
			const repo = makeRepo({ dg: declared("prod/a"), files: FILES });
			await addFixture(sb, repo);
			updateMarks(sb.paths, "bot", { prefixAccepted: true, setupDone: "bot" });
			changeBlock(repo, declared("prod/b"), FILES);

			const result = await runJob(["update", "bot", "--yes"], sb.deps());

			expect(result.code).toBe(0);
			expect(registry().tools.setupDone).toEqual([]);
			expect(registry().tools.prefixAccepted).toBe(true);
			expect(result.stdout.split("\n")).toContain("next: dg job setup bot");
		});

		it("keeps the setupDone mark when only the prompt of the credential changes", async () => {
			const repo = makeRepo({ dg: declared("prod/a"), files: FILES });
			await addFixture(sb, repo);
			updateMarks(sb.paths, "bot", { prefixAccepted: true, setupDone: "bot" });
			changeBlock(repo, declared("prod/a", "Another prompt"), FILES);

			const result = await runJob(["update", "bot", "--yes"], sb.deps());

			expect(result.code).toBe(0);
			expect(registry().tools.setupDone).toEqual(["bot"]);
			expect(result.stdout.split("\n")).not.toContain("next: dg job setup bot");
		});
	});

	it("drops a removed job from the setupDone list of a repository record", async () => {
		const repo = makeRepo({
			dg: {
				jobs: {
					a: { argv: ["./bin/run"], continuous: true },
					b: { argv: ["./bin/run"], continuous: true },
				},
			},
			files: FILES,
		});
		await addFixture(sb, repo);
		updateMarks(sb.paths, "a", { setupDone: "a" });
		updateMarks(sb.paths, "b", { setupDone: "b" });

		await runJob(["remove", "a"], sb.deps());

		expect(registry().tools.setupDone).toEqual(["b"]);
	});

	it("leaves a command record out of the repository paths: list and update treat the job as a command job", async () => {
		await add("x", ["--credential", "k"]);
		updateMarks(sb.paths, "x", { setupDone: "x" });

		const listed = await runJob(["list"], sb.deps());
		const updated = await runJob(["update", "x", "--every", "30m"], sb.deps());

		expect(listed.stdout).toContain("x");
		expect(updated.code).toBe(0);
		expect(registry().x).toEqual({ kind: "command", setupDone: ["x"] });
	});
});
