import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processIdentity } from "../src/bg/jobs";
import { main, readPid, terminateGroup } from "../src/proxy/background";
import { proxyFixtures } from "./proxy-fixtures";

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const savedEnv = {
	AI_SCRATCH_DIR: process.env.AI_SCRATCH_DIR,
	AI_STATE_DIR: process.env.AI_STATE_DIR,
};
let fixture: ReturnType<typeof proxyFixtures>;
let child: ChildProcess | undefined;

function setPlatform(value: string) {
	Object.defineProperty(process, "platform", { value });
}

beforeEach(() => {
	fixture = proxyFixtures();
	process.env.AI_SCRATCH_DIR = fixture.scratch;
	process.env.AI_STATE_DIR = fixture.state;
});

afterEach(() => {
	if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (child?.pid) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}
	child = undefined;
	fixture.cleanup();
});

function detachedSleeper(): number {
	child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
		detached: true,
		stdio: "ignore",
	});
	if (!child.pid) throw new Error("fixture process did not start");
	return child.pid;
}

function recordJob(id: string, pid: number, started = "12345") {
	const dir = join(fixture.scratch, "bg");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const pidFile = join(dir, `${id}.pid`);
	writeFileSync(pidFile, String(pid));
	writeFileSync(
		join(dir, `${id}.identity.json`),
		JSON.stringify({ pid, started }),
	);
	return { pidFile, id };
}

describe("background pid identity off Linux", () => {
	test("readPid returns the pid when the recorded start time matches", () => {
		const pid = detachedSleeper();
		setPlatform("darwin");
		const identity = processIdentity(pid);
		expect(identity?.group).toBe(pid);
		const job = recordJob("offlinux", pid, identity?.started);
		expect(readPid(job as never)).toBe(pid);
	});

	test("readPid returns null when the recorded start time differs", () => {
		const pid = detachedSleeper();
		const job = recordJob("offlinux", pid);
		setPlatform("darwin");
		expect(readPid(job as never)).toBeNull();
	});

	test("prune keeps the records of a live job whose state reads unknown", async () => {
		const pid = detachedSleeper();
		const job = recordJob("offlinux", pid);
		const stateDir = join(fixture.state, "bg");
		mkdirSync(stateDir, { recursive: true });
		const metaFile = join(stateDir, "offlinux.meta.json");
		writeFileSync(
			metaFile,
			JSON.stringify({
				id: job.id,
				command: ":",
				cwd: fixture.root,
				startedAt: new Date().toISOString(),
				pidFile: job.pidFile,
				launcherPid: pid,
				kind: "command",
			}),
		);
		setPlatform("darwin");
		const write = process.stdout.write.bind(process.stdout);
		const exit = process.exit;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		process.exit = (() => {
			throw new Error("exit");
		}) as typeof process.exit;
		try {
			await main(["prune", "--cwd", fixture.root]).catch(() => undefined);
		} finally {
			process.stdout.write = write;
			process.exit = exit;
		}
		expect(existsSync(metaFile)).toBe(true);
		expect(existsSync(job.pidFile)).toBe(true);
	});

	test("terminateGroup signals the detached group off Linux", async () => {
		const pid = detachedSleeper();
		setPlatform("darwin");
		expect(await terminateGroup(pid)).toBe("SIGTERM");
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test("terminateGroup refuses a process that leads no group of its own", async () => {
		setPlatform("darwin");
		await expect(terminateGroup(process.pid)).rejects.toThrow(
			/Refusing to signal/,
		);
	});
});
