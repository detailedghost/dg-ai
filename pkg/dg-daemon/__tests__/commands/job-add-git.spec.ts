import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { jobSourceDir, jobStateDir, writePidFileAtomic } from "@dg/common/node";
import { servicePidFile } from "../../src/services/supervisor";
import { ENTRY, freshTempDir, subprocessEnv, trackChild } from "../utils/daemon-harness";
import { configPathOf } from "../utils/service-daemon";
import {
	homeTracker,
	jobsTable,
	lines,
	logFileOf,
	pathsOf,
	postJob,
	readConfigFile,
	runCli,
	seedJobs,
	runUntilRefused,
	waitUntil,
} from "./job-cli-helpers";
import {
	commit,
	fileUrl,
	gitIn,
	makeRepo,
	QUICK_SCRIPT,
	type Repo,
	type RepoFile,
} from "./job-source-kit";

setDefaultTimeout(30_000);

const homes = homeTracker();
afterEach(() => homes.cleanup());

const SHA = /^[0-9a-f]{40}$/;
const ENV_ROOT = `#!${process.execPath}\n`;

const script = (body: string): RepoFile => ({
	content: `${ENV_ROOT}${body}\n`,
	executable: true,
});

const SERVER = script(
	[
		'const fs = require("node:fs");',
		'fs.writeFileSync(`${process.env.DG_SERVICE_STATE_DIR}/cwd.txt`, process.cwd());',
		"console.log(`state=${process.env.DG_SERVICE_STATE_DIR}`);",
		"setTimeout(() => {}, 600000);",
	].join("\n"),
);

const TWO_JOBS = {
	jobs: {
		"bot-a": { argv: ["./bin/run"], continuous: true, credentials: ["token", "webhook"] },
		"bot-b": { argv: ["./bin/run"], continuous: true, credentials: ["token", "extra"] },
	},
	credentials: { token: { prompt: "Token" }, extra: { required: false } },
};

const PLAIN_JOB = { jobs: { bot: { argv: ["./bin/run"], continuous: true } } };

const repoOf = (dg: unknown, files: Record<string, RepoFile> = {}): Repo =>
	makeRepo({ dg, files: { "bin/run": SERVER, "bin/quick": QUICK_SCRIPT, ...files } });

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

const add = (dgHome: string, repo: Repo, extra: string[] = [], port?: number) =>
	runCli(dgHome, ["job", "add", fileUrl(repo), "--name", "tools", ...extra], { port });

function preparedHome(jobs: Record<string, unknown> = {}) {
	const dgHome = homes.fresh();
	seedJobs(dgHome, jobs);
	return dgHome;
}

describe("job add of a repository through the CLI", () => {
	it("adds two jobs from a file:// repository and stores the record", async () => {
		const dgHome = preparedHome();
		const repo = repoOf(TWO_JOBS);

		const result = await add(dgHome, repo, ["--yes"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`sha: ${repo.sha}`);
		expect(result.stdout).toContain("credential prefix: tools/");
		expect(lines(result.stdout).slice(-3)).toEqual([
			`added jobs from "tools" at ${repo.sha.slice(0, 12)}: bot-a, bot-b`,
			"next: dg job enable bot-a",
			"next: dg job enable bot-b",
		]);
		const paths = pathsOf(dgHome);
		const table = jobsTable(readConfigFile(dgHome));
		expect(Object.keys(table)).toEqual(["bot-a", "bot-b"]);
		expect(table["bot-a"].grant).toBe("tools");
		expect(table["bot-a"].cwd).toBe(jobSourceDir(paths, "tools"));
		const registry = JSON.parse(readFileSync(paths.jobSourcesPath, "utf8"));
		expect(registry.tools.sha).toBe(repo.sha);
		expect(registry.tools.sha).toBe(gitIn(jobSourceDir(paths, "tools"), ["rev-parse", "HEAD"]));
		expect(registry.tools.credentials).toEqual(TWO_JOBS.credentials);
		expect(registry.tools.url).toBe(fileUrl(repo));
	});

	it("prints the request and exits 1 with no terminal and no --yes", async () => {
		const dgHome = preparedHome();
		const repo = repoOf(TWO_JOBS);
		const before = read(configPathOf(dgHome));

		const result = await add(dgHome, repo);

		const paths = pathsOf(dgHome);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain(`sha: ${repo.sha}`);
		expect(result.stderr).toContain(
			"job add: consent needs a terminal — run this command in a terminal yourself, or give --yes",
		);
		expect(existsSync(jobSourceDir(paths, "tools"))).toBe(false);
		expect(existsSync(paths.jobSourcesPath)).toBe(false);
		expect(read(configPathOf(dgHome))).toBe(before);
	});

	it("pins the commit of a tag when the default branch has a newer commit", async () => {
		const dgHome = preparedHome();
		const repo = repoOf(TWO_JOBS);
		const tagged = commit(repo, { tag: "v1" });
		const newer = commit(repo, {});

		const result = await runCli(
			dgHome,
			["job", "add", `${fileUrl(repo)}@v1`, "--name", "tools", "--yes"],
		);

		expect(result.code).toBe(0);
		const registry = JSON.parse(readFileSync(pathsOf(dgHome).jobSourcesPath, "utf8"));
		expect(registry.tools.sha).toBe(tagged);
		expect(registry.tools.sha).not.toBe(newer);
		expect(registry.tools.ref).toBe("v1");
	});

	it("keeps pinnedOrigin and a command job", async () => {
		const dgHome = preparedHome({
			cmd: { continuous: true, argv: [process.execPath, "-e", "1"], cwd: freshTempDir("cwd") },
		});
		const before = readConfigFile(dgHome) as { pinnedOrigin: string; jobs: Record<string, unknown> };

		const result = await add(dgHome, repoOf(TWO_JOBS), ["--yes"]);

		expect(result.code).toBe(0);
		const after = readConfigFile(dgHome) as typeof before;
		expect(after.pinnedOrigin).toBe(before.pinnedOrigin);
		expect(after.jobs.cmd).toEqual(before.jobs.cmd);
	});

	it("refuses a daemon config that is not valid JSON and leaves no clone", async () => {
		const dgHome = preparedHome();
		writeFileSync(configPathOf(dgHome), "{ not json");

		const result = await add(dgHome, repoOf(TWO_JOBS), ["--yes"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(configPathOf(dgHome));
		expect(existsSync(jobSourceDir(pathsOf(dgHome), "tools"))).toBe(false);
	});

	it("refuses a registry file that is not a JSON object before git runs", async () => {
		const dgHome = preparedHome();
		const paths = pathsOf(dgHome);
		mkdirSync(paths.jobsDir, { recursive: true });
		writeFileSync(paths.jobSourcesPath, "[]");

		const result = await add(dgHome, repoOf(TWO_JOBS), ["--yes"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(paths.jobSourcesPath);
		expect(existsSync(jobSourceDir(paths, "tools"))).toBe(false);
	});

	it("refuses an ext:: URL with no git process and no marker", async () => {
		const dgHome = preparedHome();
		const marker = join(freshTempDir("marker"), "touched");

		const result = await runCli(dgHome, ["job", "add", `ext::sh -c "touch ${marker}"`, "--yes"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job add: the URL scheme "ext::" is not allowed');
		expect(existsSync(marker)).toBe(false);
	});

	it("gives the unknown-option error for --accept", async () => {
		const dgHome = preparedHome();
		const result = await runCli(dgHome, ["job", "add", "--accept", "x", "file:///x/y"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("unknown option '--accept'");
	});

	it("still adds a command job with --cwd after --", async () => {
		const dgHome = preparedHome();
		const result = await runCli(dgHome, [
			"job", "add", "--name", "x", "--continuous", "--cwd", freshTempDir("cwd"), "--", process.execPath, "-e", "1",
		]);
		expect(result.code).toBe(0);
	});
});

describe("job add of a repository: env file and build", () => {
	it("points the entry at the state folder, runs the build, and starts with the env file in place", async () => {
		const { dgHome, port } = await homes.boot();
		const repo = repoOf(
			{
				jobs: {
					bot: { argv: ["./bin/run"], continuous: true, envFile: "bot.env" },
				},
				build: ["./bin/make"],
			},
			{
				"bin/make": script('require("node:fs").writeFileSync("built.marker", "ok");'),
			},
		);
		const paths = pathsOf(dgHome);

		const result = await add(dgHome, repo, ["--yes"], port);

		const envFile = join(jobStateDir(paths, "bot"), "bot.env");
		expect(result.code).toBe(0);
		expect(jobsTable(readConfigFile(dgHome)).bot.envFile).toBe(envFile);
		expect(readFileSync(join(jobSourceDir(paths, "tools"), "built.marker"), "utf8")).toBe("ok");
		expect(lines(result.stdout).at(-1)).toBe(
			`next: create ${envFile} with mode 600 before you start bot`,
		);

		writeFileSync(envFile, "A=1\n", { mode: 0o600 });
		const started = await postJob(port, "bot", "start");
		expect(started.ok).toBe(true);
		await waitUntil(() =>
			(read(logFileOf(dgHome, "bot")) ?? "").includes(`state=${jobStateDir(paths, "bot")}`),
		);
	});

	it("gives an entry that starts with the clone as its working directory", async () => {
		const { dgHome, port } = await homes.boot();
		const repo = repoOf(PLAIN_JOB);
		const paths = pathsOf(dgHome);

		expect((await add(dgHome, repo, ["--yes"], port)).code).toBe(0);
		const started = await postJob(port, "bot", "start");

		expect(started.ok).toBe(true);
		const cwdFile = join(jobStateDir(paths, "bot"), "cwd.txt");
		await waitUntil(() => existsSync(cwdFile));
		expect(readFileSync(cwdFile, "utf8")).toBe(realpathSync(jobSourceDir(paths, "tools")));
		expect((await postJob(port, "bot", "stop")).ok).toBe(true);
	});

	it("leaves no clone, entry or record when the build fails", async () => {
		const dgHome = preparedHome();
		const repo = repoOf(
			{ ...TWO_JOBS, build: ["./bin/fail"] },
			{ "bin/fail": script("process.exit(3);") },
		);
		const before = read(configPathOf(dgHome));

		const result = await add(dgHome, repo, ["--yes"]);

		const paths = pathsOf(dgHome);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job add: build failed (exit 3): ./bin/fail");
		expect(existsSync(jobSourceDir(paths, "tools"))).toBe(false);
		expect(existsSync(paths.jobSourcesPath)).toBe(false);
		expect(read(configPathOf(dgHome))).toBe(before);
	});

	it("stops before the question for a missing required program", async () => {
		const dgHome = preparedHome();
		const repo = repoOf({ ...TWO_JOBS, requires: ["no-such-tool-xyz"] });

		const result = await add(dgHome, repo);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"job add: required executable(s) do not resolve on PATH: no-such-tool-xyz",
		);
		expect(result.stderr).not.toContain("consent needs a terminal");
	});
});

describe.each([
	["SIGINT", 130],
	["SIGTERM", 143],
	["SIGHUP", 129],
] as const)("a %s during the build", (signal, code) => {
	it("stops the build, removes the clone and changes no file", async () => {
		const dgHome = preparedHome();
		const repo = repoOf(
			{ ...TWO_JOBS, build: ["./bin/hang"] },
			{
				"bin/hang": script(
					[
						'const fs = require("node:fs");',
						'fs.writeFileSync("build.pid", String(process.pid));',
						"setTimeout(() => {}, 600000);",
					].join("\n"),
				),
			},
		);
		const paths = pathsOf(dgHome);
		const clone = jobSourceDir(paths, "tools");
		const before = read(configPathOf(dgHome));
		const proc = trackChild(
			Bun.spawn(
				[process.execPath, ENTRY, "job", "add", fileUrl(repo), "--name", "tools", "--yes"],
				{ env: subprocessEnv(dgHome, 0), stdout: "pipe", stderr: "pipe" },
			),
		);
		const pidFile = join(clone, "build.pid");
		await waitUntil(() => existsSync(pidFile) && /^\d+$/.test(readFileSync(pidFile, "utf8")), 12000);
		const buildPid = Number(readFileSync(pidFile, "utf8"));

		proc.kill(signal);
		const exit = await proc.exited;

		expect(exit).toBe(code);
		expect(existsSync(clone)).toBe(false);
		expect(existsSync(paths.jobSourcesPath)).toBe(false);
		expect(read(configPathOf(dgHome))).toBe(before);
		await waitUntil(() => {
			try {
				process.kill(buildPid, 0);
				return false;
			} catch {
				return true;
			}
		});
	});
});

describe("job remove of a repository job through the CLI", () => {
	async function added(dgHome: string, port?: number) {
		const repo = repoOf(TWO_JOBS);
		const result = await add(dgHome, repo, ["--yes"], port);
		expect(result.code).toBe(0);
		return repo;
	}

	it("removes two jobs and leaves no clone and no record but the state folders", async () => {
		const dgHome = preparedHome({
			cmd: { continuous: true, argv: [process.execPath, "-e", "1"], cwd: freshTempDir("cwd") },
		});
		const before = jobsTable(readConfigFile(dgHome));
		await added(dgHome);
		const paths = pathsOf(dgHome);

		const first = await runCli(dgHome, ["job", "remove", "bot-a"]);
		const second = await runCli(dgHome, ["job", "remove", "bot-b"]);

		expect(first.code).toBe(0);
		expect(lines(first.stdout)).toEqual([
			'removed job "bot-a"',
			`kept state: ${jobStateDir(paths, "bot-a")}`,
			"kept credentials below tools/",
		]);
		expect(second.code).toBe(0);
		expect(existsSync(jobSourceDir(paths, "tools"))).toBe(false);
		expect(JSON.parse(readFileSync(paths.jobSourcesPath, "utf8"))).toEqual({});
		expect(jobsTable(readConfigFile(dgHome))).toEqual(before);
		expect(statSync(jobStateDir(paths, "bot-a")).isDirectory()).toBe(true);
		expect(statSync(jobStateDir(paths, "bot-b")).isDirectory()).toBe(true);
	});

	it("refuses a running job and changes no file", async () => {
		const { dgHome, port } = await homes.boot();
		expect((await add(dgHome, repoOf(PLAIN_JOB), ["--yes"], port)).code).toBe(0);
		expect((await postJob(port, "bot", "start")).ok).toBe(true);
		const paths = pathsOf(dgHome);
		const before = [read(configPathOf(dgHome)), read(paths.jobSourcesPath)];

		const result = await runCli(dgHome, ["job", "remove", "bot"], { port });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'job "bot" is running — stop it first with dg job stop bot',
		);
		expect([read(configPathOf(dgHome)), read(paths.jobSourcesPath)]).toEqual(before);
		expect(existsSync(jobSourceDir(paths, "tools"))).toBe(true);
		await postJob(port, "bot", "stop");
	});

	it("refuses a job in backoff and changes no file", async () => {
		const { dgHome, port } = await homes.boot();
		const repo = repoOf(
			{ jobs: { crash: { argv: ["./bin/crash"], continuous: true } } },
			{ "bin/crash": script("process.exit(1);") },
		);
		expect((await add(dgHome, repo, ["--yes"], port)).code).toBe(0);
		expect((await postJob(port, "crash", "start")).ok).toBe(true);
		const before = read(configPathOf(dgHome));
		const result = await runUntilRefused(
			() => runCli(dgHome, ["job", "remove", "crash"], { port }),
			"is backoff",
		);

		expect(result.stderr).toContain('job "crash" is backoff');
		expect(read(configPathOf(dgHome))).toBe(before);
	});

	it("refuses when a daemon pid is alive and does not answer", async () => {
		const dgHome = preparedHome();
		await added(dgHome);
		writePidFileAtomic(pathsOf(dgHome), {
			pid: process.pid,
			port: 1,
			instanceId: crypto.randomUUID(),
			versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
		});
		const paths = pathsOf(dgHome);
		const before = [read(configPathOf(dgHome)), read(paths.jobSourcesPath)];

		const result = await runCli(dgHome, ["job", "remove", "bot-a"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("does not answer");
		expect([read(configPathOf(dgHome)), read(paths.jobSourcesPath)]).toEqual(before);
	});

	it("refuses when the instance pid file names a live process", async () => {
		const dgHome = preparedHome();
		await added(dgHome);
		const paths = pathsOf(dgHome);
		const instance = servicePidFile(paths.daemonDir, "bot-a");
		mkdirSync(dirname(instance), { recursive: true });
		writeFileSync(instance, String(process.pid));
		const before = [read(configPathOf(dgHome)), read(paths.jobSourcesPath)];

		const result = await runCli(dgHome, ["job", "remove", "bot-a"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`still runs as pid ${process.pid}`);
		expect([read(configPathOf(dgHome)), read(paths.jobSourcesPath)]).toEqual(before);
	});

	it("removes a record that has no entry", async () => {
		const dgHome = preparedHome();
		await added(dgHome);
		const paths = pathsOf(dgHome);
		const config = readConfigFile(dgHome) as { jobs: Record<string, unknown> };
		writeFileSync(
			configPathOf(dgHome),
			JSON.stringify({ ...config, jobs: {} }),
		);

		const first = await runCli(dgHome, ["job", "remove", "bot-a"]);
		const second = await runCli(dgHome, ["job", "remove", "bot-b"]);

		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(JSON.parse(readFileSync(paths.jobSourcesPath, "utf8"))).toEqual({});
		expect(existsSync(jobSourceDir(paths, "tools"))).toBe(false);
	});

	it("exits 1 for an unknown job", async () => {
		const dgHome = preparedHome();
		const result = await runCli(dgHome, ["job", "remove", "ghost"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no job named "ghost"');
	});
});

describe("job update and list of a repository job", () => {
	it("refuses a mode flag on a repository job and names the dg block", async () => {
		const dgHome = preparedHome();
		expect((await add(dgHome, repoOf(TWO_JOBS), ["--yes"])).code).toBe(0);

		const result = await runCli(dgHome, ["job", "update", "bot-a", "--timeout", "5m"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'job update: the repository declares this in its "dg" block',
		);
	});

	it("lists source@sha and gives the json keys", async () => {
		const dgHome = preparedHome();
		const repo = repoOf(TWO_JOBS);
		expect((await add(dgHome, repo, ["--yes"])).code).toBe(0);

		const text = await runCli(dgHome, ["job", "list"]);
		const json = await runCli(dgHome, ["job", "list", "--json"]);

		expect(text.stdout).toContain(`tools@${repo.sha.slice(0, 12)}`);
		const row = (JSON.parse(json.stdout) as { jobs: Record<string, unknown>[] }).jobs[0];
		expect(row.source).toBe("tools");
		expect(row.ref).toBeNull();
		expect(row.sha).toMatch(SHA);
	});
});

describe("where git runs", () => {
	const SRC = join(import.meta.dir, "../../src");
	const walk = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
			entry.isDirectory()
				? walk(join(dir, entry.name))
				: entry.name.endsWith(".ts")
					? [join(dir, entry.name)]
					: [],
		);
	const GIT_COMMAND = /["'`]git["'`]\s*[,\])]|\bgit\s+(clone|checkout|rev-parse|show|ls-tree|fetch)\b/;

	it("keeps git out of the server, the launcher and the supervisor", () => {
		const files = [
			...walk(join(SRC, "server")),
			join(SRC, "jobs/launcher.ts"),
			join(SRC, "services/supervisor.ts"),
		];
		for (const file of files) {
			expect(readFileSync(file, "utf8")).not.toMatch(GIT_COMMAND);
		}
	});

	it("loads the source modules from jobs.ts with a lazy import only", () => {
		const text = readFileSync(join(SRC, "commands/jobs.ts"), "utf8");
		const staticImports = text.match(/^import (?!type\b)[^;]*?from "[^"]+";$/gms) ?? [];
		for (const line of staticImports) {
			expect(line).not.toMatch(/job-source|jobs\/sources|jobs\/declaration/);
		}
		expect(text).toContain('import("./job-source")');
	});

	it("keeps child_process and git code out of the declaration reader", () => {
		const text = readFileSync(join(SRC, "jobs/declaration.ts"), "utf8");
		expect(text).not.toMatch(/child_process|Bun\.spawn|job-source/);
	});
});
