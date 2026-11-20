import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_JOBS_PATH } from "@dg/common";
import { updateMarks } from "../../src/jobs/sources";
import { startFakeDaemon } from "./job-cli-helpers";
import {
	BIN_RUN,
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
afterEach(() => box.cleanup());

const jobsOf = (...names: string[]) => ({
	jobs: Object.fromEntries(
		names.map((name) => [name, { argv: ["./bin/run"], continuous: true }]),
	),
});

const rewrite = (dir: string, dg: unknown): void =>
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", dg }));

function patchEntry(name: string, change: Record<string, unknown>): void {
	const config = readConfig(sb);
	config.jobs[name] = { ...config.jobs[name], ...change };
	writeFileSync(sb.paths.daemonConfigPath, JSON.stringify(config));
}

async function addFolder(dg: unknown, name = "toolkit") {
	const dir = makeFolder({ name, dg, files: { "bin/run": BIN_RUN } });
	const result = await runJob(["add", dir], withBun(sb));
	if (result.code !== 0) throw new Error(result.stderr);
	return dir;
}

async function addFile(name = "poll.ts") {
	const file = makeScript(name);
	const result = await runJob(["add", file, "--every", "15m"], withBun(sb));
	if (result.code !== 0) throw new Error(result.stderr);
	return file;
}

describe("job update of a folder job", () => {
	it("prints a replaced line for each changed key, writes the entries and asks nothing", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a"));
		const oldHash = readRegistry(sb).toolkit.declarationHash;
		patchEntry("a", { enabled: true, passEnv: ["HOME"] });
		rewrite(dir, { jobs: { a: { argv: ["./bin/run", "--fast"], continuous: true } } });
		let asked = 0;

		const result = await runJob(
			["update", "a"],
			sb.deps({
				confirm: async () => {
					asked++;
					return true;
				},
			}),
		);

		expect(result.code).toBe(0);
		expect(asked).toBe(0);
		expect(result.stdout).toContain("replaced a.argv");
		expect(result.stdout.match(/replaced /g)).toHaveLength(1);
		const entry = readConfig(sb).jobs.a;
		expect(entry.argv).toEqual([join(realpathSync(dir), "bin/run"), "--fast"]);
		expect(entry.enabled).toBe(true);
		expect(entry.passEnv).toEqual(["HOME"]);
		const newHash = readRegistry(sb).toolkit.declarationHash as string;
		expect(newHash).toMatch(/^[0-9a-f]{64}$/);
		expect(newHash).not.toBe(oldHash);
	});

	it("removes the job from the setupDone list when a credential source changes and says to run setup", async () => {
		sb = box.create();
		const declared = (secretId: string) => ({
			jobs: { a: { argv: ["./bin/run"], continuous: true, credentials: ["token"] } },
			credentials: {
				token: { source: { type: "aws-secretsmanager", secretId, region: "us-east-1" } },
			},
		});
		const dir = await addFolder(declared("prod/a"));
		updateMarks(sb.paths, "a", { prefixAccepted: true, setupDone: "a" });
		expect(readRegistry(sb).toolkit.setupDone).toEqual(["a"]);
		rewrite(dir, declared("prod/b"));

		const result = await runJob(["update", "a"], sb.deps());

		expect(result.code).toBe(0);
		expect(readRegistry(sb).toolkit.setupDone).toEqual([]);
		expect(readRegistry(sb).toolkit.prefixAccepted).toBe(true);
		expect(result.stdout.split("\n")).toContain("next: dg job setup a");
	});

	it("gives a new job an entry with no enabled key and a next line", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a"));
		rewrite(dir, jobsOf("a", "b"));

		const result = await runJob(["update", "a"], sb.deps());

		expect(result.code).toBe(0);
		expect(readConfig(sb).jobs.b).not.toHaveProperty("enabled");
		expect(result.stdout).toContain("next: dg job enable b");
		expect(readRegistry(sb).toolkit.jobs).toEqual(["a", "b"]);
	});

	it("drops the entry of a job that the block no longer lists", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a", "b"));
		rewrite(dir, jobsOf("a"));

		const result = await runJob(["update", "a"], sb.deps());

		expect(result.code).toBe(0);
		expect(Object.keys(readConfig(sb).jobs)).toEqual(["a"]);
		expect(readRegistry(sb).toolkit.jobs).toEqual(["a"]);
	});

	it("does not run the build and says so in one line", async () => {
		sb = box.create();
		const dir = await addFolder({ ...jobsOf("a"), build: ["./bin/run"] });
		const before = sb.builds.length;
		rewrite(dir, { ...jobsOf("a"), build: ["./bin/run"], requires: [] });

		const result = await runJob(["update", "a"], sb.deps());

		expect(result.code).toBe(0);
		expect(sb.builds).toHaveLength(before);
		expect(result.stdout.split("\n").filter((line) => line.startsWith("build was not run"))).toEqual([
			`build was not run — run ./bin/run yourself in ${realpathSync(dir)}`,
		]);
	});

	it.each(["running", "backoff"])("prints the restart line for a job in the state %s", async (state) => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a"));
		rewrite(dir, { jobs: { a: { argv: ["./bin/run", "--x"], continuous: true } } });
		const daemon = startFakeDaemon(sb.dgHome, (method, path) =>
			method === "GET" && path === CHAT_JOBS_PATH
				? Response.json({
						instanceId: "i",
						jobs: [{ label: "a", state, pid: 7, restarts: 0, logFile: "/l" }],
					})
				: new Response("not found", { status: 404 }),
		);
		try {
			const result = await runJob(["update", "a"], sb.deps());
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("next: dg job restart a");
		} finally {
			daemon.stop();
		}
	});

	it("prints one line for a changed credential with each key of its source", async () => {
		sb = box.create();
		const block = (secretId: string) => ({
			jobs: { a: { argv: ["./bin/run"], continuous: true, credentials: ["token"] } },
			credentials: {
				token: {
					prompt: "Token",
					source: { type: "aws-secretsmanager", secretId, region: "us-east-1" },
				},
			},
		});
		const dir = await addFolder(block("p/one"));
		rewrite(dir, block("p/two"));

		const result = await runJob(["update", "a"], sb.deps());

		expect(result.code).toBe(0);
		const line = result.stdout.split("\n").filter((text) => text.includes("changed credential token"));
		expect(line).toHaveLength(1);
		expect(line[0]).toContain('secretId="p/two"');
		expect(line[0]).toContain('region="us-east-1"');
		expect(readRegistry(sb).toolkit.credentials).toEqual(block("p/two").credentials);
	});

	it("refuses a flag of a command job", async () => {
		sb = box.create();
		await addFolder(jobsOf("a"));

		const result = await runJob(["update", "a", "--every", "5m"], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job update: the folder declares this in its "dg" block');
	});

	it("exits 1 and changes nothing when the block no longer parses", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a"));
		const before = readFileSync(sb.paths.daemonConfigPath);
		writeFileSync(join(dir, "package.json"), "{ not json");

		const result = await runJob(["update", "a"], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job update:");
		expect(readFileSync(sb.paths.daemonConfigPath).equals(before)).toBe(true);
	});

	it("exits 1 when the folder is gone", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a"));
		rmSync(dir, { recursive: true });

		const result = await runJob(["update", "a"], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(realpathSync(join(dir, "..")));
	});
});

describe("job update of a folder job that cannot apply", () => {
	it("refuses a new job name that the table already holds", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a"));
		patchEntry("b", { continuous: true, argv: ["/bin/x"], cwd: "/tmp" });
		rewrite(dir, jobsOf("a", "b"));

		const result = await runJob(["update", "a"], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job update: a job named "b" already exists');
	});

	it("refuses when the record changed while the command ran", async () => {
		sb = box.create();
		const dir = await addFolder({ ...jobsOf("a"), requires: ["tool"] });
		rewrite(dir, { ...jobsOf("a"), requires: ["tool"] });
		const record = readRegistry(sb).toolkit;
		const before = readFileSync(sb.paths.daemonConfigPath);

		const result = await runJob(
			["update", "a"],
			sb.deps({
				which: (name) => {
					writeFileSync(
						sb.paths.jobSourcesPath,
						JSON.stringify({ toolkit: { ...record, jobs: ["a", "zz"] } }),
					);
					return sb.tools.which(name);
				},
			}),
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("changed — nothing was changed");
		expect(readFileSync(sb.paths.daemonConfigPath).equals(before)).toBe(true);
	});

	it("restores the table and the registry when a write fails", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a"));
		rewrite(dir, jobsOf("a", "b"));
		writeFileSync(join(sb.paths.jobStateRoot, "b"), "in the way");
		const config = readFileSync(sb.paths.daemonConfigPath);
		const registry = readFileSync(sb.paths.jobSourcesPath);

		const result = await runJob(["update", "a"], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`EEXIST: file already exists, mkdir '${join(sb.paths.jobStateRoot, "b")}'`);
		expect(readFileSync(sb.paths.daemonConfigPath).equals(config)).toBe(true);
		expect(readFileSync(sb.paths.jobSourcesPath).equals(registry)).toBe(true);
	});

	it("refuses to drop a job that is still live", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a", "b"));
		rewrite(dir, jobsOf("a"));
		const before = readFileSync(sb.paths.daemonConfigPath);
		const daemon = startFakeDaemon(sb.dgHome, (method, path) =>
			method === "GET" && path === CHAT_JOBS_PATH
				? Response.json({
						instanceId: "i",
						jobs: [{ label: "b", state: "running", pid: 7, restarts: 0, logFile: "/l" }],
					})
				: new Response("not found", { status: 404 }),
		);
		try {
			const result = await runJob(["update", "a"], sb.deps());
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('job "b" is running — stop it first');
			expect(readFileSync(sb.paths.daemonConfigPath).equals(before)).toBe(true);
		} finally {
			daemon.stop();
		}
	});
});

describe("job remove of a local job", () => {
	it("leaves the script byte-equal and drops the record with the job", async () => {
		sb = box.create();
		const file = await addFile();
		const before = readFileSync(file);

		const result = await runJob(["remove", "poll"], sb.deps());

		expect(result.code).toBe(0);
		expect(readFileSync(file).equals(before)).toBe(true);
		expect(readConfig(sb).jobs).toEqual({});
		expect(readRegistry(sb)).toEqual({});
	});

	it("keeps the record until the last job of a folder goes and never touches the folder", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a", "b"));

		await runJob(["remove", "a"], sb.deps());
		expect(readRegistry(sb).toolkit.jobs).toEqual(["b"]);
		await runJob(["remove", "b"], sb.deps());

		expect(readRegistry(sb)).toEqual({});
		expect(existsSync(join(dir, "package.json"))).toBe(true);
		expect(existsSync(join(dir, "bin/run"))).toBe(true);
	});
});

describe("job status and list of a local job", () => {
	it("shows the source and its path in the text row", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a"));

		const result = await runJob(["status", "a"], sb.deps());

		expect(result.stdout).toContain(`toolkit (${realpathSync(dir)})`);
		expect(result.stdout).not.toContain("source changed");
	});

	it("shows source changed after an edit of the block and none after the update", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a"));
		rewrite(dir, { jobs: { a: { argv: ["./bin/run", "--x"], continuous: true } } });

		const status = await runJob(["status", "a"], sb.deps());
		const list = await runJob(["list"], sb.deps());
		await runJob(["update", "a"], sb.deps());
		const after = await runJob(["status", "a"], sb.deps());

		expect(status.stdout).toContain("source changed — run dg job update a");
		expect(list.stdout).toContain("source changed — run dg job update a");
		expect(after.stdout).not.toContain("source changed");
	});

	it("shows source missing for a file job whose script is gone", async () => {
		sb = box.create();
		const file = await addFile();
		const real = realpathSync(file);
		rmSync(file);

		const status = await runJob(["status", "poll"], sb.deps());
		const list = await runJob(["list"], sb.deps());

		expect(status.code).toBe(0);
		expect(status.stdout).toContain(`source missing: ${real}`);
		expect(list.stdout).toContain(`source missing: ${real}`);
	});

	it("shows source missing for a continuous file job", async () => {
		sb = box.create();
		const file = makeScript("run.sh", "#!/bin/sh\n", { executable: true });
		await runJob(["add", file, "--continuous"], withBun(sb));
		const real = realpathSync(file);
		rmSync(file);

		const status = await runJob(["status", "run"], sb.deps());

		expect(status.stdout).toContain(`source missing: ${real}`);
	});

	it("gives source, path and sourceState in json", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a"));
		const file = await addFile();
		rmSync(file);

		const result = await runJob(["list", "--json"], sb.deps());

		const rows = JSON.parse(result.stdout).jobs as Record<string, unknown>[];
		const a = rows.find((row) => row.name === "a");
		const poll = rows.find((row) => row.name === "poll");
		expect(a).toMatchObject({ source: "toolkit", path: realpathSync(dir), sourceState: "ok" });
		expect(a).not.toHaveProperty("sha");
		expect(poll).toMatchObject({ source: "poll", sourceState: "missing" });
	});

	it("shows source invalid with the path when the block cannot be read", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a"));
		writeFileSync(join(dir, "package.json"), "{ not json");

		const result = await runJob(["status", "a"], sb.deps());

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`source invalid: ${realpathSync(dir)}`);
	});

	it("gives sourceState changed and invalid and never fails the command", async () => {
		sb = box.create();
		const dir = await addFolder(jobsOf("a"));
		const state = async () => {
			const result = await runJob(["list", "--json"], sb.deps());
			expect(result.code).toBe(0);
			return (JSON.parse(result.stdout).jobs as Record<string, unknown>[])[0].sourceState;
		};

		rewrite(dir, { jobs: { a: { argv: ["./bin/run", "--x"], continuous: true } } });
		expect(await state()).toBe("changed");
		writeFileSync(join(dir, "package.json"), "{ not json");
		expect(await state()).toBe("invalid");
		rewrite(dir, { jobs: { a: { continuous: true } } });
		expect(await state()).toBe("invalid");
	});
});
