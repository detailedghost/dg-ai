import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../src/runners/spawn";

const OUTPUT_CAP_BYTES = 5 * 1024 * 1024;
const TAIL_BYTES = 8 * 1024;

let dir: string;
let scriptCount = 0;
const strayPids: number[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "runners-spawn-"));
});

afterEach(() => {
	for (const pid of strayPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			continue;
		}
	}
	rmSync(dir, { recursive: true, force: true });
});

function script(body: string): string {
	scriptCount += 1;
	const path = join(dir, `child-${scriptCount}.mjs`);
	writeFileSync(path, body);
	return path;
}

function request(
	argv: string[],
	overrides: Partial<Parameters<typeof runProcess>[0]> = {},
): Parameters<typeof runProcess>[0] {
	return {
		argv,
		cwd: join(dir, "work"),
		timeoutMs: 30_000,
		logPath: join(dir, "logs", "job.log"),
		signal: new AbortController().signal,
		...overrides,
	};
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
	} catch {
		const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
			encoding: "utf8",
		}).stdout.trim();
		return stat !== "" && !stat.startsWith("Z");
	}
}

async function waitDead(pid: number, withinMs = 3000): Promise<boolean> {
	const deadline = Date.now() + withinMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await Bun.sleep(25);
	}
	return !isAlive(pid);
}

function loggedPid(logPath: string, label: string): number {
	const match = readFileSync(logPath, "utf8").match(
		new RegExp(`${label}=(\\d+)`),
	);
	if (!match) throw new Error(`no ${label} pid in log`);
	const pid = Number(match[1]);
	strayPids.push(pid);
	return pid;
}

const SLEEPY_GRANDCHILD = `
import { spawn } from "node:child_process";
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write("grandchild=" + grandchild.pid + "\\n");
`;

describe("runProcess", () => {
	test("resolves status 0 and reports the child pid through onSpawn", async () => {
		const child = script(`console.log("pid=" + process.pid);`);
		const pids: number[] = [];
		const req = request([process.execPath, child], {
			onSpawn: (pid: number) => pids.push(pid),
		});
		const result = await runProcess(req);
		expect(result).toMatchObject({
			status: 0,
			timedOut: false,
			aborted: false,
		});
		expect(pids).toHaveLength(1);
		expect(pids[0]).toBe(loggedPid(req.logPath, "pid"));
	});

	test("resolves the nonzero exit status of the child", async () => {
		const child = script("process.exit(3);");
		const result = await runProcess(request([process.execPath, child]));
		expect(result).toMatchObject({ status: 3, timedOut: false });
	});

	test("appends stdout and stderr of the child to the log", async () => {
		const child = script(
			`console.log("to-stdout"); console.error("to-stderr");`,
		);
		const req = request([process.execPath, child]);
		await runProcess(req);
		const log = readFileSync(req.logPath, "utf8");
		expect(log).toContain("to-stdout");
		expect(log).toContain("to-stderr");
	});

	test("appends to a log that already has content", async () => {
		const child = script(`console.log("second-run");`);
		const req = request([process.execPath, child]);
		await runProcess(req);
		await runProcess(req);
		const log = readFileSync(req.logPath, "utf8");
		expect(log.match(/second-run/g)).toHaveLength(2);
	});

	test("creates cwd and the log directory with mode 0700 when missing", async () => {
		const child = script("");
		const req = request([process.execPath, child]);
		await runProcess(req);
		expect(statSync(req.cwd).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "logs")).mode & 0o777).toBe(0o700);
	});

	test("runs the child in cwd", async () => {
		const child = script(`console.log("cwd=" + process.cwd());`);
		const req = request([process.execPath, child]);
		await runProcess(req);
		const expected = join(dir, "work");
		expect(readFileSync(req.logPath, "utf8")).toContain(`cwd=${expected}`);
	});

	test("passes every argv element verbatim without a shell", async () => {
		const child = script(
			`console.log("argv=" + JSON.stringify(process.argv.slice(2)));`,
		);
		const hostile = ["a b", "$(whoami)", "x; rm -rf /", "*"];
		const req = request([process.execPath, child, ...hostile]);
		await runProcess(req);
		expect(readFileSync(req.logPath, "utf8")).toContain(
			`argv=${JSON.stringify(hostile)}`,
		);
	});

	test("closes stdin so a child that reads it sees end of input", async () => {
		const child = script(
			`const text = await Bun.stdin.text(); console.log("stdin-length=" + text.length);`,
		);
		const req = request([process.execPath, child]);
		const result = await runProcess(req);
		expect(result.status).toBe(0);
		expect(readFileSync(req.logPath, "utf8")).toContain("stdin-length=0");
	});

	test("keeps the last 8 KB of stderr as stderrTail", async () => {
		const child = script(
			`process.stderr.write("A".repeat(20000) + "END");`,
		);
		const result = await runProcess(request([process.execPath, child]));
		expect(result.stderrTail.length).toBeLessThanOrEqual(TAIL_BYTES);
		expect(result.stderrTail.endsWith("END")).toBe(true);
		expect(result.stderrTail.startsWith("A")).toBe(true);
	});

	test("keeps stderr and leaves stdout out of stderrTail", async () => {
		const child = script(
			`console.log("auth says log in"); console.error("stderr-line");`,
		);
		const result = await runProcess(request([process.execPath, child]));
		expect(result.stderrTail).toContain("stderr-line");
		expect(result.stderrTail).not.toContain("auth says log in");
	});

	test.skipIf(process.platform !== "linux")("keeps draining and resolves when a log write fails (linux only: /dev/full)", async () => {
		const child = script(`
console.log("out-1");
console.error("err-1");
await new Promise((r) => setTimeout(r, 100));
console.error("err-2");
`);
		const result = await runProcess(
			request([process.execPath, child], { logPath: "/dev/full" }),
		);
		expect(result.status).toBe(0);
		expect(result.stderrTail).toContain("err-2");
	});

	test("drops output past one 5 MB cap across both streams while the child keeps running", async () => {
		const child = script(`
const chunk = "x".repeat(1024 * 1024);
for (let i = 0; i < 4; i++) await new Promise((r) => process.stdout.write(chunk, r));
for (let i = 0; i < 3; i++) await new Promise((r) => process.stderr.write(chunk, r));
process.exit(0);
`);
		const req = request([process.execPath, child]);
		const result = await runProcess(req);
		expect(result.status).toBe(0);
		const size = statSync(req.logPath).size;
		expect(size).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
		expect(size).toBeGreaterThan(OUTPUT_CAP_BYTES - 1024 * 1024);
	});

	test("removes Claude and agent variables from the child env and keeps the rest", async () => {
		const removed = [
			"CLAUDECODE",
			"CLAUDE_CODE_SESSION_ID",
			"CLAUDE_CODE_ENTRYPOINT",
			"CLAUDE_PID",
			"CLAUDE_EFFORT",
			"AI_AGENT",
		];
		const saved = new Map<string, string | undefined>();
		for (const key of [...removed, "CHANNEL_REVIEW_KEEP", "CLAUDE_CODE_OAUTH_TOKEN"]) {
			saved.set(key, process.env[key]);
			process.env[key] = "set";
		}
		try {
			const child = script(
				`console.log("env=" + JSON.stringify(Object.keys(process.env)));`,
			);
			const req = request([process.execPath, child]);
			await runProcess(req);
			const line = readFileSync(req.logPath, "utf8").match(/env=(.*)/);
			const keys: string[] = JSON.parse(line?.[1] ?? "[]");
			expect(keys.filter((key) => key.startsWith("CLAUDE_CODE_"))).toEqual([]);
			for (const key of removed) expect(keys).not.toContain(key);
			expect(keys).toContain("CHANNEL_REVIEW_KEEP");
			expect(keys).toContain("PATH");
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test("keeps CLAUDE_CODE_OAUTH_TOKEN only when keepOauthToken is set", async () => {
		const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "set";
		try {
			const child = script(
				`console.log("has=" + ("CLAUDE_CODE_OAUTH_TOKEN" in process.env));`,
			);
			const kept = request([process.execPath, child], { keepOauthToken: true });
			await runProcess(kept);
			expect(readFileSync(kept.logPath, "utf8")).toContain("has=true");
			const dropped = request([process.execPath, child], {
				logPath: join(dir, "logs", "dropped.log"),
			});
			await runProcess(dropped);
			expect(readFileSync(dropped.logPath, "utf8")).toContain("has=false");
		} finally {
			if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
			else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
		}
	});

	test("kills the process tree when onSpawn throws", async () => {
		const child = script(`console.log("pid=" + process.pid); setInterval(() => {}, 1000);`);
		const pids: number[] = [];
		const req = request([process.execPath, child], {
			onSpawn: (pid) => {
				pids.push(pid);
				throw new Error("onSpawn failed");
			},
		});
		strayPids.push(...pids);
		await expect(runProcess(req)).rejects.toThrow("onSpawn failed");
		strayPids.push(...pids);
		expect(await waitDead(pids[0] as number)).toBe(true);
	});

	test("maps a missing binary to code CR-201 without throwing", async () => {
		const result = await runProcess(
			request([join(dir, "no-such-binary")]),
		);
		expect(result.code).toBe("CR-201");
		expect(result.status).toBeNull();
		expect(result.timedOut).toBe(false);
	});
});

describe("runProcess termination", () => {
	test("kills a SIGTERM-ignoring child and its group within 2 s of the timeout", async () => {
		const child = script(`
process.on("SIGTERM", () => {});
${SLEEPY_GRANDCHILD}
setInterval(() => {}, 1000);
`);
		const req = request([process.execPath, child], { timeoutMs: 1000 });
		const started = Date.now();
		const result = await runProcess(req);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(result.timedOut).toBe(true);
		expect(result.aborted).toBe(false);
		const grandchild = loggedPid(req.logPath, "grandchild");
		expect(await waitDead(grandchild)).toBe(true);
	});

	test("kills the process group with SIGKILL on a negative pid on POSIX", async () => {
		const child = script("setInterval(() => {}, 1000);");
		const kills: [number, string | number | undefined][] = [];
		let pid = 0;
		const req = request([process.execPath, child], {
			timeoutMs: 300,
			platform: "linux",
			onSpawn: (spawned: number) => {
				pid = spawned;
			},
			kill: (target: number, signal?: string | number) => {
				kills.push([target, signal]);
				process.kill(target, signal);
			},
		});
		const result = await runProcess(req);
		expect(result.timedOut).toBe(true);
		expect(kills).toContainEqual([-pid, "SIGKILL"]);
	});

	test("resolves aborted true and kills the tree when the signal aborts", async () => {
		const child = script(`${SLEEPY_GRANDCHILD}
setInterval(() => {}, 1000);`);
		const controller = new AbortController();
		const req = request([process.execPath, child], {
			signal: controller.signal,
			onSpawn: () => {
				setTimeout(() => controller.abort(), 300);
			},
		});
		const result = await runProcess(req);
		expect(result.aborted).toBe(true);
		expect(result.timedOut).toBe(false);
		expect(await waitDead(loggedPid(req.logPath, "grandchild"))).toBe(true);
	});

	test("kills the tree after a normal exit so a grandchild does not outlive the run", async () => {
		const child = script(`${SLEEPY_GRANDCHILD}
await Bun.sleep(300);
process.exit(0);`);
		const req = request([process.execPath, child]);
		const result = await runProcess(req);
		expect(result.status).toBe(0);
		expect(await waitDead(loggedPid(req.logPath, "grandchild"))).toBe(true);
	});

	test("stops waiting for the drain within the grace when a detached grandchild holds the pipe", async () => {
		const child = script(`
import { spawn } from "node:child_process";
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], { stdio: "inherit", detached: true });
process.stdout.write("grandchild=" + grandchild.pid + "\\n");
grandchild.unref();
`);
		const req = request([process.execPath, child]);
		const started = Date.now();
		const result = await runProcess(req);
		const elapsed = Date.now() - started;
		loggedPid(req.logPath, "grandchild");
		expect(result.status).toBe(0);
		expect(elapsed).toBeLessThan(4500);
	});

	test("tolerates ESRCH when the tree kill finds the tree already gone", async () => {
		const child = script("await Bun.sleep(1200);");
		const req = request([process.execPath, child], {
			timeoutMs: 200,
			platform: "linux",
			kill: () => {
				throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
			},
		});
		const result = await runProcess(req);
		expect(result.timedOut).toBe(true);
	});

	test("rejects before spawning when the log file cannot be opened", async () => {
		const marker = join(dir, "spawned");
		const child = script(
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x"); await Bun.sleep(30000);`,
		);
		await expect(
			runProcess(request([process.execPath, child], { logPath: dir })),
		).rejects.toThrow();
		await Bun.sleep(300);
		expect(existsSync(marker)).toBe(false);
	});

	test("kills the tree with taskkill /T /F /PID through the platform seam on win32", async () => {
		const child = script("await Bun.sleep(1200);");
		const calls: { command: string; args: string[] }[] = [];
		let pid = 0;
		const req = request([process.execPath, child], {
			timeoutMs: 200,
			platform: "win32",
			onSpawn: (spawned: number) => {
				pid = spawned;
			},
			exec: (command: string, args: string[]) => {
				calls.push({ command, args });
			},
		});
		const result = await runProcess(req);
		expect(result.timedOut).toBe(true);
		expect(calls).toContainEqual({
			command: "taskkill",
			args: ["/T", "/F", "/PID", String(pid)],
		});
		expect(existsSync(req.logPath)).toBe(true);
	});
});
