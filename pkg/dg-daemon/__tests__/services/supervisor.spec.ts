import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wait } from "@dg/common";
import {
	BACKOFF_MAX_MS,
	createSupervisor,
	exponentialBackoffMs,
	type ServiceStatus,
	type Supervisor,
} from "../../src/services/supervisor";

const roots: string[] = [];
const supervisors: Supervisor[] = [];

afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((s) => s.stopAll()));
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

const SLEEPER = "setInterval(() => {}, 1000);";

type Kit = {
	root: string;
	script: (source: string) => string[];
};

type Fixture = Kit & {
	supervisor: Supervisor;
	logFile: string;
	pidFile: string;
	status: (label?: string) => ServiceStatus;
};

function fixture(build: (kit: Kit) => Record<string, unknown>): Fixture {
	const root = mkdtempSync(join(tmpdir(), "dg-svc-"));
	roots.push(root);
	const kit: Kit = {
		root,
		script: (source) => {
			const path = join(root, `script-${roots.length}-${Date.now()}.js`);
			writeFileSync(path, source);
			return [process.execPath, path];
		},
	};
	const services = build(kit);
	const supervisor = createSupervisor({
		paths: { daemonDir: join(root, "daemon"), logDir: join(root, "logs") },
		loadConfig: () => ({ services }),
		logger: { info: () => {}, warn: () => {} },
		backoffMs: () => 25,
		stopGraceMs: 500,
	});
	supervisors.push(supervisor);
	return {
		...kit,
		supervisor,
		logFile: join(root, "logs", "service-bot.log"),
		pidFile: join(root, "daemon", "services", "bot.pid"),
		status: (label = "bot") =>
			supervisor
				.status()
				.find((entry) => entry.label === label) as ServiceStatus,
	};
}

const botRunning = (source: string, extra: Record<string, unknown> = {}) =>
	fixture(({ root, script }) => ({
		bot: { argv: script(source), cwd: root, ...extra },
	}));

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await wait(20);
	}
}

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("exponentialBackoffMs", () => {
	it("doubles per consecutive failure and caps", () => {
		expect([1, 2, 3, 4].map(exponentialBackoffMs)).toEqual([
			1000, 2000, 4000, 8000,
		]);
		expect(exponentialBackoffMs(50)).toBe(BACKOFF_MAX_MS);
	});
});

describe("createSupervisor", () => {
	it("streams a script's output to its log file and stops it with its pid file", async () => {
		const f = botRunning(`console.log("hello from bot"); ${SLEEPER}`);
		expect(f.supervisor.start("bot").ok).toBe(true);
		await until(
			() =>
				existsSync(f.logFile) &&
				readFileSync(f.logFile, "utf8").includes("hello from bot"),
		);
		const running = f.status();
		expect(running.state).toBe("running");
		expect(existsSync(f.pidFile)).toBe(true);

		const stopped = await f.supervisor.stop("bot");
		expect(stopped.ok && stopped.status.state).toBe("stopped");
		expect(isAlive(running.pid as number)).toBe(false);
		expect(existsSync(f.pidFile)).toBe(false);
	});

	it("refuses an undeclared label and spawns nothing", () => {
		const f = botRunning(SLEEPER);
		expect(f.supervisor.start("rm-rf")).toMatchObject({
			ok: false,
			kind: "unknown",
		});
		expect(f.supervisor.runningCount()).toBe(0);
	});

	it("refuses a declared entry that is invalid", () => {
		const f = fixture(() => ({ bot: { argv: "bot --run", cwd: tmpdir() } }));
		expect(f.supervisor.start("bot")).toMatchObject({
			ok: false,
			kind: "invalid",
		});
	});

	it("refuses a missing cwd and an unresolvable executable", () => {
		const f = fixture(() => ({
			nocwd: { argv: [process.execPath], cwd: "/no/such/dir" },
			noexe: { argv: ["dg-no-such-binary"], cwd: tmpdir() },
		}));
		expect(f.supervisor.start("nocwd")).toMatchObject({
			ok: false,
			kind: "invalid",
		});
		expect(f.supervisor.start("noexe")).toMatchObject({
			ok: false,
			kind: "invalid",
		});
	});

	it("keeps one instance: a second start conflicts and the pid is unchanged", async () => {
		const f = botRunning(SLEEPER);
		f.supervisor.start("bot");
		await until(() => f.status().pid !== null);
		const { pid } = f.status();

		expect(f.supervisor.start("bot")).toMatchObject({
			ok: false,
			kind: "conflict",
		});
		expect(f.status().pid).toBe(pid);
	});

	it("refuses to start beside a live instance left by an earlier daemon", async () => {
		const f = botRunning(SLEEPER);
		const orphan = Bun.spawn([process.execPath, "-e", SLEEPER]);
		try {
			await Bun.write(f.pidFile, String(orphan.pid));
			expect(f.supervisor.start("bot")).toMatchObject({
				ok: false,
				kind: "conflict",
			});
		} finally {
			orphan.kill();
		}
	});

	it("ignores a pid file whose process is gone", async () => {
		const f = botRunning(SLEEPER);
		const gone = Bun.spawn([process.execPath, "-e", "0"]);
		await gone.exited;
		await Bun.write(f.pidFile, String(gone.pid));
		expect(f.supervisor.start("bot").ok).toBe(true);
	});

	it("restarts a crashing script with backoff until stopped", async () => {
		const runs = mkdtempSync(join(tmpdir(), "dg-runs-"));
		roots.push(runs);
		const counter = join(runs, "runs");
		const f = botRunning(
			`require("node:fs").appendFileSync(${JSON.stringify(counter)}, "x"); process.exit(1);`,
		);
		f.supervisor.start("bot");
		await until(() => f.status().restarts >= 2);
		expect(f.status().lastExit).toBe("exit 1");
		expect(readFileSync(counter, "utf8").length).toBeGreaterThanOrEqual(2);

		await f.supervisor.stop("bot");
		const { restarts } = f.status();
		await wait(150);
		expect(f.status()).toMatchObject({ restarts, state: "stopped" });
	});

	it("does not restart a script that exits cleanly", async () => {
		const f = botRunning("process.exit(0);");
		f.supervisor.start("bot");
		await until(() => f.status().state === "stopped");
		expect(f.status()).toMatchObject({ restarts: 0, lastExit: "exit 0" });
	});

	it("stop kills the child's whole process group", async () => {
		const marker = mkdtempSync(join(tmpdir(), "dg-grand-"));
		roots.push(marker);
		const pidFile = join(marker, "grandchild.pid");
		const f = botRunning(`
			const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(SLEEPER)}]);
			require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
			${SLEEPER}`);
		f.supervisor.start("bot");
		await until(() => existsSync(pidFile));
		const grandchild = Number(readFileSync(pidFile, "utf8"));
		expect(isAlive(grandchild)).toBe(true);

		await f.supervisor.stop("bot");
		await until(() => !isAlive(grandchild));
	});

	it("passes the allowlisted env plus the declared env file, not the parent env", async () => {
		const out = mkdtempSync(join(tmpdir(), "dg-envout-"));
		roots.push(out);
		const dump = join(out, "env.json");
		const envFile = join(out, "secrets.env");
		writeFileSync(envFile, "BOT_TOKEN=s3cret\n", { mode: 0o600 });
		process.env.DG_TEST_PARENT_SECRET = "leak";
		try {
			const f = botRunning(
				`require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env)); ${SLEEPER}`,
				{ envFile },
			);
			f.supervisor.start("bot");
			await until(() => existsSync(dump));
		} finally {
			delete process.env.DG_TEST_PARENT_SECRET;
		}
		const env = JSON.parse(readFileSync(dump, "utf8"));
		expect(env.BOT_TOKEN).toBe("s3cret");
		expect(env.DG_TEST_PARENT_SECRET).toBeUndefined();
	});

	it("refuses to start with an env file other users can read", () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-envperm-"));
		roots.push(dir);
		const envFile = join(dir, "secrets.env");
		writeFileSync(envFile, "A=1\n");
		chmodSync(envFile, 0o644);
		const f = botRunning(SLEEPER, { envFile });
		expect(f.supervisor.start("bot")).toMatchObject({
			ok: false,
			kind: "invalid",
		});
	});

	it("autostarts only the services that opt in", () => {
		const f = fixture(({ root, script }) => {
			const argv = script(SLEEPER);
			return {
				bot: { argv, cwd: root, autostart: true },
				other: { argv, cwd: root },
			};
		});
		f.supervisor.autostart();
		expect(f.status("bot").state).toBe("running");
		expect(f.status("other").state).toBe("stopped");
		expect(f.supervisor.runningCount()).toBe(1);
	});

	it("reports an invalid declaration in status", () => {
		const f = fixture(() => ({ bot: { argv: [], cwd: tmpdir() } }));
		expect(f.status()).toMatchObject({ state: "invalid" });
	});
});
