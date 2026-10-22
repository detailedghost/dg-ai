import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { shellCommand } from "@dg/common/node";
import {
	type BgJob,
	bgWorld,
	isLive,
	killQuietly,
	until,
} from "./bg-fixtures";
import {
	compileProxyCli,
	proxyFixtures,
	runProxyProcess,
} from "./proxy-fixtures";

setDefaultTimeout(60_000);

const installation = proxyFixtures();
const command: string[] = [];
const world = bgWorld(command);
let binary: string;

beforeAll(() => {
	binary = compileProxyCli(installation);
	command.push(binary);
}, 240_000);

afterEach(() => world.cleanup());
afterAll(() => {
	installation.cleanup();
	return world.cleanup();
});

function script(name: string, body: string): string {
	const file = join(world.dir("bg-script-"), name);
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}

function inOwnGroup(file: string) {
	const child = spawn(file, [], {
		detached: true,
		stdio: "ignore",
		env: world.env(),
	});
	const exited = new Promise<number | null>((resolve) =>
		child.once("exit", (code) => resolve(code)),
	);
	return { child, exited };
}

describe("compiled dg-skills bg detachment", () => {
	test("a job survives the death of the caller's whole process group", async () => {
		const dir = world.dir();
		const out = join(dir, "job.json");
		const ready = join(dir, "ready");
		const caller = script(
			"caller.sh",
			`${shellCommand([binary, "bg", "run", "sleep 30"])} > ${shellCommand([out])} || exit 1\n: > ${shellCommand([ready])}\nsleep 30`,
		);
		const { child, exited } = inOwnGroup(caller);
		const groupPid = child.pid;
		if (!groupPid) throw new Error("caller script did not start");
		let job: BgJob | undefined;
		try {
			await until(() => existsSync(ready), Boolean);
			job = JSON.parse(readFileSync(out, "utf8")) as BgJob;
			killQuietly(-groupPid);
			await exited;
			await Bun.sleep(300);
			expect(isLive(job.launcherPid)).toBe(true);
			expect((await world.json(["status", job.id], dir)).state).toBe(
				"running",
			);
			await world.json(["cancel", job.id], dir);
			await until(
				() => isLive(job?.launcherPid ?? 0),
				(live) => !live,
			);
		} finally {
			if (job) await world.bg(["cancel", job.id], dir).catch(() => null);
			killQuietly(-groupPid);
		}
	});

	test("cancel signals only the job's own group and leaves its caller running", async () => {
		const dir = world.dir();
		const marker = join(dir, "survived");
		const caller = script(
			"cancel-caller.sh",
			[
				`out=$(${shellCommand([binary, "bg", "run", "sleep 30"])}) || exit 1`,
				`id=$(printf '%s' "$out" | sed -n 's/.*"id": *"\\([^"]*\\)".*/\\1/p')`,
				`${shellCommand([binary, "bg", "cancel"])} "$id" > ${shellCommand([join(dir, "cancel.json")])} || exit 2`,
				`: > ${shellCommand([marker])}`,
			].join("\n"),
		);
		const { exited } = inOwnGroup(caller);
		expect(await exited).toBe(0);
		expect(existsSync(marker)).toBe(true);
		expect(
			JSON.parse(readFileSync(join(dir, "cancel.json"), "utf8")),
		).toMatchObject({
			action: "cancel",
			result: "canceled",
		});
	});

	test("cancel ends the descendants of the job's group", async () => {
		const dir = world.dir();
		const childPid = join(dir, "child.pid");
		const job = await world.launch(
			`sleep 30 & echo $! > ${shellCommand([childPid])}; wait`,
			dir,
		);
		await until(
			() =>
				existsSync(childPid) && readFileSync(childPid, "utf8").trim() !== "",
			Boolean,
		);
		const descendant = Number(readFileSync(childPid, "utf8"));
		expect(isLive(descendant)).toBe(true);
		await world.json(["cancel", job.id], dir);
		await until(
			() => isLive(descendant),
			(live) => !live,
		);
		expect(isLive(job.launcherPid)).toBe(false);
	});

	test("cancel refuses to signal a recorded pid that lacks matching identity evidence", async () => {
		const dir = world.dir();
		const ready = join(dir, "sentinel.ready");
		const stop = join(dir, "sentinel.stop");
		const sentinel = spawn(
			process.execPath,
			[
				"-e",
				`import { existsSync, writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, String(process.pid)); while (!existsSync(${JSON.stringify(stop)})) await Bun.sleep(10);`,
			],
			{ detached: true, stdio: "ignore" },
		);
		const exited = new Promise<void>((resolve) =>
			sentinel.once("exit", () => resolve()),
		);
		try {
			await until(() => existsSync(ready), Boolean);
			const pid = Number(readFileSync(ready, "utf8"));
			const job = await world.launch(":", dir);
			await world.settled(job.id, dir);
			rmSync(job.statusFile, { force: true });
			writeFileSync(job.pidFile, String(pid));
			writeFileSync(
				world.files(job.id).identityFile,
				JSON.stringify({ pid }),
			);
			expect(await world.json(["cancel", job.id], dir)).toMatchObject({
				result: "already-finished",
				state: "unknown",
			});
			expect(isLive(pid)).toBe(true);
		} finally {
			writeFileSync(stop, "stop");
			setTimeout(() => sentinel.kill("SIGKILL"), 1000).unref();
			await exited;
		}
	});
});

describe("compiled dg-skills bg prune", () => {
	test("a prune of /repo removes its finished jobs and never touches /repo-other or live jobs", async () => {
		const base = world.dir();
		const repo = world.mkdir(join(base, "repo"));
		const other = world.mkdir(join(base, "repo-other"));
		const finished = await world.launch("echo repo-done", repo);
		const nested = await world.launch(
			"echo nested-done",
			world.mkdir(join(repo, "sub")),
		);
		const live = await world.launch("sleep 30", repo);
		const siblingDone = await world.launch("echo other-done", other);
		const siblingLive = await world.launch("sleep 30", other);
		for (const job of [finished, nested, siblingDone])
			await world.settled(job.id, base);

		const pruned = await world.json<{ removed: string[]; running: BgJob[] }>(
			["prune", "--cwd", repo],
			base,
		);
		expect(pruned.removed.sort()).toEqual([finished.id, nested.id].sort());
		expect(pruned.running.map((job) => job.id)).toEqual([live.id]);

		const { jobs } = await world.json<{ jobs: BgJob[] }>(["list"], base);
		expect(jobs.map((job) => job.id).sort()).toEqual(
			[live.id, siblingDone.id, siblingLive.id].sort(),
		);
		for (const job of [finished, nested])
			for (const file of [job.logFile, job.statusFile, job.pidFile])
				expect(existsSync(file)).toBe(false);
		for (const job of [live, siblingDone, siblingLive])
			expect(existsSync(job.logFile)).toBe(true);
		expect(isLive(live.launcherPid)).toBe(true);
		expect(isLive(siblingLive.launcherPid)).toBe(true);
	});

	test("a prune from outside any job cwd works and an empty tree reports nothing", async () => {
		const base = world.dir();
		const empty = world.mkdir(join(base, "empty"));
		expect(await world.json<unknown>(["prune", "--cwd", empty], base)).toEqual({
			prunedCwd: empty,
			removed: [],
			running: [],
		});
	});
});

describe("compiled dg-skills bg proxy jobs", () => {
	const run = (args: string[]) =>
		runProxyProcess([binary, "bg", ...args], installation);
	async function json(args: string[]) {
		const result = await run(args);
		expect(result.exitCode, result.stderr).toBe(0);
		return JSON.parse(result.stdout);
	}
	function proxyJobs(): BgJob[] {
		const root = join(installation.state, "bg");
		if (!existsSync(root)) return [];
		return readdirSync(root)
			.filter((name) => name.endsWith(".meta.json"))
			.map((name: string) =>
				JSON.parse(readFileSync(join(root, name), "utf8")),
			);
	}
	afterEach(async () => {
		for (const job of proxyJobs())
			if (isLive(job.launcherPid)) await run(["cancel", job.id]);
		rmSync(installation.calls, { force: true });
		rmSync(join(installation.state, "bg"), { recursive: true, force: true });
		rmSync(join(installation.scratch, "bg"), { recursive: true, force: true });
	});

	test("queues ordered context, drains once through the relocated binary and resumes the backend session", async () => {
		const gate = join(installation.root, "release ' gate");
		installation.fakeBackend("pi", { gate });
		const inner = shellCommand([
			binary,
			"proxy",
			"pi",
			"--prompt",
			"initial",
			"--model",
			"m ' x",
			"--effort",
			"high",
		]);
		const job: BgJob = await json(["run", inner, "--cwd", installation.root]);
		expect(job).toMatchObject({ kind: "proxy", proxyBackend: "pi" });
		await until(
			() => installation.readCalls(),
			(calls) => calls.length === 1,
		);

		const contexts = [
			"first ' context $HOME $(touch forbidden)",
			"second; context",
		];
		for (const context of contexts)
			expect(await json(["update", job.id, context])).toMatchObject({
				result: "queued",
			});
		expect(await json(["status", job.id])).toMatchObject({
			state: "running",
			pendingUpdate: contexts.join("\n"),
		});

		writeFileSync(gate, "release");
		const calls = await until(
			() => installation.readCalls(),
			(value) => value.length === 2,
		);
		expect(calls[1]).toEqual({
			args: [
				"--print",
				contexts.join("\n"),
				"--mode",
				"json",
				"--resume",
				"fixture-session",
				"--model",
				"m ' x",
				"--thinking",
				"high",
			],
			cwd: installation.root,
		});
		const settled = await until(
			() => json(["status", job.id]),
			(value) => value.state === "done" && value.drainOutput !== null,
		);
		expect(JSON.parse(settled.drainOutput)).toMatchObject({
			action: "drain",
			result: "resumed",
		});
		const resumed = proxyJobs().find((value) => value.id !== job.id) as BgJob;
		expect(resumed.command).toContain(shellCommand([binary]));
		expect(resumed.command).not.toMatch(/\$bunfs|~BUN/);
		expect(await json(["drain", job.id])).toMatchObject({
			result: "nothing-pending",
		});
		expect(existsSync(join(installation.root, "forbidden"))).toBe(false);
	}, 30_000);

	test("a proxy job with nothing queued drains to nothing-pending on its own", async () => {
		installation.fakeBackend("pi");
		const job: BgJob = await json([
			"run",
			shellCommand([binary, "proxy", "pi", "--prompt", "quick"]),
		]);
		const settled = await until(
			() => json(["status", job.id]),
			(value) => value.state === "done" && value.drainOutput !== null,
		);
		expect(JSON.parse(settled.drainOutput)).toMatchObject({
			result: "nothing-pending",
		});
		expect(installation.readCalls()).toHaveLength(1);
	});

	test("cancel on a live proxy job drops its queued context and prune then removes it", async () => {
		installation.fakeBackend("pi", {
			gate: join(installation.root, "never released"),
		});
		const job: BgJob = await json([
			"run",
			shellCommand([binary, "proxy", "pi", "--prompt", "wait"]),
			"--cwd",
			installation.root,
		]);
		await until(
			() => installation.readCalls(),
			(calls) => calls.length === 1,
		);
		await json(["update", job.id, "never resume"]);
		const retained = await json(["prune", "--cwd", installation.root]);
		expect(retained.removed).toEqual([]);
		expect(retained.running.map((value: BgJob) => value.id)).toEqual([job.id]);
		expect(await json(["cancel", job.id])).toMatchObject({
			result: "canceled",
		});
		await until(
			() => isLive(job.launcherPid),
			(live) => !live,
		);
		expect(await json(["drain", job.id])).toMatchObject({ result: "canceled" });
		expect(await json(["status", job.id])).toMatchObject({
			state: "canceled",
			pendingUpdate: null,
		});
		expect(installation.readCalls()).toHaveLength(1);
		expect((await json(["prune", "--cwd", installation.root])).removed).toEqual(
			[job.id],
		);
	}, 20_000);
});

describe("compiled dg-skills bg from an external cwd", () => {
	test("--help runs with only sh on PATH and starts nothing", async () => {
		const result = await runProxyProcess(
			[binary, "bg", "--help"],
			installation,
		);
		expect(result.exitCode, result.stderr).toBe(0);
		for (const verb of ["run", "list", "prune", "status", "cancel", "update"])
			expect(result.stdout).toMatch(new RegExp(`^  ${verb}(?: |$)`, "m"));
		expect(existsSync(join(installation.state, "bg"))).toBe(false);
	});
});
