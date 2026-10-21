import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { BACKENDS, type BackendName, withPersona } from "../src/proxy/index";
import { shellCommand } from "@dg/common/node";
import {
	compileProxyCli,
	proxyFixtures,
	runProxyProcess,
} from "./proxy-fixtures";

let installation: ReturnType<typeof proxyFixtures>;
let fixture: ReturnType<typeof proxyFixtures>;
let binary: string;
beforeAll(() => {
	installation = proxyFixtures();
	binary = compileProxyCli(installation);
}, 120000);
afterAll(() => installation.cleanup());
beforeEach(() => {
	fixture = proxyFixtures();
});

interface Job {
	id: string;
	launcherPid: number;
	logFile: string;
	statusFile: string;
	pidFile: string;
	kind: string;
	state: string;
	exitCode: number | null;
	pendingUpdate: string | null;
}
const ALIAS_VERBS = new Set(["run", "status", "cancel"]);
const run = (args: string[]) =>
	runProxyProcess(
		args[0] === "background" && !ALIAS_VERBS.has(args[1] ?? "")
			? [binary, "bg", ...args.slice(1)]
			: [binary, "proxy", ...args],
		fixture,
	);
async function json(args: string[]) {
	const result = await run(args);
	expect(result.exitCode, result.stderr).toBe(0);
	return JSON.parse(result.stdout);
}
async function until<T>(
	read: () => T,
	ready: (value: T) => boolean,
): Promise<T> {
	const deadline = Date.now() + 10000;
	let value = read();
	while (!ready(value) && Date.now() < deadline) {
		await Bun.sleep(20);
		value = read();
	}
	expect(ready(value), "condition did not settle before timeout").toBe(true);
	return value;
}
function live(pid: number): boolean {
	try {
		if (
			process.platform === "linux" &&
			/^\S+ \(.+\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
		)
			return false;
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function jobs(): Job[] {
	const root = join(fixture.state, "bg");
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((name) => name.endsWith(".meta.json"))
		.map((name) => JSON.parse(readFileSync(join(root, name), "utf8")));
}

function lockOwner(
	id: string,
	owner: { pid: number; nonce: string; started?: string },
) {
	const directory = join(fixture.scratch, "bg", `${id}.lock`);
	mkdirSync(directory, { recursive: true });
	const file = join(directory, `${owner.nonce}.json`);
	writeFileSync(file, JSON.stringify(owner));
	return { directory, file };
}

async function deadOwnerPid(): Promise<number> {
	const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
		env: fixture.env(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	await child.exited;
	return child.pid;
}
async function finished(job: Job) {
	await until(
		() =>
			existsSync(job.statusFile)
				? readFileSync(job.statusFile, "utf8").trim()
				: "",
		(value) => value !== "",
	);
	await until(
		() => live(job.launcherPid),
		(value) => !value,
	);
	return json(["background", "status", job.id]);
}
afterEach(async () => {
	try {
		for (const job of jobs()) {
			if (live(job.launcherPid)) await run(["background", "cancel", job.id]);
			await until(
				() => live(job.launcherPid),
				(value) => !value,
			);
		}
	} finally {
		fixture.cleanup();
	}
});

describe("compiled proxy background", () => {
	test.each([
		"missing",
		"malformed",
		"mismatched-pid",
		...(process.platform === "linux"
			? ["missing-birth", "mismatched-birth"]
			: []),
	])(
		"does not cancel an unrelated detached sentinel with %s identity evidence",
		async (evidence) => {
			const ready = join(fixture.root, `${evidence}.sentinel.ready`);
			const stop = join(fixture.root, `${evidence}.sentinel.stop`);
			const sentinel = spawn(
				process.execPath,
				[
					"-e",
					`import { existsSync, writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, String(process.pid)); while (!existsSync(${JSON.stringify(stop)})) await Bun.sleep(10);`,
				],
				{
					detached: true,
					stdio: "ignore",
					env: fixture.env(),
				},
			);
			const exited = new Promise<void>((resolve, reject) => {
				sentinel.once("exit", () => resolve());
				sentinel.once("error", reject);
			});
			try {
				await until(() => existsSync(ready), Boolean);
				const pid = Number(readFileSync(ready, "utf8"));
				const job: Job = await json(["background", "run", ":"]);
				await finished(job);
				rmSync(job.statusFile);
				writeFileSync(job.pidFile, String(pid));
				const identity = join(fixture.scratch, "bg", `${job.id}.identity.json`);
				if (evidence === "missing") rmSync(identity);
				else if (evidence === "malformed") writeFileSync(identity, '{"pid":');
				else if (evidence === "mismatched-pid")
					writeFileSync(identity, JSON.stringify({ pid: job.launcherPid }));
				else
					writeFileSync(
						identity,
						JSON.stringify({
							pid,
							...(evidence === "mismatched-birth" ? { started: "0" } : {}),
						}),
					);
				expect(await json(["background", "cancel", job.id])).toMatchObject({
					result: "already-finished",
					state: "unknown",
				});
				expect(await json(["background", "status", job.id])).toMatchObject({
					state: "unknown",
				});
				expect(live(pid)).toBe(true);
			} finally {
				writeFileSync(stop, "stop");
				const deadline = setTimeout(() => sentinel.kill("SIGKILL"), 1000);
				try {
					await exited;
				} finally {
					clearTimeout(deadline);
				}
			}
		},
		15000,
	);

	test("recovers an empty abandoned lock directory", async () => {
		const id = "empty-owner";
		const directory = join(fixture.scratch, "bg", `${id}.lock`);
		mkdirSync(directory, { recursive: true });
		expect(await json(["background", "drain", id])).toMatchObject({
			result: "unknown",
		});
		expect(existsSync(directory)).toBe(false);
	});

	test("preserves a nonempty malformed lock and bounds the contention wait", async () => {
		const id = "malformed-owner";
		const directory = join(fixture.scratch, "bg", `${id}.lock`);
		mkdirSync(directory, { recursive: true });
		const file = join(directory, "partial.json");
		const partial = '{"pid":';
		writeFileSync(file, partial);
		const result = await run(["background", "drain", id]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("busy");
		expect(readFileSync(file, "utf8")).toBe(partial);
	}, 10000);

	test("recovers a lock only after its recorded owner has exited", async () => {
		const id = "stale-owner";
		const lock = lockOwner(id, {
			pid: await deadOwnerPid(),
			nonce: "dead-owner",
		});
		expect(await json(["background", "drain", id])).toMatchObject({
			result: "unknown",
		});
		expect(existsSync(lock.directory)).toBe(false);
	});

	test("recovers an unreadable populated lock once it is old enough to be abandoned", async () => {
		const id = "abandoned-malformed";
		const directory = join(fixture.scratch, "bg", `${id}.lock`);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "one.json"), "{");
		writeFileSync(join(directory, "two.json"), "{");
		const old = new Date(Date.now() - 5 * 60 * 1000);
		utimesSync(directory, old, old);
		expect(await json(["background", "drain", id])).toMatchObject({
			result: "unknown",
		});
		expect(existsSync(directory)).toBe(false);
	});

	test("keeps a live owner's lock and reports contention without stealing it", async () => {
		const id = "live-owner";
		const owner = { pid: process.pid, nonce: "live-owner" };
		const lock = lockOwner(id, owner);
		const result = await run(["background", "drain", id]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("busy");
		expect(JSON.parse(readFileSync(lock.file, "utf8"))).toEqual(owner);
	}, 10000);

	test("releases only its own lock when another owner replaces it during cancellation", async () => {
		const backendPid = join(fixture.root, "backend.pid");
		fixture.fakeBackend("pi", {
			gate: join(fixture.root, "never released"),
			ignoreTerm: true,
			pidFile: backendPid,
		});
		const job: Job = await json([
			"background",
			"run",
			shellCommand([binary, "proxy", "pi", "--prompt", "wait"]),
		]);
		await until(
			() => fixture.readCalls(),
			(calls) => calls.length === 1,
		);
		const cancel = run(["background", "cancel", job.id]);
		const directory = join(fixture.scratch, "bg", `${job.id}.lock`);
		await until(() => existsSync(directory), Boolean);
		renameSync(directory, `${directory}.previous-owner`);
		const replacement = { pid: process.pid, nonce: "replacement-live-owner" };
		const lock = lockOwner(job.id, replacement);
		const result = await cancel;
		expect(result.exitCode, result.stderr).toBe(0);
		expect(JSON.parse(readFileSync(lock.file, "utf8"))).toEqual(replacement);
		await until(
			() => live(Number(readFileSync(backendPid, "utf8"))),
			(value) => !value,
		);
	}, 10000);

	test("the proxy background alias reads the same job registry as bg", async () => {
		const job: Job = await json(["background", "run", ":"]);
		await finished(job);
		const viaAlias = await runProxyProcess(
			[binary, "proxy", "background", "list"],
			fixture,
		);
		expect(viaAlias.exitCode, viaAlias.stderr).toBe(0);
		expect(
			JSON.parse(viaAlias.stdout).jobs.map((value: Job) => value.id),
		).toEqual([job.id]);
		const viaBg = await runProxyProcess([binary, "bg", "list"], fixture);
		expect(JSON.parse(viaBg.stdout)).toEqual(JSON.parse(viaAlias.stdout));
	});

	test("lists the five public backend identities from the relocated executable", async () => {
		const result = await run(["--list-backends"]);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual([
			"codex",
			"copilot",
			"pi",
			"opencode",
			"grok",
		]);
	});

	test.each(Object.keys(BACKENDS) as BackendName[])(
		"executes %s through the compiled command with output and cwd parity",
		async (name) => {
			fixture.fakeBackend(name);
			const prompt = "preserve ' quotes, spaces; $HOME $(touch forbidden)";
			const input = { prompt, model: "model ' spaced", effort: "high" };
			const result = await run([
				name,
				"--prompt",
				prompt,
				"--model",
				input.model,
				"--effort",
				input.effort,
				"--cwd",
				fixture.root,
			]);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({
				sessionId: "fixture-session",
				message: "fixture done",
				exitCode: 0,
			});
			expect(fixture.readCalls()).toEqual([
				{ args: BACKENDS[name].buildArgs(input), cwd: fixture.root },
			]);
			expect(existsSync(join(fixture.root, "forbidden"))).toBe(false);
		},
	);

	test("runs a compiled generated plan after relocation without wrapping the persona twice", async () => {
		fixture.fakeBackend("pi");
		const directory = join(fixture.home, ".claude", "agents");
		mkdirSync(directory, { recursive: true });
		const persona = "A unique test role with ' quoted instructions.";
		writeFileSync(join(directory, "fixture-role.md"), persona);
		const prompt = "task ' quoted $HOME $(touch forbidden)";
		const plan = await json([
			"pi",
			"--prompt",
			prompt,
			"--subagent",
			"fixture-role",
			"--plan",
			"--cwd",
			fixture.root,
			"--model",
			"model ' with spaces",
			"--effort",
			"high",
		]);
		expect(readFileSync(plan.planFile, "utf8")).toBe(
			withPersona(persona, prompt),
		);
		expect(fixture.readCalls()).toEqual([]);
		expect(plan.command).not.toMatch(/\$bunfs|~BUN|\/src\/index/);
		expect(plan.command).toContain(shellCommand([binary, "bg", "run"]));
		expect(plan.command).not.toContain("'background'");
		const launched = await runProxyProcess(
			["/bin/sh", "-c", plan.command],
			fixture,
		);
		expect(launched.exitCode, launched.stderr).toBe(0);
		const job: Job = JSON.parse(launched.stdout);
		expect(await finished(job)).toMatchObject({
			kind: "proxy",
			state: "done",
			exitCode: 0,
		});
		expect(fixture.readCalls()).toEqual([
			{
				args: BACKENDS.pi.buildArgs({
					prompt: withPersona(persona, prompt),
					model: "model ' with spaces",
					effort: "high",
				}),
				cwd: fixture.root,
			},
		]);
		expect(existsSync(join(fixture.root, "forbidden"))).toBe(false);
	}, 20000);

	test("list and status skip a truncated meta file instead of failing for every job", async () => {
		const job: Job = await json(["background", "run", ":"]);
		await finished(job);
		const truncated = join(fixture.state, "bg", "truncated.meta.json");
		writeFileSync(truncated, '{"id":');
		const listed = await json(["background", "list"]);
		expect(listed.jobs.map((value: Job) => value.id)).toEqual([job.id]);
		expect(await json(["background", "status", job.id])).toMatchObject({
			drainOutput: null,
		});
		expect(
			await json(["background", "prune", "--cwd", fixture.root]),
		).toMatchObject({ removed: [job.id] });
		rmSync(truncated);
	});

	test("status surfaces the output a failed drain left behind", async () => {
		const job: Job = await json(["background", "run", ":"]);
		await finished(job);
		writeFileSync(
			join(fixture.state, "bg", `${job.id}.drain.log`),
			'{"result":"no-session"}\n',
		);
		expect(await json(["background", "status", job.id])).toMatchObject({
			drainOutput: '{"result":"no-session"}',
		});
	});

	test.each(["status", "cancel", "update", "drain"])(
		"%s rejects a job id that escapes the job directory",
		async (subcommand) => {
			const args =
				subcommand === "update"
					? ["background", subcommand, "../escape", "context"]
					: ["background", subcommand, "../escape"];
			const result = await run(args);
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("invalid job id");
		},
	);

	test("prune skips a meta file whose id is not a safe job name", async () => {
		const victim = join(fixture.root, "victim.log");
		writeFileSync(victim, "keep");
		const dir = join(fixture.state, "bg");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "evil.meta.json"),
			JSON.stringify({
				id: "../../victim",
				command: ":",
				cwd: fixture.root,
				startedAt: new Date().toISOString(),
				kind: "shell",
			}),
		);
		expect(
			await json(["background", "prune", "--cwd", fixture.root]),
		).toMatchObject({ removed: [] });
		expect(existsSync(victim)).toBe(true);
	});

	test("run rejects a command split across several arguments", async () => {
		const result = await run(["background", "run", "sh", "-c", "echo hi"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("one quoted argument");
		expect(jobs()).toEqual([]);
	});

	test("queues ordered context, automatically drains once, and resumes the actual backend session", async () => {
		const gate = join(fixture.root, "release ' gate");
		fixture.fakeBackend("pi", { gate });
		const command = shellCommand([
			binary,
			"proxy",
			"pi",
			"--prompt",
			"initial task",
			"--model",
			"fixture ' model",
			"--effort",
			"high",
		]);
		const job: Job = await json([
			"background",
			"run",
			command,
			"--cwd",
			fixture.root,
		]);
		await until(
			() => fixture.readCalls(),
			(calls) => calls.length === 1,
		);
		expect(live(job.launcherPid)).toBe(true);
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${job.launcherPid}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			expect(Number(fields[2])).toBe(job.launcherPid);
		}
		const contexts = [
			"first ' context $HOME $(touch forbidden)",
			"second; context with spaces",
		];
		for (const context of contexts)
			expect(
				await json(["background", "update", job.id, context]),
			).toMatchObject({ result: "queued" });
		expect(await json(["background", "status", job.id])).toMatchObject({
			state: "running",
			pendingUpdate: contexts.join("\n"),
		});
		writeFileSync(gate, "release");
		await finished(job);
		const calls = await until(
			() => fixture.readCalls(),
			(value) => value.length === 2,
		);
		expect(calls[1]).toEqual({
			args: BACKENDS.pi.buildArgs({
				prompt: contexts.join("\n"),
				resume: "fixture-session",
				model: "fixture ' model",
				effort: "high",
			}),
			cwd: fixture.root,
		});
		const resumed = jobs().find((value) => value.id !== job.id);
		expect(resumed).toBeDefined();
		if (!resumed) return;
		await finished(resumed);
		expect(await json(["background", "drain", job.id])).toMatchObject({
			result: "nothing-pending",
		});
		expect(fixture.readCalls()).toHaveLength(2);
		expect(await json(["background", "status", job.id])).toMatchObject({
			pendingUpdate: null,
		});
		const pruned = await json(["background", "prune", "--cwd", fixture.root]);
		expect(pruned.removed.sort()).toEqual([job.id, resumed.id].sort());
		expect((await json(["background", "list"])).jobs).toEqual([]);
		for (const finishedJob of [job, resumed])
			for (const path of [
				finishedJob.logFile,
				finishedJob.statusFile,
				finishedJob.pidFile,
			])
				expect(existsSync(path)).toBe(false);
		expect(existsSync(join(fixture.root, "forbidden"))).toBe(false);
	}, 25000);

	test("preserves a live job during prune, cancels its group, and drops queued context", async () => {
		fixture.fakeBackend("pi", { gate: join(fixture.root, "never released") });
		const job: Job = await json([
			"background",
			"run",
			shellCommand([binary, "proxy", "pi", "--prompt", "wait"]),
			"--cwd",
			fixture.root,
		]);
		await until(
			() => fixture.readCalls(),
			(calls) => calls.length === 1,
		);
		await json(["background", "update", job.id, "never resume"]);
		const retained = await json(["background", "prune", "--cwd", fixture.root]);
		expect(retained.removed).toEqual([]);
		expect(retained.running.map((value: Job) => value.id)).toEqual([job.id]);
		expect(await json(["background", "cancel", job.id])).toMatchObject({
			result: "canceled",
		});
		await until(
			() => live(job.launcherPid),
			(value) => !value,
		);
		expect(await json(["background", "drain", job.id])).toMatchObject({
			result: "canceled",
		});
		expect(await json(["background", "status", job.id])).toMatchObject({
			state: "canceled",
			pendingUpdate: null,
		});
		expect(await json(["background", "update", job.id, "later"])).toMatchObject(
			{ result: "canceled-job" },
		);
		expect(fixture.readCalls()).toHaveLength(1);
		expect(
			(await json(["background", "prune", "--cwd", fixture.root])).removed,
		).toEqual([job.id]);
	}, 15000);

	test.each([7, 124])(
		"records backend exit %i and structured failure details for detached jobs",
		async (exitCode) => {
			fixture.fakeBackend("pi", { exitCode });
			const job: Job = await json([
				"background",
				"run",
				shellCommand([binary, "proxy", "pi", "--prompt", "fail"]),
			]);
			expect(await finished(job)).toMatchObject({ state: "done", exitCode });
			const result = readFileSync(job.logFile, "utf8")
				.trim()
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line))
				.at(-1);
			expect(result).toMatchObject({
				exitCode,
				stderrTail: "unknown model rejected",
				likelyCause: "model",
			});
		},
	);
});
