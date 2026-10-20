import {
	afterAll,
	afterEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	chmodSync,
	existsSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { shellCommand } from "../src/utils/self-command";
import { BG_ENTRY, type BgJob, bgWorld, isLive, until } from "./bg-fixtures";

setDefaultTimeout(60_000);

const world = bgWorld();
afterEach(() => world.cleanup());
afterAll(() => world.cleanup());

function proxyJob(sessionId: string, sleepSeconds = 0) {
	const bin = world.dir("bg-proxy-");
	const events = [
		{ type: "thread.started", thread_id: sessionId },
		{
			type: "item.completed",
			item: { type: "agent_message", text: "ok" },
		},
	]
		.map((event) => JSON.stringify(event))
		.join("\n");
	const stub = join(bin, "codex");
	writeFileSync(
		stub,
		`#!/bin/sh\nsleep ${sleepSeconds}\ncat <<'EOF'\n${events}\nEOF\n`,
	);
	chmodSync(stub, 0o755);
	return {
		command: shellCommand([
			process.execPath,
			"run",
			BG_ENTRY,
			"proxy",
			"codex",
			"--prompt",
			"go",
		]),
		env: { PATH: `${bin}:${process.env.PATH}` },
	};
}

describe("dg-skills bg run and status", () => {
	test("records the command's own exit code once done", async () => {
		const cwd = world.dir();
		const job = await world.launch("sleep 0.2; exit 3", cwd);
		expect(job.state).toBe("running");
		expect(await world.settled(job.id, cwd)).toMatchObject({
			state: "done",
			exitCode: 3,
		});
	});

	test("a command that calls exit still records its status", async () => {
		const cwd = world.dir();
		const job = await world.launch("echo ok; exit 0", cwd);
		expect(await world.settled(job.id, cwd)).toMatchObject({
			state: "done",
			exitCode: 0,
		});
	});

	test("captures stdout and stderr into the log file", async () => {
		const cwd = world.dir();
		const job = await world.launch("echo to-stdout; echo to-stderr 1>&2", cwd);
		await world.settled(job.id, cwd);
		const log = readFileSync(job.logFile, "utf8");
		expect(log).toContain("to-stdout");
		expect(log).toContain("to-stderr");
	});

	test("runs the command in the directory given by --cwd", async () => {
		const caller = world.dir();
		const workdir = world.dir("bg-work-");
		const job = await world.launch("pwd", caller, ["--cwd", workdir]);
		await world.settled(job.id, caller);
		expect(readFileSync(job.logFile, "utf8").trim()).toBe(workdir);
		expect(job.cwd).toBe(workdir);
	});

	test("keeps the durable log and status in the state root and the pid in scratch", async () => {
		const cwd = world.dir();
		const job = await world.launch("exit 0", cwd);
		await world.settled(job.id, cwd);
		expect(job.logFile.startsWith(world.state)).toBe(true);
		expect(job.statusFile.startsWith(world.state)).toBe(true);
		expect(job.pidFile.startsWith(world.scratch)).toBe(true);
	});

	test("run without a command is a usage error with exit 2", async () => {
		const result = await world.bg(["run"], world.dir());
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/usage/i);
		expect(world.jobs()).toEqual([]);
	});

	test("run rejects a command split across several arguments", async () => {
		const result = await world.bg(["run", "sh", "-c", "echo hi"], world.dir());
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("one quoted argument");
		expect(world.jobs()).toEqual([]);
	});

	test("run with --cwd missing its directory is a usage error and starts nothing", async () => {
		const result = await world.bg(["run", "echo hi", "--cwd"], world.dir());
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("--cwd requires a directory argument");
		expect(world.jobs()).toEqual([]);
	});

	test("run in a directory that does not exist fails with exit 1 and no live job", async () => {
		const missing = join(world.dir(), "absent");
		const result = await world.bg(
			["run", "echo hi", "--cwd", missing],
			world.dir(),
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("bg run");
		expect(world.jobs().filter((job) => job.state === "running")).toEqual([]);
	});

	test("status of an unknown id exits 1 with a clear message", async () => {
		const result = await world.bg(["status", "does-not-exist"], world.dir());
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/unknown job/i);
	});

	test.each(["status", "cancel", "update", "drain"])(
		"%s rejects a job id that escapes the job directory",
		async (verb) => {
			const args =
				verb === "update"
					? [verb, "../escape", "context"]
					: [verb, "../escape"];
			const result = await world.bg(args, world.dir());
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("invalid job id");
		},
	);
});

describe("dg-skills bg list", () => {
	test("includes every launched job with its derived state", async () => {
		const cwd = world.dir();
		const a = await world.launch("exit 0", cwd);
		const b = await world.launch("exit 0", cwd);
		await world.settled(a.id, cwd);
		await world.settled(b.id, cwd);
		const { jobs } = await world.json<{ jobs: BgJob[] }>(["list"], cwd);
		expect(jobs.map((job) => job.id).sort()).toEqual([a.id, b.id].sort());
		expect(jobs.every((job) => job.state === "done")).toBe(true);
	});

	test("returns an empty list when no job was launched", async () => {
		expect(await world.json<unknown>(["list"], world.dir())).toEqual({
			jobs: [],
		});
	});

	test("skips a truncated meta file instead of failing for every job", async () => {
		const cwd = world.dir();
		const job = await world.launch("exit 0", cwd);
		await world.settled(job.id, cwd);
		writeFileSync(join(world.state, "bg", "truncated.meta.json"), '{"id":');
		const { jobs } = await world.json<{ jobs: BgJob[] }>(["list"], cwd);
		expect(jobs.map((value) => value.id)).toEqual([job.id]);
	});
});

describe("dg-skills bg cancel", () => {
	test.each(["cancel", "kill"])(
		"%s stops a running job and flips it to canceled",
		async (verb) => {
			const cwd = world.dir();
			const job = await world.launch("sleep 30", cwd);
			await world.settled(job.id, cwd, (value) => value.state === "running");
			const result = await world.json<{ result: string }>([verb, job.id], cwd);
			expect(result.result).toBe("canceled");
			expect((await world.json(["status", job.id], cwd)).state).toBe(
				"canceled",
			);
		},
	);

	test("is a graceful no-op on an already finished job and keeps its terminal state", async () => {
		const cwd = world.dir();
		const job = await world.launch("exit 0", cwd);
		await world.settled(job.id, cwd);
		const result = await world.bg(["cancel", job.id], cwd);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			result: "already-finished",
		});
		expect((await world.json(["status", job.id], cwd)).state).toBe("done");
	});

	test("is a graceful no-op on an unknown id", async () => {
		const result = await world.bg(["cancel", "no-such-job"], world.dir());
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).result).toBe("unknown");
	});
});

describe("dg-skills bg update", () => {
	test("refuses a plain shell job because there is no session to update", async () => {
		const cwd = world.dir();
		const job = await world.launch("sleep 30", cwd);
		const out = await world.json<{ result: string }>(
			["update", job.id, "more"],
			cwd,
		);
		expect(out.result).toBe("unsupported-shell");
	});

	test("queues context on a running proxy job and surfaces it in status", async () => {
		const cwd = world.dir();
		const { command, env } = proxyJob("sess-queue", 30);
		const job = await world.launch(command, cwd, [], env);
		expect(job).toMatchObject({ kind: "proxy", proxyBackend: "codex" });
		await world.settled(job.id, cwd, (value) => value.state === "running");
		const out = await world.json<{ result: string; pendingUpdate: string }>(
			["update", job.id, "also handle the edge case"],
			cwd,
			env,
		);
		expect(out.result).toBe("queued");
		expect(out.pendingUpdate).toContain("also handle the edge case");
		expect((await world.json(["status", job.id], cwd)).pendingUpdate).toContain(
			"also handle the edge case",
		);
	});

	test("resumes a finished proxy session as a new chained job", async () => {
		const cwd = world.dir();
		const { command, env } = proxyJob("sess-done");
		const job = await world.launch(command, cwd, [], env);
		await world.settled(job.id, cwd);
		const out = await world.json<{
			result: string;
			sessionId: string;
			newJobId: string;
		}>(["update", job.id, "follow-up context"], cwd, env);
		expect(out).toMatchObject({ result: "resumed", sessionId: "sess-done" });
		const chained = await world.json(["status", out.newJobId], cwd);
		expect(chained.command).toContain("--resume");
		expect(chained.command).toContain("sess-done");
		expect(chained.command).toContain("follow-up context");
	});

	test("drain applies queued context once and reports nothing pending afterward", async () => {
		const cwd = world.dir();
		const { command, env } = proxyJob("sess-drain");
		const job = await world.launch(command, cwd, [], env);
		await world.settled(job.id, cwd);
		await until(
			() => world.json(["status", job.id], cwd),
			(value) => value.drainOutput !== null,
		);
		writeFileSync(
			join(world.state, "bg", `${job.id}.pending`),
			"queued while running\n",
		);
		const drained = await world.json<{ result: string; newJobId: string }>(
			["drain", job.id],
			cwd,
			env,
		);
		expect(drained.result).toBe("resumed");
		expect(
			(await world.json(["status", drained.newJobId], cwd)).command,
		).toContain("queued while running");
		expect(await world.json(["drain", job.id], cwd, env)).toMatchObject({
			result: "nothing-pending",
		});
	});

	test("drain on a canceled job drops its queued context", async () => {
		const cwd = world.dir();
		const { command, env } = proxyJob("sess-cancel", 30);
		const job = await world.launch(command, cwd, [], env);
		await world.settled(job.id, cwd, (value) => value.state === "running");
		await world.json(["update", job.id, "never resume"], cwd, env);
		await world.json(["cancel", job.id], cwd, env);
		expect(await world.json(["drain", job.id], cwd, env)).toMatchObject({
			result: "canceled",
		});
		expect(await world.json(["status", job.id], cwd, env)).toMatchObject({
			state: "canceled",
			pendingUpdate: null,
		});
		expect(
			await world.json(["update", job.id, "later"], cwd, env),
		).toMatchObject({
			result: "canceled-job",
		});
	});
});

describe("dg-skills bg prune", () => {
	test("drops a finished job in the tree and keeps a sibling that only shares a path prefix", async () => {
		const base = world.dir();
		const tree = world.mkdir(join(base, "repo"));
		const sibling = world.mkdir(join(base, "repo-other"));
		const inTree = await world.launch("echo in-tree", tree);
		const inSibling = await world.launch("echo in-sibling", sibling);
		await world.settled(inTree.id, base);
		await world.settled(inSibling.id, base);

		const pruned = await world.json<{
			prunedCwd: string;
			removed: string[];
			running: BgJob[];
		}>(["prune", "--cwd", tree], base);
		expect(pruned.prunedCwd).toBe(tree);
		expect(pruned.removed).toEqual([inTree.id]);
		expect(pruned.running).toEqual([]);
		const { jobs } = await world.json<{ jobs: BgJob[] }>(["list"], base);
		expect(jobs.map((job) => job.id)).toEqual([inSibling.id]);
		expect(existsSync(inSibling.logFile)).toBe(true);
		expect(existsSync(inTree.logFile)).toBe(false);
	});

	test("prunes a job whose cwd is nested inside the target tree", async () => {
		const base = world.dir();
		const tree = world.mkdir(join(base, "repo"));
		const nested = world.mkdir(join(tree, "pkg", "app"));
		const job = await world.launch("exit 0", nested);
		await world.settled(job.id, base);
		expect(
			(await world.json<{ removed: string[] }>(["prune", "--cwd", tree], base))
				.removed,
		).toEqual([job.id]);
	});

	test("removes a job that died without a status file", async () => {
		const base = world.dir();
		const tree = world.mkdir(join(base, "repo"));
		const stateDir = world.mkdir(join(world.state, "bg"));
		const meta = {
			id: "crashed-1",
			command: "sleep 30",
			cwd: tree,
			startedAt: new Date().toISOString(),
			logFile: join(stateDir, "crashed-1.log"),
			statusFile: join(stateDir, "crashed-1.status"),
			pidFile: join(world.scratch, "bg", "crashed-1.pid"),
			launcherPid: 999999,
			kind: "shell",
		};
		writeFileSync(join(stateDir, "crashed-1.meta.json"), JSON.stringify(meta));
		expect((await world.json(["status", "crashed-1"], base)).state).toBe(
			"unknown",
		);
		const pruned = await world.json<{ removed: string[] }>(
			["prune", "--cwd", tree],
			base,
		);
		expect(pruned.removed).toEqual(["crashed-1"]);
		expect(world.jobs()).toEqual([]);
	});

	test("stores a relative --cwd as an absolute path so a prune elsewhere keeps the job", async () => {
		const base = world.dir();
		const other = world.mkdir(join(base, "other"));
		world.mkdir(join(base, "sub"));
		const job = await world.launch("exit 0", base, ["--cwd", "sub"]);
		expect(job.cwd).toBe(join(base, "sub"));
		await world.settled(job.id, base);
		const pruned = await world.json<{ removed: string[] }>(
			["prune", "--cwd", other],
			other,
		);
		expect(pruned.removed).toEqual([]);
		expect(world.jobs().map((value) => value.id)).toEqual([job.id]);
	});

	test("classifies a legacy proxy-helper command as a proxy job", async () => {
		const job = await world.launch(
			"/absent/proxy-helper.sh codex --prompt go",
			world.dir(),
		);
		expect(job).toMatchObject({ kind: "proxy", proxyBackend: "codex" });
	});

	test("leaves a running job alone and reports it so its cancel handle survives", async () => {
		const base = world.dir();
		const tree = world.mkdir(join(base, "repo"));
		const job = await world.launch("sleep 30", tree);
		const pruned = await world.json<{ removed: string[]; running: BgJob[] }>(
			["prune", "--cwd", tree],
			base,
		);
		expect(pruned.removed).toEqual([]);
		expect(pruned.running.map((value) => value.id)).toEqual([job.id]);
		expect(
			(await world.json<{ result: string }>(["cancel", job.id], base)).result,
		).toBe("canceled");
	});

	test("keeps a job whose identity record is gone while its process is still alive", async () => {
		const base = world.dir();
		const tree = world.mkdir(join(base, "repo"));
		const job = await world.launch("sleep 30", tree);
		const pid = Number(readFileSync(job.pidFile, "utf8"));
		try {
			rmSync(join(world.scratch, "bg", `${job.id}.identity.json`), {
				force: true,
			});
			expect((await world.json(["status", job.id], base)).state).toBe("unknown");
			expect(isLive(pid)).toBe(true);

			const pruned = await world.json<{ removed: string[] }>(
				["prune", "--cwd", tree],
				base,
			);
			expect(pruned.removed).toEqual([]);
			expect(world.jobs().map((value) => value.id)).toEqual([job.id]);
			expect(isLive(pid)).toBe(true);
		} finally {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				process.kill(pid, "SIGKILL");
			}
		}
	});

	test("prune skips meta records without a string id and cwd", async () => {
		const base = world.dir();
		const tree = world.mkdir(join(base, "repo"));
		const job = await world.launch("exit 0", tree);
		await world.settled(job.id, tree);
		writeFileSync(join(world.state, "bg", "x.meta.json"), "{}");
		writeFileSync(join(world.state, "bg", "y.meta.json"), '{"id":"y"}');
		const pruned = await world.json<{ removed: string[] }>(
			["prune", "--cwd", tree],
			base,
		);
		expect(pruned.removed).toEqual([job.id]);
	});

	test("prune without --cwd is a usage error and an unknown flag is rejected", async () => {
		const missing = await world.bg(["prune"], world.dir());
		expect(missing.exitCode).toBe(2);
		expect(missing.stderr).toMatch(/usage/i);
		const unknown = await world.bg(["prune", "--all"], world.dir());
		expect(unknown.exitCode).toBe(2);
		expect(unknown.stderr).toContain("unknown prune flag");
	});

	test("skips a meta file whose id is not a safe job name", async () => {
		const base = world.dir();
		const victim = join(base, "victim.log");
		writeFileSync(victim, "keep");
		world.mkdir(join(world.state, "bg"));
		writeFileSync(
			join(world.state, "bg", "evil.meta.json"),
			JSON.stringify({
				id: "../../victim",
				command: ":",
				cwd: base,
				startedAt: new Date().toISOString(),
				kind: "shell",
			}),
		);
		expect(await world.json(["prune", "--cwd", base], base)).toMatchObject({
			removed: [],
		});
		expect(existsSync(victim)).toBe(true);
	});

	test("list skips a meta file whose id is not a safe job name and still lists the rest", async () => {
		const base = world.dir();
		const tree = world.mkdir(join(base, "repo"));
		const job = await world.launch("exit 0", tree);
		await world.settled(job.id, tree);
		writeFileSync(
			join(world.state, "bg", "evil.meta.json"),
			JSON.stringify({ id: "../../evil", command: ":", cwd: base, kind: "shell" }),
		);
		const listed = await world.json<{ jobs: { id: string }[] }>(["list"], base);
		expect(listed.jobs.map((value) => value.id)).toEqual([job.id]);
	});
});

describe("dg-skills bg help", () => {
	test("lists every job verb without creating a job", async () => {
		const result = await world.bg(["--help"], world.dir());
		expect(result.exitCode).toBe(0);
		for (const verb of [
			"run",
			"list",
			"prune",
			"status",
			"cancel",
			"kill",
			"update",
			"drain",
		])
			expect(result.stdout).toMatch(new RegExp(`^  ${verb}(?: |$)`, "m"));
		expect(world.jobs()).toEqual([]);
	});
});
