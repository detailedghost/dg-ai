import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { jobStateDir } from "@dg/common/node";
import { freshTempDir } from "../utils/daemon-harness";
import {
	BIN_RUN,
	FAKE_BUN,
	makeFolder,
	makeScript,
	readConfig,
	readRegistry,
	runJob,
	type Sandbox,
	sandbox,
	withBun,
} from "./job-source-kit";

const box = sandbox(["tool", "sh"]);
let sb: Sandbox;
const savedHome = process.env.HOME;

afterEach(() => {
	box.cleanup();
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
});

const add = (args: string[], over: Parameters<typeof withBun>[1] = {}) =>
	runJob(["add", ...args], withBun(sb, over));

const refused = async (args: string[], text: string, over: Parameters<typeof withBun>[1] = {}) => {
	const result = await add(args, over);
	expect(result.code).toBe(1);
	expect(result.stderr).toContain(text);
	return result;
};

const block = (...names: string[]) => ({
	jobs: Object.fromEntries(
		names.map((name) => [name, { argv: ["./bin/run"], continuous: true }]),
	),
});

describe("job add of a local file", () => {
	it("writes the entry of a ts file through the bun of the seam and starts no git process", async () => {
		sb = box.create();
		const file = makeScript("poll.ts");

		const result = await add([file, "--every", "15m"]);

		expect(result.code).toBe(0);
		const real = realpathSync(file);
		const entry = readConfig(sb).jobs.poll;
		expect(entry).toEqual({ argv: [FAKE_BUN, real], cwd: dirname(real), every: "15m" });
		expect(entry).not.toHaveProperty("grant");
		expect(sb.gitCalls).toEqual([]);
		expect(result.stdout).toContain(`added job "poll" from ${real}`);
		expect(result.stdout).toContain("next: dg job enable poll");
		expect(existsSync(jobStateDir(sb.paths, "poll"))).toBe(true);
		expect(readRegistry(sb).poll).toEqual({
			kind: "path",
			path: real,
			jobs: ["poll"],
			credentials: {},
		});
	});

	it("says in one line that a change of the script needs no command", async () => {
		sb = box.create();

		const result = await add([makeScript("poll.ts"), "--every", "15m"]);

		expect(result.stdout).toMatch(/edit the script[^\n]*no dg command/i);
	});

	it("lists the credential and sets the grant to the job name", async () => {
		sb = box.create();

		const result = await add([makeScript("poll.ts"), "--every", "15m", "--credential", "api-key"]);

		expect(result.code).toBe(0);
		const entry = readConfig(sb).jobs.poll;
		expect(entry.credentials).toEqual(["api-key"]);
		expect(entry.grant).toBe("poll");
	});

	it("stores the real path of an executable file as argv[0] with the continuous key", async () => {
		sb = box.create();
		const file = makeScript("run.sh", "#!/bin/sh\nexit 0\n", { executable: true });

		const result = await add([file, "--continuous"]);

		expect(result.code).toBe(0);
		const entry = readConfig(sb).jobs.run;
		expect(entry.argv).toEqual([realpathSync(file)]);
		expect(entry.continuous).toBe(true);
	});

	it("prefers the execute bit over the extension", async () => {
		sb = box.create();
		const file = makeScript("tool.ts", "#!/bin/sh\nexit 0\n", { executable: true });

		await add([file, "--every", "1h"]);

		expect(readConfig(sb).jobs.tool.argv).toEqual([realpathSync(file)]);
	});

	it("refuses a file that is neither executable nor a script and writes nothing", async () => {
		sb = box.create();
		const file = makeScript("notes.txt", "hello");

		await refused([file, "--continuous"], `job add: ${realpathSync(file)} is not executable — run chmod +x, or use dg job add --name <name> --cwd <dir> <mode> -- <command>`);

		expect(readConfig(sb).jobs).toEqual({});
		expect(existsSync(sb.paths.jobSourcesPath)).toBe(false);
	});

	it("refuses a file with no mode flag", async () => {
		sb = box.create();
		await refused([makeScript("poll.ts")], "job add: give one of --continuous, --schedule or --every");
	});

	it("refuses two mode flags", async () => {
		sb = box.create();
		await refused(
			[makeScript("poll.ts"), "--continuous", "--every", "5m"],
			"job add: give one of --continuous, --schedule or --every",
		);
	});

	it("refuses a file name that fails the name rule and accepts --name", async () => {
		sb = box.create();
		const file = makeScript("Poll_Job.ts");

		await refused([file, "--every", "15m"], 'job add: cannot use "Poll_Job" as a job name — give one with --name');
		const result = await add([file, "--every", "15m", "--name", "poll-job"]);

		expect(result.code).toBe(0);
		expect(Object.keys(readConfig(sb).jobs)).toEqual(["poll-job"]);
	});

	it("refuses a --name that fails the name rule", async () => {
		sb = box.create();
		const result = await refused([makeScript("poll.ts"), "--every", "15m", "--name", "Bad_Name"], "job add:");
		expect(result.stderr).toMatch(/--name/);
	});

	it("refuses a reserved job name", async () => {
		sb = box.create();
		await refused([makeScript("pw.ts"), "--every", "15m", "--credential", "x"], "reserved name");
	});

	it("expands ~ and stores the real path below the home folder", async () => {
		sb = box.create();
		const home = realpathSync(freshTempDir("job-home"));
		mkdirSync(join(home, "jobs"));
		const file = makeScript("poll.ts", "", { dir: join(home, "jobs") });
		process.env.HOME = home;

		const result = await add(["~/jobs/poll.ts", "--every", "15m"]);

		expect(result.code).toBe(0);
		expect(readConfig(sb).jobs.poll.argv).toEqual([FAKE_BUN, realpathSync(file)]);
	});

	it("refuses ~user", async () => {
		sb = box.create();
		await refused(["~root/x.ts", "--every", "15m"], "job add: only ~ and ~/ are supported");
	});

	it("exits 1 for a path that does not exist", async () => {
		sb = box.create();
		const missing = join(freshTempDir("job-none"), "gone.ts");
		await refused([missing, "--every", "15m"], `job add: no file or folder at ${missing}`);
	});

	it("stores the real path of a link and says so", async () => {
		sb = box.create();
		const target = makeScript("real.ts");
		const link = join(freshTempDir("job-link"), "poll.ts");
		symlinkSync(target, link);

		const result = await add([link, "--every", "15m"]);

		expect(result.code).toBe(0);
		expect(readConfig(sb).jobs.poll.argv).toEqual([FAKE_BUN, realpathSync(target)]);
		expect(result.stdout).toContain(`stored real path ${realpathSync(target)}`);
	});

	it("passes the arguments after a bare -- to the script", async () => {
		sb = box.create();
		const file = makeScript("run.sh", "#!/bin/sh\n", { executable: true });

		const result = await add([file, "--continuous", "--", "--verbose"]);

		expect(result.code).toBe(0);
		expect(readConfig(sb).jobs.run.argv).toEqual([realpathSync(file), "--verbose"]);
	});

	it("stores the absolute bun path of the seam for a ts file", async () => {
		sb = box.create();
		const file = makeScript("poll.ts");

		await add([file, "--every", "15m"], { bun: "/custom/bin/bun" });

		expect((readConfig(sb).jobs.poll.argv as string[])[0]).toBe("/custom/bin/bun");
	});

	it("refuses a ts file when no bun is installed and writes nothing", async () => {
		sb = box.create();
		const file = makeScript("poll.ts");

		await refused(
			[file, "--every", "15m"],
			`job add: bun is not installed — it is necessary to run ${realpathSync(file)}`,
			{ bun: null },
		);

		expect(readConfig(sb).jobs).toEqual({});
	});

	it("refuses --cwd and writes nothing", async () => {
		sb = box.create();
		await refused(
			[makeScript("poll.ts"), "--every", "15m", "--cwd", freshTempDir("job-cwd")],
			"job add: the folder of the file is its working directory",
		);
		expect(readConfig(sb).jobs).toEqual({});
	});

	it("accepts a permitted flag and keeps its key in the entry", async () => {
		sb = box.create();

		const result = await add([makeScript("poll.ts"), "--every", "15m", "--feed", "--notify", "bot"]);

		expect(result.code).toBe(0);
		expect(readConfig(sb).jobs.poll.feed).toBe(true);
		expect(readConfig(sb).jobs.poll.notify).toBe("bot");
	});

	it("gives the same entry with and without --yes", async () => {
		sb = box.create();
		const file = makeScript("poll.ts");

		await add([file, "--every", "15m"]);
		const plain = readConfig(sb).jobs.poll;
		await runJob(["remove", "poll"], sb.deps());
		const result = await add([file, "--every", "15m", "--yes"]);

		expect(result.code).toBe(0);
		expect(readConfig(sb).jobs.poll).toEqual(plain);
	});

	it("exits 1 for a second add of the same name and points to update", async () => {
		sb = box.create();
		const file = makeScript("poll.ts");
		await add([file, "--every", "15m"]);

		await refused(
			[file, "--every", "30m"],
			'a job named "poll" already exists — to change it, run dg job update poll',
		);
	});

	it("asks no question", async () => {
		sb = box.create();
		let asked = 0;

		const result = await add([makeScript("poll.ts"), "--every", "15m"], {
			confirm: async () => {
				asked++;
				return true;
			},
		});

		expect(result.code).toBe(0);
		expect(asked).toBe(0);
	});

	it("runs no build and starts no process of a repository", async () => {
		sb = box.create();

		await add([makeScript("poll.ts"), "--every", "15m"]);

		expect(sb.builds).toEqual([]);
		expect(sb.gitCalls).toEqual([]);
	});
});

describe("job add of a local folder", () => {
	it("writes one entry for each job with the real path of the folder as cwd", async () => {
		sb = box.create();
		const dir = makeFolder({ name: "toolkit", dg: block("a", "b"), files: { "bin/run": BIN_RUN } });

		const result = await add([dir]);

		expect(result.code).toBe(0);
		const real = realpathSync(dir);
		const jobs = readConfig(sb).jobs;
		expect(Object.keys(jobs)).toEqual(["a", "b"]);
		for (const name of ["a", "b"]) {
			expect(jobs[name].cwd).toBe(real);
			expect(jobs[name].argv).toEqual([join(real, "bin/run")]);
			expect(existsSync(jobStateDir(sb.paths, name))).toBe(true);
		}
		const record = readRegistry(sb).toolkit;
		expect(record).toMatchObject({ kind: "path", path: real, jobs: ["a", "b"], credentials: {} });
		expect(record.declarationHash).toMatch(/^[0-9a-f]{64}$/);
		expect(record).not.toHaveProperty("url");
		expect(record).not.toHaveProperty("sha");
		expect(result.stdout).toContain(`added jobs from "toolkit" at ${real}: a, b`);
		expect(result.stdout).toContain("next: dg job enable a");
		expect(result.stdout).toContain("next: dg job enable b");
		expect(result.stdout).toContain("job a");
		expect(sb.gitCalls).toEqual([]);
	});

	it("uses --name as the source name and the lower case folder name otherwise", async () => {
		sb = box.create();
		const dir = makeFolder({ name: "MyKit", dg: block("a"), files: { "bin/run": BIN_RUN } });

		await add([dir]);

		expect(Object.keys(readRegistry(sb))).toEqual(["mykit"]);
	});

	it("takes --name as the source name", async () => {
		sb = box.create();
		const dir = makeFolder({ name: "MyKit", dg: block("a"), files: { "bin/run": BIN_RUN } });

		const result = await add([dir, "--name", "second"]);

		expect(result.code).toBe(0);
		expect(Object.keys(readRegistry(sb))).toEqual(["second"]);
	});

	it("accepts --yes and gives the same entries", async () => {
		sb = box.create();
		const dir = makeFolder({ name: "kit", dg: block("a"), files: { "bin/run": BIN_RUN } });
		await add([dir]);
		const plain = readConfig(sb).jobs.a;
		await runJob(["remove", "a"], sb.deps());

		const result = await add([dir, "--yes"]);

		expect(result.code).toBe(0);
		expect(readConfig(sb).jobs.a).toEqual(plain);
	});

	it("adds the folder that ~ names", async () => {
		sb = box.create();
		const home = makeFolder({ name: "home", dg: block("a"), files: { "bin/run": BIN_RUN } });
		process.env.HOME = home;

		const result = await add(["~", "--name", "tilde"]);

		expect(result.code).toBe(0);
		expect(readRegistry(sb).tilde.path).toBe(realpathSync(home));
	});

	it("refuses a folder name that fails the name rule", async () => {
		sb = box.create();
		const dir = makeFolder({ name: "My_Kit", dg: block("a"), files: { "bin/run": BIN_RUN } });
		await refused([dir], 'job add: cannot use "My_Kit" as a source name — give one with --name');
		expect((await add([dir, "--name", "my-kit"])).code).toBe(0);
	});

	it("exits 1 for a folder with no package.json", async () => {
		sb = box.create();
		const dir = makeFolder({ name: "empty" });
		await refused([dir], `job add: ${realpathSync(dir)} has no package.json with a "dg" key`);
	});

	it("exits 1 for a package.json with no dg key", async () => {
		sb = box.create();
		const dir = makeFolder({ name: "plain" });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
		await refused([dir], `has no package.json with a "dg" key`);
	});

	it.each([
		[["--every", "15m"]],
		[["--continuous"]],
		[["--credential", "x"]],
		[["--timeout", "5m"]],
		[["--feed"]],
		[["--notify", "bot"]],
		[["--cwd", "/tmp"]],
		[["--env", "HOME"]],
		[["--env-file", "/tmp/x"]],
		[["--stop-timeout", "5s"]],
		[["--cron", "* * * * *"]],
		[["--pass-env", "HOME"]],
	])("refuses the flag %s with a folder", async (flag) => {
		sb = box.create();
		const dir = makeFolder({ dg: block("a"), files: { "bin/run": BIN_RUN } });
		await refused([dir, ...flag], 'job add: the folder declares this in its "dg" block');
		expect(readConfig(sb).jobs).toEqual({});
	});

	it("runs the build one time after the parse, before the write", async () => {
		sb = box.create();
		const dir = makeFolder({
			name: "built",
			dg: { ...block("a"), build: ["./bin/run"] },
			files: { "bin/run": BIN_RUN },
		});

		const result = await add([dir]);

		expect(result.code).toBe(0);
		expect(sb.builds).toEqual([{ argv: [join(realpathSync(dir), "bin/run")], cwd: realpathSync(dir) }]);
	});

	it("exits 1 when the build fails and writes nothing", async () => {
		sb = box.create();
		const dir = makeFolder({
			name: "built",
			dg: { ...block("a"), build: ["./bin/run"] },
			files: { "bin/run": BIN_RUN },
		});

		const result = await runJob(["add", dir], withBun(sb, { runBuild: async () => 3 }));

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job add: build failed (exit 3): ./bin/run");
		expect(readConfig(sb).jobs).toEqual({});
		expect(existsSync(sb.paths.jobSourcesPath)).toBe(false);
	});

	it("refuses a missing required executable", async () => {
		sb = box.create();
		const dir = makeFolder({
			dg: { ...block("a"), requires: ["nothing-here"] },
			files: { "bin/run": BIN_RUN },
		});
		await refused([dir], "required executable(s) do not resolve on PATH: nothing-here");
	});

	it("resolves a bare argv[0] to an absolute path", async () => {
		sb = box.create();
		const dir = makeFolder({ dg: { jobs: { a: { argv: ["sh"], continuous: true } } } });

		await add([dir]);

		expect(readConfig(sb).jobs.a.argv).toEqual([sb.tools.which("sh")]);
	});

	it("refuses a link inside the folder that points outside it", async () => {
		sb = box.create();
		const outside = makeScript("run", "#!/bin/sh\n", { executable: true });
		const dir = makeFolder({ dg: block("a") });
		mkdirSync(join(dir, "bin"));
		symlinkSync(outside, join(dir, "bin/run"));

		await refused([dir], 'job "a": "argv" must stay inside the repository or folder');
		expect(readConfig(sb).jobs).toEqual({});
	});

	it("refuses a job name that the table already holds", async () => {
		sb = box.create({ a: { continuous: true, argv: ["/bin/x"], cwd: "/tmp" } });
		const dir = makeFolder({ dg: block("a"), files: { "bin/run": BIN_RUN } });
		await refused([dir], 'a job named "a" already exists');
	});

	it("refuses a second add of the same folder", async () => {
		sb = box.create();
		const dir = makeFolder({ name: "toolkit", dg: block("a"), files: { "bin/run": BIN_RUN } });
		await add([dir]);
		await refused([dir], 'source "toolkit" is already added');
	});

	it("restores the table and the registry when a write fails", async () => {
		sb = box.create();
		const dir = makeFolder({ name: "toolkit", dg: block("a"), files: { "bin/run": BIN_RUN } });
		mkdirSync(join(sb.paths.jobStateRoot), { recursive: true });
		writeFileSync(join(sb.paths.jobStateRoot, "a"), "in the way");
		const before = readFileSync(sb.paths.daemonConfigPath);

		const result = await add([dir]);

		expect(result.code).not.toBe(0);
		expect(readFileSync(sb.paths.daemonConfigPath).equals(before)).toBe(true);
		expect(readRegistry(sb)).toEqual({});
	});

	it("prints the env file line for a job whose env file is missing", async () => {
		sb = box.create();
		const dir = makeFolder({
			dg: { jobs: { a: { argv: ["./bin/run"], continuous: true, envFile: "a.env" } } },
			files: { "bin/run": BIN_RUN },
		});

		const result = await add([dir]);

		expect(result.stdout).toMatch(/next: create .*a\.env with mode 600 before you start a/);
	});
});

describe("job add clashes between a file job and a folder source", () => {
	it("refuses a folder source named like a file job", async () => {
		sb = box.create();
		await add([makeScript("poll.ts"), "--every", "15m"]);
		const dir = makeFolder({ name: "poll", dg: block("a"), files: { "bin/run": BIN_RUN } });

		await refused([dir], 'source "poll" is already added');
	});

	it("refuses a file job named like a folder source", async () => {
		sb = box.create();
		const dir = makeFolder({ name: "poll", dg: block("a"), files: { "bin/run": BIN_RUN } });
		await add([dir]);

		await refused([makeScript("poll.ts"), "--every", "15m"], '"poll" is already used as a credential prefix');
	});
});

describe("job update of a file job", () => {
	it("changes the mode with the command-job update and keeps enabled", async () => {
		sb = box.create();
		await add([makeScript("poll.ts"), "--every", "15m"]);
		const config = readConfig(sb);
		config.jobs.poll.enabled = true;
		writeFileSync(sb.paths.daemonConfigPath, JSON.stringify({ ...config }));

		const result = await runJob(["update", "poll", "--every", "30m"], sb.deps());

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("changed every");
		const entry = readConfig(sb).jobs.poll;
		expect(entry.every).toBe("30m");
		expect(entry.enabled).toBe(true);
	});

	it("adds a credential, sets the grant and keeps enabled", async () => {
		sb = box.create();
		await add([makeScript("poll.ts"), "--every", "15m"]);
		const config = readConfig(sb);
		config.jobs.poll.enabled = true;
		writeFileSync(sb.paths.daemonConfigPath, JSON.stringify({ ...config }));

		const result = await runJob(["update", "poll", "--credential", "api-key"], sb.deps());

		expect(result.code).toBe(0);
		const entry = readConfig(sb).jobs.poll;
		expect(entry.credentials).toEqual(["api-key"]);
		expect(entry.grant).toBe("poll");
		expect(entry.enabled).toBe(true);
	});

	it("refuses a credential flag with no name before the =", async () => {
		sb = box.create();
		await add([makeScript("poll.ts"), "--every", "15m"]);

		const result = await runJob(["update", "poll", "--credential", "=API_KEY"], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--credential takes a name");
	});
});

describe("job name of a file", () => {
	it("names the job after the file with no extension in lower case", async () => {
		sb = box.create();

		await add([makeScript("Poll.TS"), "--every", "15m"]);

		expect(Object.keys(readConfig(sb).jobs)).toEqual(["poll"]);
	});
});

describe("job add of a file with entry flags", () => {
	it("stores --env, --env-file and --stop-timeout of a continuous job", async () => {
		sb = box.create();
		const file = makeScript("run.sh", "#!/bin/sh\n", { executable: true });

		const result = await add([
			file,
			"--continuous",
			"--env",
			"HOME",
			"--env-file",
			"/tmp/run.env",
			"--stop-timeout",
			"5s",
		]);

		expect(result.code).toBe(0);
		const entry = readConfig(sb).jobs.run;
		expect(entry.passEnv).toEqual(["HOME"]);
		expect(entry.envFile).toBe("/tmp/run.env");
		expect(entry.stopTimeoutMs).toBe(5000);
	});

	it("stores --timeout of a scheduled job", async () => {
		sb = box.create();

		await add([makeScript("poll.ts"), "--every", "15m", "--timeout", "5m"]);

		expect(readConfig(sb).jobs.poll.timeoutMs).toBe(300000);
	});

	it("refuses --env with a value and a bad duration", async () => {
		sb = box.create();
		const file = makeScript("poll.ts");
		await refused([file, "--every", "15m", "--env", "A=b"], "--env takes a variable name");
		await refused([file, "--every", "15m", "--timeout", "soon"], "job add:");
		expect(readConfig(sb).jobs).toEqual({});
	});

	it("refuses --schedule together with --cron", async () => {
		sb = box.create();
		await refused(
			[makeScript("poll.ts"), "--schedule", "* * * * *", "--cron", "* * * * *"],
			"job add: give one of --continuous, --schedule or --every",
		);
	});

	it("prints the alias note for --cron, --label and --pass-env", async () => {
		sb = box.create();

		const result = await add([
			makeScript("poll.ts"),
			"--cron",
			"* * * * *",
			"--label",
			"tick",
			"--pass-env",
			"HOME",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toContain('"--cron" is now "--schedule"');
		expect(result.stderr).toContain('"--label" is now "--name"');
		expect(result.stderr).toContain('"--pass-env" is now "--env"');
		expect(readConfig(sb).jobs.tick.schedule).toBe("* * * * *");
	});
});
